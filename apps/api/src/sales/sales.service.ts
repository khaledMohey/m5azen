import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InvoiceStatus, Prisma, StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequenceService } from '../common/sequence.service';
import { normalizeTenders, postCustomerTenders, reverseSaleMoney, sumTenders, syncSaleTenders, TenderInput } from '../cash/tenders';
import { assertPeriodsOpen } from '../settings/period-lock';

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
    await assertPeriodsOpen(this.prisma, data.invoiceDate || new Date());
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
    await assertPeriodsOpen(this.prisma, inv.invoiceDate);
    const parts = normalizeTenders(payments);
    const paidAmount = parts.length ? sumTenders(parts) : 0;
    if (paidAmount > inv.total + 0.009) throw new BadRequestException('المدفوع أكبر من إجمالي الفاتورة');
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
    lines: { id?: string; productId: string; quantity: number; unitPrice: number; discount?: number }[];
  }) {
    const inv = await this.prisma.salesInvoice.findUnique({
      where: { id },
      include: { lines: true, receipts: true, returns: true },
    });
    if (!inv) throw new NotFoundException('فاتورة البيع غير موجودة');
    await assertPeriodsOpen(this.prisma, inv.invoiceDate, data.invoiceDate);
    if (inv.returns.length) throw new BadRequestException('لا يمكن تعديل فاتورة عليها مرتجعات');
    if (!data.lines?.length) throw new BadRequestException('أضف بنوداً للفاتورة');
    if (data.shiftId) await this.assertOpenShift(data.shiftId);

    const products = await this.prisma.product.findMany({
      where: { id: { in: data.lines.map((l) => l.productId) } },
    });
    const costOf = (productId: string) => products.find((p) => p.id === productId)?.costPrice || 0;
    const lines = data.lines.map((l) => ({
      id: l.id,
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
    if (alreadyPosted) return this.revisePostedSale(id, inv, data, lines, parts, subtotal, discount, tax, taxRate, total);

    const receiptNumbers: string[] = [];
    if (posting) {
      for (let i = 0; i < parts.length; i++) receiptNumbers.push(await this.sequence.next('receipts', 'RCP'));
    }

    return this.prisma.$transaction(async (tx) => {
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

  private async revisePostedSale(
    id: string,
    inv: {
      number: string;
      customerId: string;
      warehouseId: string;
      total: number;
      paidAmount: number;
      invoiceDate: Date;
      shiftId: string | null;
      lines: { id: string; productId: string; quantity: number; unitCost: number }[];
      receipts: { id: string; number: string; amount: number; cashAccountId: string | null; paymentMethod: string; referenceNo: string | null }[];
    },
    data: { customerId: string; warehouseId: string; invoiceDate?: string; notes?: string; shiftId?: string | null },
    lines: { id?: string; productId: string; quantity: number; unitPrice: number; unitCost: number; discount: number; total: number }[],
    parts: TenderInput[],
    subtotal: number,
    discount: number,
    tax: number,
    taxRate: number,
    total: number,
  ) {
    const replacements = parts.filter((part) => {
      if (!part.id) return true;
      const row = inv.receipts.find((receipt) => receipt.id === part.id);
      return !row || row.paymentMethod !== part.methodId;
    }).length;
    const newNumbers: string[] = [];
    for (let i = 0; i < replacements; i++) newNumbers.push(await this.sequence.next('receipts', 'RCP'));

    return this.prisma.$transaction(async (tx) => {
      await this.applySaleStockDelta(tx, inv.warehouseId, data.warehouseId, inv.number, inv.lines, lines);
      const paidAmount = await syncSaleTenders(tx, {
        existing: inv.receipts,
        parts,
        customerId: data.customerId,
        salesInvoiceId: id,
        invoiceNumber: inv.number,
        shiftId: data.shiftId === undefined ? inv.shiftId : data.shiftId,
        newNumbers,
      });
      if (paidAmount > total + 0.009) throw new BadRequestException('المدفوع أكبر من إجمالي الفاتورة');
      const oldDue = inv.total - inv.paidAmount;
      const newDue = total - paidAmount;
      if (data.customerId === inv.customerId) {
        const delta = newDue - oldDue;
        if (Math.abs(delta) >= 0.009) {
          await tx.customer.update({ where: { id: inv.customerId }, data: { balance: { increment: delta } } });
        }
      } else {
        if (Math.abs(oldDue) >= 0.009) {
          await tx.customer.update({ where: { id: inv.customerId }, data: { balance: { decrement: oldDue } } });
        }
        if (Math.abs(newDue) >= 0.009) {
          await tx.customer.update({ where: { id: data.customerId }, data: { balance: { increment: newDue } } });
        }
      }
      const kept = new Set(lines.map((line) => line.id).filter((lineId): lineId is string => !!lineId));
      for (const old of inv.lines) {
        if (!kept.has(old.id)) await tx.salesInvoiceLine.delete({ where: { id: old.id } });
      }
      for (const line of lines) {
        const previous = line.id ? inv.lines.find((row) => row.id === line.id) : undefined;
        const unitCost = previous && previous.productId === line.productId ? previous.unitCost : line.unitCost;
        const row = {
          productId: line.productId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          unitCost,
          discount: line.discount,
          total: line.total,
        };
        if (previous) await tx.salesInvoiceLine.update({ where: { id: previous.id }, data: row });
        else await tx.salesInvoiceLine.create({ data: { invoiceId: id, ...row } });
      }
      const methods = await tx.receipt.findMany({ where: { salesInvoiceId: id }, select: { paymentMethod: true } });
      const status = paidAmount >= total - 0.009
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
          paymentMethod: methods.length === 1 ? methods[0].paymentMethod : '',
          shiftId: data.shiftId === undefined ? inv.shiftId : (data.shiftId || null),
          notes: data.notes,
          status,
        },
        include: { customer: true, warehouse: true, lines: { include: { product: true } }, receipts: true },
      });
    });
  }

  private async applySaleStockDelta(
    tx: Prisma.TransactionClient,
    oldWarehouse: string,
    newWarehouse: string,
    reference: string,
    oldLines: { productId: string; quantity: number; unitCost: number }[],
    newLines: { productId: string; quantity: number; unitCost: number }[],
  ) {
    if (oldWarehouse !== newWarehouse) {
      for (const line of oldLines) {
        await tx.stockBalance.upsert({
          where: { warehouseId_productId: { warehouseId: oldWarehouse, productId: line.productId } },
          create: { warehouseId: oldWarehouse, productId: line.productId, quantity: line.quantity },
          update: { quantity: { increment: line.quantity } },
        });
      }
      for (const line of newLines) {
        const bal = await tx.stockBalance.findUnique({
          where: { warehouseId_productId: { warehouseId: newWarehouse, productId: line.productId } },
        });
        if (!bal || bal.quantity < line.quantity) throw new BadRequestException('كمية غير كافية في المخزن');
        await tx.stockBalance.update({ where: { id: bal.id }, data: { quantity: { decrement: line.quantity } } });
        await tx.stockMovement.create({
          data: {
            warehouseId: newWarehouse,
            productId: line.productId,
            type: StockMovementType.ADJUSTMENT,
            quantity: -line.quantity,
            unitCost: line.unitCost,
            reference,
            note: 'تعديل مخزن الفاتورة',
          },
        });
      }
      return;
    }
    const oldQty = new Map<string, number>();
    const newQty = new Map<string, number>();
    for (const line of oldLines) oldQty.set(line.productId, (oldQty.get(line.productId) || 0) + line.quantity);
    for (const line of newLines) newQty.set(line.productId, (newQty.get(line.productId) || 0) + line.quantity);
    for (const productId of new Set([...oldQty.keys(), ...newQty.keys()])) {
      const delta = (newQty.get(productId) || 0) - (oldQty.get(productId) || 0);
      if (Math.abs(delta) < 0.0001) continue;
      if (delta > 0) {
        const bal = await tx.stockBalance.findUnique({
          where: { warehouseId_productId: { warehouseId: oldWarehouse, productId } },
        });
        if (!bal || bal.quantity < delta) throw new BadRequestException('كمية غير كافية في المخزن');
        await tx.stockBalance.update({ where: { id: bal.id }, data: { quantity: { decrement: delta } } });
      } else {
        await tx.stockBalance.upsert({
          where: { warehouseId_productId: { warehouseId: oldWarehouse, productId } },
          create: { warehouseId: oldWarehouse, productId, quantity: -delta },
          update: { quantity: { increment: -delta } },
        });
      }
      const sample = newLines.find((line) => line.productId === productId) || oldLines.find((line) => line.productId === productId);
      await tx.stockMovement.create({
        data: {
          warehouseId: oldWarehouse,
          productId,
          type: StockMovementType.ADJUSTMENT,
          quantity: -delta,
          unitCost: sample?.unitCost || 0,
          reference,
          note: 'تعديل فاتورة',
        },
      });
    }
  }

  async remove(id: string) {
    const inv = await this.prisma.salesInvoice.findUnique({
      where: { id },
      include: { lines: true, receipts: true, returns: true },
    });
    if (!inv) throw new NotFoundException('فاتورة البيع غير موجودة');
    await assertPeriodsOpen(this.prisma, inv.invoiceDate);
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
