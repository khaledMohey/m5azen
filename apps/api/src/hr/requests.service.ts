import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { HrLeaveType, HrMovementKind, HrRequestKind, HrRequestStatus, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { egyptDayKey, egyptDayStart } from './egypt-time';

type Actor = { userId: string; role: string; fullName?: string };

@Injectable()
export class RequestsService {
  constructor(private prisma: PrismaService) {}

  private isStaff(role: string) {
    return role === Role.ADMIN || role === Role.ACCOUNTANT;
  }

  async list(actor: Actor, query?: { status?: string; employeeId?: string; mine?: string }) {
    const mine = query?.mine === '1' || !this.isStaff(actor.role);
    let employeeId = query?.employeeId;
    if (mine) {
      const me = await this.prisma.employee.findUnique({ where: { userId: actor.userId } });
      if (!me) return [];
      employeeId = me.id;
    }
    return this.prisma.hrRequest.findMany({
      where: {
        ...(employeeId ? { employeeId } : {}),
        ...(query?.status ? { status: query.status as HrRequestStatus } : {}),
      },
      include: { employee: { select: { id: true, code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(actor: Actor, data: {
    employeeId?: string;
    kind: HrRequestKind;
    leaveType?: HrLeaveType;
    fromDate?: string;
    toDate?: string;
    hours?: number;
    amount?: number;
    reason?: string;
    notes?: string;
  }) {
    let employeeId = data.employeeId;
    if (!this.isStaff(actor.role)) {
      const me = await this.prisma.employee.findUnique({ where: { userId: actor.userId } });
      if (!me) throw new ForbiddenException('حسابك مش مربوط بملف موظف');
      employeeId = me.id;
    }
    if (!employeeId) throw new BadRequestException('حدد الموظف');

    if (data.kind === HrRequestKind.LEAVE) {
      if (!data.fromDate || !data.toDate) throw new BadRequestException('حدد فترة الإجازة');
      if (!data.leaveType || data.leaveType === HrLeaveType.PERMISSION) {
        throw new BadRequestException('نوع الإجازة غير صالح — للإذن استخدم نوع إذن');
      }
    }
    if (data.kind === HrRequestKind.PERMISSION) {
      if (!data.fromDate) throw new BadRequestException('حدد يوم الإذن');
      if (!(data.hours && data.hours > 0)) throw new BadRequestException('ساعات الإذن مطلوبة');
    }
    if (data.kind === HrRequestKind.ADVANCE) {
      if (!(data.amount && data.amount > 0)) throw new BadRequestException('مبلغ السلفة مطلوب');
    }

    return this.prisma.hrRequest.create({
      data: {
        employeeId,
        kind: data.kind,
        leaveType: data.kind === HrRequestKind.LEAVE ? data.leaveType : (data.kind === HrRequestKind.PERMISSION ? HrLeaveType.PERMISSION : null),
        fromDate: data.fromDate ? egyptDayStart(egyptDayKey(data.fromDate)) : (data.kind === HrRequestKind.ADVANCE ? egyptDayStart(egyptDayKey()) : null),
        toDate: data.toDate
          ? egyptDayStart(egyptDayKey(data.toDate))
          : (data.fromDate ? egyptDayStart(egyptDayKey(data.fromDate)) : null),
        hours: data.hours || 0,
        amount: data.amount || 0,
        reason: data.reason?.trim() || null,
        notes: data.notes?.trim() || null,
        requestedById: actor.userId,
      },
      include: { employee: { select: { id: true, code: true, name: true } } },
    });
  }

  async cancel(actor: Actor, id: string) {
    const row = await this.prisma.hrRequest.findUnique({ where: { id }, include: { employee: true } });
    if (!row) throw new NotFoundException('الطلب غير موجود');
    if (row.status !== HrRequestStatus.PENDING) throw new BadRequestException('ينفع تلغي الطلبات المعلّقة فقط');
    if (!this.isStaff(actor.role) && row.employee.userId !== actor.userId) {
      throw new ForbiddenException('تقدر تلغي طلباتك بس');
    }
    return this.prisma.hrRequest.update({
      where: { id },
      data: { status: HrRequestStatus.CANCELLED },
      include: { employee: { select: { id: true, code: true, name: true } } },
    });
  }

  async approve(actor: Actor, id: string, body?: { deductHours?: number; notes?: string }) {
    if (!this.isStaff(actor.role)) throw new ForbiddenException('الموافقة للإدارة فقط');
    const row = await this.prisma.hrRequest.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('الطلب غير موجود');
    if (row.status !== HrRequestStatus.PENDING) throw new BadRequestException('الطلب مش معلّق');

    const reviewer = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
    let leaveId: string | undefined;
    let movementId: string | undefined;

    if (row.kind === HrRequestKind.LEAVE) {
      const leave = await this.prisma.hrLeave.create({
        data: {
          employeeId: row.employeeId,
          type: row.leaveType || HrLeaveType.ANNUAL,
          fromDate: row.fromDate!,
          toDate: row.toDate || row.fromDate!,
          hours: 0,
          notes: [row.reason, body?.notes, 'من طلب موظف'].filter(Boolean).join(' — ') || null,
        },
      });
      leaveId = leave.id;
    } else if (row.kind === HrRequestKind.PERMISSION) {
      const deduct = body?.deductHours !== undefined ? Math.max(0, body.deductHours) : row.hours;
      const leave = await this.prisma.hrLeave.create({
        data: {
          employeeId: row.employeeId,
          type: HrLeaveType.PERMISSION,
          fromDate: row.fromDate!,
          toDate: row.toDate || row.fromDate!,
          hours: deduct,
          notes: `طلب ${row.hours} ساعة / خصم ${deduct === 0 ? 'بدون خصم' : `${deduct} ساعة`}${body?.notes ? ` — ${body.notes}` : ''}`,
        },
      });
      leaveId = leave.id;
    } else if (row.kind === HrRequestKind.ADVANCE) {
      const movement = await this.prisma.hrMovement.create({
        data: {
          employeeId: row.employeeId,
          kind: HrMovementKind.ADVANCE,
          amount: row.amount,
          movementDate: row.fromDate || egyptDayStart(egyptDayKey()),
          notes: [row.reason, body?.notes, 'من طلب موظف'].filter(Boolean).join(' — ') || null,
        },
      });
      movementId = movement.id;
    }

    return this.prisma.hrRequest.update({
      where: { id },
      data: {
        status: HrRequestStatus.APPROVED,
        deductHours: row.kind === HrRequestKind.PERMISSION
          ? (body?.deductHours !== undefined ? Math.max(0, body.deductHours) : row.hours)
          : row.deductHours,
        notes: body?.notes ?? row.notes,
        reviewedById: actor.userId,
        reviewedByName: reviewer?.fullName || null,
        reviewedAt: new Date(),
        leaveId: leaveId || null,
        movementId: movementId || null,
      },
      include: { employee: { select: { id: true, code: true, name: true } } },
    });
  }

  async reject(actor: Actor, id: string, body?: { reason?: string }) {
    if (!this.isStaff(actor.role)) throw new ForbiddenException('الرفض للإدارة فقط');
    const row = await this.prisma.hrRequest.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('الطلب غير موجود');
    if (row.status !== HrRequestStatus.PENDING) throw new BadRequestException('الطلب مش معلّق');
    const reviewer = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
    return this.prisma.hrRequest.update({
      where: { id },
      data: {
        status: HrRequestStatus.REJECTED,
        rejectReason: body?.reason?.trim() || null,
        reviewedById: actor.userId,
        reviewedByName: reviewer?.fullName || null,
        reviewedAt: new Date(),
      },
      include: { employee: { select: { id: true, code: true, name: true } } },
    });
  }
}
