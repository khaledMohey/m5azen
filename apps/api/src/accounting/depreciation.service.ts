import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountingEvent, AccountingRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { periodParts } from '../settings/period-lock';
import { JournalService } from './journal.service';
import { MappingService } from './mapping.service';
import { roundMoney, toCents } from './money';

/**
 * إهلاك القسط الثابت للأصول المسجّلة في FixedAsset.
 * لا يغيّر قيمة الأصل التاريخية — يحدّث accumulatedDepreciation فقط.
 */
@Injectable()
export class DepreciationService {
  constructor(
    private prisma: PrismaService,
    private journal: JournalService,
    private mapping: MappingService,
  ) {}

  private monthlyAmount(asset: {
    value: number;
    residualValue: number;
    usefulLifeMonths: number | null;
    accumulatedDepreciation: number;
  }) {
    const life = asset.usefulLifeMonths || 0;
    if (life <= 0) return 0;
    const base = Math.max(0, Number(asset.value) - Number(asset.residualValue || 0));
    const remaining = Math.max(0, base - Number(asset.accumulatedDepreciation || 0));
    if (remaining <= 0) return 0;
    return roundMoney(Math.min(remaining, base / life));
  }

  async runMonth(year: number, month: number, userId?: string) {
    if (month < 1 || month > 12) throw new BadRequestException('شهر غير صالح');
    const assets = await this.prisma.fixedAsset.findMany({
      where: { isActive: true, usefulLifeMonths: { gt: 0 } },
    });
    const results: { assetId: string; amount: number; entryId?: string; skipped?: string }[] = [];

    let expenseAccountId: string | null = null;
    let accumAccountId: string | null = null;
    try {
      const map = await this.mapping.getMapping(AccountingEvent.DEPRECIATION);
      expenseAccountId = map.lines.find((l) => l.role === AccountingRole.DEPRECIATION_EXPENSE)?.accountId || null;
      accumAccountId = map.lines.find((l) => l.role === AccountingRole.ACCUMULATED_DEPRECIATION)?.accountId || null;
    } catch {
      const expense = await this.prisma.account.findUnique({ where: { code: '5300' } });
      const accum = await this.prisma.account.findUnique({ where: { code: '1510' } });
      expenseAccountId = expense?.id || null;
      accumAccountId = accum?.id || null;
    }
    if (!expenseAccountId || !accumAccountId) {
      throw new BadRequestException('حسابات الإهلاك غير مضبوطة في دليل الحسابات (5300 / 1510)');
    }

    const entryDate = new Date(Date.UTC(year, month - 1, 28));

    for (const asset of assets) {
      const existing = await this.prisma.fixedAssetDepreciation.findUnique({
        where: {
          fixedAssetId_periodYear_periodMonth: {
            fixedAssetId: asset.id,
            periodYear: year,
            periodMonth: month,
          },
        },
      });
      if (existing) {
        results.push({ assetId: asset.id, amount: existing.amount, skipped: 'already_posted' });
        continue;
      }

      const amount = this.monthlyAmount(asset);
      if (toCents(amount) === 0) {
        results.push({ assetId: asset.id, amount: 0, skipped: 'fully_depreciated' });
        continue;
      }

      const sourceId = `DEP:${asset.id}:${year}-${String(month).padStart(2, '0')}`;
      const entry = await this.journal.createPostedDirect({
        entryDate,
        description: `إهلاك ${asset.name} ${month}/${year}`,
        createdById: userId,
        sourceType: AccountingEvent.DEPRECIATION,
        sourceId,
        lines: [
          {
            accountId: expenseAccountId,
            debit: amount,
            credit: 0,
            description: 'مصروف إهلاك',
            lineOrder: 0,
          },
          {
            accountId: accumAccountId,
            debit: 0,
            credit: amount,
            description: 'مجمع إهلاك',
            lineOrder: 1,
          },
        ],
      });

      await this.prisma.$transaction([
        this.prisma.fixedAssetDepreciation.create({
          data: {
            fixedAssetId: asset.id,
            periodYear: year,
            periodMonth: month,
            amount,
            journalEntryId: entry.id,
          },
        }),
        this.prisma.fixedAsset.update({
          where: { id: asset.id },
          data: { accumulatedDepreciation: { increment: amount } },
        }),
      ]);

      results.push({ assetId: asset.id, amount, entryId: entry.id });
    }

    return { year, month, results };
  }

  async preview(assetId: string) {
    const asset = await this.prisma.fixedAsset.findUnique({ where: { id: assetId } });
    if (!asset) throw new NotFoundException('الأصل غير موجود');
    const now = periodParts(new Date());
    return {
      asset,
      monthlyAmount: this.monthlyAmount(asset),
      nextPeriod: { year: now.year, month: now.month },
    };
  }
}
