import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { egyptDayKey } from './egypt-time';

@Injectable()
export class HrSettingsService {
  constructor(private prisma: PrismaService) {}

  async get() {
    const row = await this.prisma.hrSettings.findUnique({ where: { id: 'default' } });
    if (row) return row;
    return this.prisma.hrSettings.create({
      data: { id: 'default' },
    });
  }

  async update(data: Partial<{
    workStart: string;
    workEnd: string;
    graceMinutes: number;
    monthWorkDays: number;
    weekendDays: string;
    lateDeductPerMinute: number;
  }>) {
    await this.get();
    return this.prisma.hrSettings.update({ where: { id: 'default' }, data });
  }

  listHolidays() {
    return this.prisma.hrHoliday.findMany({ orderBy: { date: 'asc' } });
  }

  createHoliday(data: { date: string; name: string; yearly?: boolean }) {
    return this.prisma.hrHoliday.create({
      data: {
        date: new Date(`${egyptDayKey(data.date)}T12:00:00+02:00`),
        name: data.name.trim(),
        yearly: !!data.yearly,
      },
    });
  }

  async removeHoliday(id: string) {
    const row = await this.prisma.hrHoliday.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('الإجازة الرسمية غير موجودة');
    await this.prisma.hrHoliday.delete({ where: { id } });
    return { ok: true };
  }

  weekendSet(settings?: { weekendDays: string }) {
    try {
      const parsed = JSON.parse(settings?.weekendDays || '[6]');
      return new Set((Array.isArray(parsed) ? parsed : [6]).map(Number));
    } catch {
      return new Set([6]);
    }
  }
}
