import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { HrLeaveType, HrMovementKind, InvoiceStatus, PayrollStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceService } from '../finance/finance.service';
import { HrSettingsService } from './hr-settings.service';
import {
  eachDayKeys, egyptDayEnd, egyptDayKey, egyptDayStart, egyptWeekday, parseTimeToMinutes,
} from './egypt-time';

@Injectable()
export class PayrollService {
  constructor(
    private prisma: PrismaService,
    private settings: HrSettingsService,
    private finance: FinanceService,
  ) {}

  async calc(from: string, to: string, employeeIds?: string[]) {
    const fromKey = egyptDayKey(from);
    const toKey = egyptDayKey(to);
    if (toKey < fromKey) throw new BadRequestException('فترة المرتب غير صحيحة');
    const settings = await this.settings.get();
    const weekends = this.settings.weekendSet(settings);
    const holidays = await this.settings.listHolidays();
    const holidayKeys = new Set<string>();
    for (const day of eachDayKeys(fromKey, toKey)) {
      for (const h of holidays) {
        const hk = egyptDayKey(h.date);
        if (h.yearly) {
          if (hk.slice(5) === day.slice(5)) holidayKeys.add(day);
        } else if (hk === day) holidayKeys.add(day);
      }
    }
    const workDays = eachDayKeys(fromKey, toKey).filter((day) => !weekends.has(egyptWeekday(day)) && !holidayKeys.has(day));
    const workMinutes = Math.max(1, parseTimeToMinutes(settings.workEnd) - parseTimeToMinutes(settings.workStart));
    const workHours = workMinutes / 60;

    const employees = await this.prisma.employee.findMany({
      where: {
        isActive: true,
        ...(employeeIds?.length ? { id: { in: employeeIds } } : {}),
      },
      include: { user: { select: { id: true, fullName: true } } },
      orderBy: { name: 'asc' },
    });

    const fromDate = egyptDayStart(fromKey);
    const toDate = egyptDayEnd(toKey);
    const overlap = await this.prisma.payrollLine.findMany({
      where: {
        employeeId: { in: employees.map((e) => e.id) },
        payrollRun: {
          status: { in: [PayrollStatus.DRAFT, PayrollStatus.POSTED] },
          fromDate: { lte: toDate },
          toDate: { gte: fromDate },
        },
      },
      include: { payrollRun: true, employee: { select: { name: true, code: true } } },
    });
    const blocked = new Set(overlap.map((row) => row.employeeId));

    const lines = [];
    const skipped: { employeeId: string; name: string; reason: string }[] = [];

    for (const emp of employees) {
      if (blocked.has(emp.id)) {
        skipped.push({
          employeeId: emp.id,
          name: emp.name,
          reason: 'الموظف موجود بالفعل في كشف مرتبات متداخل مع الفترة دي',
        });
        continue;
      }

      const [attendances, leaves, movements, sales, paidCommission] = await Promise.all([
        this.prisma.attendance.findMany({
          where: { employeeId: emp.id, date: { gte: fromDate, lte: toDate } },
        }),
        this.prisma.hrLeave.findMany({
          where: { employeeId: emp.id, fromDate: { lte: toDate }, toDate: { gte: fromDate } },
        }),
        this.prisma.hrMovement.findMany({
          where: {
            employeeId: emp.id,
            settled: false,
            movementDate: { gte: fromDate, lte: toDate },
          },
        }),
        emp.userId
          ? this.prisma.salesInvoice.aggregate({
              where: {
                createdById: emp.userId,
                status: { not: InvoiceStatus.CANCELLED },
                invoiceDate: { gte: fromDate, lte: toDate },
              },
              _sum: { total: true },
            })
          : Promise.resolve({ _sum: { total: 0 } }),
        this.prisma.hrCommissionPayment.aggregate({
          where: {
            employeeId: emp.id,
            fromDate: { lte: toDate },
            toDate: { gte: fromDate },
          },
          _sum: { amount: true },
        }),
      ]);

      const attByDay = new Map(attendances.map((a) => [egyptDayKey(a.date), a]));
      let presentDays = 0;
      let paidLeaveDays = 0;
      let permissionDays = 0;
      let unpaidDays = 0;
      let absentDays = 0;
      let lateMinutes = 0;

      for (const day of workDays) {
        const att = attByDay.get(day);
        const dayStart = egyptDayStart(day);
        const covering = leaves.filter((l) => l.fromDate <= dayStart && l.toDate >= dayStart);
        if (att && (att.status === 'PRESENT' || att.checkIn)) {
          presentDays += 1;
          lateMinutes += att.lateMinutes || 0;
          continue;
        }
        const unpaid = covering.find((l) => l.type === HrLeaveType.UNPAID);
        const permission = covering.find((l) => l.type === HrLeaveType.PERMISSION);
        const paid = covering.find((l) => l.type !== HrLeaveType.UNPAID && l.type !== HrLeaveType.PERMISSION);
        if (unpaid) unpaidDays += 1;
        else if (permission) permissionDays += 1;
        else if (paid) paidLeaveDays += 1;
        else absentDays += 1;
      }

      const permissionHours = leaves
        .filter((l) => l.type === HrLeaveType.PERMISSION)
        .reduce((sum, l) => sum + (l.hours || 0), 0);

      const dailyRate = emp.basicSalary / 30;
      const earned = dailyRate * (presentDays + paidLeaveDays + permissionDays);
      const bonuses = movements.filter((m) => m.kind === HrMovementKind.BONUS).reduce((s, m) => s + m.amount, 0);
      const deductions = movements.filter((m) => m.kind === HrMovementKind.DEDUCTION).reduce((s, m) => s + m.amount, 0);
      const advances = movements.filter((m) => m.kind === HrMovementKind.ADVANCE).reduce((s, m) => s + m.amount, 0);
      const latePenalty = (lateMinutes / workMinutes) * dailyRate;
      const permissionDeduct = (permissionHours / workHours) * dailyRate;
      const absenceDeduct = dailyRate * (absentDays + unpaidDays);
      const salaryNet = earned + bonuses - deductions - advances - latePenalty - permissionDeduct;

      const salesTotal = sales._sum.total || 0;
      const accrued = salesTotal * (emp.commissionPercent || 0) / 100;
      const alreadyPaid = paidCommission._sum.amount || 0;
      const commissionDue = Math.max(0, Math.round((accrued - alreadyPaid) * 100) / 100);
      const net = Math.round((salaryNet + commissionDue) * 100) / 100;

      lines.push({
        employeeId: emp.id,
        code: emp.code,
        name: emp.name,
        userId: emp.userId,
        basicSalary: emp.basicSalary,
        commissionPercent: emp.commissionPercent,
        dailyRate: Math.round(dailyRate * 100) / 100,
        workDays: workDays.length,
        presentDays,
        paidLeaveDays,
        permissionDays,
        unpaidDays,
        absentDays,
        lateMinutes,
        permissionHours,
        earned: Math.round(earned * 100) / 100,
        bonuses,
        deductions,
        advances,
        latePenalty: Math.round(latePenalty * 100) / 100,
        permissionDeduct: Math.round(permissionDeduct * 100) / 100,
        absenceDeduct: Math.round(absenceDeduct * 100) / 100,
        salaryNet: Math.round(salaryNet * 100) / 100,
        salesTotal,
        commissionDue,
        net,
        movementIds: movements.map((m) => m.id),
      });
    }

    return {
      from: fromKey,
      to: toKey,
      workDays: workDays.length,
      lines,
      skipped,
      totalNet: Math.round(lines.reduce((s, l) => s + l.net, 0) * 100) / 100,
      totalSalary: Math.round(lines.reduce((s, l) => s + l.salaryNet, 0) * 100) / 100,
      totalCommission: Math.round(lines.reduce((s, l) => s + l.commissionDue, 0) * 100) / 100,
    };
  }

