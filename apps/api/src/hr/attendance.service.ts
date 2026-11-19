import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { HrAttendanceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HrSettingsService } from './hr-settings.service';
import {
  egyptDayEnd, egyptDayKey, egyptDayStart, egyptMinutesOf, parseTimeToMinutes,
} from './egypt-time';

@Injectable()
export class AttendanceService {
  constructor(
    private prisma: PrismaService,
    private settings: HrSettingsService,
  ) {}

  list(query?: { from?: string; to?: string; employeeId?: string }) {
    const from = query?.from ? egyptDayStart(egyptDayKey(query.from)) : undefined;
    const to = query?.to ? egyptDayEnd(egyptDayKey(query.to)) : undefined;
    return this.prisma.attendance.findMany({
      where: {
        ...(query?.employeeId ? { employeeId: query.employeeId } : {}),
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      include: { employee: { select: { id: true, code: true, name: true } } },
      orderBy: [{ date: 'desc' }, { employee: { name: 'asc' } }],
    });
  }

  async upsert(data: {
    employeeId: string;
    date: string;
    checkIn?: string | null;
    checkOut?: string | null;
    status?: HrAttendanceStatus;
    notes?: string;
  }) {
    const day = egyptDayKey(data.date);
    const date = egyptDayStart(day);
    const checkIn = data.checkIn ? new Date(data.checkIn) : null;
    const checkOut = data.checkOut ? new Date(data.checkOut) : null;
    const lateMinutes = checkIn ? await this.calcLate(checkIn) : 0;
    return this.prisma.attendance.upsert({
      where: { employeeId_date: { employeeId: data.employeeId, date } },
      create: {
        employeeId: data.employeeId,
        date,
        checkIn,
        checkOut,
        status: data.status || (checkIn ? HrAttendanceStatus.PRESENT : HrAttendanceStatus.ABSENT),
        lateMinutes,
        notes: data.notes,
      },
      update: {
        checkIn,
        checkOut,
        status: data.status || (checkIn ? HrAttendanceStatus.PRESENT : HrAttendanceStatus.ABSENT),
        lateMinutes,
        notes: data.notes,
      },
      include: { employee: { select: { id: true, code: true, name: true } } },
    });
  }

  async punchIn(employeeId: string) {
    const day = egyptDayKey();
    const date = egyptDayStart(day);
    const existing = await this.prisma.attendance.findUnique({
      where: { employeeId_date: { employeeId, date } },
    });
    if (existing?.checkIn) throw new BadRequestException('تم تسجيل الحضور النهاردة بالفعل');
    const now = new Date();
    const lateMinutes = await this.calcLate(now);
    return this.prisma.attendance.upsert({
      where: { employeeId_date: { employeeId, date } },
      create: {
        employeeId,
        date,
        checkIn: now,
        status: HrAttendanceStatus.PRESENT,
        lateMinutes,
      },
      update: {
        checkIn: now,
        status: HrAttendanceStatus.PRESENT,
        lateMinutes,
      },
      include: { employee: { select: { id: true, code: true, name: true } } },
    });
  }

  async punchOut(employeeId: string) {
    const day = egyptDayKey();
    const date = egyptDayStart(day);
    const existing = await this.prisma.attendance.findUnique({
      where: { employeeId_date: { employeeId, date } },
    });
    if (!existing?.checkIn) throw new BadRequestException('سجّل الحضور الأول');
    if (existing.checkOut) throw new BadRequestException('تم تسجيل الانصراف بالفعل');
    const openMission = await this.prisma.attendanceMission.findFirst({
      where: { employeeId, date, returnedAt: null },
    });
    if (openMission) throw new BadRequestException('فيه مأمورية مفتوحة — رجّع من المأمورية قبل الانصراف');
    return this.prisma.attendance.update({
      where: { id: existing.id },
      data: { checkOut: new Date() },
      include: { employee: { select: { id: true, code: true, name: true } } },
    });
  }

  listMissions(query?: { from?: string; to?: string; employeeId?: string }) {
    const from = query?.from ? egyptDayStart(egyptDayKey(query.from)) : undefined;
    const to = query?.to ? egyptDayEnd(egyptDayKey(query.to)) : undefined;
    return this.prisma.attendanceMission.findMany({
      where: {
        ...(query?.employeeId ? { employeeId: query.employeeId } : {}),
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      include: { employee: { select: { id: true, code: true, name: true } } },
      orderBy: { leftAt: 'desc' },
    });
  }

  async missionOut(data: { employeeId: string; purpose: string; notes?: string }) {
    if (!data.purpose?.trim()) throw new BadRequestException('غرض المأمورية مطلوب');
    const day = egyptDayKey();
    const date = egyptDayStart(day);
    const attendance = await this.prisma.attendance.findUnique({
      where: { employeeId_date: { employeeId: data.employeeId, date } },
    });
    if (!attendance?.checkIn) throw new BadRequestException('لازم حضور النهاردة قبل المأمورية');
    if (attendance.checkOut) throw new BadRequestException('تم الانصراف — مينفعش تبدأ مأمورية');
    const open = await this.prisma.attendanceMission.findFirst({
      where: { employeeId: data.employeeId, date, returnedAt: null },
    });
    if (open) throw new BadRequestException('فيه مأمورية مفتوحة بالفعل');
    return this.prisma.attendanceMission.create({
      data: {
        employeeId: data.employeeId,
        date,
        leftAt: new Date(),
        purpose: data.purpose.trim(),
        notes: data.notes?.trim() || null,
      },
      include: { employee: { select: { id: true, code: true, name: true } } },
    });
  }

  async missionIn(employeeId: string) {
    const day = egyptDayKey();
    const date = egyptDayStart(day);
    const open = await this.prisma.attendanceMission.findFirst({
      where: { employeeId, date, returnedAt: null },
      orderBy: { leftAt: 'desc' },
    });
    if (!open) throw new BadRequestException('مفيش مأمورية مفتوحة');
    return this.prisma.attendanceMission.update({
      where: { id: open.id },
      data: { returnedAt: new Date() },
      include: { employee: { select: { id: true, code: true, name: true } } },
    });
  }

  async removeMission(id: string) {
    const row = await this.prisma.attendanceMission.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('المأمورية غير موجودة');
    await this.prisma.attendanceMission.delete({ where: { id } });
    return { ok: true };
  }

  async remove(id: string) {
    const row = await this.prisma.attendance.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('سجل الحضور غير موجود');
    await this.prisma.attendance.delete({ where: { id } });
    return { ok: true };
  }

  async recalculateLate() {
    const settings = await this.settings.get();
    const rows = await this.prisma.attendance.findMany({ where: { checkIn: { not: null } } });
    let updated = 0;
    for (const row of rows) {
      const lateMinutes = Math.max(
        0,
        egyptMinutesOf(row.checkIn!) - parseTimeToMinutes(settings.workStart) - settings.graceMinutes,
      );
      if (lateMinutes !== row.lateMinutes) {
        await this.prisma.attendance.update({ where: { id: row.id }, data: { lateMinutes } });
        updated += 1;
      }
    }
    return { updated };
  }

  private async calcLate(checkIn: Date) {
    const settings = await this.settings.get();
    return Math.max(
      0,
      egyptMinutesOf(checkIn) - parseTimeToMinutes(settings.workStart) - settings.graceMinutes,
    );
  }
}
