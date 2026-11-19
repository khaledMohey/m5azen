import { BadRequestException, Injectable } from '@nestjs/common';
import { InvoiceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { egyptDayEnd, egyptDayKey, egyptDayStart } from './egypt-time';

@Injectable()
export class CommissionsService {
  constructor(private prisma: PrismaService) {}

  async summary(from?: string, to?: string) {
    const fromKey = from ? egyptDayKey(from) : egyptDayKey(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const toKey = to ? egyptDayKey(to) : egyptDayKey();
    const fromDate = egyptDayStart(fromKey);
    const toDate = egyptDayEnd(toKey);

    const employees = await this.prisma.employee.findMany({
      where: { isActive: true },
      include: { user: { select: { id: true, username: true, fullName: true } } },
      orderBy: { name: 'asc' },
    });

    const rows = [];
    for (const emp of employees) {
      const salesTotal = emp.userId
        ? (await this.prisma.salesInvoice.aggregate({
            where: {
              createdById: emp.userId,
              status: { not: InvoiceStatus.CANCELLED },
              invoiceDate: { gte: fromDate, lte: toDate },
            },
            _sum: { total: true },
          }))._sum.total || 0
        : 0;
      const accrued = salesTotal * (emp.commissionPercent || 0) / 100;
      const paid = (await this.prisma.hrCommissionPayment.aggregate({
        where: {
          employeeId: emp.id,
          fromDate: { lte: toDate },
          toDate: { gte: fromDate },
        },
        _sum: { amount: true },
      }))._sum.amount || 0;
      rows.push({
        employeeId: emp.id,
        code: emp.code,
        name: emp.name,
        linked: !!emp.userId,
        userId: emp.userId,
        userName: emp.user?.fullName || null,
        commissionPercent: emp.commissionPercent,
        salesTotal,
        accrued: Math.round(accrued * 100) / 100,
        paid,
        remaining: Math.max(0, Math.round((accrued - paid) * 100) / 100),
      });
    }

    const linkedUserIds = new Set(employees.map((e) => e.userId).filter(Boolean) as string[]);
    const unlinkedInvoices = await this.prisma.salesInvoice.findMany({
      where: {
        status: { not: InvoiceStatus.CANCELLED },
        invoiceDate: { gte: fromDate, lte: toDate },
        createdById: { not: null },
      },
      select: {
        id: true,
        number: true,
        total: true,
        invoiceDate: true,
        createdById: true,
        createdBy: { select: { id: true, username: true, fullName: true } },
      },
      orderBy: { invoiceDate: 'desc' },
      take: 200,
    });
    const byUser = new Map<string, { userId: string; fullName: string; username: string; salesTotal: number; count: number }>();
    for (const inv of unlinkedInvoices) {
      if (!inv.createdById || linkedUserIds.has(inv.createdById)) continue;
      const cur = byUser.get(inv.createdById) || {
        userId: inv.createdById,
        fullName: inv.createdBy?.fullName || '',
        username: inv.createdBy?.username || '',
        salesTotal: 0,
        count: 0,
      };
      cur.salesTotal += inv.total;
      cur.count += 1;
      byUser.set(inv.createdById, cur);
    }

    return {
      from: fromKey,
      to: toKey,
      rows,
      unlinkedSales: [...byUser.values()].map((row) => ({
        ...row,
        salesTotal: Math.round(row.salesTotal * 100) / 100,
      })),
    };
  }

  listPayments(from?: string, to?: string) {
    const fromDate = from ? egyptDayStart(egyptDayKey(from)) : undefined;
    const toDate = to ? egyptDayEnd(egyptDayKey(to)) : undefined;
    return this.prisma.hrCommissionPayment.findMany({
      where: {
        ...(fromDate || toDate
          ? { paidAt: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } }
          : {}),
      },
      include: { employee: { select: { id: true, code: true, name: true } } },
      orderBy: { paidAt: 'desc' },
    });
  }

  pay() {
    throw new BadRequestException('صرف العمولة بقى ضمن كشف المرتبات فقط — احسب كشف ورحّله');
  }
}
