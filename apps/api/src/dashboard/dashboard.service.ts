import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async summary() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [salesToday, purchasesToday, cashAccounts, lowStock, recentSales, recentPurchases, customers, suppliers] =
      await Promise.all([
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
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { customer: true },
        }),
        this.prisma.purchaseInvoice.findMany({
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { supplier: true },
        }),
        this.prisma.customer.count({ where: { isActive: true } }),
        this.prisma.supplier.count({ where: { isActive: true } }),
      ]);

    const cashBalance = cashAccounts.reduce((s, a) => s + a.balance, 0);

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
    };
  }
}
