import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CogsLockService {
  constructor(private prisma: PrismaService) {}

  async claimLock(invoiceId: string, workerId: string, leaseMs = 60_000) {
    if (!invoiceId) throw new BadRequestException('فاتورة التكلفة ناقصة');
    if (!workerId) throw new BadRequestException('معرّف العامل ناقص');
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + Math.max(1000, leaseMs));

    const existing = await this.prisma.accountingCogsLock.findUnique({ where: { invoiceId } });
    if (!existing) {
      return this.prisma.accountingCogsLock.create({
        data: {
          invoiceId,
          lockVersion: 1,
          lockedBy: workerId,
          leaseExpiresAt,
        },
      });
    }

    const expired = !existing.leaseExpiresAt || existing.leaseExpiresAt <= now;
    const owned = existing.lockedBy === workerId;
    if (!expired && !owned) {
      throw new BadRequestException('قفل تكلفة الفاتورة محجوز لعامل تاني');
    }

    const updated = await this.prisma.accountingCogsLock.updateMany({
      where: {
        invoiceId,
        lockVersion: existing.lockVersion,
        OR: [
          { lockedBy: workerId },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        lockVersion: { increment: 1 },
        lockedBy: workerId,
        leaseExpiresAt,
      },
    });
    if (updated.count !== 1) {
      throw new BadRequestException('تعذر حجز قفل التكلفة — حاول تاني');
    }
    return this.prisma.accountingCogsLock.findUniqueOrThrow({ where: { invoiceId } });
  }

  async releaseLock(invoiceId: string, workerId: string, lockVersion: number) {
    if (!invoiceId) throw new BadRequestException('فاتورة التكلفة ناقصة');
    const updated = await this.prisma.accountingCogsLock.updateMany({
      where: { invoiceId, lockedBy: workerId, lockVersion },
      data: { lockedBy: null, leaseExpiresAt: null },
    });
    if (updated.count !== 1) {
      throw new BadRequestException('تعذر تحرير قفل التكلفة — التوكن غير صالح');
    }
    return { ok: true };
  }
}
