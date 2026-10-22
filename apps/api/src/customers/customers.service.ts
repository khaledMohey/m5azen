import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PriceList } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { pageResult, readPage } from '../common/paging';

export const WALK_IN_CODE = 'WALKIN';
export const WALK_IN_NAME = 'عميل سريع';

@Injectable()
export class CustomersService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    await this.ensureWalkIn().catch(() => undefined);
  }

  async ensureWalkIn() {
    const named = await this.prisma.customer.findFirst({ where: { name: WALK_IN_NAME } });
    if (named) return named;
    return this.prisma.customer.upsert({
      where: { code: WALK_IN_CODE },
      create: { code: WALK_IN_CODE, name: WALK_IN_NAME, notes: 'عميل نقدي يشتري مرة ويمشي' },
      update: {},
    });
  }

  async ensureByName(name: string) {
    const trimmed = name.trim();
    if (trimmed.length < 2) throw new BadRequestException('اسم العميل قصير');
    const existing = await this.prisma.customer.findFirst({ where: { name: trimmed } });
    if (existing) return existing;
    const code = `C${Date.now().toString(36).toUpperCase()}`;
    return this.prisma.customer.create({ data: { code, name: trimmed } });
  }

  async findAll(query?: { search?: string; page?: string; pageSize?: string; balance?: string }) {
    const page = readPage(query);
    const where = {
      ...(query?.search ? { OR: [{ name: { contains: query.search } }, { code: { contains: query.search } }] } : {}),
      ...(query?.balance === 'debit' ? { balance: { gt: 0 } } : {}),
    };
    if (!page) {
      return this.prisma.customer.findMany({ where, orderBy: { name: 'asc' } });
    }
    const [total, items, all] = await Promise.all([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({ where, orderBy: { name: 'asc' }, skip: page.skip, take: page.take }),
      this.prisma.customer.findMany({ select: { balance: true, isActive: true } }),
    ]);
    const summary = {
      debitCount: all.filter((row) => row.balance > 0).length,
      activeCount: all.filter((row) => row.isActive !== false).length,
      totalDue: all.reduce((sum, row) => sum + Math.max(0, row.balance), 0),
    };
    return pageResult(items, total, page, { summary });
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
        debit: s.subtotal + s.tax,
        credit: 0,
        method: methodName(s.paymentMethod),
        note: s.notes,
      });
      if (s.discount > 0.009) {
        rows.push({
          date: s.invoiceDate,
          type: 'خصم فاتورة',
          ref: s.number,
          debit: 0,
          credit: s.discount,
          note: 'يُخصم من إيراد الفاتورة ومن الربح',
        });
      }
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
