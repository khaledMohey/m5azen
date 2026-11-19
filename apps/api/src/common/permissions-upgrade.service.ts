import { Injectable, OnModuleInit } from '@nestjs/common';
import { Role } from '@prisma/client';
import { normalizeAccess, parseAccess } from './access-map';
import { PrismaService } from '../prisma/prisma.service';

/** يفعّل hr.view + request للحسابات القديمة اللي القالب بتاعها اتحدّث. */
@Injectable()
export class PermissionsUpgradeService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    const users = await this.prisma.user.findMany({
      where: { role: { in: [Role.SALES, Role.WAREHOUSE, Role.ACCOUNTANT] }, isActive: true },
      select: { id: true, role: true, permissions: true },
    });
    for (const user of users) {
      if (!user.permissions) continue;
      const access = parseAccess(user.permissions, user.role);
      const hr = access.hr;
      if (!hr?.view || !hr.actions.includes('request')) {
        const next = normalizeAccess(
          {
            ...access,
            hr: {
              view: true,
              actions: Array.from(new Set([...(hr?.actions || []), 'request', ...(user.role === Role.ACCOUNTANT ? ['create', 'edit', 'delete', 'post', 'export'] : [])])),
              fields: user.role === Role.ACCOUNTANT ? Array.from(new Set([...(hr?.fields || []), 'salary', 'amounts'])) : (hr?.fields || []),
            },
          },
          user.role,
        );
        await this.prisma.user.update({
          where: { id: user.id },
          data: { permissions: JSON.stringify(next) },
        });
      }
    }
  }
}
