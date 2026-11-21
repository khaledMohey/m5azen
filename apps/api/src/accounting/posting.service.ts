import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AccountingEvent,
  AccountingPartyType,
  AccountingRole,
  AccountResolutionMode,
  InvoiceStatus,
  MappingAmountSource,
  MappingSide,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fromCents, roundMoney, toCents } from './money';
import { JournalLineInput, JournalService } from './journal.service';
import { MappingService } from './mapping.service';
import { QueueService } from './queue.service';

type AmountContext = {
  total?: number;
  subtotal?: number;
  discount?: number;
  tax?: number;
  scrap?: number;
  net?: number;
  tenderAmount?: number;
  cogsSum?: number;
  cogsDelta?: number;
  salaryAmount?: number;
  commissionAmount?: number;
  contextAmount?: number;
};

type ResolveCtx = {
  cashAccountId?: string | null;
  methodId?: string | null;
  customerId?: string | null;
  supplierId?: string | null;
  amounts: AmountContext;
};

@Injectable()
export class PostingService {
  constructor(
    private prisma: PrismaService,
    private journal: JournalService,
    private mapping: MappingService,
    private queue: QueueService,
  ) {}

  private documentNet(subtotal: number, discount: number) {
    return roundMoney(Math.max(0, Number(subtotal || 0) - Number(discount || 0)));
  }

  private amountFromSource(source: MappingAmountSource, amounts: AmountContext, param?: number | null) {
    switch (source) {
      case MappingAmountSource.DOCUMENT_TOTAL:
        return roundMoney(amounts.total || 0);
      case MappingAmountSource.DOCUMENT_SUBTOTAL:
        return roundMoney(amounts.subtotal || 0);
      case MappingAmountSource.DOCUMENT_DISCOUNT:
        return roundMoney(amounts.discount || 0);
      case MappingAmountSource.DOCUMENT_NET:
        return roundMoney(
          amounts.net != null
            ? amounts.net
            : this.documentNet(amounts.subtotal || 0, amounts.discount || 0),
        );
      case MappingAmountSource.DOCUMENT_TAX:
        return roundMoney(amounts.tax || 0);
      case MappingAmountSource.DOCUMENT_SCRAP:
      case MappingAmountSource.SCRAP_AMOUNT:
        return roundMoney(amounts.scrap || 0);
      case MappingAmountSource.LINE_COGS_SUM:
        return roundMoney(amounts.cogsSum || 0);
      case MappingAmountSource.COGS_DELTA:
        return roundMoney(amounts.cogsDelta || 0);
      case MappingAmountSource.TENDER_AMOUNT:
        return roundMoney(amounts.tenderAmount || 0);
      case MappingAmountSource.SALARY_AMOUNT:
        return roundMoney(amounts.salaryAmount || 0);
      case MappingAmountSource.COMMISSION_AMOUNT:
        return roundMoney(amounts.commissionAmount || 0);
      case MappingAmountSource.CONTEXT:
        return roundMoney(param ?? amounts.contextAmount ?? 0);
      case MappingAmountSource.OPENING_ROW:
      case MappingAmountSource.STOCK_VALUE:
      case MappingAmountSource.FIXED_ASSET_VALUE:
        return roundMoney(param ?? amounts.contextAmount ?? 0);
      default:
        return 0;
    }
  }

  private async resolveAccountId(
    line: {
      resolutionMode: AccountResolutionMode;
      accountId: string | null;
      isRequired: boolean;
      role: AccountingRole;
    },
    ctx: ResolveCtx,
  ) {
    if (line.resolutionMode === AccountResolutionMode.FIXED) {
      if (!line.accountId) {
        if (line.isRequired) throw new BadRequestException(`الربط المحاسبي لـ ${line.role} ناقص حساب`);
        return null;
      }
      return line.accountId;
    }

    let cashAccountId = ctx.cashAccountId || null;
    if (line.resolutionMode === AccountResolutionMode.PAY_METHOD) {
      if (!ctx.methodId) {
        if (line.isRequired) throw new BadRequestException('طريقة الدفع ناقصة لحل الحساب');
        return null;
      }
      const method = await this.prisma.payMethod.findUnique({
        where: { id: ctx.methodId },
        select: { cashAccountId: true },
      });
      cashAccountId = method?.cashAccountId || null;
    }

    if (!cashAccountId) {
      if (line.accountId) return line.accountId;
      if (line.isRequired) throw new BadRequestException('تعذر ربط حساب الخزنة بالدليل المحاسبي');
      return null;
    }

    const gl = await this.prisma.account.findFirst({
      where: { cashAccountId, isActive: true, isPostable: true },
    });
    if (gl) return gl.id;
    if (line.accountId) return line.accountId;
    if (line.isRequired) throw new BadRequestException('حساب الخزنة مش مربوط بدليل الحسابات');
    return null;
  }

