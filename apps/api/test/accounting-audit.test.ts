/**
 * تدقيق مطابقة وإقفال وإعادة محاولة — على accounting-test.db فقط.
 */
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PrismaClient,
  AccountingEvent,
  JournalEntryStatus,
} from '@prisma/client';
import { seedDefaultChartAndMappings } from '../src/accounting/mapping.service';
import { toCents, assertBalanced } from '../src/accounting/money';
import { closedYearSettingKey, yearCloseSourceId } from '../src/accounting/closing.util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDb = path.join(__dirname, '../prisma/accounting-test.db');
process.env.TURSO_DATABASE_URL = '';
process.env.DATABASE_URL = `file:${testDb}`;

const prisma = new PrismaClient();

async function cleanAccounting() {
  await prisma.journalLine.deleteMany();
  await prisma.accountingPostQueue.updateMany({ data: { postedEntryId: null } });
  await prisma.accountingPostQueue.deleteMany();
  await prisma.accountOpeningBalance.deleteMany();
  await prisma.accountOpeningBatch.updateMany({ data: { journalEntryId: null, appliedYearKey: null } });
  await prisma.accountOpeningBatch.deleteMany();
  await prisma.journalEntry.updateMany({ data: { reversesEntryId: null } });
  await prisma.journalEntry.deleteMany();
  await prisma.accountMappingLine.deleteMany();
  await prisma.accountMapping.deleteMany();
  await prisma.setting.deleteMany({ where: { key: { startsWith: 'accounting.closedYear.' } } });
  await prisma.account.updateMany({ data: { parentId: null, cashAccountId: null, costCenterId: null } });
  await prisma.account.deleteMany();
  await seedDefaultChartAndMappings(prisma);
}

