import { BadRequestException, Injectable } from '@nestjs/common';
import { StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequenceService } from '../common/sequence.service';

@Injectable()
export class ReturnsService {
  constructor(
    private prisma: PrismaService,
    private sequence: SequenceService,
  ) {}

  listSalesReturns() {
    return this.prisma.salesReturn.findMany({
      include: {
        customer: true,
        warehouse: true,
        salesInvoice: true,
        lines: { include: { product: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  listPurchaseReturns() {
    return this.prisma.purchaseReturn.findMany({
      include: {
        supplier: true,
        warehouse: true,
        purchaseInvoice: true,
        lines: { include: { product: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async salesReturnable(customerId: string) {
    const invoices = await this.prisma.salesInvoice.findMany({
      where: {
        customerId,
        status: { in: ['CONFIRMED', 'PARTIAL', 'PAID'] },
      },
      include: {
        lines: { include: { product: true } },
        warehouse: true,
      },
      orderBy: { invoiceDate: 'asc' },
    });

    const returns = await this.prisma.salesReturn.findMany({
      where: { customerId },
      include: { lines: true },
    });

    const linked = new Map<string, number>();
    const unlinked = new Map<string, number>();
    for (const r of returns) {
      for (const line of r.lines) {
        if (r.salesInvoiceId) {
          const key = `${r.salesInvoiceId}:${line.productId}`;
          linked.set(key, (linked.get(key) || 0) + line.quantity);
        } else {
          unlinked.set(line.productId, (unlinked.get(line.productId) || 0) + line.quantity);
        }
      }
    }

    const grouped = invoices.map((inv) => {
      const byProduct = new Map<string, {
        productId: string; sku: string; name: string; unit: string;
        quantity: number; unitPrice: number;
      }>();
      for (const line of inv.lines) {
        const existing = byProduct.get(line.productId);
        if (!existing) {
          byProduct.set(line.productId, {
            productId: line.productId,
            sku: line.product.sku,
            name: line.product.name,
            unit: line.product.unit,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
          });
        } else {
          existing.quantity += line.quantity;
        }
      }

      const lines = Array.from(byProduct.values()).map((line) => {
        let returnedQty = linked.get(`${inv.id}:${line.productId}`) || 0;
        const loose = unlinked.get(line.productId) || 0;
        const room = Math.max(0, line.quantity - returnedQty);
        const take = Math.min(room, loose);
        returnedQty += take;
        unlinked.set(line.productId, loose - take);
        const remainingQty = Math.max(0, line.quantity - returnedQty);
        return { ...line, returnedQty, remainingQty };
      }).filter((line) => line.remainingQty > 0);

      return {
        id: inv.id,
        number: inv.number,
        invoiceDate: inv.invoiceDate,
        warehouseId: inv.warehouseId,
        warehouseName: inv.warehouse.name,
        total: inv.total,
        lines,
      };
    }).filter((inv) => inv.lines.length > 0)
      .sort((a, b) => new Date(b.invoiceDate).getTime() - new Date(a.invoiceDate).getTime());

    return { customerId, invoices: grouped };
  }

  async purchasesReturnable(supplierId: string) {
    const invoices = await this.prisma.purchaseInvoice.findMany({
      where: {
        supplierId,
        status: { in: ['CONFIRMED', 'PARTIAL', 'PAID'] },
      },
      include: {
        lines: { include: { product: true } },
        warehouse: true,
      },
      orderBy: { invoiceDate: 'asc' },
    });

    const returns = await this.prisma.purchaseReturn.findMany({
      where: { supplierId },
      include: { lines: true },
    });

    const linked = new Map<string, number>();
    const unlinked = new Map<string, number>();
    for (const r of returns) {
      for (const line of r.lines) {
        if (r.purchaseInvoiceId) {
          const key = `${r.purchaseInvoiceId}:${line.productId}`;
          linked.set(key, (linked.get(key) || 0) + line.quantity);
        } else {
          unlinked.set(line.productId, (unlinked.get(line.productId) || 0) + line.quantity);
        }
      }
    }

    const grouped = invoices.map((inv) => {
      const byProduct = new Map<string, {
        productId: string; sku: string; name: string; unit: string;
        quantity: number; unitCost: number;
      }>();
      for (const line of inv.lines) {
        const existing = byProduct.get(line.productId);
        if (!existing) {
          byProduct.set(line.productId, {
            productId: line.productId,
            sku: line.product.sku,
            name: line.product.name,
            unit: line.product.unit,
            quantity: line.quantity,
            unitCost: line.unitCost,
          });
        } else {
          existing.quantity += line.quantity;
        }
      }

      const lines = Array.from(byProduct.values()).map((line) => {
        let returnedQty = linked.get(`${inv.id}:${line.productId}`) || 0;
        const loose = unlinked.get(line.productId) || 0;
        const room = Math.max(0, line.quantity - returnedQty);
        const take = Math.min(room, loose);
        returnedQty += take;
        unlinked.set(line.productId, loose - take);
        const remainingQty = Math.max(0, line.quantity - returnedQty);
        return { ...line, returnedQty, remainingQty };
      }).filter((line) => line.remainingQty > 0);

      return {
        id: inv.id,
        number: inv.number,
        invoiceDate: inv.invoiceDate,
        warehouseId: inv.warehouseId,
        warehouseName: inv.warehouse.name,
        total: inv.total,
        lines,
      };
    }).filter((inv) => inv.lines.length > 0)
      .sort((a, b) => new Date(b.invoiceDate).getTime() - new Date(a.invoiceDate).getTime());

    return { supplierId, invoices: grouped };
  }

  async createSalesReturn(data: {
    customerId: string;
    warehouseId: string;
    salesInvoiceId?: string;
    notes?: string;
    lines: { productId: string; quantity: number; unitPrice: number }[];
  }) {
    if (!data.lines?.length) throw new BadRequestException('أضف بنوداً');

    const returnable = await this.salesReturnable(data.customerId);
    const pool = data.salesInvoiceId
      ? returnable.invoices.filter((inv) => inv.id === data.salesInvoiceId)
      : returnable.invoices;
    const remainingByProduct = new Map<string, number>();
    for (const inv of pool) {
      for (const line of inv.lines) {
        remainingByProduct.set(line.productId, (remainingByProduct.get(line.productId) || 0) + line.remainingQty);
      }
    }
    for (const line of data.lines) {
      if (line.quantity <= 0) throw new BadRequestException('كمية الإرجاع يجب أن تكون أكبر من صفر');
      const remaining = remainingByProduct.get(line.productId) || 0;
      if (line.quantity > remaining) {
        throw new BadRequestException(`الكمية المرتجعة أكبر من المتاح للصنف (${remaining})`);
      }
    }

    const number = await this.sequence.next('sales_return', 'SR');
    const lines = data.lines.map((l) => ({
      ...l,
      total: l.quantity * l.unitPrice,
    }));
    const total = lines.reduce((s, l) => s + l.total, 0);

    return this.prisma.$transaction(async (tx) => {
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
            type: StockMovementType.SALE_RETURN,
            quantity: line.quantity,
            unitCost: line.unitPrice,
            reference: number,
          },
        });
      }
      await tx.customer.update({
        where: { id: data.customerId },
        data: { balance: { decrement: total } },
      });
      return tx.salesReturn.create({
        data: {
          number,
          customerId: data.customerId,
          warehouseId: data.warehouseId,
          salesInvoiceId: data.salesInvoiceId,
          total,
          notes: data.notes,
          lines: { create: lines },
        },
        include: {
          customer: true,
          warehouse: true,
          lines: { include: { product: true } },
        },
      });
    });
  }

  async createPurchaseReturn(data: {
    supplierId: string;
    warehouseId: string;
    purchaseInvoiceId?: string;
    notes?: string;
    lines: { productId: string; quantity: number; unitCost: number }[];
  }) {
    if (!data.lines?.length) throw new BadRequestException('أضف بنوداً');

    const returnable = await this.purchasesReturnable(data.supplierId);
    const pool = data.purchaseInvoiceId
      ? returnable.invoices.filter((inv) => inv.id === data.purchaseInvoiceId)
      : returnable.invoices;
    const remainingByProduct = new Map<string, number>();
    for (const inv of pool) {
      for (const line of inv.lines) {
        remainingByProduct.set(line.productId, (remainingByProduct.get(line.productId) || 0) + line.remainingQty);
      }
    }
    for (const line of data.lines) {
      if (line.quantity <= 0) throw new BadRequestException('كمية الإرجاع يجب أن تكون أكبر من صفر');
      const remaining = remainingByProduct.get(line.productId) || 0;
      if (line.quantity > remaining) {
        throw new BadRequestException(`الكمية المرتجعة أكبر من المتاح للصنف (${remaining})`);
      }
    }

    const number = await this.sequence.next('purchase_return', 'PR');
    const lines = data.lines.map((l) => ({
      ...l,
      total: l.quantity * l.unitCost,
    }));
    const total = lines.reduce((s, l) => s + l.total, 0);

    return this.prisma.$transaction(async (tx) => {
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
          throw new BadRequestException('كمية غير كافية لمرتجع الشراء');
        }
        await tx.stockBalance.update({
          where: { id: bal.id },
          data: { quantity: { decrement: line.quantity } },
        });
        await tx.stockMovement.create({
          data: {
            warehouseId: data.warehouseId,
            productId: line.productId,
            type: StockMovementType.PURCHASE_RETURN,
            quantity: -line.quantity,
            unitCost: line.unitCost,
            reference: number,
          },
        });
      }
      await tx.supplier.update({
        where: { id: data.supplierId },
        data: { balance: { decrement: total } },
      });
      return tx.purchaseReturn.create({
        data: {
          number,
          supplierId: data.supplierId,
          warehouseId: data.warehouseId,
          purchaseInvoiceId: data.purchaseInvoiceId,
          total,
          notes: data.notes,
          lines: { create: lines },
        },
        include: {
          supplier: true,
          warehouse: true,
          lines: { include: { product: true } },
        },
      });
    });
  }
}
