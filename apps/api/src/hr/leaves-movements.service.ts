import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { HrLeaveType, HrMovementKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { egyptDayEnd, egyptDayKey, egyptDayStart } from './egypt-time';

@Injectable()
export class LeavesMovementsService {
  constructor(private prisma: PrismaService) {}

  listLeaves(query?: { from?: string; to?: string; employeeId?: string }) {
    const from = query?.from ? egyptDayStart(egyptDayKey(query.from)) : undefined;
    const to = query?.to ? egyptDayEnd(egyptDayKey(query.to)) : undefined;
    return this.prisma.hrLeave.findMany({
      where: {
        ...(query?.employeeId ? { employeeId: query.employeeId } : {}),
        ...(from || to
          ? {
              AND: [
                ...(from ? [{ toDate: { gte: from } }] : []),
                ...(to ? [{ fromDate: { lte: to } }] : []),
              ],
            }
          : {}),
      },
      include: { employee: { select: { id: true, code: true, name: true } } },
      orderBy: { fromDate: 'desc' },
    });
  }

  createLeave(data: {
    employeeId: string;
    type: HrLeaveType;
    fromDate: string;
    toDate: string;
    hours?: number;
    notes?: string;
  }) {
    if (!data.fromDate || !data.toDate) throw new BadRequestException('حدد فترة الإجازة');
    const from = egyptDayStart(egyptDayKey(data.fromDate));
    const to = egyptDayStart(egyptDayKey(data.toDate));
    if (to < from) throw new BadRequestException('تاريخ النهاية قبل البداية');
    if (data.type === HrLeaveType.PERMISSION && !(data.hours && data.hours > 0)) {
      throw new BadRequestException('ساعات الإذن مطلوبة');
    }
    return this.prisma.hrLeave.create({
      data: {
        employeeId: data.employeeId,
        type: data.type,
        fromDate: from,
        toDate: to,
        hours: data.type === HrLeaveType.PERMISSION ? (data.hours || 0) : 0,
        notes: data.notes?.trim() || null,
      },
      include: { employee: { select: { id: true, code: true, name: true } } },
    });
  }

  async removeLeave(id: string) {
    const row = await this.prisma.hrLeave.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('الإجازة غير موجودة');
    await this.prisma.hrLeave.delete({ where: { id } });
    return { ok: true };
  }

  listMovements(query?: { from?: string; to?: string; employeeId?: string; kind?: HrMovementKind }) {
    const from = query?.from ? egyptDayStart(egyptDayKey(query.from)) : undefined;
    const to = query?.to ? egyptDayEnd(egyptDayKey(query.to)) : undefined;
    return this.prisma.hrMovement.findMany({
      where: {
        ...(query?.employeeId ? { employeeId: query.employeeId } : {}),
        ...(query?.kind ? { kind: query.kind } : {}),
        ...(from || to ? { movementDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      include: { employee: { select: { id: true, code: true, name: true } } },
      orderBy: { movementDate: 'desc' },
    });
  }

  createMovement(data: {
    employeeId: string;
    kind: HrMovementKind;
    amount: number;
    movementDate: string;
    notes?: string;
  }) {
    if (!(data.amount > 0)) throw new BadRequestException('المبلغ لازم يكون أكبر من صفر');
    return this.prisma.hrMovement.create({
      data: {
        employeeId: data.employeeId,
        kind: data.kind,
        amount: data.amount,
        movementDate: egyptDayStart(egyptDayKey(data.movementDate || egyptDayKey())),
        notes: data.notes?.trim() || null,
      },
      include: { employee: { select: { id: true, code: true, name: true } } },
    });
  }

  async removeMovement(id: string) {
    const row = await this.prisma.hrMovement.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('الحركة غير موجودة');
    if (row.settled) throw new BadRequestException('الحركة متسوّاة في كشف مرتبات — مينفعش تتحذف');
    await this.prisma.hrMovement.delete({ where: { id } });
    return { ok: true };
  }
}
