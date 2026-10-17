import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InvoiceStatus, StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequenceService } from '../common/sequence.service';
import { normalizeTenders, postSupplierTenders, reversePurchaseMoney, sumTenders, TenderInput } from '../cash/tenders';

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
        payments: { orderBy: { paidAt: 'asc' } },
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
    payments?: TenderInput[];
    confirm?: boolean;
    createdById?: string;
    lines: { productId: string; quantity: number; unitCost: number; discount?: number; batchNumber?: string; expiryDate?: string }[];
  }) {
    if (!data.lines?.length) throw new BadRequestException('أضف بنوداً للفاتورة');
    const number = await this.sequence.next('purchases', 'PUR');
    const parts = normalizeTenders(data.payments);
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
    const paidAmount = parts.length ? sumTenders(parts) : (data.paidAmount || 0);
    if (paidAmount > total + 0.009) throw new BadRequestException('المدفوع أكبر من إجمالي الفاتورة');
    if (data.confirm && paidAmount > 0 && !parts.length) throw new BadRequestException('قسّم المدفوع على طرق الدفع');
    const paymentNumbers: string[] = [];
    if (data.confirm) {
      for (let i = 0; i < parts.length; i++) paymentNumbers.push(await this.sequence.next('payments', 'PAY'));
    }

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
          paymentMethod: parts.length === 1 ? parts[0].methodId : '',
          notes: data.notes,
          createdById: data.createdById,
          lines: { create: lines },
        },
        include: { supplier: true, warehouse: true, lines: { include: { product: true } } },
      });

      if (data.confirm && parts.length) {
        await postSupplierTenders(tx, {
          parts,
          supplierId: data.supplierId,
          purchaseInvoiceId: invoice.id,
          invoiceNumber: number,
          createdById: data.createdById,
          paymentNumbers,
        });
      }

      return invoice;
    });
  }

  async confirm(id: string, payments?: TenderInput[]) {
    const inv = await this.findOne(id);
    if (inv.status !== InvoiceStatus.DRAFT) {
      throw new BadRequestException('الفاتورة ليست مسودة');
    }
    const parts = normalizeTenders(payments);
    const paidAmount = parts.length ? sumTenders(parts) : 0;
    if (paidAmount > inv.total + 0.009) throw new BadRequestException('المدفوع أكبر من إجمالي الفاتورة');
    const paymentNumbers: string[] = [];
    for (let i = 0; i < parts.length; i++) paymentNumbers.push(await this.sequence.next('payments', 'PAY'));
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
      await tx.supplier.update({
        where: { id: inv.supplierId },
        data: { balance: { increment: inv.total - paidAmount } },
      });
      if (parts.length) {
        await postSupplierTenders(tx, {
          parts,
          supplierId: inv.supplierId,
          purchaseInvoiceId: inv.id,
          invoiceNumber: inv.number,
          paymentNumbers,
        });
      }
      const status =
        paidAmount >= inv.total
          ? InvoiceStatus.PAID
          : paidAmount > 0
            ? InvoiceStatus.PARTIAL
            : InvoiceStatus.CONFIRMED;
      return tx.purchaseInvoice.update({
        where: { id },
        data: { status, paidAmount, paymentMethod: parts.length === 1 ? parts[0].methodId : '' },
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
    payments?: TenderInput[];
    confirm?: boolean;
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
    const parts = data.payments ? normalizeTenders(data.payments) : [];
    const paidAmount = data.payments ? sumTenders(parts) : (data.paidAmount ?? inv.paidAmount);
    if (paidAmount > total + 0.009) throw new BadRequestException('المدفوع أكبر من إجمالي الفاتورة');
    const alreadyPosted = inv.status !== InvoiceStatus.DRAFT;
    const posting = alreadyPosted || !!data.confirm;
    if (posting && paidAmount > 0 && !parts.length) throw new BadRequestException('قسّم المدفوع على طرق الدفع');
    const paymentNumbers: string[] = [];
    if (posting) {
      for (let i = 0; i < parts.length; i++) paymentNumbers.push(await this.sequence.next('payments', 'PAY'));
    }

    return this.prisma.$transaction(async (tx) => {
      if (alreadyPosted) {
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
        await reversePurchaseMoney(tx, id, inv.payments);
      }

      await tx.purchaseInvoiceLine.deleteMany({ where: { invoiceId: id } });

      if (posting) {
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
        if (parts.length) {
          await postSupplierTenders(tx, {
            parts,
            supplierId: data.supplierId,
            purchaseInvoiceId: id,
            invoiceNumber: inv.number,
            paymentNumbers,
          });
        }
      }

      const status = !posting
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
          paidAmount,
          paymentMethod: parts.length === 1 ? parts[0].methodId : (parts.length ? '' : inv.paymentMethod),
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
        await reversePurchaseMoney(tx, id, inv.payments);
      } else {
        await tx.payment.deleteMany({ where: { purchaseInvoiceId: id } });
      }
      await tx.purchaseInvoice.delete({ where: { id } });
      return { ok: true };
    });
  }
}
