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
export class PurchasesService {
  constructor(
    private prisma: PrismaService,
    private sequence: SequenceService,
  ) {}

  findAll(status?: InvoiceStatus) {
    return this.prisma.purchaseInvoice.findMany({
      where: status ? { status } : undefined,
      include: {
        supplier: true,
        warehouse: true,
        lines: { include: { product: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const inv = await this.prisma.purchaseInvoice.findUnique({
      where: { id },
      include: {
        supplier: true,
        warehouse: true,
        lines: { include: { product: true } },
        payments: true,
        createdBy: { select: { fullName: true } },
      },
    });
    if (!inv) throw new NotFoundException('فاتورة الشراء غير موجودة');
    return inv;
  }

  async create(data: {
    supplierId: string;
    warehouseId: string;
    invoiceDate?: string;
    discount?: number;
    tax?: number;
    notes?: string;
    paidAmount?: number;
    cashAccountId?: string;
    paymentMethod?: PaymentMethod;
    confirm?: boolean;
    createdById?: string;
    lines: { productId: string; quantity: number; unitCost: number; discount?: number; batchNumber?: string; expiryDate?: string }[];
  }) {
    if (!data.lines?.length) throw new BadRequestException('أضف بنوداً للفاتورة');
    const number = await this.sequence.next('purchases', 'PUR');
    const paymentNumber =
      data.confirm && (data.paidAmount || 0) > 0
        ? await this.sequence.next('payments', 'PAY')
        : null;
    const method = data.paymentMethod || PaymentMethod.CASH;
    const lines = data.lines.map((l) => {
      const total = l.quantity * l.unitCost - (l.discount || 0);
      return {
        productId: l.productId,
        quantity: l.quantity,
        unitCost: l.unitCost,
        discount: l.discount || 0,
        total,
        batchNumber: l.batchNumber?.trim() || null,
        expiryDate: l.expiryDate ? new Date(l.expiryDate) : null,
      };
    });
    const subtotal = lines.reduce((s, l) => s + l.total, 0);
    const discount = data.discount || 0;
    // tax من الواجهة = نسبة مئوية (مثلاً 14 = 14%)
    const taxPercent = data.tax || 0;
    const tax = Math.round((subtotal - discount) * taxPercent * 100) / 10000;
    const total = subtotal - discount + tax;
    const paidAmount = data.paidAmount || 0;

    return this.prisma.$transaction(async (tx) => {
      let status: InvoiceStatus = InvoiceStatus.DRAFT;
      if (data.confirm) {
        status = paidAmount >= total ? InvoiceStatus.PAID : paidAmount > 0 ? InvoiceStatus.PARTIAL : InvoiceStatus.CONFIRMED;
        for (const line of lines) {
          await tx.stockBalance.upsert({
            where: {
              warehouseId_productId: {
                warehouseId: data.warehouseId,
                productId: line.productId,
              },
            },
            create: {
              warehouseId: data.warehouseId,
              productId: line.productId,
              quantity: line.quantity,
            },
            update: { quantity: { increment: line.quantity } },
          });
          await tx.stockMovement.create({
            data: {
              warehouseId: data.warehouseId,
              productId: line.productId,
              type: StockMovementType.PURCHASE,
              quantity: line.quantity,
              unitCost: line.unitCost,
              reference: number,
              note: [line.batchNumber && `تشغيلة: ${line.batchNumber}`, line.expiryDate && `صلاحية: ${line.expiryDate.toISOString().slice(0, 10)}`]
                .filter(Boolean)
                .join(' | ') || null,
            },
          });
          // تكلفة الصنف = آخر سعر شراء من الفاتورة (سعر البيع لا يُمس)
          await tx.product.update({
            where: { id: line.productId },
            data: { costPrice: line.unitCost },
          });
        }
        await tx.supplier.update({
          where: { id: data.supplierId },
          data: { balance: { increment: total - paidAmount } },
        });
        if (paidAmount > 0) {
          if (!data.cashAccountId) throw new BadRequestException('اختر حساب خزنة');
          const account = await tx.cashAccount.findUnique({ where: { id: data.cashAccountId } });
          if (!account) throw new BadRequestException('حساب الخزنة غير موجود');
          // يُسمح بالرصيد السالب عند سداد الشراء
          await tx.cashAccount.update({
            where: { id: data.cashAccountId },
            data: { balance: { decrement: paidAmount } },
          });
          await tx.cashTransaction.create({
            data: {
              accountId: data.cashAccountId,
              direction: CashDirection.OUT,
              amount: paidAmount,
              description: `سداد فاتورة شراء ${number} (${METHOD_LABELS[method]})`,
              paymentMethod: method,
              reference: paymentNumber || number,
              createdById: data.createdById,
            },
          });
        }
      }

      const invoice = await tx.purchaseInvoice.create({
        data: {
          number,
          supplierId: data.supplierId,
          warehouseId: data.warehouseId,
          status,
          invoiceDate: data.invoiceDate ? new Date(data.invoiceDate) : new Date(),
          subtotal,
          discount,
          tax,
          total,
          paidAmount,
          paymentMethod: method,
          notes: data.notes,
          createdById: data.createdById,
          lines: { create: lines },
        },
        include: { supplier: true, warehouse: true, lines: { include: { product: true } } },
      });

      if (data.confirm && paidAmount > 0 && data.cashAccountId && paymentNumber) {
        await tx.payment.create({
          data: {
            number: paymentNumber,
            supplierId: data.supplierId,
            cashAccountId: data.cashAccountId,
            purchaseInvoiceId: invoice.id,
            amount: paidAmount,
            paymentMethod: method,
            note: `سداد فاتورة ${number} (${METHOD_LABELS[method]})`,
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
    const paymentNumber =
      inv.paidAmount > 0 ? await this.sequence.next('payments', 'PAY') : null;
    return this.prisma.$transaction(async (tx) => {
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
        await tx.stockMovement.create({
          data: {
            warehouseId: inv.warehouseId,
            productId: line.productId,
            type: StockMovementType.PURCHASE,
            quantity: line.quantity,
            unitCost: line.unitCost,
            reference: inv.number,
          },
        });
        // تكلفة الصنف = آخر سعر شراء من الفاتورة (سعر البيع لا يُمس)
        await tx.product.update({
          where: { id: line.productId },
          data: { costPrice: line.unitCost },
        });
      }
      const remaining = inv.total - inv.paidAmount;
      await tx.supplier.update({
        where: { id: inv.supplierId },
        data: { balance: { increment: remaining } },
      });
      if (inv.paidAmount > 0) {
        if (!cashAccountId) throw new BadRequestException('اختر حساب خزنة');
        const account = await tx.cashAccount.findUnique({ where: { id: cashAccountId } });
        if (!account) throw new BadRequestException('حساب الخزنة غير موجود');
        // يُسمح بالرصيد السالب عند سداد الشراء
        await tx.cashAccount.update({
          where: { id: cashAccountId },
          data: { balance: { decrement: inv.paidAmount } },
        });
        await tx.cashTransaction.create({
          data: {
            accountId: cashAccountId,
            direction: CashDirection.OUT,
            amount: inv.paidAmount,
            description: `سداد فاتورة شراء ${inv.number}`,
            paymentMethod: inv.paymentMethod,
            reference: paymentNumber || inv.number,
          },
        });
        await tx.payment.create({
          data: {
            number: paymentNumber!,
            supplierId: inv.supplierId,
            cashAccountId,
            purchaseInvoiceId: inv.id,
            amount: inv.paidAmount,
            paymentMethod: inv.paymentMethod,
            note: `سداد فاتورة ${inv.number}`,
          },
        });
      }
      const status =
        inv.paidAmount >= inv.total
          ? InvoiceStatus.PAID
          : inv.paidAmount > 0
            ? InvoiceStatus.PARTIAL
            : InvoiceStatus.CONFIRMED;
      return tx.purchaseInvoice.update({
        where: { id },
        data: { status },
        include: { supplier: true, warehouse: true, lines: { include: { product: true } } },
      });
    });
  }

  async update(id: string, data: {
    supplierId: string;
    warehouseId: string;
    invoiceDate?: string;
    discount?: number;
    tax?: number;
    notes?: string;
    paidAmount?: number;
    cashAccountId?: string;
    paymentMethod?: PaymentMethod;
    lines: { productId: string; quantity: number; unitCost: number; discount?: number; batchNumber?: string; expiryDate?: string }[];
  }) {
    const inv = await this.prisma.purchaseInvoice.findUnique({
      where: { id },
      include: { lines: true, payments: true, returns: true },
    });
    if (!inv) throw new NotFoundException('فاتورة الشراء غير موجودة');
    if (inv.returns.length) throw new BadRequestException('لا يمكن تعديل فاتورة عليها مرتجعات');
    if (!data.lines?.length) throw new BadRequestException('أضف بنوداً للفاتورة');

    const lines = data.lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      unitCost: l.unitCost,
      discount: l.discount || 0,
      total: l.quantity * l.unitCost - (l.discount || 0),
      batchNumber: l.batchNumber?.trim() || null,
      expiryDate: l.expiryDate ? new Date(l.expiryDate) : null,
    }));
    const subtotal = lines.reduce((s, l) => s + l.total, 0);
    const discount = data.discount || 0;
    const taxPercent = data.tax || 0;
    const tax = Math.round((subtotal - discount) * taxPercent * 100) / 10000;
    const total = subtotal - discount + tax;
    const paidAmount = data.paidAmount ?? inv.paidAmount;
    const method = data.paymentMethod || inv.paymentMethod;
    const reconfirm = inv.status !== InvoiceStatus.DRAFT;
    const paymentNumber = reconfirm && paidAmount > 0 ? await this.sequence.next('payments', 'PAY') : null;

    return this.prisma.$transaction(async (tx) => {
      if (reconfirm) {
        for (const line of inv.lines) {
          const bal = await tx.stockBalance.findUnique({
            where: { warehouseId_productId: { warehouseId: inv.warehouseId, productId: line.productId } },
          });
          if (!bal || bal.quantity < line.quantity) {
            throw new BadRequestException('لا يمكن التعديل لأن كمية المخزون أقل من كمية الفاتورة');
          }
          await tx.stockBalance.update({ where: { id: bal.id }, data: { quantity: { decrement: line.quantity } } });
        }
        await tx.stockMovement.deleteMany({
          where: { reference: inv.number, warehouseId: inv.warehouseId, type: StockMovementType.PURCHASE },
        });
        const due = inv.total - inv.paidAmount;
        if (due !== 0) {
          await tx.supplier.update({ where: { id: inv.supplierId }, data: { balance: { decrement: due } } });
        }
        for (const payment of inv.payments) {
          await tx.cashAccount.update({
            where: { id: payment.cashAccountId },
            data: { balance: { increment: payment.amount } },
          });
          await tx.cashTransaction.deleteMany({
            where: { reference: payment.number, accountId: payment.cashAccountId },
          });
        }
        await tx.payment.deleteMany({ where: { purchaseInvoiceId: id } });
      }

      await tx.purchaseInvoiceLine.deleteMany({ where: { invoiceId: id } });

      if (reconfirm) {
        for (const line of lines) {
          await tx.stockBalance.upsert({
            where: { warehouseId_productId: { warehouseId: data.warehouseId, productId: line.productId } },
            create: { warehouseId: data.warehouseId, productId: line.productId, quantity: line.quantity },
            update: { quantity: { increment: line.quantity } },
          });
          await tx.stockMovement.create({
            data: {
              warehouseId: data.warehouseId,
              productId: line.productId,
              type: StockMovementType.PURCHASE,
              quantity: line.quantity,
              unitCost: line.unitCost,
              reference: inv.number,
              note: [line.batchNumber && `تشغيلة: ${line.batchNumber}`, line.expiryDate && `صلاحية: ${line.expiryDate.toISOString().slice(0, 10)}`].filter(Boolean).join(' | ') || null,
            },
          });
          await tx.product.update({ where: { id: line.productId }, data: { costPrice: line.unitCost } });
        }
        await tx.supplier.update({
          where: { id: data.supplierId },
          data: { balance: { increment: total - paidAmount } },
        });
        if (paidAmount > 0) {
          if (!data.cashAccountId) throw new BadRequestException('اختر حساب خزنة');
          await tx.cashAccount.update({ where: { id: data.cashAccountId }, data: { balance: { decrement: paidAmount } } });
          await tx.cashTransaction.create({
            data: {
              accountId: data.cashAccountId,
              direction: CashDirection.OUT,
              amount: paidAmount,
              description: `سداد فاتورة شراء ${inv.number} (${METHOD_LABELS[method]})`,
              paymentMethod: method,
              reference: paymentNumber || inv.number,
            },
          });
          await tx.payment.create({
            data: {
              number: paymentNumber!,
              supplierId: data.supplierId,
              cashAccountId: data.cashAccountId,
              purchaseInvoiceId: id,
              amount: paidAmount,
              paymentMethod: method,
              note: `سداد فاتورة ${inv.number}`,
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

      return tx.purchaseInvoice.update({
        where: { id },
        data: {
          supplierId: data.supplierId,
          warehouseId: data.warehouseId,
          invoiceDate: data.invoiceDate ? new Date(data.invoiceDate) : inv.invoiceDate,
          subtotal,
          discount,
          tax,
          total,
          paidAmount: reconfirm ? paidAmount : (data.paidAmount ?? inv.paidAmount),
          paymentMethod: method,
          notes: data.notes,
          status,
          lines: { create: lines },
        },
        include: { supplier: true, warehouse: true, lines: { include: { product: true } }, payments: true },
      });
    });
  }

  async remove(id: string) {
    const inv = await this.prisma.purchaseInvoice.findUnique({
      where: { id },
      include: { lines: true, payments: true, returns: true },
    });
    if (!inv) throw new NotFoundException('فاتورة الشراء غير موجودة');
    if (inv.returns.length) {
      throw new BadRequestException('لا يمكن حذف فاتورة عليها مرتجعات');
    }

    return this.prisma.$transaction(async (tx) => {
      if (inv.status !== InvoiceStatus.DRAFT) {
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
            throw new BadRequestException('لا يمكن الحذف لأن كمية المخزون أقل من كمية الفاتورة');
          }
          await tx.stockBalance.update({
            where: { id: bal.id },
            data: { quantity: { decrement: line.quantity } },
          });
        }
        await tx.stockMovement.deleteMany({
          where: {
            reference: inv.number,
            warehouseId: inv.warehouseId,
            type: StockMovementType.PURCHASE,
          },
        });
        const due = inv.total - inv.paidAmount;
        if (due !== 0) {
          await tx.supplier.update({
            where: { id: inv.supplierId },
            data: { balance: { decrement: due } },
          });
        }
        for (const payment of inv.payments) {
          await tx.cashAccount.update({
            where: { id: payment.cashAccountId },
            data: { balance: { increment: payment.amount } },
          });
          await tx.cashTransaction.deleteMany({
            where: { reference: payment.number, accountId: payment.cashAccountId },
          });
        }
      }
      await tx.payment.deleteMany({ where: { purchaseInvoiceId: id } });
      await tx.purchaseInvoice.delete({ where: { id } });
      return { ok: true };
    });
  }
}
