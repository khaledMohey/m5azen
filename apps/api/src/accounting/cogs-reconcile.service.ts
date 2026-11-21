import { Injectable, Logger } from '@nestjs/common';
import { AccountingEvent } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CogsLockService } from './cogs-lock.service';
import { PostingService } from './posting.service';
import { QueueService } from './queue.service';
import { toCents } from './money';

/**
 * يعالج AccountingCogsDirty بعد نشر FIFO ويُنشئ تعديلات COGS عبر الطابور.
 * المقارنة والحذف تتم بـ generation حتى لا تُحذف أجيال أحدث.
 */
@Injectable()
export class CogsReconcileService {
  private readonly logger = new Logger(CogsReconcileService.name);

  constructor(
    private prisma: PrismaService,
    private locks: CogsLockService,
    private posting: PostingService,
    private queue: QueueService,
  ) {}

  async markDirtyFromInvoice(invoiceId: string) {
    const invoice = await this.prisma.salesInvoice.findUnique({
      where: { id: invoiceId },
      include: { lines: true },
    });
    if (!invoice) return null;
    const targetCents = toCents(
      invoice.lines.reduce((sum, line) => sum + Number(line.unitCost || 0) * Number(line.quantity || 0), 0),
    );
    return this.prisma.accountingCogsDirty.upsert({
      where: { invoiceId },
      create: {
        invoiceId,
        generation: invoice.cogsEpoch,
        targetCents,
      },
      update: {
        generation: invoice.cogsEpoch,
        targetCents,
        dirtyAt: new Date(),
      },
    });
  }

  /** بعد recost: تأكد أن كل فاتورة dirty لها نية تعديل في الطابور */
  async reconcileAfterRecost(productIds: string[]) {
    const ids = [...new Set(productIds.filter(Boolean))];
    if (!ids.length) return { dirty: 0, enqueued: 0 };

    const dirtyRows = await this.prisma.accountingCogsDirty.findMany({
      where: {
        invoice: {
          status: { notIn: ['DRAFT', 'CANCELLED'] },
          lines: { some: { productId: { in: ids } } },
        },
      },
    });

    // أي فاتورة مؤكدة تغيّرت تكلفتها قد تكون dirty من fifo publish؛ أعد مسح dirty عامة أيضاً
    const allDirty = await this.prisma.accountingCogsDirty.findMany({
      orderBy: { dirtyAt: 'asc' },
      take: 200,
    });
    const byId = new Map(allDirty.map((row) => [row.invoiceId, row]));
    for (const row of dirtyRows) byId.set(row.invoiceId, row);

    let enqueued = 0;
    for (const row of byId.values()) {
      const ok = await this.reconcileInvoice(row.invoiceId, row.generation);
      if (ok) enqueued += 1;
    }
    return { dirty: byId.size, enqueued };
  }

  async reconcileInvoice(invoiceId: string, expectedGeneration?: number) {
    const dirty = await this.prisma.accountingCogsDirty.findUnique({ where: { invoiceId } });
    if (!dirty) return false;
    if (expectedGeneration != null && dirty.generation !== expectedGeneration) {
      return false;
    }

    const workerId = `cogs-reconcile:${process.pid}`;
    let claim;
    try {
      claim = await this.locks.claimLock(invoiceId, workerId);
    } catch {
      // قفل مشغول — اترك dirty لـ sweeper
      return false;
    }

    try {
      const hasConfirm = await this.prisma.journalEntry.findUnique({
        where: {
          sourceType_sourceId: {
            sourceType: AccountingEvent.SALE_CONFIRM,
            sourceId: invoiceId,
          },
        },
      });
      if (!hasConfirm) {
        await this.clearDirtyIfGeneration(invoiceId, dirty.generation);
        await this.locks.releaseLock(invoiceId, workerId, claim.lockVersion);
        return false;
      }

      await this.posting.enqueueCogsAdjust(invoiceId);
      await this.clearDirtyIfGeneration(invoiceId, dirty.generation);
      await this.locks.releaseLock(invoiceId, workerId, claim.lockVersion);
      return true;
    } catch (error) {
      this.logger.warn(`COGS reconcile failed for ${invoiceId}: ${(error as Error).message}`);
      try {
        await this.locks.releaseLock(invoiceId, workerId, claim.lockVersion);
      } catch {
        /* lease may have expired */
      }
      return false;
    }
  }

  async sweepDirty(limit = 50) {
    const rows = await this.prisma.accountingCogsDirty.findMany({
      orderBy: { dirtyAt: 'asc' },
      take: limit,
    });
    let done = 0;
    for (const row of rows) {
      if (await this.reconcileInvoice(row.invoiceId, row.generation)) done += 1;
    }

    // صرّف عناصر SALE_COGS_ADJUST المعلّقة في الطابور
    const workerId = `cogs-queue:${process.pid}`;
    for (let i = 0; i < limit; i += 1) {
      const claimed = await this.queue.claimNext(workerId, 120_000);
      if (!claimed) break;
      if (claimed.event !== AccountingEvent.SALE_COGS_ADJUST) {
        // أعد للمعلّق إن لم يكن تعديل COGS — معالج عام عبر processQueueItem أفضل
        await this.posting.processQueueItem(claimed);
        done += 1;
        continue;
      }
      try {
        let payload: { invoiceId?: string } = {};
        try {
          payload = JSON.parse(claimed.payload || '{}');
        } catch {
          payload = {};
        }
        const invoiceId = String(
          payload.invoiceId
            || (claimed.sourceId.includes('->')
              ? claimed.sourceId.split(':')[1]
              : claimed.sourceId.split('#')[0])
            || claimed.sourceId,
        );
        await this.posting.postCogsAdjust(invoiceId, {
          queueId: claimed.id,
          workerId,
          claimVersion: claimed.claimVersion,
        });
        done += 1;
      } catch (error) {
        await this.queue.fail(claimed.id, workerId, claimed.claimVersion, (error as Error).message);
      }
    }
    return { processed: done };
  }

  private async clearDirtyIfGeneration(invoiceId: string, generation: number) {
    await this.prisma.accountingCogsDirty.deleteMany({
      where: { invoiceId, generation },
    });
  }
}
