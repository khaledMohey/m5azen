import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AccountingEvent,
  AccountingPartyType,
  JournalEntryStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequenceService } from '../common/sequence.service';
import { assertPeriodsOpen, periodParts } from '../settings/period-lock';
import { assertBalanced, roundMoney, toCents } from './money';
import { assertPartyOnLine } from './party';
import { AuditService } from './audit.service';
import { closedYearSettingKey } from './closing.util';

export type JournalLineInput = {
  accountId: string;
  debit?: number;
  credit?: number;
  description?: string | null;
  partyType?: AccountingPartyType;
  customerId?: string | null;
  supplierId?: string | null;
  costCenterId?: string | null;
  lineOrder?: number;
};

export type CreateDraftInput = {
  entryDate: Date | string;
  description?: string;
  lines: JournalLineInput[];
  createdById?: string | null;
  sourceType?: AccountingEvent;
  sourceId?: string | null;
};

@Injectable()
export class JournalService {
  constructor(
    private prisma: PrismaService,
    private sequence: SequenceService,
    private audit: AuditService,
  ) {}

  private parseDate(input: Date | string) {
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('تاريخ القيد غير صالح');
    return date;
  }

  private async assertFiscalYearOpen(entryDate: Date) {
    const { year } = periodParts(entryDate);
    const row = await this.prisma.setting.findUnique({
      where: { key: closedYearSettingKey(year) },
    });
    if (row?.value === '1') {
      throw new BadRequestException(`السنة المالية ${year} مقفولة. مش ينفع ترحيل قيود عليها`);
    }
  }