  async createRun(data: { from: string; to: string; employeeIds?: string[]; notes?: string; methodId?: string }) {
    const preview = await this.calc(data.from, data.to, data.employeeIds);
    if (!preview.lines.length) throw new BadRequestException('مفيش موظفين يتحسبوا في الفترة دي');
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.payrollRun.create({
        data: {
          fromDate: egyptDayStart(preview.from),
          toDate: egyptDayEnd(preview.to),
          notes: data.notes?.trim() || null,
          methodId: data.methodId || null,
          status: PayrollStatus.DRAFT,
        },
      });
      for (const line of preview.lines) {
        await tx.payrollLine.create({
          data: {
            payrollRunId: run.id,
            employeeId: line.employeeId,
            basicSalary: line.basicSalary,
            dailyRate: line.dailyRate,
            presentDays: line.presentDays,
            paidLeaveDays: line.paidLeaveDays,
            permissionDays: line.permissionDays,
            unpaidDays: line.unpaidDays,
            absentDays: line.absentDays,
            lateMinutes: line.lateMinutes,
            permissionHours: line.permissionHours,
            earned: line.earned,
            bonuses: line.bonuses,
            deductions: line.deductions,
            advances: line.advances,
            latePenalty: line.latePenalty,
            permissionDeduct: line.permissionDeduct,
            absenceDeduct: line.absenceDeduct,
            salaryNet: line.salaryNet,
            commissionDue: line.commissionDue,
            net: line.net,
            detailJson: JSON.stringify(line),
          },
        });
      }
      return tx.payrollRun.findUnique({
        where: { id: run.id },
        include: {
          lines: { include: { employee: { select: { id: true, code: true, name: true } } } },
        },
      });
    });
  }

  listRuns() {
    return this.prisma.payrollRun.findMany({
      include: {
        lines: { include: { employee: { select: { id: true, code: true, name: true } } } },
        _count: { select: { lines: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findRun(id: string) {
    const run = await this.prisma.payrollRun.findUnique({
      where: { id },
      include: {
        lines: { include: { employee: { select: { id: true, code: true, name: true, userId: true } } } },
      },
    });
    if (!run) throw new NotFoundException('كشف المرتبات غير موجود');
    return run;
  }

  async post(id: string, actorId: string, methodId?: string) {
    const run = await this.findRun(id);
    if (run.status !== PayrollStatus.DRAFT) throw new BadRequestException('الكشف مترحّل بالفعل أو مش مسودة');
    const payMethodId = methodId || run.methodId;
    if (!payMethodId) throw new BadRequestException('حدد طريقة الدفع للترحيل');

    const salaryTotal = Math.round(run.lines.reduce((s, l) => s + l.salaryNet, 0) * 100) / 100;
    const commissionTotal = Math.round(run.lines.reduce((s, l) => s + l.commissionDue, 0) * 100) / 100;
    if (salaryTotal + commissionTotal <= 0) throw new BadRequestException('صافي الصرف صفر');

    const salaryCat = await this.ensureCategory('رواتب');
    const commissionCat = await this.ensureCategory('عمولات');

    if (salaryTotal > 0) {
      await this.finance.createExpense({
        categoryId: salaryCat.id,
        methodId: payMethodId,
        amount: salaryTotal,
        expenseDate: egyptDayKey(run.toDate),
        notes: `كشف مرتبات ${egyptDayKey(run.fromDate)} → ${egyptDayKey(run.toDate)}`,
      });
    }
    if (commissionTotal > 0) {
      await this.finance.createExpense({
        categoryId: commissionCat.id,
        methodId: payMethodId,
        amount: commissionTotal,
        expenseDate: egyptDayKey(run.toDate),
        notes: `عمولات مع كشف مرتبات ${egyptDayKey(run.fromDate)} → ${egyptDayKey(run.toDate)}`,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      for (const line of run.lines) {
        const detail = line.detailJson ? JSON.parse(line.detailJson) as { movementIds?: string[]; salesTotal?: number } : {};
        const employee = await tx.employee.findUnique({ where: { id: line.employeeId } });
        if (detail.movementIds?.length) {
          await tx.hrMovement.updateMany({
            where: { id: { in: detail.movementIds }, settled: false },
            data: { settled: true, payrollRunId: run.id },
          });
        }
        if (line.commissionDue > 0) {
          await tx.hrCommissionPayment.create({
            data: {
              employeeId: line.employeeId,
              payrollRunId: run.id,
              fromDate: run.fromDate,
              toDate: run.toDate,
              salesTotal: detail.salesTotal || 0,
              percent: employee?.commissionPercent || 0,
              amount: line.commissionDue,
              notes: 'صرف مع كشف المرتبات',
            },
          });
        }
      }

      await tx.payrollRun.update({
        where: { id: run.id },
        data: {
          status: PayrollStatus.POSTED,
          methodId: payMethodId,
          postedAt: new Date(),
          postedById: actorId,
        },
      });
    });

    return this.findRun(id);
  }

  async remove(id: string) {
    const run = await this.findRun(id);
    if (run.status !== PayrollStatus.DRAFT) throw new BadRequestException('ينفع تحذف المسودات فقط');
    await this.prisma.payrollRun.delete({ where: { id } });
    return { ok: true };
  }

  listPayments() {
    return this.prisma.payrollRun.findMany({
      where: { status: PayrollStatus.POSTED },
      include: {
        lines: { include: { employee: { select: { id: true, code: true, name: true } } } },
      },
      orderBy: { postedAt: 'desc' },
    });
  }

  covered(employeeId?: string) {
    return this.prisma.payrollLine.findMany({
      where: employeeId ? { employeeId } : undefined,
      include: {
        payrollRun: true,
        employee: { select: { id: true, code: true, name: true } },
      },
      orderBy: { payrollRun: { fromDate: 'desc' } },
    });
  }

  private async ensureCategory(name: string) {
    const existing = await this.prisma.expenseCategory.findUnique({ where: { name } });
    if (existing) return existing;
    return this.prisma.expenseCategory.create({ data: { name } });
  }
}