  private partyForRole(role: AccountingRole, ctx: ResolveCtx) {
    if (
      role === AccountingRole.ACCOUNTS_RECEIVABLE
      || role === AccountingRole.SALES_RETURN_CLEARING
    ) {
      return {
        partyType: ctx.customerId ? AccountingPartyType.CUSTOMER : AccountingPartyType.NONE,
        customerId: ctx.customerId || null,
        supplierId: null as string | null,
      };
    }
    if (
      role === AccountingRole.ACCOUNTS_PAYABLE
      || role === AccountingRole.PURCHASE_RETURN_CLEARING
    ) {
      return {
        partyType: ctx.supplierId ? AccountingPartyType.SUPPLIER : AccountingPartyType.NONE,
        customerId: null as string | null,
        supplierId: ctx.supplierId || null,
      };
    }
    return {
      partyType: AccountingPartyType.NONE,
      customerId: null as string | null,
      supplierId: null as string | null,
    };
  }

  private async buildLinesFromMapping(event: AccountingEvent, ctx: ResolveCtx): Promise<JournalLineInput[]> {
    const mapping = await this.mapping.getMapping(event);
    if (!mapping.isActive) throw new BadRequestException('الربط المحاسبي غير مفعّل');

    const lines: JournalLineInput[] = [];
    let order = 0;
    for (const mapLine of mapping.lines) {
      let amount = this.amountFromSource(mapLine.amountSource, ctx.amounts, mapLine.amountParam);
      // COGS_DELTA: signed — positive means debit COGS / credit Inventory; negative flips
      let side = mapLine.side;
      if (mapLine.amountSource === MappingAmountSource.COGS_DELTA && amount < 0) {
        amount = Math.abs(amount);
        side = side === MappingSide.DEBIT ? MappingSide.CREDIT : MappingSide.DEBIT;
      }
      amount = roundMoney(Math.abs(amount));
      if (toCents(amount) === 0) {
        if (mapLine.isRequired) continue;
        continue;
      }

      const accountId = await this.resolveAccountId(mapLine, ctx);
      if (!accountId) continue;

      const party = this.partyForRole(mapLine.role, ctx);
      lines.push({
        accountId,
        debit: side === MappingSide.DEBIT ? amount : 0,
        credit: side === MappingSide.CREDIT ? amount : 0,
        partyType: party.partyType,
        customerId: party.customerId,
        supplierId: party.supplierId,
        description: mapLine.notes || mapLine.role,
        lineOrder: order++,
      });
    }

    // Net-method scrap fold: sales scrap increases cash/AR vs net+tax; purchase scrap reduces AP vs net+tax.
    if (lines.length >= 2) {
      const debit = lines.reduce((s, l) => s + toCents(l.debit || 0), 0);
      const credit = lines.reduce((s, l) => s + toCents(l.credit || 0), 0);
      const scrapCents = toCents(ctx.amounts.scrap || 0);
      if (scrapCents > 0 && debit !== credit) {
        const scrap = fromCents(scrapCents);
        if (event === AccountingEvent.SALE_CONFIRM && debit - credit === scrapCents) {
          const revenue = lines.find((l) => toCents(l.credit || 0) > 0);
          if (revenue) revenue.credit = roundMoney((revenue.credit || 0) + scrap);
        }
        if (event === AccountingEvent.PURCHASE_CONFIRM && credit - debit === scrapCents) {
          const inventory = lines.find((l) => toCents(l.debit || 0) > 0);
          if (inventory) inventory.debit = roundMoney(Math.max(0, (inventory.debit || 0) - scrap));
        }
      }
    }

    return lines;
  }

