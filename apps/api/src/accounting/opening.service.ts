import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AccountingEvent,
  AccountingPartyType,
  AccountSubledger,
  OpeningBatchStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertBalanced, roundMoney } from './money';
import { assertPartyOnLine, openingPartyKey } from './party';
import { JournalService } from './journal.service';
import { AuditService } from './audit.service';

export type OpeningLineInput = {
  accountId: string;
  debit?: number;
  credit?: number;
  partyType?: AccountingPartyType;
  customerId?: string | null;
  supplierId?: string | null;
  notes?: string | null;
};

@Injectable()
export class OpeningService {
  constructor(
    private prisma: PrismaService,
    private journal: JournalService,
    private audit: AuditService,
  ) {}

  private async getDraftBatch(id: string) {
    const batch = await this.prisma.accountOpeningBatch.findUnique({
      where: { id },
      include: { lines: { include: { account: true } } },
    });
    if (!batch) throw new NotFoundException('دفعة الأرصدة الافتتاحية غير موجودة');
    if (batch.status !== OpeningBatchStatus.DRAFT) {
      throw new BadRequestException('تعديل دفعات المسودة فقط');
    }
    return batch;
  }

  private async validateOpeningLine(line: OpeningLineInput) {
    const account = await this.prisma.account.findUnique({ where: { id: line.accountId } });
    if (!account) throw new BadRequestException('الحساب غير موجود');
    const debit = roundMoney(Number(line.debit || 0));
    const credit = roundMoney(Number(line.credit || 0));
    const normalized = {
      accountId: line.accountId,
      debit,
      credit,
      partyType: line.partyType ?? AccountingPartyType.NONE,
      customerId: line.customerId || null,
      supplierId: line.supplierId || null,
      notes: line.notes?.trim() || null,
    };
    const partyType = assertPartyOnLine(account, normalized);
    if (
      (account.subledger === AccountSubledger.AR || account.subledger === AccountSubledger.AP)
      && partyType === AccountingPartyType.NONE
    ) {
      throw new BadRequestException('حساب الذمم في الأرصدة الافتتاحية لازم يكون على مستوى الطرف');
    }
    return { ...normalized, partyType, partyKey: openingPartyKey(normalized) };
  }

