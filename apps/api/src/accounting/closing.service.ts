import { BadRequestException, Injectable } from '@nestjs/common';
import { AccountingEvent, AccountType, JournalEntryStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalBalanceForType } from './party';
import { fromCents, roundMoney, toCents } from './money';
import { JournalService } from './journal.service';
import { AuditService } from './audit.service';
import { closedYearSettingKey, yearCloseSourceId } from './closing.util';

const POSTED_STATUSES: JournalEntryStatus[] = [
  JournalEntryStatus.POSTED,
  JournalEntryStatus.REVERSED,
];

export { closedYearSettingKey, yearCloseSourceId } from './closing.util';

@Injectable()
export class ClosingService {
  constructor(
    private prisma: PrismaService,
    private journal: JournalService,
    private audit: AuditService,
  ) {}

  private assertYear(year: number) {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('السنة المالية غير صالحة');
    }
  }

  async isYearClosed(year: number) {
    const key = closedYearSettingKey(year);
    const [setting, entry] = await Promise.all([
      this.prisma.setting.findUnique({ where: { key } }),
      this.prisma.journalEntry.findUnique({
        where: {
          sourceType_sourceId: {
            sourceType: AccountingEvent.MANUAL,
            sourceId: yearCloseSourceId(year),
          },
        },
        select: { id: true, status: true },
      }),
    ]);
    // قيد الإقفال المعكوس لا يُبقي السنة مقفولة
    const activeClose = entry?.status === JournalEntryStatus.POSTED;
    return Boolean(setting?.value === '1' || activeClose);
  }

  async assertYearNotClosed(year: number) {
    if (await this.isYearClosed(year)) {
      throw new BadRequestException(`السنة المالية ${year} مقفولة. مش ينفع ترحيل قيود عليها`);
    }
  }

  private async plBalances(year: number) {
    const lines = await this.prisma.journalLine.findMany({
      where: {
        entry: {
          fiscalYear: year,
          status: { in: POSTED_STATUSES },
        },
        account: { type: { in: [AccountType.REVENUE, AccountType.EXPENSE] } },
      },
      include: { account: true },
    });

    const map = new Map<
      string,
      {
        accountId: string;
        code: string;
        name: string;
        type: AccountType;
        debitCents: number;
        creditCents: number;
      }
    >();

    for (const line of lines) {
      const row = map.get(line.accountId) || {
        accountId: line.accountId,
        code: line.account.code,
        name: line.account.name,
        type: line.account.type,
        debitCents: 0,
        creditCents: 0,
      };
      row.debitCents += toCents(line.debit);
      row.creditCents += toCents(line.credit);
      map.set(line.accountId, row);
    }

    const revenue: {
      accountId: string;
      code: string;
      name: string;
      balance: number;
    }[] = [];
    const expense: {
      accountId: string;
      code: string;
      name: string;
      balance: number;
    }[] = [];
    let revenueTotal = 0;
    let expenseTotal = 0;

    for (const row of [...map.values()].sort((a, b) => a.code.localeCompare(b.code))) {
      if (row.type === AccountType.REVENUE) {
        // Credit-nature: credit − debit
        const balance = fromCents(row.creditCents - row.debitCents);
        if (toCents(balance) === 0) continue;
        revenue.push({
          accountId: row.accountId,
          code: row.code,
          name: row.name,
          balance,
        });
        revenueTotal = roundMoney(revenueTotal + balance);
      } else {
        // Debit-nature: debit − credit
        const balance = fromCents(row.debitCents - row.creditCents);
        if (toCents(balance) === 0) continue;
        expense.push({
          accountId: row.accountId,
          code: row.code,
          name: row.name,
          balance,
        });
        expenseTotal = roundMoney(expenseTotal + balance);
      }
    }

    return {
      year,
      revenue,
      expense,
      revenueTotal,
      expenseTotal,
      netIncome: roundMoney(revenueTotal - expenseTotal),
    };
  }

  async previewClose(year: number) {
    this.assertYear(year);
    const preview = await this.plBalances(year);
    const alreadyClosed = await this.isYearClosed(year);
    return { ...preview, alreadyClosed };
  }

  private async ensureRetainedEarningsAccount() {
    let retained = await this.prisma.account.findUnique({ where: { code: '3200' } });
    if (retained) return retained;
    const openingEquity = await this.prisma.account.findUnique({ where: { code: '3100' } });
    if (openingEquity) return openingEquity;

    retained = await this.prisma.account.create({
      data: {
        code: '3200',
        name: 'أرباح مرحّلة',
        type: AccountType.EQUITY,
        normalBalance: normalBalanceForType(AccountType.EQUITY),
        isPostable: true,
        isActive: true,
        sortOrder: 320,
      },
    });
    return retained;
  }

  async closeYear(year: number, userId?: string) {
    this.assertYear(year);

    if (await this.isYearClosed(year)) {
      throw new BadRequestException(`السنة المالية ${year} مقفولة بالفعل`);
    }

    const preview = await this.plBalances(year);
    if (preview.revenue.length === 0 && preview.expense.length === 0) {
      throw new BadRequestException('مفيش أرصدة إيرادات أو مصروفات لإقفالها في السنة دي');
    }

    const equityAccount = await this.ensureRetainedEarningsAccount();
    const sourceId = yearCloseSourceId(year);
    const entryDate = new Date(Date.UTC(year, 11, 31, 12, 0, 0));

    const lines: {
      accountId: string;
      debit: number;
      credit: number;
      description: string;
      lineOrder: number;
    }[] = [];
    let order = 0;

    // Debit each REVENUE balance (credit nature → debit to zero)
    for (const row of preview.revenue) {
      lines.push({
        accountId: row.accountId,
        debit: row.balance,
        credit: 0,
        description: `إقفال إيراد ${row.code}`,
        lineOrder: order++,
      });
    }
    // Credit each EXPENSE balance (debit nature → credit to zero)
    for (const row of preview.expense) {
      lines.push({
        accountId: row.accountId,
        debit: 0,
        credit: row.balance,
        description: `إقفال مصروف ${row.code}`,
        lineOrder: order++,
      });
    }

    // Difference to retained earnings (3200) or opening equity (3100)
    const net = preview.netIncome;
    if (toCents(net) > 0) {
      lines.push({
        accountId: equityAccount.id,
        debit: 0,
        credit: net,
        description: 'صافي الربح → أرباح مرحّلة',
        lineOrder: order++,
      });
    } else if (toCents(net) < 0) {
      lines.push({
        accountId: equityAccount.id,
        debit: roundMoney(-net),
        credit: 0,
        description: 'صافي الخسارة → أرباح مرحّلة',
        lineOrder: order++,
      });
    }

    if (lines.length < 2) {
      throw new BadRequestException('قيد الإقفال مش متوازن أو ناقص سطور');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.journalEntry.findUnique({
        where: {
          sourceType_sourceId: {
            sourceType: AccountingEvent.MANUAL,
            sourceId,
          },
        },
      });
      if (existing) {
        throw new BadRequestException(`فيه قيد إقفال بالفعل لسنة ${year}`);
      }

      const entry = await this.journal.createPostedDirect(
        {
          entryDate,
          description: `إقفال السنة المالية ${year}`,
          createdById: userId,
          sourceType: AccountingEvent.MANUAL,
          sourceId,
          skipPeriodLock: true,
          skipClosedYearCheck: true,
          lines,
        },
        tx,
      );

      await tx.setting.upsert({
        where: { key: closedYearSettingKey(year) },
        create: { key: closedYearSettingKey(year), value: '1' },
        update: { value: '1' },
      });

      return entry;
    });

    await this.audit.log(
      'YEAR_CLOSE',
      'JournalEntry',
      result.id,
      userId,
      null,
      { year, netIncome: preview.netIncome, entryId: result.id, sourceId },
      `إقفال سنة ${year}`,
    );

    return {
      year,
      netIncome: preview.netIncome,
      revenueTotal: preview.revenueTotal,
      expenseTotal: preview.expenseTotal,
      retainedEarningsAccount: { id: equityAccount.id, code: equityAccount.code, name: equityAccount.name },
      entry: result,
    };
  }
}