  private async postIdempotent(input: {
    event: AccountingEvent;
    sourceId: string;
    entryDate: Date | string;
    description: string;
    lines: JournalLineInput[];
    createdById?: string | null;
    queueId?: string;
    workerId?: string;
    claimVersion?: number;
  }) {
    const existing = await this.prisma.journalEntry.findUnique({
      where: {
        sourceType_sourceId: { sourceType: input.event, sourceId: input.sourceId },
      },
      include: { lines: true },
    });
    if (existing) {
      if (input.queueId && input.workerId != null && input.claimVersion != null) {
        try {
          await this.queue.completePosted(input.queueId, input.workerId, input.claimVersion, existing.id);
        } catch {
          /* already completed */
        }
      }
      return existing;
    }

    if (input.lines.length < 2) {
      throw new BadRequestException('تعذر بناء قيد متوازن من الربط المحاسبي');
    }

    const entry = await this.journal.createPostedDirect({
      entryDate: input.entryDate,
      description: input.description,
      lines: input.lines,
      createdById: input.createdById,
      sourceType: input.event,
      sourceId: input.sourceId,
    });

    if (input.queueId && input.workerId != null && input.claimVersion != null) {
      await this.queue.completePosted(input.queueId, input.workerId, input.claimVersion, entry.id);
    }
    return entry;
  }

  async postSaleConfirm(invoiceId: string, opts?: { queueId?: string; workerId?: string; claimVersion?: number }) {
    const invoice = await this.prisma.salesInvoice.findUnique({
      where: { id: invoiceId },
      include: { lines: true },
    });
    if (!invoice) throw new NotFoundException('فاتورة البيع غير موجودة');
    if (
      invoice.status === InvoiceStatus.DRAFT
      || invoice.status === InvoiceStatus.CANCELLED
    ) {
      throw new BadRequestException('ترحيل فواتير البيع المؤكدة فقط');
    }
    const cogsSum = roundMoney(
      invoice.lines.reduce((sum, line) => sum + Number(line.unitCost || 0) * Number(line.quantity || 0), 0),
    );
    const lines = await this.buildLinesFromMapping(AccountingEvent.SALE_CONFIRM, {
      customerId: invoice.customerId,
      amounts: {
        total: invoice.total,
        subtotal: invoice.subtotal,
        discount: invoice.discount,
        tax: invoice.tax,
        scrap: invoice.scrapAmount,
        net: this.documentNet(invoice.subtotal, invoice.discount),
        cogsSum,
      },
    });
    return this.postIdempotent({
      event: AccountingEvent.SALE_CONFIRM,
      sourceId: invoiceId,
      entryDate: invoice.invoiceDate,
      description: `تأكيد بيع ${invoice.number}`,
      lines,
      createdById: invoice.createdById,
      ...opts,
    });
  }

  async postSaleReceipt(receiptId: string, opts?: { queueId?: string; workerId?: string; claimVersion?: number }) {
    const receipt = await this.prisma.receipt.findUnique({ where: { id: receiptId } });
    if (!receipt) throw new NotFoundException('سند القبض غير موجود');
    const lines = await this.buildLinesFromMapping(AccountingEvent.SALE_RECEIPT, {
      customerId: receipt.customerId,
      cashAccountId: receipt.cashAccountId,
      amounts: {
        total: receipt.amount,
        tenderAmount: receipt.amount,
      },
    });
    return this.postIdempotent({
      event: AccountingEvent.SALE_RECEIPT,
      sourceId: receiptId,
      entryDate: receipt.receivedAt,
      description: `تحصيل ${receipt.number}`,
      lines,
      ...opts,
    });
  }

  async postPurchaseConfirm(invoiceId: string, opts?: { queueId?: string; workerId?: string; claimVersion?: number }) {
    const invoice = await this.prisma.purchaseInvoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException('فاتورة الشراء غير موجودة');
    if (
      invoice.status === InvoiceStatus.DRAFT
      || invoice.status === InvoiceStatus.CANCELLED
    ) {
      throw new BadRequestException('ترحيل فواتير الشراء المؤكدة فقط');
    }
    const lines = await this.buildLinesFromMapping(AccountingEvent.PURCHASE_CONFIRM, {
      supplierId: invoice.supplierId,
      amounts: {
        total: invoice.total,
        subtotal: invoice.subtotal,
        discount: invoice.discount,
        tax: invoice.tax,
        scrap: invoice.scrapAmount,
        net: this.documentNet(invoice.subtotal, invoice.discount),
      },
    });
    return this.postIdempotent({
      event: AccountingEvent.PURCHASE_CONFIRM,
      sourceId: invoiceId,
      entryDate: invoice.invoiceDate,
      description: `تأكيد شراء ${invoice.number}`,
      lines,
      createdById: invoice.createdById,
      ...opts,
    });
  }

