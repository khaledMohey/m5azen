import { Injectable, NotFoundException } from '@nestjs/common';
import { PriceList } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  findAll(search?: string) {
    return this.prisma.customer.findMany({
      where: search
        ? { OR: [{ name: { contains: search } }, { code: { contains: search } }] }
        : undefined,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const c = await this.prisma.customer.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('العميل غير موجود');
    return c;
  }

  create(data: {
    code: string;
    name: string;
    phone?: string;
    email?: string;
    address?: string;
    creditLimit?: number;
    priceList?: PriceList;
    notes?: string;
  }) {
    return this.prisma.customer.create({ data });
  }

  bulkSetActive(ids: string[], isActive: boolean) {
    const unique = [...new Set(ids)].slice(0, 200);
    if (!unique.length) return Promise.resolve({ updated: 0 });
    return this.prisma.customer.updateMany({ where: { id: { in: unique } }, data: { isActive } }).then((result) => ({ updated: result.count }));
  }

  update(id: string, data: Partial<{
    code: string; name: string; phone: string; email: string; address: string;
    creditLimit: number; priceList: PriceList; notes: string; isActive: boolean;
  }>) {
    return this.prisma.customer.update({ where: { id }, data });
  }

  listPrices(customerId: string) {
    return this.prisma.customerPrice.findMany({
      where: { customerId },
      include: { product: true },
    });
  }

  async setPrices(customerId: string, prices: { productId: string; price: number }[]) {
    await this.findOne(customerId);
    await this.prisma.customerPrice.deleteMany({ where: { customerId } });
    const rows = prices.filter((p) => p.price > 0);
    if (rows.length) {
      await this.prisma.customerPrice.createMany({
        data: rows.map((p) => ({ customerId, productId: p.productId, price: p.price })),
      });
    }
    return this.listPrices(customerId);
  }

  async statement(id: string) {
    const methods = await this.prisma.payMethod.findMany();
    const methodName = (value?: string | null) => methods.find((m) => m.id === value)?.name || null;
    const customer = await this.findOne(id);
    const sales = await this.prisma.salesInvoice.findMany({
      where: { customerId: id, status: { not: 'CANCELLED' } },
      orderBy: { invoiceDate: 'asc' },
    });
    const receipts = await this.prisma.receipt.findMany({
      where: { customerId: id },
      orderBy: { receivedAt: 'asc' },
    });
    const returns = await this.prisma.salesReturn.findMany({
      where: { customerId: id },
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
    for (const s of sales) {
      rows.push({
        date: s.invoiceDate,
        type: 'فاتورة بيع',
        ref: s.number,
        debit: s.total,
        credit: 0,
        method: methodName(s.paymentMethod),
        note: s.notes,
      });
    }
    for (const r of receipts) {
      rows.push({
        date: r.receivedAt,
        type: 'تحصيل',
        ref: r.number,
        debit: 0,
        credit: r.amount,
        method: methodName(r.paymentMethod),
        note: [r.note, r.referenceNo ? `مرجع: ${r.referenceNo}` : null].filter(Boolean).join(' — ') || null,
      });
    }
    for (const r of returns) {
      rows.push({
        date: r.returnDate,
        type: 'مرتجع بيع',
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
    return { customer, statement, balance: customer.balance };
  }
}
