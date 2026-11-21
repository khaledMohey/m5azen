import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AccountingEvent,
  AccountingPostQueueStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class QueueService {
  constructor(private prisma: PrismaService) {}

  async enqueue(event: AccountingEvent, sourceId: string, payload: unknown = {}) {
    return this.enqueueInTx(this.prisma, event, sourceId, payload);
  }

  /** Outbox insert/update داخل معاملة موجودة (مثلاً صرف مرتبات). */
  async enqueueInTx(
    tx: Prisma.TransactionClient | PrismaService,
    event: AccountingEvent,
    sourceId: string,
    payload: unknown = {},
  ) {
    if (!sourceId) throw new BadRequestException('معرّف المصدر ناقص للطابور');
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
    const existing = await tx.accountingPostQueue.findUnique({
      where: { event_sourceId: { event, sourceId } },
    });
    if (existing) {
      // لا تعِد فتح صف POSTED أبدًا
      if (existing.status === AccountingPostQueueStatus.POSTED) return existing;
      if (existing.status === AccountingPostQueueStatus.CANCELLED && !existing.postedEntryId) {
        return tx.accountingPostQueue.update({
          where: { id: existing.id },
          data: {
            status: AccountingPostQueueStatus.PENDING,
            payload: body,
            availableAt: new Date(),
            lastError: null,
            lockedBy: null,
            leaseExpiresAt: null,
          },
        });
      }
      if (
        existing.status === AccountingPostQueueStatus.PENDING
        || existing.status === AccountingPostQueueStatus.FAILED
      ) {
        return tx.accountingPostQueue.update({
          where: { id: existing.id },
          data: { payload: body, availableAt: new Date() },
        });
      }
      return existing;
    }
    return tx.accountingPostQueue.create({
      data: {
        event,
        sourceId,
        payload: body,
        status: AccountingPostQueueStatus.PENDING,
        availableAt: new Date(),
      },
    });
  }

  async claimNext(workerId: string, leaseMs = 60_000) {
    if (!workerId) throw new BadRequestException('معرّف العامل ناقص');
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + Math.max(1000, leaseMs));

    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.accountingPostQueue.findMany({
        where: {
          OR: [
            {
              status: AccountingPostQueueStatus.PENDING,
              availableAt: { lte: now },
            },
            {
              status: AccountingPostQueueStatus.PROCESSING,
              leaseExpiresAt: { lte: now },
            },
          ],
        },
        orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
        take: 20,
      });

      for (const row of candidates) {
        const healed = await this.healIfPosted(tx, row.id, row.event, row.sourceId);
        if (healed) continue;

        const updated = await tx.accountingPostQueue.updateMany({
          where: {
            id: row.id,
            claimVersion: row.claimVersion,
            OR: [
              { status: AccountingPostQueueStatus.PENDING, availableAt: { lte: now } },
              { status: AccountingPostQueueStatus.PROCESSING, leaseExpiresAt: { lte: now } },
            ],
          },
          data: {
            status: AccountingPostQueueStatus.PROCESSING,
            lockedBy: workerId,
            leaseExpiresAt,
            claimVersion: { increment: 1 },
            attempts: { increment: 1 },
          },
        });
        if (updated.count !== 1) continue;
        return tx.accountingPostQueue.findUniqueOrThrow({ where: { id: row.id } });
      }
      return null;
    });
  }

  private async healIfPosted(
    tx: Prisma.TransactionClient,
    queueId: string,
    event: AccountingEvent,
    sourceId: string,
  ) {
    const entry = await tx.journalEntry.findUnique({
      where: { sourceType_sourceId: { sourceType: event, sourceId } },
      select: { id: true },
    });
    if (!entry) return false;
    await tx.accountingPostQueue.update({
      where: { id: queueId },
      data: {
        status: AccountingPostQueueStatus.POSTED,
        postedEntryId: entry.id,
        lockedBy: null,
        leaseExpiresAt: null,
        lastError: null,
      },
    });
    return true;
  }

  async completePosted(id: string, workerId: string, claimVersion: number, entryId: string) {
    const updated = await this.prisma.accountingPostQueue.updateMany({
      where: {
        id,
        lockedBy: workerId,
        claimVersion,
        status: AccountingPostQueueStatus.PROCESSING,
      },
      data: {
        status: AccountingPostQueueStatus.POSTED,
        postedEntryId: entryId,
        lockedBy: null,
        leaseExpiresAt: null,
        lastError: null,
      },
    });
    if (updated.count !== 1) {
      throw new BadRequestException('تعذر إكمال عنصر الطابور — المطالبة غير صالحة');
    }
    return this.prisma.accountingPostQueue.findUniqueOrThrow({ where: { id } });
  }

  async fail(
    id: string,
    workerId: string,
    claimVersion: number,
    error: string,
    retryDelayMs = 30_000,
  ) {
    const availableAt = new Date(Date.now() + Math.max(0, retryDelayMs));
    const updated = await this.prisma.accountingPostQueue.updateMany({
      where: {
        id,
        lockedBy: workerId,
        claimVersion,
        status: AccountingPostQueueStatus.PROCESSING,
      },
      data: {
        status: AccountingPostQueueStatus.FAILED,
        lastError: error?.slice(0, 2000) || 'فشل الترحيل',
        lockedBy: null,
        leaseExpiresAt: null,
        availableAt,
      },
    });
    if (updated.count !== 1) {
      throw new BadRequestException('تعذر تسجيل فشل عنصر الطابور');
    }
    return this.prisma.accountingPostQueue.findUniqueOrThrow({ where: { id } });
  }

  async cancel(id: string, reason?: string) {
    const existing = await this.prisma.accountingPostQueue.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('عنصر الطابور غير موجود');
    if (existing.status === AccountingPostQueueStatus.POSTED) {
      throw new BadRequestException('العنصر مترحّل بالفعل');
    }
    return this.prisma.accountingPostQueue.update({
      where: { id },
      data: {
        status: AccountingPostQueueStatus.CANCELLED,
        lastError: reason?.slice(0, 2000) || existing.lastError,
        lockedBy: null,
        leaseExpiresAt: null,
      },
    });
  }

  async list(status?: AccountingPostQueueStatus) {
    return this.prisma.accountingPostQueue.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    });
  }
}
