import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CashDirection, InvoiceStatus, PaymentMethod } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequenceService } from '../common/sequence.service';

const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'نقدي',
  BANK_TRANSFER: 'تحويل بنكي',
  CHECK: 'شيك',
  CARD: 'بطاقة',
  INSTAPAY: 'إنستاباي',
  OTHER: 'أخرى',
};

@Injectable()
export class CashService {
  constructor(
    private prisma: PrismaService,
    private sequence: SequenceService,
  ) {}

  accounts() {
    return this.prisma.cashAccount.findMany({ orderBy: [{ accountType: 'asc' }, { name: 'asc' }] });
  }

  createAccount(data: { code: string; name: string; balance?: number; accountType?: string }) {
    return this.prisma.cashAccount.create({
      data: {
        code: data.code,
        name: data.name,
        balance: data.balance ?? 0,
        accountType: data.accountType || 'CASH',
      },
    });
  }

  updateAccount(
    id: string,
    data: Partial<{ code: string; name: string; isActive: boolean; accountType: string }>,
  ) {
    return this.prisma.cashAccount.update({ where: { id }, data });
  }

  transactions(accountId?: string) {
    return this.prisma.cashTransaction.findMany({
      where: accountId ? { accountId } : undefined,
      include: { account: true, createdBy: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async createTransaction(data: {
    accountId: string;
    direction: CashDirection;
    amount: number;
    description: string;
    paymentMethod?: PaymentMethod;
    reference?: string;
    createdById?: string;
  }) {
    if (data.amount <= 0) throw new BadRequestException('المبلغ يجب أن يكون أكبر من صفر');
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.cashAccount.findUnique({ where: { id: data.accountId } });
      if (!account) throw new NotFoundException('حساب الخزنة غير موجود');
      const delta = data.direction === CashDirection.IN ? data.amount : -data.amount;
      if (account.balance + delta < 0) {
        throw new BadRequestException('رصيد الخزنة غير كافٍ');
      }
      await tx.cashAccount.update({
        where: { id: data.accountId },
        data: { balance: { increment: delta } },
      });
      return tx.cashTransaction.create({
        data: {
          accountId: data.accountId,
          direction: data.direction,
          amount: data.amount,
          description: data.description,
          paymentMethod: data.paymentMethod || PaymentMethod.CASH,
          reference: data.reference,
          createdById: data.createdById,
        },
        include: { account: true },
      });
    });
  }

  async supplierSummary(supplierId: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw new NotFoundException('المورد غير موجود');
    const openInvoices = await this.prisma.purchaseInvoice.findMany({
      where: {
        supplierId,
        status: { in: [InvoiceStatus.CONFIRMED, InvoiceStatus.PARTIAL] },
      },
      orderBy: { invoiceDate: 'asc' },
      select: {
        id: true,
        number: true,
        total: true,
        paidAmount: true,
        invoiceDate: true,
        status: true,
      },
    });
    return {
      supplier,
      balance: supplier.balance,
      openInvoices: openInvoices.map((i) => ({
        ...i,
        remaining: Math.max(0, i.total - i.paidAmount),
      })),
    };
  }

  async customerSummary(customerId: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new NotFoundException('العميل غير موجود');
    const openInvoices = await this.prisma.salesInvoice.findMany({
      where: {
        customerId,
        status: { in: [InvoiceStatus.CONFIRMED, InvoiceStatus.PARTIAL] },
      },
      orderBy: { invoiceDate: 'asc' },
      select: {
        id: true,
        number: true,
        total: true,
        paidAmount: true,
        invoiceDate: true,
        status: true,
      },
    });
    return {
      customer,
      balance: customer.balance,
      openInvoices: openInvoices.map((i) => ({
        ...i,
        remaining: Math.max(0, i.total - i.paidAmount),
      })),
    };
  }

  async createReceipt(data: {
    customerId: string;
    cashAccountId: string;
    amount: number;
    salesInvoiceId?: string;
    paymentMethod?: PaymentMethod;
    referenceNo?: string;
    note?: string;
  }) {
    if (data.amount <= 0) throw new BadRequestException('المبلغ يجب أن يكون أكبر من صفر');
    const method = data.paymentMethod || PaymentMethod.CASH;
    const methodLabel = METHOD_LABELS[method];

    const openInvoices = await this.prisma.salesInvoice.findMany({
      where: {
        customerId: data.customerId,
        status: { in: [InvoiceStatus.CONFIRMED, InvoiceStatus.PARTIAL, InvoiceStatus.PAID] },
        ...(data.salesInvoiceId ? { id: data.salesInvoiceId } : {}),
      },
      orderBy: { invoiceDate: 'asc' },
    });

    type Slice = { invoiceId: string; invoiceNumber: string; amount: number; nextPaid: number; nextStatus: InvoiceStatus };
    const slices: Slice[] = [];
    let left = data.amount;
    for (const inv of openInvoices) {
      if (left <= 0) break;
      const due = Math.max(0, inv.total - inv.paidAmount);
      if (due <= 0) continue;
      const pay = Math.min(due, left);
      const nextPaid = inv.paidAmount + pay;
      slices.push({
        invoiceId: inv.id,
        invoiceNumber: inv.number,
        amount: pay,
        nextPaid,
        nextStatus: nextPaid >= inv.total - 0.001 ? InvoiceStatus.PAID : InvoiceStatus.PARTIAL,
      });
      left -= pay;
      if (data.salesInvoiceId) break;
    }

    const receiptCount = slices.length + (left > 0.001 ? 1 : 0);
    const numbers: string[] = [];
    for (let i = 0; i < Math.max(1, receiptCount); i++) {
      numbers.push(await this.sequence.next('receipts', 'RCP'));
    }

    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: data.customerId } });
      if (!customer) throw new NotFoundException('العميل غير موجود');

