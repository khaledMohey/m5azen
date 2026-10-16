import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async summary() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(startOfDay.getFullYear(), startOfDay.getMonth(), 1);
    const startOfPrevMonth = new Date(startOfDay.getFullYear(), startOfDay.getMonth() - 1, 1);
    const openStatuses = ['CONFIRMED', 'PARTIAL'] as const;

    const [
      salesToday,
      purchasesToday,
      cashAccounts,
      lowStock,
      recentSales,
      recentPurchases,
      customers,
      suppliers,
      salesMonth,
      salesPrevMonth,
      purchasesMonth,
      purchasesPrevMonth,
      productCount,
      warehouseCount,
      openSales,
      openPurchases,
    ] = await Promise.all([
      this.prisma.salesInvoice.aggregate({
        where: { invoiceDate: { gte: startOfDay }, status: { not: 'CANCELLED' } },
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.purchaseInvoice.aggregate({
        where: { invoiceDate: { gte: startOfDay }, status: { not: 'CANCELLED' } },
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.cashAccount.findMany({ where: { isActive: true } }),
      this.prisma.$queryRawUnsafe<
        { id: string; sku: string; name: string; minStock: number; quantity: number; warehouseName: string }[]
      >(`
          SELECT p.id, p.sku, p.name, p.minStock, sb.quantity, w.name as warehouseName
          FROM StockBalance sb
          JOIN Product p ON p.id = sb.productId
          JOIN Warehouse w ON w.id = sb.warehouseId
          WHERE p.minStock > 0 AND sb.quantity <= p.minStock AND p.isActive = 1
          ORDER BY sb.quantity ASC
          LIMIT 10
        `),
      this.prisma.salesInvoice.findMany({
        take: 6,
        orderBy: { createdAt: 'desc' },
        include: { customer: true, createdBy: { select: { fullName: true } } },
      }),
      this.prisma.purchaseInvoice.findMany({
        take: 6,
        orderBy: { createdAt: 'desc' },
        include: { supplier: true, createdBy: { select: { fullName: true } } },
      }),
      this.prisma.customer.count({ where: { isActive: true } }),
      this.prisma.supplier.count({ where: { isActive: true } }),
      this.prisma.salesInvoice.aggregate({
        where: { invoiceDate: { gte: startOfMonth }, status: { not: 'CANCELLED' } },
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.salesInvoice.aggregate({
        where: { invoiceDate: { gte: startOfPrevMonth, lt: startOfMonth }, status: { not: 'CANCELLED' } },
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.purchaseInvoice.aggregate({
        where: { invoiceDate: { gte: startOfMonth }, status: { not: 'CANCELLED' } },
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.purchaseInvoice.aggregate({
        where: { invoiceDate: { gte: startOfPrevMonth, lt: startOfMonth }, status: { not: 'CANCELLED' } },
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.product.count({ where: { isActive: true } }),
      this.prisma.warehouse.count({ where: { isActive: true } }),
      this.prisma.salesInvoice.aggregate({
        where: { status: { in: [...openStatuses] } },
        _sum: { total: true, paidAmount: true },
        _count: true,
      }),
      this.prisma.purchaseInvoice.aggregate({
        where: { status: { in: [...openStatuses] } },
        _sum: { total: true, paidAmount: true },
        _count: true,
      }),
    ]);

    const cashBalance = cashAccounts.reduce((s, a) => s + a.balance, 0);
    const trend = await this.weekTrend(startOfDay);

    return {
      salesToday: { total: salesToday._sum.total || 0, count: salesToday._count },
      purchasesToday: { total: purchasesToday._sum.total || 0, count: purchasesToday._count },
      cashBalance,
      cashAccounts,
      lowStock,
      recentSales,
      recentPurchases,
      customersCount: customers,
      suppliersCount: suppliers,
      salesMonth: { total: salesMonth._sum.total || 0, count: salesMonth._count },
      salesPrevMonth: { total: salesPrevMonth._sum.total || 0, count: salesPrevMonth._count },
      purchasesMonth: { total: purchasesMonth._sum.total || 0, count: purchasesMonth._count },
      purchasesPrevMonth: { total: purchasesPrevMonth._sum.total || 0, count: purchasesPrevMonth._count },
      productCount,
      warehouseCount,
      receivables: {
        count: openSales._count,
        amount: Math.max(0, (openSales._sum.total || 0) - (openSales._sum.paidAmount || 0)),
      },
      payables: {
        count: openPurchases._count,
        amount: Math.max(0, (openPurchases._sum.total || 0) - (openPurchases._sum.paidAmount || 0)),
      },
      trend,
    };
  }

  private async weekTrend(startOfDay: Date) {
    const since = new Date(startOfDay);
    since.setDate(since.getDate() - 6);
    try {
      const sinceIso = since.toISOString();
      const [saleRows, purchaseRows] = await Promise.all([
        this.prisma.$queryRaw<{ day: string; total: number | null }[]>`
          SELECT substr(invoiceDate, 1, 10) AS day, SUM(total) AS total
          FROM SalesInvoice
          WHERE status != 'CANCELLED' AND invoiceDate >= ${sinceIso}
          GROUP BY substr(invoiceDate, 1, 10)
        `,
        this.prisma.$queryRaw<{ day: string; total: number | null }[]>`
          SELECT substr(invoiceDate, 1, 10) AS day, SUM(total) AS total
          FROM PurchaseInvoice
          WHERE status != 'CANCELLED' AND invoiceDate >= ${sinceIso}
          GROUP BY substr(invoiceDate, 1, 10)
        `,
      ]);
      const sales = new Map(saleRows.map((row) => [String(row.day), Number(row.total || 0)]));
      const purchases = new Map(purchaseRows.map((row) => [String(row.day), Number(row.total || 0)]));
      return Array.from({ length: 7 }, (_, index) => {
        const day = new Date(since);
        day.setDate(since.getDate() + index);
        const key = day.toISOString().slice(0, 10);
        return { day: key, sales: sales.get(key) || 0, purchases: purchases.get(key) || 0 };
      });
    } catch {
      return [];
    }
  }
}