  async createDraftBatch(year: number, notes?: string, userId?: string) {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('السنة المالية غير صالحة');
    }
    const last = await this.prisma.accountOpeningBatch.findFirst({
      where: { fiscalYear: year },
      orderBy: { version: 'desc' },
    });
    const version = (last?.version || 0) + 1;
    const batch = await this.prisma.accountOpeningBatch.create({
      data: {
        fiscalYear: year,
        version,
        status: OpeningBatchStatus.DRAFT,
        notes: notes?.trim() || null,
      },
    });
    await this.audit.log('OPENING_BATCH_CREATE', 'AccountOpeningBatch', batch.id, userId, null, batch);
    return batch;
  }

  async addLine(batchId: string, line: OpeningLineInput, userId?: string) {
    await this.getDraftBatch(batchId);
    const normalized = await this.validateOpeningLine(line);
    try {
      const row = await this.prisma.accountOpeningBalance.create({
        data: { batchId, ...normalized },
        include: { account: true },
      });
      await this.audit.log('OPENING_LINE_ADD', 'AccountOpeningBalance', row.id, userId, null, row);
      return row;
    } catch {
      throw new BadRequestException('السطر مكرر لنفس الحساب والطرف في الدفعة');
    }
  }

  async updateLine(lineId: string, data: Partial<OpeningLineInput>, userId?: string) {
    const existing = await this.prisma.accountOpeningBalance.findUnique({
      where: { id: lineId },
      include: { batch: true, account: true },
    });
    if (!existing) throw new NotFoundException('سطر الرصيد الافتتاحي غير موجود');
    if (existing.batch.status !== OpeningBatchStatus.DRAFT) {
      throw new BadRequestException('تعديل دفعات المسودة فقط');
    }
    const normalized = await this.validateOpeningLine({
      accountId: data.accountId ?? existing.accountId,
      debit: data.debit ?? existing.debit,
      credit: data.credit ?? existing.credit,
      partyType: data.partyType ?? existing.partyType,
      customerId: data.customerId === undefined ? existing.customerId : data.customerId,
      supplierId: data.supplierId === undefined ? existing.supplierId : data.supplierId,
      notes: data.notes === undefined ? existing.notes : data.notes,
    });
    try {
      const row = await this.prisma.accountOpeningBalance.update({
        where: { id: lineId },
        data: normalized,
        include: { account: true },
      });
      await this.audit.log('OPENING_LINE_UPDATE', 'AccountOpeningBalance', lineId, userId, existing, row);
      return row;
    } catch {
      throw new BadRequestException('السطر مكرر لنفس الحساب والطرف في الدفعة');
    }
  }

  async deleteLine(lineId: string, userId?: string) {
    const existing = await this.prisma.accountOpeningBalance.findUnique({
      where: { id: lineId },
      include: { batch: true },
    });
    if (!existing) throw new NotFoundException('سطر الرصيد الافتتاحي غير موجود');
    if (existing.batch.status !== OpeningBatchStatus.DRAFT) {
      throw new BadRequestException('تعديل دفعات المسودة فقط');
    }
    await this.prisma.accountOpeningBalance.delete({ where: { id: lineId } });
    await this.audit.log('OPENING_LINE_DELETE', 'AccountOpeningBalance', lineId, userId, existing, null);
    return { ok: true };
  }

  async findBatch(id: string) {
    const batch = await this.prisma.accountOpeningBatch.findUnique({
      where: { id },
      include: {
        lines: { include: { account: true, customer: true, supplier: true }, orderBy: { createdAt: 'asc' } },
        journalEntry: true,
      },
    });
    if (!batch) throw new NotFoundException('دفعة الأرصدة الافتتاحية غير موجودة');
    return batch;
  }

  async listBatches(year?: number) {
    return this.prisma.accountOpeningBatch.findMany({
      where: year ? { fiscalYear: year } : undefined,
      include: { _count: { select: { lines: true } }, journalEntry: { select: { id: true, number: true } } },
      orderBy: [{ fiscalYear: 'desc' }, { version: 'desc' }],
    });
  }

  async applyBatch(id: string, userId?: string) {
    const batch = await this.prisma.accountOpeningBatch.findUnique({
      where: { id },
      include: { lines: { include: { account: true } } },
    });
    if (!batch) throw new NotFoundException('دفعة الأرصدة الافتتاحية غير موجودة');
    if (batch.status !== OpeningBatchStatus.DRAFT) {
      throw new BadRequestException('ترحيل دفعات المسودة فقط');
    }
    if (batch.lines.length < 2) {
      throw new BadRequestException('الأرصدة الافتتاحية لازم يكون فيها سطرين على الأقل');
    }
    assertBalanced(batch.lines);
    for (const line of batch.lines) {
      assertPartyOnLine(line.account, line);
    }

    const sourceId = `OB-${batch.fiscalYear}-v${batch.version}`;
    const entryDate = new Date(Date.UTC(batch.fiscalYear, 0, 1, 12, 0, 0));

    const result = await this.prisma.$transaction(async (tx) => {
      const applied = await tx.accountOpeningBatch.findFirst({
        where: { appliedYearKey: String(batch.fiscalYear) },
      });
      if (applied) {
        throw new BadRequestException(`فيه دفعة افتتاحية مطبّقة بالفعل لسنة ${batch.fiscalYear}`);
      }

      const entry = await this.journal.createPostedDirect(
        {
          entryDate,
          description: `أرصدة افتتاحية ${batch.fiscalYear} (v${batch.version})`,
          createdById: userId,
          sourceType: AccountingEvent.OPENING_BALANCE,
          sourceId,
          lines: batch.lines.map((line, index) => ({
            accountId: line.accountId,
            debit: line.debit,
            credit: line.credit,
            partyType: line.partyType,
            customerId: line.customerId,
            supplierId: line.supplierId,
            description: line.notes,
            lineOrder: index,
          })),
        },
        tx,
      );

      const updated = await tx.accountOpeningBatch.update({
        where: { id },
        data: {
          status: OpeningBatchStatus.APPLIED,
          journalEntryId: entry.id,
          appliedYearKey: String(batch.fiscalYear),
        },
        include: { lines: true, journalEntry: true },
      });
      return updated;
    });

    await this.audit.log('OPENING_BATCH_APPLY', 'AccountOpeningBatch', id, userId, batch, result);
    return result;
  }

  async reverseBatch(id: string, userId?: string, reason?: string) {
    const batch = await this.prisma.accountOpeningBatch.findUnique({ where: { id } });
    if (!batch) throw new NotFoundException('دفعة الأرصدة الافتتاحية غير موجودة');
    if (batch.status !== OpeningBatchStatus.APPLIED || !batch.journalEntryId) {
      throw new BadRequestException('عكس الدفعات المطبّقة فقط');
    }

    // العكس أولًا؛ لو نجح لازم تتحدّث الدفعة وإلا تُبلَّغ الحالة الشاذة
    await this.journal.reverse(batch.journalEntryId, { userId, reason: reason || 'عكس أرصدة افتتاحية' });
    try {
      const updated = await this.prisma.accountOpeningBatch.update({
        where: { id },
        data: {
          status: OpeningBatchStatus.REVERSED,
          appliedYearKey: null,
        },
      });
      await this.audit.log('OPENING_BATCH_REVERSE', 'AccountOpeningBatch', id, userId, batch, updated, reason);
      return updated;
    } catch (error) {
      throw new BadRequestException(
        'تم عكس قيد الافتتاح لكن تحديث حالة الدفعة فشل — راجع الدفعة يدويًا',
      );
    }
  }
}
