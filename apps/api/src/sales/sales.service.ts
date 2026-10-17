import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InvoiceStatus, StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequenceService } from '../common/sequence.service';
import { normalizeTenders, postCustomerTenders, reverseSaleMoney, sumTenders, TenderInput } from '../cash/tenders';

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
    payments?: TenderInput[];
    taxRate?: number;
    shiftId?: string | null;
    confirm?: boolean;
    createdById?: string;
    lines: { productId: string; quantity: number; unitPrice: number; discount?: number }[];
  }) {
    if (!data.lines?.length) throw new BadRequestException('أضف بنوداً للفاتورة');
    if (data.shiftId) await this.assertOpenShift(data.shiftId);
    const number = await this.sequence.next('sales', 'SAL');
    const parts = normalizeTenders(data.payments);
    const paidFromParts = sumTenders(parts);
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
    const paidAmount = parts.length ? paidFromParts : (data.paidAmount || 0);
    if (paidAmount > total + 0.009) throw new BadRequestException('المدفوع أكبر من إجمالي الفاتورة');
    if (data.confirm && paidAmount > 0 && !parts.length) throw new BadRequestException('قسّم المدفوع على طرق الدفع');
    const receiptNumbers: string[] = [];
    if (data.confirm) {
      for (let i = 0; i < parts.length; i++) receiptNumbers.push(await this.sequence.next('receipts', 'RCP'));
    }
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
          paymentMethod: parts.length === 1 ? parts[0].methodId : '',
          shiftId: data.shiftId || null,
          notes: data.notes,
          createdById: data.createdById,
          lines: { create: lines },
        },
        include: { customer: true, warehouse: true, lines: { include: { product: true } } },
      });

      if (data.confirm && parts.length) {
        await postCustomerTenders(tx, {
          parts,
          customerId: data.customerId,
          salesInvoiceId: invoice.id,
          invoiceNumber: number,
          shiftId: data.shiftId,
          createdById: data.createdById,
          receiptNumbers,
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
    await this.assertCredit(inv.customerId, inv.total - paidAmount);
    const receiptNumbers: string[] = [];
    for (let i = 0; i < parts.length; i++) receiptNumbers.push(await this.sequence.next('receipts', 'RCP'));
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
      await tx.customer.update({
        where: { id: inv.customerId },
        data: { balance: { increment: inv.total - paidAmount } },
      });
      if (parts.length) {
        await postCustomerTenders(tx, {
          parts,
          customerId: inv.customerId,
          salesInvoiceId: inv.id,
          invoiceNumber: inv.number,
          shiftId: inv.shiftId,
          receiptNumbers,
        });
      }
      const status =
        paidAmount >= inv.total
          ? InvoiceStatus.PAID
          : paidAmount > 0
            ? InvoiceStatus.PARTIAL
            : InvoiceStatus.CONFIRMED;
      return tx.salesInvoice.update({
        where: { id },
        data: { status, paidAmount, paymentMethod: parts.length === 1 ? parts[0].methodId : '' },
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
    payments?: TenderInput[];
    confirm?: boolean;
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
    const parts = data.payments ? normalizeTenders(data.payments) : [];
    const paidAmount = data.payments ? sumTenders(parts) : (data.paidAmount ?? inv.paidAmount);
    if (paidAmount > total + 0.009) throw new BadRequestException('المدفوع أكبر من إجمالي الفاتورة');
    const alreadyPosted = inv.status !== InvoiceStatus.DRAFT;
    const posting = alreadyPosted || !!data.confirm;
    if (posting && paidAmount > 0 && !parts.length) throw new BadRequestException('قسّم المدفوع على طرق الدفع');
    if (posting) await this.assertCredit(data.customerId, total - paidAmount - (alreadyPosted ? inv.total - inv.paidAmount : 0));
    const receiptNumbers: string[] = [];
    if (posting) {
      for (let i = 0; i < parts.length; i++) receiptNumbers.push(await this.sequence.next('receipts', 'RCP'));
    }

    return this.prisma.$transaction(async (tx) => {
      if (alreadyPosted) {
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
        await reverseSaleMoney(tx, id, inv.receipts);
      }

      await tx.salesInvoiceLine.deleteMany({ where: { invoiceId: id } });

      if (posting) {
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
        if (parts.length) {
          await postCustomerTenders(tx, {
            parts,
            customerId: data.customerId,
            salesInvoiceId: id,
            invoiceNumber: inv.number,
            shiftId: data.shiftId,
            receiptNumbers,
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
          paidAmount,
          paymentMethod: parts.length === 1 ? parts[0].methodId : (parts.length ? '' : inv.paymentMethod),
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
        await reverseSaleMoney(tx, id, inv.receipts);
      } else {
        await tx.receipt.deleteMany({ where: { salesInvoiceId: id } });
      }
      await tx.salesInvoice.delete({ where: { id } });
      return { ok: true };
    });
  }
}
