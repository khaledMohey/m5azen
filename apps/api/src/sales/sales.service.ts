import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CashDirection, InvoiceStatus, PaymentMethod, StockMovementType } from '@prisma/client';
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
export class SalesService {
  constructor(
    private prisma: PrismaService,
    private sequence: SequenceService,
  ) {}

  findAll(status?: InvoiceStatus) {
    return this.prisma.salesInvoice.findMany({
      where: status ? { status } : undefined,
      include: {
        customer: true,
        warehouse: true,
        lines: { include: { product: true } },
        receipts: { orderBy: { receivedAt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const inv = await this.prisma.salesInvoice.findUnique({
      where: { id },
      include: {
        customer: true,
        warehouse: true,
        lines: { include: { product: true } },
        receipts: { orderBy: { receivedAt: 'asc' } },
        createdBy: { select: { fullName: true } },
      },
    });
    if (!inv) throw new NotFoundException('فاتورة البيع غير موجودة');
    return inv;
  }

  async create(data: {
    customerId: string;
    warehouseId: string;
    invoiceDate?: string;
    discount?: number;
    tax?: number;
    notes?: string;
    paidAmount?: number;
    cashAccountId?: string;
    paymentMethod?: PaymentMethod;
    taxRate?: number;
    shiftId?: string | null;
    confirm?: boolean;
    createdById?: string;
    lines: { productId: string; quantity: number; unitPrice: number; discount?: number }[];
  }) {
    if (!data.lines?.length) throw new BadRequestException('أضف بنوداً للفاتورة');
    if (data.shiftId) await this.assertOpenShift(data.shiftId);
    const number = await this.sequence.next('sales', 'SAL');
    const receiptNumber =
      data.confirm && (data.paidAmount || 0) > 0
        ? await this.sequence.next('receipts', 'RCP')
        : null;
    const method = data.paymentMethod || PaymentMethod.CASH;
    const products = await this.prisma.product.findMany({
      where: { id: { in: data.lines.map((l) => l.productId) } },
    });
    const costOf = (productId: string) => products.find((p) => p.id === productId)?.costPrice || 0;
    const lines = data.lines.map((l) => {
      const total = l.quantity * l.unitPrice - (l.discount || 0);
      return { ...l, discount: l.discount || 0, total, unitCost: costOf(l.productId) };
    });
    const subtotal = lines.reduce((s, l) => s + l.total, 0);
    const discount = data.discount || 0;
    const taxRate = data.taxRate ?? 0;
    const tax = data.taxRate != null
      ? Math.round((subtotal - discount) * taxRate * 100) / 10000
      : (data.tax || 0);
    const total = subtotal - discount + tax;
    const paidAmount = data.paidAmount || 0;
    if (data.confirm) await this.assertCredit(data.customerId, total - paidAmount);

    return this.prisma.$transaction(async (tx) => {
      let status: InvoiceStatus = InvoiceStatus.DRAFT;
      if (data.confirm) {
        status = paidAmount >= total ? InvoiceStatus.PAID : paidAmount > 0 ? InvoiceStatus.PARTIAL : InvoiceStatus.CONFIRMED;
        for (const line of lines) {
          const bal = await tx.stockBalance.findUnique({
            where: {
              warehouseId_productId: {
                warehouseId: data.warehouseId,
                productId: line.productId,
              },
            },
          });
          if (!bal || bal.quantity < line.quantity) {
            throw new BadRequestException('كمية غير كافية في المخزن');
          }
          await tx.stockBalance.update({
            where: { id: bal.id },
            data: { quantity: { decrement: line.quantity } },
          });
          await tx.stockMovement.create({
            data: {
              warehouseId: data.warehouseId,
              productId: line.productId,
              type: StockMovementType.SALE,
              quantity: -line.quantity,
              unitCost: line.unitCost,
              reference: number,
            },
          });
        }
        await tx.customer.update({
          where: { id: data.customerId },
          data: { balance: { increment: total - paidAmount } },
        });
        if (paidAmount > 0) {
          if (!data.cashAccountId) throw new BadRequestException('اختر حساب خزنة للمبلغ المدفوع');
          await tx.cashAccount.update({
            where: { id: data.cashAccountId },
            data: { balance: { increment: paidAmount } },
          });
          await tx.cashTransaction.create({
            data: {
              accountId: data.cashAccountId,
              direction: CashDirection.IN,
              amount: paidAmount,
              description: `تحصيل فاتورة بيع ${number} (${METHOD_LABELS[method]})`,
              paymentMethod: method,
              reference: receiptNumber || number,
              createdById: data.createdById,
            },
          });
        }
      }

      const invoice = await tx.salesInvoice.create({
        data: {
          number,
          customerId: data.customerId,
          warehouseId: data.warehouseId,
          status,
          invoiceDate: data.invoiceDate ? new Date(data.invoiceDate) : new Date(),
          subtotal,
          discount,
          tax,
          taxRate,
          total,
          paidAmount,
          paymentMethod: method,
          shiftId: data.shiftId || null,
          notes: data.notes,
          createdById: data.createdById,
          lines: { create: lines },
        },
        include: { customer: true, warehouse: true, lines: { include: { product: true } } },
      });

      if (data.confirm && paidAmount > 0 && data.cashAccountId && receiptNumber) {
        await tx.receipt.create({
          data: {
            number: receiptNumber,
            customerId: data.customerId,
            cashAccountId: data.cashAccountId,
            salesInvoiceId: invoice.id,
            amount: paidAmount,
            paymentMethod: method,
            shiftId: data.shiftId || null,
            note: `تحصيل فاتورة ${number} (${METHOD_LABELS[method]})`,
          },
        });
      }

      return invoice;
    });
  }

  async confirm(id: string, cashAccountId?: string) {
    const inv = await this.findOne(id);
    if (inv.status !== InvoiceStatus.DRAFT) {
      throw new BadRequestException('الفاتورة ليست مسودة');
    }
    await this.assertCredit(inv.customerId, inv.total - inv.paidAmount);
    const receiptNumber =
      inv.paidAmount > 0 ? await this.sequence.next('receipts', 'RCP') : null;
    return this.prisma.$transaction(async (tx) => {
      for (const line of inv.lines) {
        const bal = await tx.stockBalance.findUnique({
          where: {
            warehouseId_productId: {
              warehouseId: inv.warehouseId,
              productId: line.productId,
            },
          },
        });
        if (!bal || bal.quantity < line.quantity) {
          throw new BadRequestException(`كمية غير كافية للصنف ${line.product.name}`);
        }
        await tx.stockBalance.update({
          where: { id: bal.id },
          data: { quantity: { decrement: line.quantity } },
        });
        await tx.stockMovement.create({
          data: {
            warehouseId: inv.warehouseId,
            productId: line.productId,
            type: StockMovementType.SALE,
            quantity: -line.quantity,
            unitCost: line.unitCost || line.product.costPrice,
            reference: inv.number,
          },
        });
      }
      const remaining = inv.total - inv.paidAmount;
      await tx.customer.update({
        where: { id: inv.customerId },
        data: { balance: { increment: remaining } },
      });
      if (inv.paidAmount > 0) {
        if (!cashAccountId) throw new BadRequestException('اختر حساب خزنة');
        await tx.cashAccount.update({
          where: { id: cashAccountId },
          data: { balance: { increment: inv.paidAmount } },
        });
        await tx.cashTransaction.create({
          data: {
            accountId: cashAccountId,
            direction: CashDirection.IN,
            amount: inv.paidAmount,
            description: `تحصيل فاتورة بيع ${inv.number}`,
            paymentMethod: inv.paymentMethod,
            reference: receiptNumber || inv.number,
          },
        });
        await tx.receipt.create({
          data: {
            number: receiptNumber!,
            customerId: inv.customerId,
            cashAccountId,
            salesInvoiceId: inv.id,
            amount: inv.paidAmount,
            paymentMethod: inv.paymentMethod,
            note: `تحصيل فاتورة ${inv.number}`,
          },
        });
      }
      const status =
        inv.paidAmount >= inv.total
          ? InvoiceStatus.PAID
          : inv.paidAmount > 0
            ? InvoiceStatus.PARTIAL
            : InvoiceStatus.CONFIRMED;
      return tx.salesInvoice.update({
        where: { id },
        data: { status },
        include: { customer: true, warehouse: true, lines: { include: { product: true } } },
      });
    });
  }

  private async assertCredit(customerId: string, extraDue: number) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new NotFoundException('العميل غير موجود');
    if (customer.creditLimit > 0 && customer.balance + extraDue > customer.creditLimit + 0.001) {
      throw new BadRequestException(
        `تجاوز حد الائتمان. الحد ${customer.creditLimit} والرصيد الحالي ${customer.balance}`,
      );
    }
  }

  private async assertOpenShift(shiftId: string) {
    const shift = await this.prisma.cashierShift.findUnique({ where: { id: shiftId } });
    if (!shift || shift.status !== 'OPEN') {
      throw new BadRequestException('الوردية غير مفتوحة');
    }
  }

  async update(id: string, data: {
    customerId: string;
    warehouseId: string;
    invoiceDate?: string;
    discount?: number;
    taxRate?: number;
    notes?: string;
    paidAmount?: number;
    cashAccountId?: string;
    paymentMethod?: PaymentMethod;
    shiftId?: string | null;
    lines: { productId: string; quantity: number; unitPrice: number; discount?: number }[];
  }) {
    const inv = await this.prisma.salesInvoice.findUnique({
      where: { id },
      include: { lines: true, receipts: true, returns: true },
    });
    if (!inv) throw new NotFoundException('فاتورة البيع غير موجودة');
    if (inv.returns.length) throw new BadRequestException('لا يمكن تعديل فاتورة عليها مرتجعات');
    if (!data.lines?.length) throw new BadRequestException('أضف بنوداً للفاتورة');
    if (data.shiftId) await this.assertOpenShift(data.shiftId);

    const products = await this.prisma.product.findMany({
      where: { id: { in: data.lines.map((l) => l.productId) } },
    });
    const costOf = (productId: string) => products.find((p) => p.id === productId)?.costPrice || 0;
    const lines = data.lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      unitCost: costOf(l.productId),
      discount: l.discount || 0,
      total: l.quantity * l.unitPrice - (l.discount || 0),
    }));
    const subtotal = lines.reduce((s, l) => s + l.total, 0);
    const discount = data.discount || 0;
    const taxRate = data.taxRate ?? inv.taxRate ?? 0;
    const tax = Math.round((subtotal - discount) * taxRate * 100) / 10000;
    const total = subtotal - discount + tax;
    const paidAmount = data.paidAmount ?? inv.paidAmount;
    const method = data.paymentMethod || inv.paymentMethod;
    const reconfirm = inv.status !== InvoiceStatus.DRAFT;
    if (reconfirm) await this.assertCredit(data.customerId, total - paidAmount - (inv.total - inv.paidAmount));

    const receiptNumber = reconfirm && paidAmount > 0 ? await this.sequence.next('receipts', 'RCP') : null;

    return this.prisma.$transaction(async (tx) => {
      if (reconfirm) {
        for (const line of inv.lines) {
          await tx.stockBalance.upsert({
            where: { warehouseId_productId: { warehouseId: inv.warehouseId, productId: line.productId } },
            create: { warehouseId: inv.warehouseId, productId: line.productId, quantity: line.quantity },
            update: { quantity: { increment: line.quantity } },
          });
        }
        await tx.stockMovement.deleteMany({
          where: { reference: inv.number, warehouseId: inv.warehouseId, type: StockMovementType.SALE },
        });
        const due = inv.total - inv.paidAmount;
        if (due !== 0) {
          await tx.customer.update({ where: { id: inv.customerId }, data: { balance: { decrement: due } } });
        }
        for (const receipt of inv.receipts) {
          await tx.cashAccount.update({
            where: { id: receipt.cashAccountId },
            data: { balance: { decrement: receipt.amount } },
          });
          await tx.cashTransaction.deleteMany({
            where: { reference: receipt.number, accountId: receipt.cashAccountId },
          });
        }
        await tx.receipt.deleteMany({ where: { salesInvoiceId: id } });
      }

      await tx.salesInvoiceLine.deleteMany({ where: { invoiceId: id } });

      if (reconfirm) {
        for (const line of lines) {
          const bal = await tx.stockBalance.findUnique({
            where: { warehouseId_productId: { warehouseId: data.warehouseId, productId: line.productId } },
          });
          if (!bal || bal.quantity < line.quantity) throw new BadRequestException('كمية غير كافية في المخزن');
          await tx.stockBalance.update({ where: { id: bal.id }, data: { quantity: { decrement: line.quantity } } });
          await tx.stockMovement.create({
            data: {
              warehouseId: data.warehouseId,
              productId: line.productId,
              type: StockMovementType.SALE,
              quantity: -line.quantity,
              unitCost: line.unitCost,
              reference: inv.number,
            },
          });
        }
        await tx.customer.update({
          where: { id: data.customerId },
          data: { balance: { increment: total - paidAmount } },
        });
        if (paidAmount > 0) {
          if (!data.cashAccountId) throw new BadRequestException('اختر حساب خزنة للمبلغ المدفوع');
          await tx.cashAccount.update({
            where: { id: data.cashAccountId },
            data: { balance: { increment: paidAmount } },
          });
          await tx.cashTransaction.create({
            data: {
              accountId: data.cashAccountId,
              direction: CashDirection.IN,
              amount: paidAmount,
              description: `تحصيل فاتورة بيع ${inv.number} (${METHOD_LABELS[method]})`,
              paymentMethod: method,
              reference: receiptNumber || inv.number,
            },
          });
          await tx.receipt.create({
            data: {
              number: receiptNumber!,
              customerId: data.customerId,
              cashAccountId: data.cashAccountId,
              salesInvoiceId: id,
              amount: paidAmount,
              paymentMethod: method,
              shiftId: data.shiftId || null,
              note: `تحصيل فاتورة ${inv.number}`,
            },
          });
        }
      }

      const status = !reconfirm
        ? InvoiceStatus.DRAFT
        : paidAmount >= total
          ? InvoiceStatus.PAID
          : paidAmount > 0
            ? InvoiceStatus.PARTIAL
            : InvoiceStatus.CONFIRMED;

      return tx.salesInvoice.update({
        where: { id },
        data: {
          customerId: data.customerId,
          warehouseId: data.warehouseId,
          invoiceDate: data.invoiceDate ? new Date(data.invoiceDate) : inv.invoiceDate,
          subtotal,
          discount,
          tax,
          taxRate,
          total,
          paidAmount: reconfirm ? paidAmount : (data.paidAmount ?? inv.paidAmount),
          paymentMethod: method,
          shiftId: data.shiftId === undefined ? inv.shiftId : (data.shiftId || null),
          notes: data.notes,
          status,
          lines: { create: lines },
        },
        include: { customer: true, warehouse: true, lines: { include: { product: true } }, receipts: true },
      });
    });
  }

  async remove(id: string) {
    const inv = await this.prisma.salesInvoice.findUnique({
      where: { id },
      include: { lines: true, receipts: true, returns: true },
    });
    if (!inv) throw new NotFoundException('فاتورة البيع غير موجودة');
    if (inv.returns.length) {
      throw new BadRequestException('لا يمكن حذف فاتورة عليها مرتجعات');
    }

    return this.prisma.$transaction(async (tx) => {
      if (inv.status !== InvoiceStatus.DRAFT) {
        for (const line of inv.lines) {
          await tx.stockBalance.upsert({
            where: {
              warehouseId_productId: {
                warehouseId: inv.warehouseId,
                productId: line.productId,
              },
            },
            create: {
              warehouseId: inv.warehouseId,
              productId: line.productId,
              quantity: line.quantity,
            },
            update: { quantity: { increment: line.quantity } },
          });
        }
        await tx.stockMovement.deleteMany({
          where: {
            reference: inv.number,
            warehouseId: inv.warehouseId,
            type: StockMovementType.SALE,
          },
        });
        const due = inv.total - inv.paidAmount;
        if (due !== 0) {
          await tx.customer.update({
            where: { id: inv.customerId },
            data: { balance: { decrement: due } },
          });
        }
        for (const receipt of inv.receipts) {
          await tx.cashAccount.update({
            where: { id: receipt.cashAccountId },
            data: { balance: { decrement: receipt.amount } },
          });
          await tx.cashTransaction.deleteMany({
            where: { reference: receipt.number, accountId: receipt.cashAccountId },
          });
        }
      }
      await tx.receipt.deleteMany({ where: { salesInvoiceId: id } });
      await tx.salesInvoice.delete({ where: { id } });
      return { ok: true };
    });
  }
}
