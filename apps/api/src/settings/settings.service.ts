import { Injectable } from '@nestjs/common';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SettingsService {
  constructor(private prisma: PrismaService) {}

  async getAll() {
    const settings = await this.prisma.setting.findMany();
    const map: Record<string, string> = {};
    for (const s of settings) map[s.key] = s.value;
    return {
      companyName: map.companyName || 'نظام AK Tech لإدارة المخازن',
      apiUrl: map.apiUrl || '',
      ...map,
    };
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
