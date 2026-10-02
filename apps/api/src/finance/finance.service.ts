import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CheckDirection, CheckStatus, PaymentMethod, ShiftStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FinanceService {
  constructor(private prisma: PrismaService) {}

  async openShift(data: { userId: string; cashAccountId: string; openingCash: number; notes?: string }) {
    const existing = await this.prisma.cashierShift.findFirst({
      where: { userId: data.userId, status: ShiftStatus.OPEN },
    });
    if (existing) throw new BadRequestException('عندك وردية مفتوحة بالفعل. قفلها أو كمّل البيع من غيرها');
    return this.prisma.cashierShift.create({
      data: {
        userId: data.userId,
        cashAccountId: data.cashAccountId,
        openingCash: data.openingCash || 0,
        notes: data.notes,
      },
      include: { account: true, user: { select: { fullName: true } } },
    });
  }

  currentShift(userId: string) {
    return this.prisma.cashierShift.findFirst({
      where: { userId, status: ShiftStatus.OPEN },
      include: { account: true },
    });
  }

  listShifts() {
    return this.prisma.cashierShift.findMany({
      include: { account: true, user: { select: { fullName: true } } },
      orderBy: { openedAt: 'desc' },
      take: 50,
    });
  }

  async closeShift(id: string, data: { closingCash: number; notes?: string }) {
    const shift = await this.prisma.cashierShift.findUnique({ where: { id } });
    if (!shift || shift.status !== ShiftStatus.OPEN) throw new BadRequestException('الوردية مش مفتوحة');
    const [receipts, expenses] = await Promise.all([
      this.prisma.receipt.findMany({ where: { shiftId: id, paymentMethod: PaymentMethod.CASH } }),
      this.prisma.expense.findMany({ where: { shiftId: id, paymentMethod: PaymentMethod.CASH } }),
    ]);
    const cashIn = receipts.reduce((s, r) => s + r.amount, 0);
    const cashOut = expenses.reduce((s, e) => s + e.amount, 0);
    const expectedCash = shift.openingCash + cashIn - cashOut;
    const difference = Math.round((data.closingCash - expectedCash) * 100) / 100;
    return this.prisma.cashierShift.update({
      where: { id },
      data: {
        status: ShiftStatus.CLOSED,
        closingCash: data.closingCash,
        expectedCash,
        difference,
        notes: data.notes ?? shift.notes,
        closedAt: new Date(),
      },
      include: { account: true, user: { select: { fullName: true } } },
    });
  }

  listExpenseCategories() {
    return this.prisma.expenseCategory.findMany({ orderBy: { name: 'asc' } });
  }

  createExpenseCategory(name: string) {
    return this.prisma.expenseCategory.create({ data: { name: name.trim() } });
  }

  listExpenses() {
    return this.prisma.expense.findMany({
      include: { category: true, account: true },
      orderBy: { expenseDate: 'desc' },
    });
  }

  async createExpense(data: {
    categoryId: string;
    accountId: string;
    amount: number;
    expenseDate?: string;
    paymentMethod?: PaymentMethod;
    notes?: string;
    shiftId?: string | null;
  }) {
    if (data.amount <= 0) throw new BadRequestException('المبلغ لازم يكون أكبر من صفر');
    const account = await this.prisma.cashAccount.findUnique({ where: { id: data.accountId } });
    if (!account) throw new NotFoundException('حساب الخزنة غير موجود');
    return this.prisma.$transaction(async (tx) => {
      await tx.cashAccount.update({
        where: { id: data.accountId },
        data: { balance: { decrement: data.amount } },
      });
      const category = await tx.expenseCategory.findUnique({ where: { id: data.categoryId } });
      await tx.cashTransaction.create({
        data: {
          accountId: data.accountId,
          direction: 'OUT',
          amount: data.amount,
          description: `مصروف${category ? `: ${category.name}` : ''}${data.notes ? ` - ${data.notes}` : ''}`,
          paymentMethod: data.paymentMethod || PaymentMethod.CASH,
        },
      });
      return tx.expense.create({
        data: {
          categoryId: data.categoryId,
          accountId: data.accountId,
          amount: data.amount,
          expenseDate: data.expenseDate ? new Date(data.expenseDate) : new Date(),
          paymentMethod: data.paymentMethod || PaymentMethod.CASH,
          notes: data.notes,
          shiftId: data.shiftId || null,
        },
        include: { category: true, account: true },
      });
    });
  }

  listChecks() {
    return this.prisma.bankCheck.findMany({
      include: { customer: true, supplier: true, account: true },
      orderBy: { dueDate: 'asc' },
    });
  }

  createCheck(data: {
    direction: CheckDirection;
    checkNumber: string;
    bankName: string;
    amount: number;
    issueDate?: string;
    dueDate: string;
    customerId?: string;
    supplierId?: string;
    notes?: string;
  }) {
    if (data.amount <= 0) throw new BadRequestException('مبلغ الشيك لازم يكون أكبر من صفر');
    return this.prisma.bankCheck.create({
      data: {
        direction: data.direction,
        checkNumber: data.checkNumber,
        bankName: data.bankName,
        amount: data.amount,
        issueDate: data.issueDate ? new Date(data.issueDate) : new Date(),
        dueDate: new Date(data.dueDate),
        customerId: data.customerId || null,
        supplierId: data.supplierId || null,
        notes: data.notes,
      },
      include: { customer: true, supplier: true },
    });
  }

  async setCheckStatus(id: string, status: CheckStatus, accountId?: string) {
    const check = await this.prisma.bankCheck.findUnique({ where: { id } });
    if (!check) throw new NotFoundException('الشيك غير موجود');
    if (check.status === status) return check;

    return this.prisma.$transaction(async (tx) => {
      const wasCleared = check.status === CheckStatus.CLEARED;
      const willClear = status === CheckStatus.CLEARED;
      const targetAccount = accountId || check.accountId;
      if (willClear) {
        if (!targetAccount) throw new BadRequestException('اختر حساب الخزنة عند التحصيل أو الصرف');
        const sign = check.direction === CheckDirection.IN ? 1 : -1;
        await tx.cashAccount.update({
          where: { id: targetAccount },
          data: { balance: { increment: sign * check.amount } },
        });
        await tx.cashTransaction.create({
          data: {
            accountId: targetAccount,
            direction: sign > 0 ? 'IN' : 'OUT',
            amount: check.amount,
            description: `شيك ${check.checkNumber} - ${check.bankName}`,
            paymentMethod: PaymentMethod.CHECK,
            reference: check.checkNumber,
          },
        });
      } else if (wasCleared && check.accountId) {
        const sign = check.direction === CheckDirection.IN ? -1 : 1;
        await tx.cashAccount.update({
          where: { id: check.accountId },
          data: { balance: { increment: sign * check.amount } },
        });
        await tx.cashTransaction.deleteMany({
          where: { reference: check.checkNumber, accountId: check.accountId, paymentMethod: PaymentMethod.CHECK },
        });
      }
      return tx.bankCheck.update({
        where: { id },
        data: { status, accountId: willClear ? targetAccount : check.accountId },
        include: { customer: true, supplier: true, account: true },
      });
    });
  }
}
