import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async log(
    action: string,
    entityType: string,
    entityId: string,
    userId: string | null | undefined,
    before: unknown,
    after: unknown,
    reason?: string,
  ) {
    return this.prisma.accountingAuditLog.create({
      data: {
        action,
        entityType,
        entityId,
        userId: userId || null,
        beforeJson: before == null ? null : JSON.stringify(before),
        afterJson: after == null ? null : JSON.stringify(after),
        reason: reason?.trim() || null,
      },
    });
  }
}
