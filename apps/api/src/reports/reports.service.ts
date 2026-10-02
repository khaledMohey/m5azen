import { Injectable } from '@nestjs/common';
import { InvoiceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import * as ExcelJS from 'exceljs';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  async inventory(warehouseId?: string) {
    return this.prisma.stockBalance.findMany({
      where: warehouseId ? { warehouseId } : undefined,
      include: { product: true, warehouse: true },
      orderBy: { product: { name: 'asc' } },
    });
  }

  async salesSummary(from?: string, to?: string) {
    const where = {
      status: { not: 'CANCELLED' as const },
      ...(from || to
        ? {
            invoiceDate: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    };
    const invoices = await this.prisma.salesInvoice.findMany({
      where,
      include: { customer: true, warehouse: true },
      orderBy: { invoiceDate: 'desc' },
    });
    const total = invoices.reduce((s, i) => s + i.total, 0);
    const paid = invoices.reduce((s, i) => s + i.paidAmount, 0);
    return { invoices, total, paid, count: invoices.length };
  }

  async purchasesSummary(from?: string, to?: string) {
    const where = {
      status: { not: 'CANCELLED' as const },
      ...(from || to
        ? {
            invoiceDate: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    };
    const invoices = await this.prisma.purchaseInvoice.findMany({
      where,
      include: { supplier: true, warehouse: true },
      orderBy: { invoiceDate: 'desc' },
    });
    const total = invoices.reduce((s, i) => s + i.total, 0);
    const paid = invoices.reduce((s, i) => s + i.paidAmount, 0);
    return { invoices, total, paid, count: invoices.length };
  }

  async profit(from?: string, to?: string) {
    const sales = await this.salesSummary(from, to);
    const purchases = await this.purchasesSummary(from, to);
    const invoiceDate = this.dayRange(from, to);
    const [saleLines, returnLines] = await Promise.all([
      this.prisma.salesInvoiceLine.findMany({
        where: {
          invoice: {
            status: { not: 'CANCELLED' },
            ...(invoiceDate ? { invoiceDate } : {}),
          },
        },
        include: { product: true },
      }),
      this.prisma.salesReturnLine.findMany({
        where: invoiceDate ? { salesReturn: { returnDate: invoiceDate } } : undefined,
        include: { product: true },
      }),
    ]);
    let revenue = 0;
    let cogs = 0;
    for (const line of saleLines) {
      revenue += line.total;
      cogs += line.quantity * (line.unitCost || line.product.costPrice);
    }
    for (const line of returnLines) {
      revenue -= line.total;
      cogs -= line.quantity * line.product.costPrice;
    }
    revenue = Math.round(revenue * 100) / 100;
    cogs = Math.round(cogs * 100) / 100;
    return {
      salesTotal: sales.total,
      purchasesTotal: purchases.total,
      grossProfit: sales.total - purchases.total,
      salesCount: sales.count,
      purchasesCount: purchases.count,
      revenue,
      cogs,
      netProfit: Math.round((revenue - cogs) * 100) / 100,
    };
  }

  async productInsights(from?: string, to?: string) {
    const invoiceDate = this.dayRange(from, to);
    const confirmed = { in: [InvoiceStatus.CONFIRMED, InvoiceStatus.PARTIAL, InvoiceStatus.PAID] };

    const [saleLines, saleReturnLines, purchaseLines, purchaseReturnLines, products] = await Promise.all([
      this.prisma.salesInvoiceLine.findMany({
        where: { invoice: { status: confirmed, ...(invoiceDate ? { invoiceDate } : {}) } },
        include: { product: true },
      }),
      this.prisma.salesReturnLine.findMany({
        where: invoiceDate ? { salesReturn: { returnDate: invoiceDate } } : undefined,
        include: { product: true },
      }),
      this.prisma.purchaseInvoiceLine.findMany({
        where: { invoice: { status: confirmed, ...(invoiceDate ? { invoiceDate } : {}) } },
        include: { product: true },
      }),
      this.prisma.purchaseReturnLine.findMany({
        where: invoiceDate ? { purchaseReturn: { returnDate: invoiceDate } } : undefined,
        include: { product: true },
      }),
      this.prisma.product.findMany({
        where: { isActive: true },
        include: { stockBalances: true },
      }),
    ]);

    type Info = {
      productId: string;
      sku: string;
      name: string;
      unit: string;
      costPrice: number;
      salePrice: number;
      stockQty: number;
    };
    const info = new Map<string, Info>();
    const remember = (product: { id: string; sku: string; name: string; unit: string; costPrice: number; salePrice: number }, stockQty = 0) => {
      if (!info.has(product.id)) {
        info.set(product.id, {
          productId: product.id,
          sku: product.sku,
          name: product.name,
          unit: product.unit,
          costPrice: product.costPrice,
          salePrice: product.salePrice,
          stockQty,
        });
      }
    };
    for (const product of products) {
      remember(product, product.stockBalances.reduce((sum, row) => sum + row.quantity, 0));
    }
    for (const line of saleLines) remember(line.product);
    for (const line of saleReturnLines) remember(line.product);
    for (const line of purchaseLines) remember(line.product);
    for (const line of purchaseReturnLines) remember(line.product);

    const sold = new Map<string, { qty: number; amount: number }>();
    const purchased = new Map<string, { qty: number; amount: number }>();
    const add = (map: Map<string, { qty: number; amount: number }>, productId: string, qty: number, amount: number) => {
      const current = map.get(productId) || { qty: 0, amount: 0 };
      current.qty += qty;
      current.amount += amount;
      map.set(productId, current);
    };
    for (const line of saleLines) add(sold, line.productId, line.quantity, line.total);
    for (const line of saleReturnLines) add(sold, line.productId, -line.quantity, -line.total);
    for (const line of purchaseLines) add(purchased, line.productId, line.quantity, line.total);
    for (const line of purchaseReturnLines) add(purchased, line.productId, -line.quantity, -line.total);

    const topSold = [...sold.entries()]
      .filter(([, row]) => row.qty > 0)
      .map(([productId, row]) => ({ ...info.get(productId)!, quantity: row.qty, amount: row.amount }))
      .sort((a, b) => b.quantity - a.quantity);

    const topPurchased = [...purchased.entries()]
      .filter(([, row]) => row.qty > 0)
      .map(([productId, row]) => ({ ...info.get(productId)!, quantity: row.qty, amount: row.amount }))
      .sort((a, b) => b.quantity - a.quantity);

    const losses = topSold
      .map((row) => {
        const cost = row.quantity * row.costPrice;
        const loss = Math.round((cost - row.amount) * 100) / 100;
        return { ...row, revenue: row.amount, cost, loss };
      })
      .filter((row) => row.loss > 0)
      .sort((a, b) => b.loss - a.loss);

    const lossTotal = Math.round(losses.reduce((sum, row) => sum + row.loss, 0) * 100) / 100;

    const underpriced = [...info.values()]
      .filter((row) => row.stockQty > 0 && row.salePrice > 0 && row.costPrice > row.salePrice)
      .map((row) => ({
        ...row,
        gap: row.costPrice - row.salePrice,
        potentialLoss: Math.round(row.stockQty * (row.costPrice - row.salePrice) * 100) / 100,
      }))
      .sort((a, b) => b.potentialLoss - a.potentialLoss);

    const potentialLossTotal = Math.round(underpriced.reduce((sum, row) => sum + row.potentialLoss, 0) * 100) / 100;

    const unsold = [...info.values()]
      .filter((row) => {
        const soldQty = sold.get(row.productId)?.qty || 0;
        const purchasedQty = purchased.get(row.productId)?.qty || 0;
        return soldQty <= 0 && (row.stockQty > 0 || purchasedQty > 0);
      })
      .map((row) => ({
        ...row,
        purchasedQty: Math.max(0, purchased.get(row.productId)?.qty || 0),
        stockValue: Math.round(row.stockQty * row.costPrice * 100) / 100,
      }))
      .sort((a, b) => b.stockValue - a.stockValue);

    const unsoldValue = Math.round(unsold.reduce((sum, row) => sum + row.stockValue, 0) * 100) / 100;

    return {
      topSold,
      topPurchased,
      losses,
      lossTotal,
      underpriced,
      potentialLossTotal,
      unsold,
      unsoldValue,
    };
  }

  private dayRange(from?: string, to?: string) {
    if (!from && !to) return undefined;
    return {
      ...(from ? { gte: new Date(`${from}T00:00:00`) } : {}),
      ...(to ? { lte: new Date(`${to}T23:59:59.999`) } : {}),
    };
  }

  async cashReport(from?: string, to?: string) {
    const where =
      from || to
        ? {
            createdAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : undefined;
    const transactions = await this.prisma.cashTransaction.findMany({
      where,
      include: { account: true },
      orderBy: { createdAt: 'desc' },
    });
    const accounts = await this.prisma.cashAccount.findMany();
    const totalIn = transactions.filter((t) => t.direction === 'IN').reduce((s, t) => s + t.amount, 0);
    const totalOut = transactions.filter((t) => t.direction === 'OUT').reduce((s, t) => s + t.amount, 0);
    return { transactions, accounts, totalIn, totalOut, net: totalIn - totalOut };
  }

  async exportInventoryExcel(warehouseId?: string) {
    const rows = await this.inventory(warehouseId);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('المخزون');
    ws.columns = [
      { header: 'المخزن', key: 'warehouse', width: 20 },
      { header: 'الكود', key: 'sku', width: 15 },
      { header: 'الصنف', key: 'name', width: 30 },
      { header: 'الوحدة', key: 'unit', width: 10 },
      { header: 'الكمية', key: 'qty', width: 12 },
      { header: 'تكلفة', key: 'cost', width: 12 },
      { header: 'بيع', key: 'sale', width: 12 },
    ];
    for (const r of rows) {
      ws.addRow({
        warehouse: r.warehouse.name,
        sku: r.product.sku,
        name: r.product.name,
        unit: r.product.unit,
        qty: r.quantity,
        cost: r.product.costPrice,
        sale: r.product.salePrice,
      });
    }
    ws.getRow(1).font = { bold: true };
    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
