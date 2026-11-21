import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AccountingEvent,
  AccountingPostQueueStatus,
  HrLeaveType,
  HrMovementKind,
  InvoiceStatus,
  JournalEntryStatus,
  PayMethodKind,
  PayrollStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PostingService } from '../accounting/posting.service';
import { QueueService } from '../accounting/queue.service';
import { JournalService } from '../accounting/journal.service';
import { HrSettingsService } from './hr-settings.service';
import {
  eachDayKeys, egyptDayEnd, egyptDayKey, egyptDayStart, egyptWeekday, parseTimeToMinutes,
} from './egypt-time';
import { roundMoney, toCents } from '../accounting/money';

@Injectable()
export class PayrollService {
  constructor(
    private prisma: PrismaService,
    private settings: HrSettingsService,
    private posting: PostingService,
    private accountingQueue: QueueService,
    private journal: JournalService,
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
          status: { in: [PayrollStatus.DRAFT, PayrollStatus.POSTED, PayrollStatus.PAID] },
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

  private runTotals(run: { lines: { salaryNet: number; commissionDue: number; net: number }[] }) {
    const salaryTotal = roundMoney(run.lines.reduce((s, l) => s + l.salaryNet, 0));
    const commissionTotal = roundMoney(run.lines.reduce((s, l) => s + l.commissionDue, 0));
    const netTotal = roundMoney(run.lines.reduce((s, l) => s + l.net, 0));
    return { salaryTotal, commissionTotal, netTotal };
  }

  /**
   * اعتماد الكشف: قيد استحقاق فقط (مصروف رواتب/عمولات ↔ رواتب مستحقة).
   * لا حركة خزنة ولا مصروف تشغيلي من المالية.
   */
  async post(id: string, actorId: string, methodId?: string) {
    const run = await this.findRun(id);
    if (run.status !== PayrollStatus.DRAFT) {
      // Idempotent: already approved — return without duplicate JE
      if (run.status === PayrollStatus.POSTED || run.status === PayrollStatus.PAID) {
        return run;
      }
      throw new BadRequestException('الكشف مترحّل بالفعل أو مش مسودة');
    }

    const { salaryTotal, commissionTotal, netTotal } = this.runTotals(run);
    if (toCents(netTotal) <= 0) throw new BadRequestException('صافي الصرف صفر');

    const preferredMethodId = methodId || run.methodId || null;

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
              notes: 'استحقاق مع كشف المرتبات',
            },
          });
        }
      }

      await tx.payrollRun.update({
        where: { id: run.id },
        data: {
          status: PayrollStatus.POSTED,
          methodId: preferredMethodId,
          postedAt: new Date(),
          postedById: actorId,
        },
      });
    });

    try {
      await this.posting.postPayrollAccrual(id);
    } catch (error) {
      console.error('Accounting payroll accrual failed', error);
      try {
        await this.accountingQueue.enqueue(AccountingEvent.PAYROLL_POST, id);
      } catch (queueError) {
        console.error('Accounting payroll accrual enqueue failed', queueError);
      }
    }

    void salaryTotal;
    void commissionTotal;
    return this.findRun(id);
  }

  private payrollCashReference(runId: string) {
    return `PAYROLL-${runId}`;
  }

  private payrollCashReversalReference(runId: string) {
    return `REV-PAYROLL-${runId}`;
  }

  /**
   * صرف الكشف بالكامل: claim ذري + حركة خزنة + outbox محاسبي في معاملة واحدة.
   * لا ينشئ Expense / EXPENSE_CREATE.
   */
  async pay(id: string, actorId: string, methodId?: string) {
    const run = await this.findRun(id);
    // قراءة تمهيدية فقط — الحسم النهائي داخل updateMany الشرطي
    if (run.status === PayrollStatus.PAID && toCents(run.paidAmount) > 0) {
      return run;
    }
    if (run.status === PayrollStatus.DRAFT) {
      throw new BadRequestException('اعتمد الكشف أولًا قبل الصرف');
    }

    const payMethodId = methodId || run.methodId;
    if (!payMethodId) throw new BadRequestException('حدد طريقة الدفع للصرف');

    const method = await this.prisma.payMethod.findUnique({ where: { id: payMethodId } });
    if (!method || method.kind !== PayMethodKind.IMMEDIATE || !method.cashAccountId) {
      throw new BadRequestException('صرف المرتبات من طريقة دفع فورية مربوطة بخزنة');
    }

    const { netTotal } = this.runTotals(run);
    if (toCents(netTotal) <= 0) throw new BadRequestException('صافي الصرف صفر');

    const accrual = await this.prisma.journalEntry.findUnique({
      where: {
        sourceType_sourceId: {
          sourceType: AccountingEvent.PAYROLL_POST,
          sourceId: id,
        },
      },
    });
    if (!accrual || accrual.status !== JournalEntryStatus.POSTED) {
      try {
        await this.posting.postPayrollAccrual(id);
      } catch {
        await this.accountingQueue.enqueue(AccountingEvent.PAYROLL_POST, id);
        throw new BadRequestException('قيد الاستحقاق غير جاهز — أعد محاولة الصرف بعد معالجة الطابور');
      }
    }

    const paidAt = new Date();
    const cashRef = this.payrollCashReference(id);
    const payload = {
      amount: netTotal,
      cashAccountId: method.cashAccountId,
      methodId: payMethodId,
    };

    try {
      await this.prisma.$transaction(async (tx) => {
        // 1) claim ذري — طلبان متزامنان: واحد فقط count=1
        const claimed = await tx.payrollRun.updateMany({
          where: {
            id,
            status: PayrollStatus.POSTED,
            paidAmount: 0,
          },
          data: {
            status: PayrollStatus.PAID,
            methodId: payMethodId,
            accountId: method.cashAccountId,
            paidAmount: netTotal,
            paidAt,
            paidById: actorId,
          },
        });
        if (claimed.count !== 1) {
          throw new BadRequestException('PAYROLL_PAY_CLAIM_FAILED');
        }

        // 2) حركة نقدية واحدة
        await tx.cashAccount.update({
          where: { id: method.cashAccountId! },
          data: { balance: { decrement: netTotal } },
        });
        await tx.cashTransaction.create({
          data: {
            accountId: method.cashAccountId!,
            direction: 'OUT',
            amount: netTotal,
            description: `صرف مرتبات ${egyptDayKey(run.fromDate)} → ${egyptDayKey(run.toDate)}`,
            paymentMethod: payMethodId,
            reference: cashRef,
            createdById: actorId,
          },
        });

        // 3) outbox محاسبي في نفس المعاملة
        await this.accountingQueue.enqueueInTx(
          tx,
          AccountingEvent.PAYROLL_PAYMENT,
          id,
          payload,
        );
      });
    } catch (error) {
      const current = await this.findRun(id);
      if (current.status === PayrollStatus.PAID && toCents(current.paidAmount) > 0) {
        // طلب منافس فاز بالـ claim — رجوع آمن بدون صرف ثانٍ
        return current;
      }
      if (error instanceof BadRequestException && error.message === 'PAYROLL_PAY_CLAIM_FAILED') {
        throw new BadRequestException('تعذر صرف الكشف — مش معتمد أو اتصرّف بالفعل');
      }
      throw error;
    }

    // ترحيل فوري اختياري؛ الطابور يضمن الاسترداد إن فشل
    try {
      const entry = await this.posting.postPayrollPayment(id, {
        amount: netTotal,
        cashAccountId: method.cashAccountId,
        methodId: payMethodId,
        entryDate: paidAt,
      });
      await this.prisma.accountingPostQueue.updateMany({
        where: {
          event: AccountingEvent.PAYROLL_PAYMENT,
          sourceId: id,
          status: {
            in: [
              AccountingPostQueueStatus.PENDING,
              AccountingPostQueueStatus.FAILED,
              AccountingPostQueueStatus.PROCESSING,
            ],
          },
        },
        data: {
          status: AccountingPostQueueStatus.POSTED,
          postedEntryId: entry.id,
          lockedBy: null,
          leaseExpiresAt: null,
          lastError: null,
        },
      });
    } catch (error) {
      console.error('Accounting payroll payment post deferred to queue', error);
    }

    return this.findRun(id);
  }

  /**
   * عكس صرف كشف مدفوع: قيد الصرف (إن وُجد) ثم حركة خزنة IN مطابقة + إعادة الحالة POSTED.
   * لا يحذف حركة OUT الأصلية.
   */
  async reversePayment(id: string, actorId: string, reason?: string) {
    const run = await this.findRun(id);
    if (run.status !== PayrollStatus.PAID || toCents(run.paidAmount) <= 0) {
      throw new BadRequestException('عكس الصرف للكشوف المصروفة فقط');
    }
    if (!run.accountId) {
      throw new BadRequestException('خزنة الصرف غير مسجّلة على الكشف — راجع يدويًا');
    }

    const queueRow = await this.prisma.accountingPostQueue.findUnique({
      where: {
        event_sourceId: {
          event: AccountingEvent.PAYROLL_PAYMENT,
          sourceId: id,
        },
      },
    });
    if (queueRow?.status === AccountingPostQueueStatus.PROCESSING) {
      throw new BadRequestException('ترحيل قيد الصرف قيد المعالجة — أعد المحاولة بعد انتهاء الطابور');
    }

    const paymentJe = await this.prisma.journalEntry.findUnique({
      where: {
        sourceType_sourceId: {
          sourceType: AccountingEvent.PAYROLL_PAYMENT,
          sourceId: id,
        },
      },
    });

    if (paymentJe?.status === JournalEntryStatus.POSTED) {
      await this.journal.reverse(paymentJe.id, {
        userId: actorId,
        reason: reason || 'عكس صرف مرتبات',
      });
      await this.prisma.journalEntry.update({
        where: { id: paymentJe.id },
        data: { sourceId: `ARCH-PAY-${id}-${paymentJe.id}` },
      });
    } else if (paymentJe && paymentJe.status !== JournalEntryStatus.REVERSED) {
      throw new BadRequestException('حالة قيد الصرف لا تسمح بالعكس التلقائي');
    }

    if (queueRow && queueRow.status !== AccountingPostQueueStatus.POSTED) {
      await this.accountingQueue.cancel(queueRow.id, reason || 'إلغاء outbox بعد عكس صرف المرتبات');
    }

    const amount = roundMoney(run.paidAmount);
    const cashOutRef = this.payrollCashReference(id);
    const cashInRef = this.payrollCashReversalReference(id);

    try {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.payrollRun.updateMany({
          where: {
            id,
            status: PayrollStatus.PAID,
            paidAmount: amount,
          },
          data: {
            status: PayrollStatus.POSTED,
            paidAmount: 0,
            paidAt: null,
            paidById: null,
          },
        });
        if (claimed.count !== 1) {
          throw new BadRequestException('PAYROLL_UNPAY_CLAIM_FAILED');
        }

        const existingOut = await tx.cashTransaction.findFirst({
          where: { reference: cashOutRef, direction: 'OUT', accountId: run.accountId! },
        });
        if (!existingOut) {
          throw new BadRequestException('حركة صرف الخزنة الأصلية غير موجودة — لا عكس تلقائي');
        }
        const alreadyReversed = await tx.cashTransaction.findFirst({
          where: { reference: cashInRef, direction: 'IN', accountId: run.accountId! },
        });
        if (alreadyReversed) {
          throw new BadRequestException('عكس حركة الخزنة مسجّل مسبقًا');
        }

        await tx.cashAccount.update({
          where: { id: run.accountId! },
          data: { balance: { increment: amount } },
        });
        await tx.cashTransaction.create({
          data: {
            accountId: run.accountId!,
            direction: 'IN',
            amount,
            description: `عكس صرف مرتبات ${egyptDayKey(run.fromDate)} → ${egyptDayKey(run.toDate)}`,
            paymentMethod: run.methodId || '',
            reference: cashInRef,
            createdById: actorId,
          },
        });
      });
    } catch (error) {
      if (error instanceof BadRequestException && error.message === 'PAYROLL_UNPAY_CLAIM_FAILED') {
        throw new BadRequestException('تعذر عكس الصرف — الحالة تغيّرت');
      }
      throw error;
    }

    return this.findRun(id);
  }

  /**
   * عكس قيد الاستحقاق فقط إن لم يُصرف الكشف. لا يحذف القيود المرحّلة.
   */
  async reverseAccrual(id: string, actorId: string, reason?: string) {
    const run = await this.findRun(id);
    if (run.status === PayrollStatus.PAID || toCents(run.paidAmount) > 0) {
      throw new BadRequestException(
        'الكشف مدفوع — استخدم عكس الصرف أولًا ثم عكس الاستحقاق',
      );
    }
    if (run.status !== PayrollStatus.POSTED) {
      throw new BadRequestException('عكس الاستحقاق للكشوف المعتمدة غير المدفوعة فقط');
    }

    const accrual = await this.prisma.journalEntry.findUnique({
      where: {
        sourceType_sourceId: {
          sourceType: AccountingEvent.PAYROLL_POST,
          sourceId: id,
        },
      },
    });
    if (!accrual) throw new NotFoundException('قيد الاستحقاق غير موجود');
    if (accrual.status === JournalEntryStatus.REVERSED) {
      throw new BadRequestException('القيد معكوس بالفعل');
    }

    await this.journal.reverse(accrual.id, {
      userId: actorId,
      reason: reason || 'عكس استحقاق مرتبات',
    });

    // حرّر مفتاح المصدر حتى يمكن إعادة اعتماد الكشف لاحقًا دون تكرار صامت للقيد المعكوس
    await this.prisma.journalEntry.update({
      where: { id: accrual.id },
      data: { sourceId: `ARCH-${id}-${accrual.id}` },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.hrMovement.updateMany({
        where: { payrollRunId: id },
        data: { settled: false, payrollRunId: null },
      });
      await tx.hrCommissionPayment.deleteMany({ where: { payrollRunId: id } });
      await tx.payrollRun.update({
        where: { id },
        data: {
          status: PayrollStatus.DRAFT,
          postedAt: null,
          postedById: null,
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
      where: { status: { in: [PayrollStatus.POSTED, PayrollStatus.PAID] } },
      include: {
        lines: { include: { employee: { select: { id: true, code: true, name: true } } } },
      },
      orderBy: [{ paidAt: 'desc' }, { postedAt: 'desc' }],
    });
  }

  /**
   * أرصدة مستحقة تشغيلية حسب الموظف من سطور الكشوف غير المدفوعة.
   * ليس أستاذ GL فرعيًا (لا employeeId على JournalLine).
   */
  async employeePayables() {
    const lines = await this.prisma.payrollLine.findMany({
      where: { payrollRun: { status: PayrollStatus.POSTED } },
      include: {
        employee: { select: { id: true, code: true, name: true } },
        payrollRun: { select: { id: true, fromDate: true, toDate: true, status: true, paidAmount: true } },
      },
      orderBy: { payrollRun: { fromDate: 'desc' } },
    });
    const byEmployee = new Map<string, {
      employeeId: string;
      code: string;
      name: string;
      outstanding: number;
      runs: { payrollRunId: string; fromDate: Date; toDate: Date; net: number }[];
    }>();
    for (const line of lines) {
      const key = line.employeeId;
      const row = byEmployee.get(key) || {
        employeeId: line.employeeId,
        code: line.employee.code,
        name: line.employee.name,
        outstanding: 0,
        runs: [],
      };
      row.outstanding = roundMoney(row.outstanding + line.net);
      row.runs.push({
        payrollRunId: line.payrollRunId,
        fromDate: line.payrollRun.fromDate,
        toDate: line.payrollRun.toDate,
        net: line.net,
      });
      byEmployee.set(key, row);
    }
    return [...byEmployee.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
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
}