  private async validateLines(lines: JournalLineInput[]) {
    if (!lines || lines.length < 2) {
      throw new BadRequestException('القيد لازم يكون فيه سطرين على الأقل');
    }
    const normalized = lines.map((line, index) => ({
      accountId: line.accountId,
      debit: roundMoney(Number(line.debit || 0)),
      credit: roundMoney(Number(line.credit || 0)),
      description: line.description?.trim() || null,
      partyType: line.partyType ?? AccountingPartyType.NONE,
      customerId: line.customerId || null,
      supplierId: line.supplierId || null,
      costCenterId: line.costCenterId || null,
      lineOrder: line.lineOrder ?? index,
    }));
    assertBalanced(normalized);

    const accountIds = [...new Set(normalized.map((l) => l.accountId))];
    const accounts = await this.prisma.account.findMany({ where: { id: { in: accountIds } } });
    if (accounts.length !== accountIds.length) {
      throw new BadRequestException('حساب في سطور القيد غير موجود');
    }
    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const line of normalized) {
      const account = byId.get(line.accountId)!;
      const partyType = assertPartyOnLine(account, line);
      line.partyType = partyType;
      if (toCents(line.debit) === 0 && toCents(line.credit) === 0) {
        throw new BadRequestException('السطر لازم يكون فيه مبلغ');
      }
    }
    return normalized;
  }

  async createDraft(data: CreateDraftInput) {
    const entryDate = this.parseDate(data.entryDate);
    const lines = await this.validateLines(data.lines);
    const parts = periodParts(entryDate);
    const sourceType = data.sourceType ?? AccountingEvent.MANUAL;
    const sourceId = sourceType === AccountingEvent.MANUAL ? null : data.sourceId ?? null;
    if (sourceType !== AccountingEvent.MANUAL && !sourceId) {
      throw new BadRequestException('مصدر القيد التلقائي ناقص');
    }
    const number = await this.sequence.next('journal', 'JE');
    const entry = await this.prisma.journalEntry.create({
      data: {
        number,
        entryDate,
        description: data.description?.trim() || '',
        status: JournalEntryStatus.DRAFT,
        sourceType,
        sourceId,
        fiscalYear: parts.year,
        fiscalMonth: parts.month,
        createdById: data.createdById || null,
        lines: { create: lines },
      },
      include: { lines: { include: { account: true }, orderBy: { lineOrder: 'asc' } } },
    });
    await this.audit.log('JOURNAL_DRAFT_CREATE', 'JournalEntry', entry.id, data.createdById, null, entry);
    return entry;
  }

  async updateDraft(
    id: string,
    data: Partial<Omit<CreateDraftInput, 'createdById' | 'sourceType' | 'sourceId'>> & { userId?: string },
  ) {
    const existing = await this.prisma.journalEntry.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!existing) throw new NotFoundException('القيد غير موجود');
    if (existing.status !== JournalEntryStatus.DRAFT) {
      throw new BadRequestException('تعديل المسودات فقط');
    }
    if (existing.sourceType !== AccountingEvent.MANUAL) {
      throw new BadRequestException('القيد التلقائي مش يتعدل يدوي');
    }

    const entryDate = data.entryDate != null ? this.parseDate(data.entryDate) : existing.entryDate;
    const lines = data.lines ? await this.validateLines(data.lines) : null;
    const parts = periodParts(entryDate);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (lines) {
        await tx.journalLine.deleteMany({ where: { entryId: id } });
      }
      return tx.journalEntry.update({
        where: { id },
        data: {
          entryDate,
          description: data.description != null ? data.description.trim() : undefined,
          fiscalYear: parts.year,
          fiscalMonth: parts.month,
          ...(lines ? { lines: { create: lines } } : {}),
        },
        include: { lines: { include: { account: true }, orderBy: { lineOrder: 'asc' } } },
      });
    });
    await this.audit.log('JOURNAL_DRAFT_UPDATE', 'JournalEntry', id, data.userId, existing, updated);
    return updated;
  }

  async post(id: string, userId?: string) {
    const existing = await this.prisma.journalEntry.findUnique({
      where: { id },
      include: { lines: { include: { account: true } } },
    });
    if (!existing) throw new NotFoundException('القيد غير موجود');
    if (existing.status !== JournalEntryStatus.DRAFT) {
      throw new BadRequestException('ترحيل المسودات فقط');
    }
    await this.validateLines(
      existing.lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit,
        credit: l.credit,
        description: l.description,
        partyType: l.partyType,
        customerId: l.customerId,
        supplierId: l.supplierId,
        costCenterId: l.costCenterId,
        lineOrder: l.lineOrder,
      })),
    );
    await assertPeriodsOpen(this.prisma, existing.entryDate);
    await this.assertFiscalYearOpen(existing.entryDate);

    const updated = await this.prisma.journalEntry.update({
      where: { id },
      data: { status: JournalEntryStatus.POSTED, postedAt: new Date() },
      include: { lines: { include: { account: true }, orderBy: { lineOrder: 'asc' } } },
    });
    await this.audit.log('JOURNAL_POST', 'JournalEntry', id, userId, existing, updated);
    return updated;
  }

  async reverse(
    id: string,
    opts: { entryDate?: Date | string; reason?: string; userId?: string } = {},
  ) {
    const original = await this.prisma.journalEntry.findUnique({
      where: { id },
      include: { lines: true, reversalEntry: true },
    });
    if (!original) throw new NotFoundException('القيد غير موجود');
    if (original.status === JournalEntryStatus.REVERSED || original.reversalEntry) {
      throw new BadRequestException('القيد متعكس بالفعل');
    }
    if (original.status !== JournalEntryStatus.POSTED) {
      throw new BadRequestException('عكس القيود المرحلة فقط');
    }

    const entryDate = opts.entryDate != null ? this.parseDate(opts.entryDate) : original.entryDate;
    await assertPeriodsOpen(this.prisma, entryDate);
    await this.assertFiscalYearOpen(entryDate);
    const parts = periodParts(entryDate);
    const number = await this.sequence.next('journal', 'JE');
    const reason = opts.reason?.trim() || '';

    const reversal = await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.journalEntry.updateMany({
        where: { id, status: JournalEntryStatus.POSTED },
        data: { status: JournalEntryStatus.REVERSED },
      });
      if (flipped.count !== 1) {
        throw new BadRequestException('تعذر عكس القيد — ربما اتعكس من قبل');
      }
      return tx.journalEntry.create({
        data: {
          number,
          entryDate,
          description: reason
            ? `عكس ${original.number}: ${reason}`
            : `عكس ${original.number}`,
          status: JournalEntryStatus.POSTED,
          sourceType: original.sourceType,
          sourceId: original.sourceId ? `REV-${original.sourceId}` : null,
          fiscalYear: parts.year,
          fiscalMonth: parts.month,
          createdById: opts.userId || null,
          reversesEntryId: id,
          postedAt: new Date(),
          lines: {
            create: original.lines.map((line, index) => ({
              accountId: line.accountId,
              debit: line.credit,
              credit: line.debit,
              description: line.description,
              partyType: line.partyType,
              customerId: line.customerId,
              supplierId: line.supplierId,
              costCenterId: line.costCenterId,
              lineOrder: line.lineOrder ?? index,
            })),
          },
        },
        include: { lines: { include: { account: true }, orderBy: { lineOrder: 'asc' } } },
      });
    });

    // عكس قيد إقفال السنة يزيل قفل السنة حتى لا تبقى مقفولة بلا قيد فعّال
    if (
      original.sourceType === AccountingEvent.MANUAL
      && original.sourceId?.startsWith('YEARCLOSE-')
    ) {
      const year = Number(String(original.sourceId).replace('YEARCLOSE-', ''));
      if (Number.isInteger(year)) {
        await this.prisma.setting.deleteMany({ where: { key: closedYearSettingKey(year) } });
      }
    }

    await this.audit.log('JOURNAL_REVERSE', 'JournalEntry', id, opts.userId, original, reversal, reason || undefined);
    return reversal;
  }

  async findOne(id: string) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id },
      include: {
        lines: { include: { account: true, customer: true, supplier: true }, orderBy: { lineOrder: 'asc' } },
        createdBy: { select: { id: true, fullName: true, username: true } },
        reversesEntry: { select: { id: true, number: true } },
        reversalEntry: { select: { id: true, number: true } },
      },
    });
    if (!entry) throw new NotFoundException('القيد غير موجود');
    return entry;
  }

  async list(filters: {
    status?: JournalEntryStatus;
    from?: string;
    to?: string;
    sourceType?: AccountingEvent;
    q?: string;
    page?: number;
    pageSize?: number;
  } = {}) {
    const page = Math.max(1, filters.page || 1);
    const pageSize = Math.min(100, Math.max(1, filters.pageSize || 50));
    const where: Prisma.JournalEntryWhereInput = {};
    if (filters.status) where.status = filters.status;
    if (filters.sourceType) where.sourceType = filters.sourceType;
    if (filters.from || filters.to) {
      where.entryDate = {};
      if (filters.from) where.entryDate.gte = this.parseDate(filters.from);
      if (filters.to) where.entryDate.lte = this.parseDate(filters.to);
    }
    if (filters.q?.trim()) {
      const q = filters.q.trim();
      where.OR = [
        { number: { contains: q } },
        { description: { contains: q } },
        { sourceId: { contains: q } },
      ];
    }
    const [total, items] = await Promise.all([
      this.prisma.journalEntry.count({ where }),
      this.prisma.journalEntry.findMany({
        where,
        include: { lines: { select: { debit: true, credit: true } } },
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, page, pageSize, items };
  }

  async deleteDraft(id: string, userId?: string) {
    const existing = await this.prisma.journalEntry.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('القيد غير موجود');
    if (existing.status !== JournalEntryStatus.DRAFT) {
      throw new BadRequestException('حذف المسودات فقط');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.journalLine.deleteMany({ where: { entryId: id } });
      await tx.journalEntry.delete({ where: { id } });
    });
    await this.audit.log('JOURNAL_DRAFT_DELETE', 'JournalEntry', id, userId, existing, null);
    return { ok: true };
  }

  /** Create a POSTED journal in one shot (for automatic posting / openings / year close). */
  async createPostedDirect(
    data: CreateDraftInput & {
      postedAt?: Date;
      /** Year-close JE may post into already-locked months. */
      skipPeriodLock?: boolean;
      /** Year-close JE itself must write before the closed-year flag is checked. */
      skipClosedYearCheck?: boolean;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx || this.prisma;
    const entryDate = this.parseDate(data.entryDate);
    const lines = await this.validateLines(data.lines);
    if (!data.skipPeriodLock) {
      await assertPeriodsOpen(this.prisma, entryDate);
    }
    if (!data.skipClosedYearCheck) {
      await this.assertFiscalYearOpen(entryDate);
    }
    const parts = periodParts(entryDate);
    const sourceType = data.sourceType ?? AccountingEvent.MANUAL;
    // MANUAL may carry an explicit sourceId (e.g. YEARCLOSE-{year}) for idempotency.
    const sourceId = data.sourceId?.trim() || null;
    if (sourceType !== AccountingEvent.MANUAL && !sourceId) {
      throw new BadRequestException('مصدر القيد التلقائي ناقص');
    }
    const existing = sourceId
      ? await db.journalEntry.findUnique({
          where: { sourceType_sourceId: { sourceType, sourceId } },
          include: { lines: true },
        })
      : null;
    if (existing) return existing;

    // استخدم نفس عميل المعاملة حتى لا يتقدّم Sequence خارج الـ rollback
    const seq = await db.sequence.upsert({
      where: { key: 'journal' },
      create: { key: 'journal', value: 1 },
      update: { value: { increment: 1 } },
    });
    const number = `JE-${String(seq.value).padStart(6, '0')}`;
    return db.journalEntry.create({
      data: {
        number,
        entryDate,
        description: data.description?.trim() || '',
        status: JournalEntryStatus.POSTED,
        sourceType,
        sourceId,
        fiscalYear: parts.year,
        fiscalMonth: parts.month,
        createdById: data.createdById || null,
        postedAt: data.postedAt || new Date(),
        lines: { create: lines },
      },
      include: { lines: { include: { account: true }, orderBy: { lineOrder: 'asc' } } },
    });
  }
}