  async postPurchasePayment(paymentId: string, opts?: { queueId?: string; workerId?: string; claimVersion?: number }) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('سند السداد غير موجود');
    const lines = await this.buildLinesFromMapping(AccountingEvent.PURCHASE_PAYMENT, {
      supplierId: payment.supplierId,
      cashAccountId: payment.cashAccountId,
      amounts: {
        total: payment.amount,
        tenderAmount: payment.amount,
      },
    });
    return this.postIdempotent({
      event: AccountingEvent.PURCHASE_PAYMENT,
      sourceId: paymentId,
      entryDate: payment.paidAt,
      description: `سداد ${payment.number}`,
      lines,
      ...opts,
    });
  }

  async postExpense(expenseId: string, opts?: { queueId?: string; workerId?: string; claimVersion?: number }) {
    const expense = await this.prisma.expense.findUnique({
      where: { id: expenseId },
      include: { category: true },
    });
    if (!expense) throw new NotFoundException('المصروف غير موجود');
    const lines = await this.buildLinesFromMapping(AccountingEvent.EXPENSE_CREATE, {
      cashAccountId: expense.accountId,
      amounts: {
        total: expense.amount,
        tenderAmount: expense.amount,
      },
    });
    return this.postIdempotent({
      event: AccountingEvent.EXPENSE_CREATE,
      sourceId: expenseId,
      entryDate: expense.expenseDate,
      description: `مصروف ${expense.category.name}`,
      lines,
      ...opts,
    });
  }

  async enqueueCogsAdjust(invoiceId: string) {
    const invoice = await this.prisma.salesInvoice.findUnique({
      where: { id: invoiceId },
      include: { lines: true },
    });
    if (!invoice) throw new NotFoundException('فاتورة البيع غير موجودة');
    const targetCents = toCents(
      invoice.lines.reduce((sum, line) => sum + Number(line.unitCost || 0) * Number(line.quantity || 0), 0),
    );

    // baseline = صافي COGS المرحّل فعليًا (POSTED+REVERSED)
    const posted = await this.prisma.journalEntry.findMany({
      where: {
        OR: [
          { sourceType: AccountingEvent.SALE_CONFIRM, sourceId: invoiceId },
          { sourceType: AccountingEvent.SALE_COGS_ADJUST, sourceId: { startsWith: `${invoiceId}#` } },
        ],
        status: { in: ['POSTED', 'REVERSED'] },
      },
      include: { lines: { include: { account: true } } },
    });
    let baselineCents = 0;
    try {
      const map = await this.mapping.getMapping(AccountingEvent.SALE_COGS_ADJUST);
      const cogsIds = new Set(
        map.lines.filter((l) => l.role === AccountingRole.COGS && l.accountId).map((l) => l.accountId!),
      );
      for (const entry of posted) {
        for (const line of entry.lines) {
          if (cogsIds.size ? cogsIds.has(line.accountId) : line.account.code === '5100') {
            baselineCents += toCents(line.debit) - toCents(line.credit);
          }
        }
      }
    } catch {
      for (const entry of posted) {
        for (const line of entry.lines) {
          if (line.account.code === '5100') {
            baselineCents += toCents(line.debit) - toCents(line.credit);
          }
        }
      }
    }

    if (baselineCents === targetCents) {
      await this.prisma.accountingCogsDirty.deleteMany({
        where: { invoiceId, generation: invoice.cogsEpoch },
      });
      return null;
    }

    const sourceId = `COGSADJ:${invoiceId}:${baselineCents}->${targetCents}`;
    // ألغِ نوايا معلّقة قديمة لنفس الفاتورة
    const stale = await this.prisma.accountingPostQueue.findMany({
      where: {
        event: AccountingEvent.SALE_COGS_ADJUST,
        sourceId: { startsWith: `COGSADJ:${invoiceId}:` },
        status: { in: ['PENDING', 'FAILED'] },
      },
    });
    for (const row of stale) {
      if (row.sourceId !== sourceId) {
        await this.queue.cancel(row.id, 'superseded by newer COGS target');
      }
    }

    return this.queue.enqueue(AccountingEvent.SALE_COGS_ADJUST, sourceId, {
      invoiceId,
      generation: invoice.cogsEpoch,
      baselineCents,
      targetCents,
    });
  }

  async postCogsAdjust(invoiceId: string, opts?: { queueId?: string; workerId?: string; claimVersion?: number }) {
    const invoice = await this.prisma.salesInvoice.findUnique({
      where: { id: invoiceId },
      include: { lines: true },
    });
    if (!invoice) throw new NotFoundException('فاتورة البيع غير موجودة');

    const target = roundMoney(
      invoice.lines.reduce((sum, line) => sum + Number(line.unitCost || 0) * Number(line.quantity || 0), 0),
    );
    const posted = await this.prisma.journalEntry.findMany({
      where: {
        OR: [
          { sourceType: AccountingEvent.SALE_CONFIRM, sourceId: invoiceId },
          { sourceType: AccountingEvent.SALE_COGS_ADJUST, sourceId: { startsWith: `${invoiceId}#` } },
        ],
        status: { in: ['POSTED', 'REVERSED'] },
      },
      include: {
        lines: { include: { account: true } },
      },
    });

    let cogsPostedCents = 0;
    for (const entry of posted) {
      for (const line of entry.lines) {
        if (line.account.code === '5100' || line.account.type === 'EXPENSE') {
          // Prefer role via account code when seeded; accumulate net COGS movement
          cogsPostedCents += toCents(line.debit) - toCents(line.credit);
        }
      }
    }
    // Narrow to COGS account from mapping when possible
    try {
      const map = await this.mapping.getMapping(AccountingEvent.SALE_COGS_ADJUST);
      const cogsAccountIds = new Set(
        map.lines.filter((l) => l.role === AccountingRole.COGS && l.accountId).map((l) => l.accountId!),
      );
      if (cogsAccountIds.size) {
        cogsPostedCents = 0;
        for (const entry of posted) {
          for (const line of entry.lines) {
            if (cogsAccountIds.has(line.accountId)) {
              cogsPostedCents += toCents(line.debit) - toCents(line.credit);
            }
          }
        }
      }
    } catch {
      /* mapping missing — keep heuristic */
    }

    const delta = fromCents(toCents(target) - cogsPostedCents);
    if (toCents(delta) === 0) {
      if (opts?.queueId && opts.workerId != null && opts.claimVersion != null) {
        const existing = await this.prisma.journalEntry.findFirst({
          where: { sourceType: AccountingEvent.SALE_COGS_ADJUST, sourceId: { startsWith: `${invoiceId}#` } },
          orderBy: { createdAt: 'desc' },
        });
        if (existing) {
          await this.queue.completePosted(opts.queueId, opts.workerId, opts.claimVersion, existing.id);
          return existing;
        }
      }
      return null;
    }

    const sourceId = `${invoiceId}#e${invoice.cogsEpoch}`;
    const lines = await this.buildLinesFromMapping(AccountingEvent.SALE_COGS_ADJUST, {
      customerId: invoice.customerId,
      amounts: { cogsDelta: delta },
    });
    return this.postIdempotent({
      event: AccountingEvent.SALE_COGS_ADJUST,
      sourceId,
      entryDate: new Date(),
      description: `تعديل تكلفة بيع ${invoice.number} (epoch ${invoice.cogsEpoch})`,
      lines,
      ...opts,
    });
  }

  async postSaleReturn(returnId: string, opts?: { queueId?: string; workerId?: string; claimVersion?: number }) {
    const row = await this.prisma.salesReturn.findUnique({
      where: { id: returnId },
      include: { lines: true, salesInvoice: true },
    });
    if (!row) throw new NotFoundException('مرتجع البيع غير موجود');

    const cogsSum = roundMoney(
      row.lines.reduce((sum, line) => sum + Number(line.unitCost || 0) * Number(line.quantity || 0), 0),
    );
    // قيمة المرتجع المالية: إن وُجدت فاتورة أصلية نستخدم نسبة من بنودها؛ وإلا الاستهلاك المسجّل
    let total = roundMoney(Number(row.total || 0));
    let net = total;
    let tax = 0;
    if (row.salesInvoiceId && row.salesInvoice && row.lines.length) {
      const inv = row.salesInvoice;
      const invCogs = 0; // قيمة البيع من الفاتورة بنسبة الكمية إن أمكن — نستخدم total الفاتورة كسقف
      const ratio = inv.total > 0.009 ? Math.min(1, total > 0 ? total / inv.total : cogsSum / Math.max(inv.total, 1)) : 0;
      if (total <= 0.009 && cogsSum > 0.009) {
        // مرتجع مخزني بدون قيمة بيع صريحة: قيّد المخزون/COGS فقط
        total = 0;
        net = 0;
        tax = 0;
      } else if (total > 0.009) {
        net = this.documentNet(roundMoney(inv.subtotal * (total / Math.max(inv.total, 0.01))), roundMoney(inv.discount * (total / Math.max(inv.total, 0.01))));
        tax = roundMoney(inv.tax * (total / Math.max(inv.total, 0.01)));
        void invCogs;
        void ratio;
      }
    }

    const lines = await this.buildLinesFromMapping(AccountingEvent.SALE_RETURN, {
      customerId: row.customerId,
      amounts: {
        total,
        net,
        tax,
        cogsSum,
      },
    });
    if (lines.length < 2) {
      // لا شيء للترحيل (مرتجع بلا قيمة ولا تكلفة)
      return null;
    }
    return this.postIdempotent({
      event: AccountingEvent.SALE_RETURN,
      sourceId: returnId,
      entryDate: row.returnDate,
      description: `مرتجع بيع ${row.number}`,
      lines,
      ...opts,
    });
  }

  async postPurchaseReturn(returnId: string, opts?: { queueId?: string; workerId?: string; claimVersion?: number }) {
    const row = await this.prisma.purchaseReturn.findUnique({
      where: { id: returnId },
      include: { lines: true, purchaseInvoice: true },
    });
    if (!row) throw new NotFoundException('مرتجع الشراء غير موجود');
    const net = roundMoney(Number(row.total || 0));
    let tax = 0;
    if (row.purchaseInvoice && row.purchaseInvoice.tax > 0.009 && row.purchaseInvoice.total > 0.009) {
      tax = roundMoney(row.purchaseInvoice.tax * (net / row.purchaseInvoice.total));
    }
    const total = roundMoney(net + tax);
    const lines = await this.buildLinesFromMapping(AccountingEvent.PURCHASE_RETURN, {
      supplierId: row.supplierId,
      amounts: {
        total,
        net,
        tax,
        subtotal: net,
        discount: 0,
      },
    });
    return this.postIdempotent({
      event: AccountingEvent.PURCHASE_RETURN,
      sourceId: returnId,
      entryDate: row.returnDate,
      description: `مرتجع شراء ${row.number}`,
      lines,
      ...opts,
    });
  }

  async postPayrollAccrual(payrollRunId: string, opts?: { queueId?: string; workerId?: string; claimVersion?: number }) {
    const run = await this.prisma.payrollRun.findUnique({
      where: { id: payrollRunId },
      include: { lines: true },
    });
    if (!run) throw new NotFoundException('كشف المرتبات غير موجود');
    if (run.status === 'DRAFT') {
      throw new BadRequestException('ترحيل استحقاق المرتبات للكشوف المعتمدة فقط');
    }
    const salaryAmount = roundMoney(run.lines.reduce((s, l) => s + Number(l.salaryNet || 0), 0));
    const commissionAmount = roundMoney(run.lines.reduce((s, l) => s + Number(l.commissionDue || 0), 0));
    const total = roundMoney(salaryAmount + commissionAmount);
    if (toCents(total) <= 0) throw new BadRequestException('صافي كشف المرتبات صفر');

    const lines = await this.buildLinesFromMapping(AccountingEvent.PAYROLL_POST, {
      amounts: {
        salaryAmount,
        commissionAmount,
        total,
      },
    });
    return this.postIdempotent({
      event: AccountingEvent.PAYROLL_POST,
      sourceId: payrollRunId,
      entryDate: run.toDate,
      description: `استحقاق مرتبات ${run.id.slice(0, 8)}`,
      lines,
      ...opts,
    });
  }

  async postPayrollPayment(
    payrollRunId: string,
    opts?: {
      queueId?: string;
      workerId?: string;
      claimVersion?: number;
      amount?: number;
      cashAccountId?: string | null;
      methodId?: string | null;
      entryDate?: Date | string;
    },
  ) {
    const existing = await this.prisma.journalEntry.findUnique({
      where: {
        sourceType_sourceId: {
          sourceType: AccountingEvent.PAYROLL_PAYMENT,
          sourceId: payrollRunId,
        },
      },
      include: { lines: true },
    });
    if (existing) {
      if (opts?.queueId && opts.workerId != null && opts.claimVersion != null) {
        try {
          await this.queue.completePosted(opts.queueId, opts.workerId, opts.claimVersion, existing.id);
        } catch {
          /* already completed */
        }
      }
      return existing;
    }

    const run = await this.prisma.payrollRun.findUnique({
      where: { id: payrollRunId },
      include: { lines: true },
    });
    if (!run) throw new NotFoundException('كشف المرتبات غير موجود');
    if (run.status === 'DRAFT') {
      throw new BadRequestException('صرف المرتبات للكشوف المعتمدة فقط');
    }

    const gross = roundMoney(run.lines.reduce((s, l) => s + Number(l.net || 0), 0));
    // Full payment only: JE amount is always the run net (paidAmount may already be set by ops)
    const payAmount = roundMoney(opts?.amount != null ? opts.amount : (run.paidAmount > 0 ? run.paidAmount : gross));
    if (toCents(payAmount) <= 0) throw new BadRequestException('مبلغ الصرف صفر');
    if (toCents(payAmount) !== toCents(gross)) {
      throw new BadRequestException('الدفع الجزئي غير مدعوم — اصرف كامل مستحق الكشف');
    }

    const cashAccountId = opts?.cashAccountId || run.accountId;
    const lines = await this.buildLinesFromMapping(AccountingEvent.PAYROLL_PAYMENT, {
      cashAccountId,
      methodId: opts?.methodId || run.methodId,
      amounts: { tenderAmount: payAmount, total: payAmount },
    });
    return this.postIdempotent({
      event: AccountingEvent.PAYROLL_PAYMENT,
      sourceId: payrollRunId,
      entryDate: opts?.entryDate || run.paidAt || new Date(),
      description: `صرف مرتبات ${payrollRunId.slice(0, 8)}`,
      lines,
      ...opts,
    });
  }

  async processQueueItem(
    item: {
      id: string;
      event: AccountingEvent;
      sourceId: string;
      claimVersion: number;
      lockedBy: string | null;
    },
  ) {
    const workerId = item.lockedBy || 'worker';
    const opts = { queueId: item.id, workerId, claimVersion: item.claimVersion };
    try {
      switch (item.event) {
        case AccountingEvent.SALE_CONFIRM:
          return await this.postSaleConfirm(item.sourceId, opts);
        case AccountingEvent.SALE_RECEIPT:
          return await this.postSaleReceipt(item.sourceId, opts);
        case AccountingEvent.PURCHASE_CONFIRM:
          return await this.postPurchaseConfirm(item.sourceId, opts);
        case AccountingEvent.PURCHASE_PAYMENT:
          return await this.postPurchasePayment(item.sourceId, opts);
        case AccountingEvent.EXPENSE_CREATE:
          return await this.postExpense(item.sourceId, opts);
        case AccountingEvent.SALE_RETURN:
          return await this.postSaleReturn(item.sourceId, opts);
        case AccountingEvent.PURCHASE_RETURN:
          return await this.postPurchaseReturn(item.sourceId, opts);
        case AccountingEvent.PAYROLL_POST:
          return await this.postPayrollAccrual(item.sourceId, opts);
        case AccountingEvent.PAYROLL_PAYMENT:
          return await this.postPayrollPayment(item.sourceId, opts);
        case AccountingEvent.SALE_COGS_ADJUST: {
          let invoiceId = item.sourceId;
          if (item.sourceId.startsWith('COGSADJ:')) {
            invoiceId = item.sourceId.split(':')[1] || item.sourceId;
          } else if (item.sourceId.includes('#')) {
            invoiceId = item.sourceId.split('#')[0];
          }
          return await this.postCogsAdjust(invoiceId, opts);
        }
        default:
          throw new BadRequestException(`حدث الترحيل ${item.event} غير مدعوم في المعالج`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'فشل الترحيل';
      await this.queue.fail(item.id, workerId, item.claimVersion, message);
      throw err;
    }
  }
}