      await tx.customer.update({
        where: { id: data.customerId },
        data: { balance: { decrement: data.amount } },
      });
      await tx.cashAccount.update({
        where: { id: data.cashAccountId },
        data: { balance: { increment: data.amount } },
      });

      const created = [];
      let idx = 0;
      for (const slice of slices) {
        const number = numbers[idx++];
        await tx.salesInvoice.update({
          where: { id: slice.invoiceId },
          data: {
            paidAmount: slice.nextPaid,
            status: slice.nextStatus,
            paymentMethod: method,
          },
        });
        const desc = `تحصيل من ${customer.name} — ${slice.invoiceNumber} (${methodLabel})`;
        await tx.cashTransaction.create({
          data: {
            accountId: data.cashAccountId,
            direction: CashDirection.IN,
            amount: slice.amount,
            description: data.note || desc,
            paymentMethod: method,
            reference: number,
          },
        });
        created.push(await tx.receipt.create({
          data: {
            number,
            customerId: data.customerId,
            cashAccountId: data.cashAccountId,
            salesInvoiceId: slice.invoiceId,
            amount: slice.amount,
            paymentMethod: method,
            referenceNo: data.referenceNo,
            note: data.note || desc,
          },
          include: { customer: true, cashAccount: true, salesInvoice: true },
        }));
      }

      if (left > 0.001 || created.length === 0) {
        const number = numbers[idx] || numbers[0];
        const desc = data.note || `تحصيل من ${customer.name} (${methodLabel})`;
        await tx.cashTransaction.create({
          data: {
            accountId: data.cashAccountId,
            direction: CashDirection.IN,
            amount: created.length === 0 ? data.amount : left,
            description: desc,
            paymentMethod: method,
            reference: number,
          },
        });
        created.push(await tx.receipt.create({
          data: {
            number,
            customerId: data.customerId,
            cashAccountId: data.cashAccountId,
            amount: created.length === 0 ? data.amount : left,
            paymentMethod: method,
            referenceNo: data.referenceNo,
            note: desc,
          },
          include: { customer: true, cashAccount: true, salesInvoice: true },
        }));
      }

      return created[0];
    });
  }

  async createPayment(data: {
    supplierId: string;
    cashAccountId: string;
    amount: number;
    purchaseInvoiceId?: string;
    paymentMethod?: PaymentMethod;
    referenceNo?: string;
    note?: string;
  }) {
    if (data.amount <= 0) throw new BadRequestException('المبلغ يجب أن يكون أكبر من صفر');
    const number = await this.sequence.next('payments', 'PAY');
    const method = data.paymentMethod || PaymentMethod.CASH;
    const methodLabel = METHOD_LABELS[method];

    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUnique({ where: { id: data.supplierId } });
      if (!supplier) throw new NotFoundException('المورد غير موجود');
      const account = await tx.cashAccount.findUnique({ where: { id: data.cashAccountId } });
      if (!account || account.balance < data.amount) {
        throw new BadRequestException('رصيد الخزنة غير كافٍ');
      }

      await tx.supplier.update({
        where: { id: data.supplierId },
        data: { balance: { decrement: data.amount } },
      });
      await tx.cashAccount.update({
        where: { id: data.cashAccountId },
        data: { balance: { decrement: data.amount } },
      });

      let invRef = '';
      if (data.purchaseInvoiceId) {
        const inv = await tx.purchaseInvoice.findUnique({ where: { id: data.purchaseInvoiceId } });
        if (inv) {
          invRef = inv.number;
          const paidAmount = inv.paidAmount + data.amount;
          let status: InvoiceStatus = InvoiceStatus.PARTIAL;
          if (paidAmount >= inv.total) status = InvoiceStatus.PAID;
          await tx.purchaseInvoice.update({
            where: { id: inv.id },
            data: { paidAmount, status, paymentMethod: method },
          });
        }
      }

      const desc =
        data.note ||
        `سداد لـ ${supplier.name}${invRef ? ` — ${invRef}` : ''} (${methodLabel})`;

      await tx.cashTransaction.create({
        data: {
          accountId: data.cashAccountId,
          direction: CashDirection.OUT,
          amount: data.amount,
          description: desc,
          paymentMethod: method,
          reference: number,
        },
      });

      return tx.payment.create({
        data: {
          number,
          supplierId: data.supplierId,
          cashAccountId: data.cashAccountId,
          purchaseInvoiceId: data.purchaseInvoiceId,
          amount: data.amount,
          paymentMethod: method,
          referenceNo: data.referenceNo,
          note: data.note || desc,
        },
        include: { supplier: true, cashAccount: true, purchaseInvoice: true },
      });
    });
  }

  receipts() {
    return this.prisma.receipt.findMany({
      include: { customer: true, cashAccount: true, salesInvoice: true },
      orderBy: { receivedAt: 'desc' },
    });
  }

  payments() {
    return this.prisma.payment.findMany({
      include: { supplier: true, cashAccount: true, purchaseInvoice: true },
      orderBy: { paidAt: 'desc' },
    });
  }
}
