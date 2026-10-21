import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { pageResult, readPage } from '../common/paging';

@Injectable()
export class SuppliersService {
  constructor(private prisma: PrismaService) {}

  async findAll(query?: { search?: string; page?: string; pageSize?: string; balance?: string }) {
    const page = readPage(query);
    const where = {
      ...(query?.search ? { OR: [{ name: { contains: query.search } }, { code: { contains: query.search } }] } : {}),
      ...(query?.balance === 'debit' ? { balance: { gt: 0 } } : {}),
      ...(query?.balance === 'credit' ? { balance: { lt: 0 } } : {}),
    };
    if (!page) return this.prisma.supplier.findMany({ where, orderBy: { name: 'asc' } });
    const [total, items, all] = await Promise.all([
      this.prisma.supplier.count({ where }),
      this.prisma.supplier.findMany({ where, orderBy: { name: 'asc' }, skip: page.skip, take: page.take }),
      this.prisma.supplier.findMany({ select: { balance: true } }),
    ]);
    return pageResult(items, total, page, {
      summary: {
        debitCount: all.filter((row) => row.balance > 0).length,
        creditCount: all.filter((row) => row.balance < 0).length,
      },
    });
  }

  async findOne(id: string) {
    const s = await this.prisma.supplier.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('المورد غير موجود');
    return s;
  }

  create(data: {
    code: string;
    name: string;
    phone?: string;
    email?: string;
    address?: string;
    notes?: string;
  }) {
    return this.prisma.supplier.create({ data });
  }

  update(id: string, data: Partial<{
    code: string; name: string; phone: string; email: string; address: string; notes: string; isActive: boolean;
  }>) {
    return this.prisma.supplier.update({ where: { id }, data });
  }

  async statement(id: string) {
    const methods = await this.prisma.payMethod.findMany();
    const methodName = (value?: string | null) => methods.find((m) => m.id === value)?.name || null;
    const supplier = await this.findOne(id);
    const purchases = await this.prisma.purchaseInvoice.findMany({
      where: { supplierId: id, status: { not: 'CANCELLED' } },
      orderBy: { invoiceDate: 'asc' },
    });
    const payments = await this.prisma.payment.findMany({
      where: { supplierId: id },
      orderBy: { paidAt: 'asc' },
    });
    const returns = await this.prisma.purchaseReturn.findMany({
      where: { supplierId: id },
      orderBy: { returnDate: 'asc' },
    });

    type Row = {
      date: Date;
      type: string;
      ref: string;
      debit: number;
      credit: number;
      method?: string | null;
      note?: string | null;
    };
    const rows: Row[] = [];
    for (const p of purchases) {
      rows.push({
        date: p.invoiceDate,
        type: 'فاتورة شراء',
        ref: p.number,
        debit: p.total,
        credit: 0,
        method: methodName(p.paymentMethod),
        note: p.notes,
      });
    }
    for (const p of payments) {
      rows.push({
        date: p.paidAt,
        type: 'سداد',
        ref: p.number,
        debit: 0,
        credit: p.amount,
        method: methodName(p.paymentMethod),
        note: [p.note, p.referenceNo ? `مرجع: ${p.referenceNo}` : null].filter(Boolean).join(' — ') || null,
      });
    }
    for (const r of returns) {
      rows.push({
        date: r.returnDate,
        type: 'مرتجع شراء',
        ref: r.number,
        debit: 0,
        credit: r.total,
        note: r.notes,
      });
    }
    rows.sort((a, b) => a.date.getTime() - b.date.getTime());
    let running = 0;
    const statement = rows.map((r) => {
      running += r.debit - r.credit;
      return { ...r, balance: running };
    });
    return { supplier, statement, balance: supplier.balance };
  }
}
