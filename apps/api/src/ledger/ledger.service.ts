import { BadRequestException, Injectable } from '@nestjs/common';
import { AccountType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequenceService } from '../common/sequence.service';

const DEFAULTS: { code: string; name: string; type: AccountType }[] = [
  { code: '1000', name: 'الخزنة', type: AccountType.ASSET },
  { code: '1100', name: 'العملاء', type: AccountType.ASSET },
  { code: '1200', name: 'المخزون', type: AccountType.ASSET },
  { code: '2000', name: 'الموردين', type: AccountType.LIABILITY },
  { code: '4000', name: 'المبيعات', type: AccountType.REVENUE },
  { code: '5000', name: 'تكلفة البضاعة', type: AccountType.EXPENSE },
  { code: '5100', name: 'مصروفات تشغيل', type: AccountType.EXPENSE },
];

@Injectable()
export class LedgerService {
  constructor(
    private prisma: PrismaService,
    private sequence: SequenceService,
  ) {}

  listAccounts() {
    return this.prisma.ledgerAccount.findMany({ orderBy: { code: 'asc' } });
  }

  createAccount(data: { code: string; name: string; type: AccountType }) {
    return this.prisma.ledgerAccount.create({ data });
  }

  async seedDefaults() {
    for (const row of DEFAULTS) {
      await this.prisma.ledgerAccount.upsert({
        where: { code: row.code },
        create: row,
        update: {},
      });
    }
    return this.listAccounts();
  }

  listEntries() {
    return this.prisma.journalEntry.findMany({
      include: { lines: { include: { account: true } } },
      orderBy: { entryDate: 'desc' },
    });
  }

  async createEntry(data: {
    entryDate?: string;
    description: string;
    lines: { accountId: string; debit?: number; credit?: number; note?: string }[];
  }) {
    if (!data.lines || data.lines.length < 2) throw new BadRequestException('القيد لازم يكون فيه طرفين على الأقل');
    const lines = data.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit || 0,
      credit: l.credit || 0,
      note: l.note,
    }));
    const debit = lines.reduce((s, l) => s + l.debit, 0);
    const credit = lines.reduce((s, l) => s + l.credit, 0);
    if (Math.abs(debit - credit) > 0.009) throw new BadRequestException('القيد مش متوازن. المدين لازم يساوي الدائن');
    if (debit <= 0) throw new BadRequestException('مبلغ القيد لازم يكون أكبر من صفر');
    const number = await this.sequence.next('journal', 'JV');
    return this.prisma.journalEntry.create({
      data: {
        number,
        description: data.description,
        entryDate: data.entryDate ? new Date(data.entryDate) : new Date(),
        lines: { create: lines },
      },
      include: { lines: { include: { account: true } } },
    });
  }
}
