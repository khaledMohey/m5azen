import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CashDirection, InvoiceStatus, PayMethodKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequenceService } from '../common/sequence.service';

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
    paymentMethod?: string;
    reference?: string;
    createdById?: string;
  }) {
    if (data.amount <= 0) throw new BadRequestException('المبلغ يجب أن يكون أكبر من صفر');
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.cashAccount.findUnique({ where: { id: data.accountId } });
      if (!account) throw new NotFoundException('حساب الخزنة غير موجود');
      const method = await tx.payMethod.findUnique({ where: { cashAccountId: data.accountId } });
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
          paymentMethod: method?.id || data.paymentMethod || '',
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
    methodId: string;
    amount: number;
    salesInvoiceId?: string;
    referenceNo?: string;
    note?: string;
  }) {
    if (data.amount <= 0) throw new BadRequestException('المبلغ يجب أن يكون أكبر من صفر');
    const method = await this.prisma.payMethod.findUnique({ where: { id: data.methodId } });
    if (!method || !method.isActive) throw new BadRequestException('طريقة الدفع غير موجودة');
    const methodLabel = method.name;
    const isCheck = method.kind === PayMethodKind.CHECK;

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
      if (!isCheck && method.cashAccountId) {
        await tx.cashAccount.update({
          where: { id: method.cashAccountId },
          data: { balance: { increment: data.amount } },
        });
      }

      const created = [];
      let idx = 0;
      for (const slice of slices) {
        const number = numbers[idx++];
        await tx.salesInvoice.update({
          where: { id: slice.invoiceId },
          data: {
            paidAmount: slice.nextPaid,
            status: slice.nextStatus,
          },
        });
        const desc = `تحصيل من ${customer.name} — ${slice.invoiceNumber} (${methodLabel})`;
        if (!isCheck && method.cashAccountId) {
          await tx.cashTransaction.create({
            data: {
              accountId: method.cashAccountId,
              direction: CashDirection.IN,
              amount: slice.amount,
              description: data.note || desc,
              paymentMethod: method.id,
              reference: number,
            },
          });
        }
        const receipt = await tx.receipt.create({
          data: {
            number,
            customerId: data.customerId,
            cashAccountId: isCheck ? null : method.cashAccountId,
            salesInvoiceId: slice.invoiceId,
            amount: slice.amount,
            paymentMethod: method.id,
            referenceNo: data.referenceNo,
            note: data.note || (isCheck ? `${desc} — معلّق حتى التحصيل` : desc),
          },
          include: { customer: true, cashAccount: true, salesInvoice: true },
        });
        if (isCheck) {
          await tx.bankCheck.create({
            data: {
              direction: 'IN',
              checkNumber: data.referenceNo || number,
              bankName: 'شيك',
              amount: slice.amount,
              dueDate: new Date(),
              customerId: data.customerId,
              salesInvoiceId: slice.invoiceId,
              methodId: method.id,
              receiptId: receipt.id,
              notes: desc,
            },
          });
        }
        created.push(receipt);
      }

      if (left > 0.001 || created.length === 0) {
        const number = numbers[idx] || numbers[0];
        const desc = data.note || `تحصيل من ${customer.name} (${methodLabel})`;
        const unapplied = created.length === 0 ? data.amount : left;
        if (!isCheck && method.cashAccountId) {
          await tx.cashTransaction.create({
            data: {
              accountId: method.cashAccountId,
              direction: CashDirection.IN,
              amount: unapplied,
              description: desc,
              paymentMethod: method.id,
              reference: number,
            },
          });
        }
        const receipt = await tx.receipt.create({
          data: {
            number,
            customerId: data.customerId,
            cashAccountId: isCheck ? null : method.cashAccountId,
            amount: unapplied,
            paymentMethod: method.id,
            referenceNo: data.referenceNo,
            note: data.note || (isCheck ? `${desc} — معلّق حتى التحصيل` : desc),
          },
          include: { customer: true, cashAccount: true, salesInvoice: true },
        });
        if (isCheck) {
          await tx.bankCheck.create({
            data: {
              direction: 'IN',
              checkNumber: data.referenceNo || number,
              bankName: 'شيك',
              amount: unapplied,
              dueDate: new Date(),
              customerId: data.customerId,
              methodId: method.id,
              receiptId: receipt.id,
              notes: desc,
            },
          });
        }
        created.push(receipt);
      }

      return created[0];
    });
  }

  async createPayment(data: {
    supplierId: string;
    methodId: string;
    amount: number;
    purchaseInvoiceId?: string;
    referenceNo?: string;
    note?: string;
  }) {
    if (data.amount <= 0) throw new BadRequestException('المبلغ يجب أن يكون أكبر من صفر');
    const method = await this.prisma.payMethod.findUnique({ where: { id: data.methodId } });
    if (!method || !method.isActive) throw new BadRequestException('طريقة الدفع غير موجودة');
    const number = await this.sequence.next('payments', 'PAY');
    const methodLabel = method.name;
    const isCheck = method.kind === PayMethodKind.CHECK;

    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUnique({ where: { id: data.supplierId } });
      if (!supplier) throw new NotFoundException('المورد غير موجود');
      if (!isCheck && method.cashAccountId) {
        const account = await tx.cashAccount.findUnique({ where: { id: method.cashAccountId } });
        if (!account || account.balance < data.amount) {
          throw new BadRequestException('رصيد الحساب غير كافٍ');
        }
        await tx.cashAccount.update({
          where: { id: method.cashAccountId },
          data: { balance: { decrement: data.amount } },
        });
      }

      await tx.supplier.update({
        where: { id: data.supplierId },
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
            data: { paidAmount, status },
          });
        }
      }

      const desc =
        data.note ||
        `سداد لـ ${supplier.name}${invRef ? ` — ${invRef}` : ''} (${methodLabel})`;

      if (!isCheck && method.cashAccountId) {
        await tx.cashTransaction.create({
          data: {
            accountId: method.cashAccountId,
            direction: CashDirection.OUT,
            amount: data.amount,
            description: desc,
            paymentMethod: method.id,
            reference: number,
          },
        });
      }

      const payment = await tx.payment.create({
        data: {
          number,
          supplierId: data.supplierId,
          cashAccountId: isCheck ? null : method.cashAccountId,
          purchaseInvoiceId: data.purchaseInvoiceId,
          amount: data.amount,
          paymentMethod: method.id,
          referenceNo: data.referenceNo,
          note: data.note || (isCheck ? `${desc} — معلّق حتى الصرف` : desc),
        },
        include: { supplier: true, cashAccount: true, purchaseInvoice: true },
      });
      if (isCheck) {
        await tx.bankCheck.create({
          data: {
            direction: 'OUT',
            checkNumber: data.referenceNo || number,
            bankName: 'شيك',
            amount: data.amount,
            dueDate: new Date(),
            supplierId: data.supplierId,
            purchaseInvoiceId: data.purchaseInvoiceId,
            methodId: method.id,
            paymentId: payment.id,
            notes: desc,
          },
        });
      }
      return payment;
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
