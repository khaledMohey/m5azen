import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { PayMethodKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const LEGACY = new Set(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'INSTAPAY', 'OTHER']);

@Injectable()
export class PayMethodsService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    await this.ensure();
  }

  async list() {
    await this.ensure();
    return this.prisma.payMethod.findMany({
      where: { isActive: true },
      include: { cashAccount: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async create(data: { name: string; code: string; kind?: PayMethodKind | string; accountType?: string; balance?: number }) {
    const name = data.name.trim();
    const code = data.code.trim().toUpperCase();
    if (name.length < 2) throw new BadRequestException('اسم طريقة الدفع حرفين على الأقل');
    if (!code) throw new BadRequestException('كود طريقة الدفع مطلوب');
    const kind = data.kind === 'CHECK' || data.kind === PayMethodKind.CHECK ? PayMethodKind.CHECK : PayMethodKind.IMMEDIATE;
    const exists = await this.prisma.payMethod.findUnique({ where: { code } });
    if (exists) throw new BadRequestException('الكود مستخدم لطريقة دفع أخرى');
    if (kind === PayMethodKind.CHECK) {
      return this.prisma.payMethod.create({ data: { code, name, kind, sortOrder: 100 } });
    }
    const accountTaken = await this.prisma.cashAccount.findUnique({ where: { code } });
    if (accountTaken) throw new BadRequestException('الكود مستخدم لحساب موجود');
    const account = await this.prisma.cashAccount.create({
      data: {
        code,
        name,
        accountType: data.accountType === 'BANK' ? 'BANK' : 'CASH',
        balance: data.balance || 0,
      },
    });
    return this.prisma.payMethod.create({
      data: { code, name, kind, cashAccountId: account.id, sortOrder: data.accountType === 'BANK' ? 20 : 10 },
      include: { cashAccount: true },
    });
  }

  async ensure() {
    let check = await this.prisma.payMethod.findUnique({ where: { code: 'CHECK' } });
    if (!check) {
      check = await this.prisma.payMethod.create({
        data: { code: 'CHECK', name: 'شيك', kind: PayMethodKind.CHECK, sortOrder: 100 },
      });
    }
    const accounts = await this.prisma.cashAccount.findMany();
    for (const account of accounts) {
      const linked = await this.prisma.payMethod.findUnique({ where: { cashAccountId: account.id } });
      if (linked) continue;
      let code = account.code.trim().toUpperCase();
      const clash = await this.prisma.payMethod.findUnique({ where: { code } });
      if (clash) code = `${code}-ACC`;
      await this.prisma.payMethod.create({
        data: {
          code,
          name: account.name,
          kind: PayMethodKind.IMMEDIATE,
          cashAccountId: account.id,
          sortOrder: account.accountType === 'BANK' ? 20 : 10,
        },
      });
    }
    await this.remapLegacy(check.id);
  }

  private async remapLegacy(checkId: string) {
    const flag = await this.prisma.setting.findUnique({ where: { key: 'payMethodsMigrated' } });
    if (flag) return;
    const methods = await this.prisma.payMethod.findMany();
    const byAccount = new Map(methods.filter((m) => m.cashAccountId).map((m) => [m.cashAccountId as string, m.id]));
    const fallback = methods.find((m) => m.kind === PayMethodKind.IMMEDIATE)?.id || checkId;
    const resolve = (current: string, accountId?: string | null) => {
      if (!LEGACY.has(current)) return current;
      if (current === 'CHECK') return checkId;
      if (accountId && byAccount.get(accountId)) return byAccount.get(accountId) as string;
      return fallback;
    };

    const receipts = await this.prisma.receipt.findMany();
    for (const row of receipts) {
      const next = resolve(row.paymentMethod, row.cashAccountId);
      if (next !== row.paymentMethod) await this.prisma.receipt.update({ where: { id: row.id }, data: { paymentMethod: next } });
      row.paymentMethod = next;
    }
    const payments = await this.prisma.payment.findMany();
    for (const row of payments) {
      const next = resolve(row.paymentMethod, row.cashAccountId);
      if (next !== row.paymentMethod) await this.prisma.payment.update({ where: { id: row.id }, data: { paymentMethod: next } });
    }
    const txs = await this.prisma.cashTransaction.findMany();
    for (const row of txs) {
      const next = resolve(row.paymentMethod, row.accountId);
      if (next !== row.paymentMethod) await this.prisma.cashTransaction.update({ where: { id: row.id }, data: { paymentMethod: next } });
    }
    const expenses = await this.prisma.expense.findMany();
    for (const row of expenses) {
      const next = resolve(row.paymentMethod, row.accountId);
      if (next !== row.paymentMethod) await this.prisma.expense.update({ where: { id: row.id }, data: { paymentMethod: next } });
    }
    const sales = await this.prisma.salesInvoice.findMany();
    for (const row of sales) {
      if (!LEGACY.has(row.paymentMethod)) continue;
      const ids = [...new Set(receipts.filter((r) => r.salesInvoiceId === row.id).map((r) => r.paymentMethod))];
      const next = row.paymentMethod === 'CHECK' ? checkId : ids[0] || fallback;
      await this.prisma.salesInvoice.update({ where: { id: row.id }, data: { paymentMethod: next } });
    }
    const purchases = await this.prisma.purchaseInvoice.findMany();
    for (const row of purchases) {
      if (!LEGACY.has(row.paymentMethod)) continue;
      const linked = payments.filter((p) => p.purchaseInvoiceId === row.id);
      const next = row.paymentMethod === 'CHECK' ? checkId : resolve(row.paymentMethod, linked[0]?.cashAccountId);
      await this.prisma.purchaseInvoice.update({ where: { id: row.id }, data: { paymentMethod: next } });
    }
    await this.prisma.setting.upsert({
      where: { key: 'payMethodsMigrated' },
      create: { key: 'payMethodsMigrated', value: '1' },
      update: { value: '1' },
    });
  }
}