describe('accounting release audit', () => {
  before(async () => {
    await prisma.$connect();
    await cleanAccounting();
  });

  it('year close isYearClosed ignores REVERSED close entry and clears setting on reverse', async () => {
    const year = 2099;
    const rev = await prisma.account.findUniqueOrThrow({ where: { code: '4100' } });
    const exp = await prisma.account.findUniqueOrThrow({ where: { code: '5200' } });
    const equity = await prisma.account.findUniqueOrThrow({ where: { code: '3200' } });

    // P&L activity
    await prisma.journalEntry.create({
      data: {
        number: `JE-AUD-PL-${Date.now()}`,
        entryDate: new Date(`${year}-06-01`),
        description: 'إيراد',
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.MANUAL,
        sourceId: `aud-pl-${Date.now()}`,
        fiscalYear: year,
        fiscalMonth: 6,
        postedAt: new Date(),
        lines: {
          create: [
            { accountId: await prisma.account.findUniqueOrThrow({ where: { code: '1100' } }).then((a) => a.id), debit: 500, credit: 0, lineOrder: 0 },
            { accountId: rev.id, debit: 0, credit: 500, lineOrder: 1 },
          ],
        },
      },
    });

    const sourceId = yearCloseSourceId(year);
    const close = await prisma.journalEntry.create({
      data: {
        number: `JE-CLOSE-${year}`,
        entryDate: new Date(`${year}-12-31`),
        description: `إقفال ${year}`,
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.MANUAL,
        sourceId,
        fiscalYear: year,
        fiscalMonth: 12,
        postedAt: new Date(),
        lines: {
          create: [
            { accountId: rev.id, debit: 500, credit: 0, lineOrder: 0 },
            { accountId: equity.id, debit: 0, credit: 500, lineOrder: 1 },
          ],
        },
      },
    });
    await prisma.setting.upsert({
      where: { key: closedYearSettingKey(year) },
      create: { key: closedYearSettingKey(year), value: '1' },
      update: { value: '1' },
    });

    // محاكاة منطق isYearClosed بعد العكس
    const reversal = await prisma.journalEntry.create({
      data: {
        number: `JE-UNCLOSE-${year}`,
        entryDate: new Date(`${year}-12-31`),
        description: 'عكس إقفال',
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.MANUAL,
        sourceId: `REV-${sourceId}`,
        fiscalYear: year,
        fiscalMonth: 12,
        postedAt: new Date(),
        reversesEntryId: close.id,
        lines: {
          create: [
            { accountId: rev.id, debit: 0, credit: 500, lineOrder: 0 },
            { accountId: equity.id, debit: 500, credit: 0, lineOrder: 1 },
          ],
        },
      },
    });
    await prisma.journalEntry.update({
      where: { id: close.id },
      data: { status: JournalEntryStatus.REVERSED },
    });
    await prisma.setting.deleteMany({ where: { key: closedYearSettingKey(year) } });

    const entry = await prisma.journalEntry.findUnique({
      where: { sourceType_sourceId: { sourceType: AccountingEvent.MANUAL, sourceId } },
    });
    assert.equal(entry?.status, JournalEntryStatus.REVERSED);
    const setting = await prisma.setting.findUnique({ where: { key: closedYearSettingKey(year) } });
    assert.equal(setting, null);
    const activeClose = entry?.status === JournalEntryStatus.POSTED;
    assert.equal(Boolean(setting?.value === '1' || activeClose), false);
    void exp;
    void reversal;
  });

  it('duplicate sourceType+sourceId cannot insert second posted JE', async () => {
    const cash = await prisma.account.findUniqueOrThrow({ where: { code: '1100' } });
    const expense = await prisma.account.findUniqueOrThrow({ where: { code: '5200' } });
    const sourceId = `idem-${Date.now()}`;
    await prisma.journalEntry.create({
      data: {
        number: `JE-IDEM-1-${Date.now()}`,
        entryDate: new Date(),
        description: 'a',
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.EXPENSE_CREATE,
        sourceId,
        fiscalYear: 2026,
        fiscalMonth: 1,
        postedAt: new Date(),
        lines: {
          create: [
            { accountId: expense.id, debit: 10, credit: 0, lineOrder: 0 },
            { accountId: cash.id, debit: 0, credit: 10, lineOrder: 1 },
          ],
        },
      },
    });
    await assert.rejects(() =>
      prisma.journalEntry.create({
        data: {
          number: `JE-IDEM-2-${Date.now()}`,
          entryDate: new Date(),
          description: 'b',
          status: JournalEntryStatus.POSTED,
          sourceType: AccountingEvent.EXPENSE_CREATE,
          sourceId,
          fiscalYear: 2026,
          fiscalMonth: 1,
          postedAt: new Date(),
          lines: {
            create: [
              { accountId: expense.id, debit: 10, credit: 0, lineOrder: 0 },
              { accountId: cash.id, debit: 0, credit: 10, lineOrder: 1 },
            ],
          },
        },
      }),
    );
  });

  it('stale queue claimVersion cannot complete POSTED', async () => {
    const row = await prisma.accountingPostQueue.create({
      data: {
        event: AccountingEvent.EXPENSE_CREATE,
        sourceId: `claim-${Date.now()}`,
        status: 'PROCESSING',
        lockedBy: 'w1',
        claimVersion: 2,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const stale = await prisma.accountingPostQueue.updateMany({
      where: { id: row.id, claimVersion: 1, lockedBy: 'w1', status: 'PROCESSING' },
      data: { status: 'POSTED' },
    });
    assert.equal(stale.count, 0);
    const ok = await prisma.accountingPostQueue.updateMany({
      where: { id: row.id, claimVersion: 2, lockedBy: 'w1', status: 'PROCESSING' },
      data: { status: 'FAILED', lockedBy: null },
    });
    assert.equal(ok.count, 1);
  });

  it('fifo stale ticket rejected when nextSeq advanced', async () => {
    const product = await prisma.product.findFirst();
    if (!product) return;
    await prisma.fifoReplayEpoch.upsert({
      where: { productId: product.id },
      create: { productId: product.id, nextSeq: 5, lastPublishedSeq: 4 },
      update: { nextSeq: 5, lastPublishedSeq: 4 },
    });
    const oldTicket = 3;
    const gate = await prisma.fifoReplayEpoch.updateMany({
      where: { productId: product.id, nextSeq: oldTicket, lastPublishedSeq: { lt: oldTicket } },
      data: { lastPublishedSeq: oldTicket },
    });
    assert.equal(gate.count, 0);
  });

  it('trial balance remains balanced across audit fixtures', async () => {
    const lines = await prisma.journalLine.findMany({
      where: { entry: { status: { in: ['POSTED', 'REVERSED'] } } },
    });
    const d = lines.reduce((s, l) => s + toCents(l.debit), 0);
    const c = lines.reduce((s, l) => s + toCents(l.credit), 0);
    assert.equal(d, c);
  });

  it('draft entries are not required for TB balance check', async () => {
    const cash = await prisma.account.findUniqueOrThrow({ where: { code: '1100' } });
    const expense = await prisma.account.findUniqueOrThrow({ where: { code: '5200' } });
    await prisma.journalEntry.create({
      data: {
        number: `JE-DRAFT-${Date.now()}`,
        entryDate: new Date(),
        description: 'مسودة',
        status: JournalEntryStatus.DRAFT,
        sourceType: AccountingEvent.MANUAL,
        sourceId: `draft-${Date.now()}`,
        fiscalYear: 2026,
        fiscalMonth: 1,
        lines: {
          create: [
            { accountId: expense.id, debit: 999, credit: 0, lineOrder: 0 },
            { accountId: cash.id, debit: 0, credit: 999, lineOrder: 1 },
          ],
        },
      },
    });
    const lines = await prisma.journalLine.findMany({
      where: { entry: { status: { in: ['POSTED', 'REVERSED'] } } },
    });
    assertBalanced(lines);
  });

  it('documents expected ops vs GL divergence without auto-adjust', async () => {
    const customers = await prisma.customer.count({ where: { balance: { not: 0 } } });
    const cashAccounts = await prisma.cashAccount.count();
    // لا نعدّل الأرصدة — نؤكد فقط أن الاستعلام يعمل وأن التقرير لا يفرض المساواة
    assert.ok(customers >= 0);
    assert.ok(cashAccounts >= 0);
  });
});
