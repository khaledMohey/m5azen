import { BadRequestException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { periodLabel, periodParts } from './period-lock';

@Injectable()
export class SettingsService {
  constructor(private prisma: PrismaService) {}

  async getAll() {
    const settings = await this.prisma.setting.findMany();
    const map: Record<string, string> = {};
    for (const s of settings) {
      if (s.key === 'editPasswordHash') continue;
      map[s.key] = s.value;
    }
    return {
      companyName: map.companyName || 'نظام AK Tech لإدارة المخازن',
      apiUrl: map.apiUrl || '',
      ...map,
      editPasswordSet: settings.some((row) => row.key === 'editPasswordHash' && row.value) ? '1' : '0',
    };
  }

  async setEditPassword(password: string) {
    const editPasswordHash = await bcrypt.hash(password, 10);
    await this.upsert('editPasswordHash', editPasswordHash);
    return { ok: true };
  }

  async editPasswordHash() {
    const row = await this.prisma.setting.findUnique({ where: { key: 'editPasswordHash' } });
    return row?.value || '';
  }

  async upsert(key: string, value: string) {
    return this.prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  async updateMany(data: Record<string, string>) {
    for (const [key, value] of Object.entries(data)) {
      if (/password/i.test(key)) continue;
      await this.upsert(key, value);
    }
    return this.getAll();
  }

  async backup() {
    if (process.env.TURSO_DATABASE_URL) {
      return { ok: false, message: 'قاعدة البيانات على السحابة (Turso) — النسخ الاحتياطي اليدوي متاح من النسخة المحلية أو من لوحة Turso' };
    }
    const candidates = [
      join(process.cwd(), 'prisma', 'dev.db'),
      join(process.cwd(), 'apps', 'api', 'prisma', 'dev.db'),
      join(__dirname, '..', '..', 'prisma', 'dev.db'),
      join(process.cwd(), 'prisma', 'prisma', 'dev.db'),
    ];
    const dbPath = candidates.find((p) => existsSync(p));
    if (!dbPath) {
      return { ok: false, message: 'ملف قاعدة البيانات غير موجود' };
    }
    const backupDir = join(dirname(dbPath), '..', 'backups');
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = join(backupDir, `m5azen-${stamp}.db`);
    copyFileSync(dbPath, dest);
    return { ok: true, path: dest, fileName: `m5azen-${stamp}.db` };
  }

  async listPeriods() {
    const now = periodParts(new Date());
    const months: { year: number; month: number }[] = [];
    let year = now.year;
    let month = now.month;
    for (let i = 0; i < 18; i++) {
      months.push({ year, month });
      month -= 1;
      if (month === 0) {
        month = 12;
        year -= 1;
      }
    }
    const closed = await this.prisma.fiscalPeriod.findMany({
      where: { closedAt: { not: null } },
      include: { closedBy: { select: { fullName: true } } },
    });
    for (const row of closed) {
      if (!months.some((item) => item.year === row.year && item.month === row.month)) {
        months.push({ year: row.year, month: row.month });
      }
    }
    const closedMap = new Map(closed.map((row) => [`${row.year}-${row.month}`, row]));
    const log = await this.prisma.fiscalPeriodLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 40,
      include: { user: { select: { fullName: true } } },
    });
    return {
      periods: months.map((item) => {
        const row = closedMap.get(`${item.year}-${item.month}`);
        return {
          year: item.year,
          month: item.month,
          label: periodLabel(item.year, item.month),
          closed: !!row?.closedAt,
          closedAt: row?.closedAt || null,
          closedBy: row?.closedBy?.fullName || '',
        };
      }),
      log: log.map((row) => ({
        id: row.id,
        label: periodLabel(row.year, row.month),
        action: row.action,
        reason: row.reason || '',
        userName: row.user.fullName,
        createdAt: row.createdAt,
      })),
    };
  }

  async closePeriod(year: number, month: number, userId: string) {
    this.assertMonth(year, month);
    const now = periodParts(new Date());
    if (year > now.year || (year === now.year && month > now.month)) {
      throw new BadRequestException('الشهر لسه ما جاش');
    }
    const existing = await this.prisma.fiscalPeriod.findUnique({ where: { year_month: { year, month } } });
    if (existing?.closedAt) throw new BadRequestException('الشهر مقفول بالفعل');
    await this.prisma.$transaction([
      this.prisma.fiscalPeriod.upsert({
        where: { year_month: { year, month } },
        create: { year, month, closedAt: new Date(), closedById: userId },
        update: { closedAt: new Date(), closedById: userId },
      }),
      this.prisma.fiscalPeriodLog.create({
        data: { year, month, action: 'CLOSE', userId },
      }),
    ]);
    return this.listPeriods();
  }

  async reopenPeriod(year: number, month: number, reason: string, userId: string) {
    this.assertMonth(year, month);
    const text = reason.trim();
    if (text.length < 3) throw new BadRequestException('اكتب سبب فتح الشهر');
    const existing = await this.prisma.fiscalPeriod.findUnique({ where: { year_month: { year, month } } });
    if (!existing?.closedAt) throw new BadRequestException('الشهر مفتوح');
    await this.prisma.$transaction([
      this.prisma.fiscalPeriod.update({
        where: { year_month: { year, month } },
        data: { closedAt: null, closedById: null },
      }),
      this.prisma.fiscalPeriodLog.create({
        data: { year, month, action: 'REOPEN', reason: text, userId },
      }),
    ]);
    return this.listPeriods();
  }

  private assertMonth(year: number, month: number) {
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException('الشهر غير صالح');
    }
  }

  listBackups() {
    const dirs = [
      join(process.cwd(), 'backups'),
      join(process.cwd(), 'apps', 'api', 'backups'),
      join(__dirname, '..', '..', 'backups'),
    ];
    const backupDir = dirs.find((d) => existsSync(d));
    if (!backupDir) return [];
    return readdirSync(backupDir)
      .filter((f) => f.endsWith('.db'))
      .sort()
      .reverse();
  }
}
