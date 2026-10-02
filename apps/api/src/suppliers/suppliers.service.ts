import { Injectable, NotFoundException } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'نقدي',
  BANK_TRANSFER: 'تحويل بنكي',
  CHECK: 'شيك',
  CARD: 'بطاقة',
  INSTAPAY: 'إنستاباي',
  OTHER: 'أخرى',
};

@Injectable()
export class SuppliersService {
  constructor(private prisma: PrismaService) {}

  findAll(search?: string) {
    return this.prisma.supplier.findMany({
      where: search
        ? { OR: [{ name: { contains: search } }, { code: { contains: search } }] }
        : undefined,
      orderBy: { name: 'asc' },
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
        method: METHOD_LABELS[p.paymentMethod] || null,
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
        method: METHOD_LABELS[p.paymentMethod] || null,
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
