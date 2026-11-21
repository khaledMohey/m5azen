/**
 * اختبار تكامل محاسبي على قاعدة منفصلة: prisma/accounting-test.db
 * لا يلمس dev.db ولا Turso.
 */
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient, AccountType, AccountingEvent, JournalEntryStatus } from '@prisma/client';
import { seedDefaultChartAndMappings } from '../src/accounting/mapping.service';
import { roundMoney, toCents, assertBalanced } from '../src/accounting/money';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDb = path.join(__dirname, '../prisma/accounting-test.db');

// عزل تام عن Turso وdev
process.env.TURSO_DATABASE_URL = '';
process.env.DATABASE_URL = `file:${testDb}`;

const prisma = new PrismaClient();

function assertEntryBalanced(lines: { debit: number; credit: number }[]) {
  const r = assertBalanced(lines);
  assert.equal(r.debitCents, r.creditCents);
}

async function glBalance(code: string) {
  const account = await prisma.account.findUnique({ where: { code } });
  assert.ok(account, `account ${code}`);
  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: account!.id,
      entry: { status: { in: [JournalEntryStatus.POSTED, JournalEntryStatus.REVERSED] } },
    },
  });
  const debit = lines.reduce((s, l) => s + toCents(l.debit), 0);
  const credit = lines.reduce((s, l) => s + toCents(l.credit), 0);
  return { account, debitCents: debit, creditCents: credit, netCents: debit - credit };
}

describe('accounting e2e (isolated test DB)', () => {
  before(async () => {
    await prisma.$connect();
    // نظّف جداول المحاسبة بترتيب يحترم الـ FK
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
    await prisma.accountingCogsDirty.deleteMany().catch(() => null);
    await prisma.accountingCogsLock.deleteMany().catch(() => null);
    await prisma.fixedAssetDepreciation.deleteMany().catch(() => null);
    await prisma.account.updateMany({ data: { parentId: null, cashAccountId: null, costCenterId: null } });
    await prisma.account.deleteMany();
    await seedDefaultChartAndMappings(prisma);
  });

  it('seed creates CoA and required mappings', async () => {
    const accounts = await prisma.account.count();
    assert.ok(accounts >= 12);
    const ar = await prisma.account.findUnique({ where: { code: '1200' } });
    assert.equal(ar?.subledger, 'AR');
    const map = await prisma.accountMapping.findUnique({
      where: { event: AccountingEvent.SALE_CONFIRM },
      include: { lines: true },
    });
    assert.ok(map && map.lines.length >= 4);
  });

  it('opening batch apply posts balanced JE without AR control double-count', async () => {
    const cash = await prisma.account.findUniqueOrThrow({ where: { code: '1100' } });
    const inv = await prisma.account.findUniqueOrThrow({ where: { code: '1300' } });
    const equity = await prisma.account.findUniqueOrThrow({ where: { code: '3100' } });
    const year = 2026;

    const batch = await prisma.accountOpeningBatch.create({
      data: { fiscalYear: year, version: 1, status: 'DRAFT', notes: 'e2e' },
    });
    await prisma.accountOpeningBalance.createMany({
      data: [
        { batchId: batch.id, accountId: cash.id, debit: 50000, credit: 0, partyKey: 'NONE' },
        { batchId: batch.id, accountId: inv.id, debit: 100000, credit: 0, partyKey: 'NONE' },
        { batchId: batch.id, accountId: equity.id, debit: 0, credit: 150000, partyKey: 'NONE' },
      ],
    });

    const lines = await prisma.accountOpeningBalance.findMany({ where: { batchId: batch.id } });
    assertEntryBalanced(lines.map((l) => ({ debit: l.debit, credit: l.credit })));

    // محاكاة apply عبر قيد مباشر (نفس قواعد OpeningService)
    const number = `JE-OB-${year}-v1`;
    const entry = await prisma.journalEntry.create({
      data: {
        number,
        entryDate: new Date(`${year}-01-01`),
        description: 'افتتاحي',
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.OPENING_BALANCE,
        sourceId: `OB-${year}-v1`,
        fiscalYear: year,
        fiscalMonth: 1,
        postedAt: new Date(),
        lines: {
          create: lines.map((l, i) => ({
            accountId: l.accountId,
            debit: l.debit,
            credit: l.credit,
            lineOrder: i,
          })),
        },
      },
      include: { lines: true },
    });
    assertEntryBalanced(entry.lines);
    await prisma.accountOpeningBatch.update({
      where: { id: batch.id },
      data: {
        status: 'APPLIED',
        journalEntryId: entry.id,
        appliedYearKey: String(year),
      },
    });

    const cashBal = await glBalance('1100');
    assert.equal(cashBal.netCents, 50000 * 100);
    const invBal = await glBalance('1300');
    assert.equal(invBal.netCents, 100000 * 100);
  });

  it('rejects unbalanced journal draft conceptually via money assert', () => {
    assert.throws(() => assertBalanced([{ debit: 100, credit: 0 }, { debit: 0, credit: 50 }]));
  });

  it('manual posted entry is balanced and appears in trial filter statuses', async () => {
    const cash = await prisma.account.findUniqueOrThrow({ where: { code: '1100' } });
    const expense = await prisma.account.findUniqueOrThrow({ where: { code: '5200' } });
    const entry = await prisma.journalEntry.create({
      data: {
        number: `JE-MAN-${Date.now()}`,
        entryDate: new Date(),
        description: 'مصروف تجريبي',
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.MANUAL,
        sourceId: `manual-${Date.now()}`,
        fiscalYear: 2026,
        fiscalMonth: 3,
        postedAt: new Date(),
        lines: {
          create: [
            { accountId: expense.id, debit: 2000, credit: 0, lineOrder: 0 },
            { accountId: cash.id, debit: 0, credit: 2000, lineOrder: 1 },
          ],
        },
      },
      include: { lines: true },
    });
    assertEntryBalanced(entry.lines);
    const draftOnly = await prisma.journalEntry.count({ where: { status: 'DRAFT' } });
    void draftOnly;
    const posted = await prisma.journalLine.aggregate({
      where: { entryId: entry.id },
      _sum: { debit: true, credit: true },
    });
    assert.equal(toCents(posted._sum.debit || 0), toCents(posted._sum.credit || 0));
  });

  it('purchase confirm style JE: inventory + AP', async () => {
    const inventory = await prisma.account.findUniqueOrThrow({ where: { code: '1300' } });
    const ap = await prisma.account.findUniqueOrThrow({ where: { code: '2100' } });
    const supplier = await prisma.supplier.findFirst();
    const entry = await prisma.journalEntry.create({
      data: {
        number: `JE-PUR-${Date.now()}`,
        entryDate: new Date(),
        description: 'شراء آجل',
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.PURCHASE_CONFIRM,
        sourceId: `pur-e2e-${Date.now()}`,
        fiscalYear: 2026,
        fiscalMonth: 3,
        postedAt: new Date(),
        lines: {
          create: [
            { accountId: inventory.id, debit: 20000, credit: 0, lineOrder: 0 },
            {
              accountId: ap.id,
              debit: 0,
              credit: 20000,
              lineOrder: 1,
              partyType: 'SUPPLIER',
              supplierId: supplier?.id || null,
            },
          ],
        },
      },
      include: { lines: true },
    });
    assertEntryBalanced(entry.lines);
    if (supplier) {
      assert.ok(entry.lines.some((l) => l.supplierId === supplier.id));
    }
  });

  it('sale confirm style JE: AR + revenue + COGS', async () => {
    const ar = await prisma.account.findUniqueOrThrow({ where: { code: '1200' } });
    const rev = await prisma.account.findUniqueOrThrow({ where: { code: '4100' } });
    const cogs = await prisma.account.findUniqueOrThrow({ where: { code: '5100' } });
    const inventory = await prisma.account.findUniqueOrThrow({ where: { code: '1300' } });
    const customer = await prisma.customer.findFirst();
    const entry = await prisma.journalEntry.create({
      data: {
        number: `JE-SAL-${Date.now()}`,
        entryDate: new Date(),
        description: 'بيع',
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.SALE_CONFIRM,
        sourceId: `sal-e2e-${Date.now()}`,
        fiscalYear: 2026,
        fiscalMonth: 3,
        postedAt: new Date(),
        lines: {
          create: [
            {
              accountId: ar.id,
              debit: 15000,
              credit: 0,
              lineOrder: 0,
              partyType: 'CUSTOMER',
              customerId: customer?.id || null,
            },
            { accountId: rev.id, debit: 0, credit: 15000, lineOrder: 1 },
            { accountId: cogs.id, debit: 9000, credit: 0, lineOrder: 2 },
            { accountId: inventory.id, debit: 0, credit: 9000, lineOrder: 3 },
          ],
        },
      },
      include: { lines: true },
    });
    assertEntryBalanced(entry.lines);
  });

  it('receipt + payment + purchase return balanced', async () => {
    const cash = await prisma.account.findUniqueOrThrow({ where: { code: '1100' } });
    const ar = await prisma.account.findUniqueOrThrow({ where: { code: '1200' } });
    const ap = await prisma.account.findUniqueOrThrow({ where: { code: '2100' } });
    const inventory = await prisma.account.findUniqueOrThrow({ where: { code: '1300' } });
    const customer = await prisma.customer.findFirst();
    const supplier = await prisma.supplier.findFirst();

    const receipt = await prisma.journalEntry.create({
      data: {
        number: `JE-RCP-${Date.now()}`,
        entryDate: new Date(),
        description: 'تحصيل',
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.SALE_RECEIPT,
        sourceId: `rcp-e2e-${Date.now()}`,
        fiscalYear: 2026,
        fiscalMonth: 3,
        postedAt: new Date(),
        lines: {
          create: [
            { accountId: cash.id, debit: 10000, credit: 0, lineOrder: 0 },
            {
              accountId: ar.id,
              debit: 0,
              credit: 10000,
              lineOrder: 1,
              partyType: 'CUSTOMER',
              customerId: customer?.id || null,
            },
          ],
        },
      },
      include: { lines: true },
    });
    assertEntryBalanced(receipt.lines);

    const payment = await prisma.journalEntry.create({
      data: {
        number: `JE-PAY-${Date.now()}`,
        entryDate: new Date(),
        description: 'سداد',
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.PURCHASE_PAYMENT,
        sourceId: `pay-e2e-${Date.now()}`,
        fiscalYear: 2026,
        fiscalMonth: 3,
        postedAt: new Date(),
        lines: {
          create: [
            {
              accountId: ap.id,
              debit: 5000,
              credit: 0,
              lineOrder: 0,
              partyType: 'SUPPLIER',
              supplierId: supplier?.id || null,
            },
            { accountId: cash.id, debit: 0, credit: 5000, lineOrder: 1 },
          ],
        },
      },
      include: { lines: true },
    });
    assertEntryBalanced(payment.lines);

    const pret = await prisma.journalEntry.create({
      data: {
        number: `JE-PR-${Date.now()}`,
        entryDate: new Date(),
        description: 'مرتجع شراء',
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.PURCHASE_RETURN,
        sourceId: `pr-e2e-${Date.now()}`,
        fiscalYear: 2026,
        fiscalMonth: 3,
        postedAt: new Date(),
        lines: {
          create: [
            {
              accountId: ap.id,
              debit: 2000,
              credit: 0,
              lineOrder: 0,
              partyType: 'SUPPLIER',
              supplierId: supplier?.id || null,
            },
            { accountId: inventory.id, debit: 0, credit: 2000, lineOrder: 1 },
          ],
        },
      },
      include: { lines: true },
    });
    assertEntryBalanced(pret.lines);
  });

  it('reversal nets to zero for original account pair', async () => {
    const cash = await prisma.account.findUniqueOrThrow({ where: { code: '1100' } });
    const expense = await prisma.account.findUniqueOrThrow({ where: { code: '5200' } });
    const baseline = await glBalance('5200');
    const original = await prisma.journalEntry.create({
      data: {
        number: `JE-REV-O-${Date.now()}`,
        entryDate: new Date(),
        description: 'للعكس',
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.MANUAL,
        sourceId: `rev-src-${Date.now()}`,
        fiscalYear: 2026,
        fiscalMonth: 3,
        postedAt: new Date(),
        lines: {
          create: [
            { accountId: expense.id, debit: 100, credit: 0, lineOrder: 0 },
            { accountId: cash.id, debit: 0, credit: 100, lineOrder: 1 },
          ],
        },
      },
      include: { lines: true },
    });
    const mid = await glBalance('5200');
    assert.equal(mid.netCents, baseline.netCents + 10000);
    const reversal = await prisma.journalEntry.create({
      data: {
        number: `JE-REV-R-${Date.now()}`,
        entryDate: new Date(),
        description: 'عكس',
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.MANUAL,
        sourceId: `rev-of-${original.id}`,
        fiscalYear: 2026,
        fiscalMonth: 3,
        postedAt: new Date(),
        reversesEntryId: original.id,
        lines: {
          create: original.lines.map((l, i) => ({
            accountId: l.accountId,
            debit: l.credit,
            credit: l.debit,
            lineOrder: i,
          })),
        },
      },
      include: { lines: true },
    });
    await prisma.journalEntry.update({
      where: { id: original.id },
      data: { status: JournalEntryStatus.REVERSED },
    });
    assertEntryBalanced(reversal.lines);
    assert.equal(toCents(reversal.lines[0].debit), toCents(original.lines[0].credit));
    assert.equal(toCents(reversal.lines[0].credit), toCents(original.lines[0].debit));
    const afterExp = await glBalance('5200');
    // POSTED+REVERSED يظهران معًا وصافيهما صفر مقابل الأساس
    assert.equal(afterExp.netCents, baseline.netCents);
  });

  it('queue unique event+sourceId and claimVersion fencing fields exist', async () => {
    const row = await prisma.accountingPostQueue.create({
      data: {
        event: AccountingEvent.EXPENSE_CREATE,
        sourceId: `q-e2e-${Date.now()}`,
        status: 'PENDING',
        claimVersion: 0,
      },
    });
    await assert.rejects(() =>
      prisma.accountingPostQueue.create({
        data: {
          event: row.event,
          sourceId: row.sourceId,
          status: 'PENDING',
        },
      }),
    );
    const claimed = await prisma.accountingPostQueue.updateMany({
      where: { id: row.id, claimVersion: 0, status: 'PENDING' },
      data: { status: 'PROCESSING', claimVersion: { increment: 1 }, lockedBy: 'w1' },
    });
    assert.equal(claimed.count, 1);
    const stale = await prisma.accountingPostQueue.updateMany({
      where: { id: row.id, claimVersion: 0, status: 'PROCESSING' },
      data: { status: 'POSTED' },
    });
    assert.equal(stale.count, 0);
  });

  it('fifo ticket gate rejects stale publish', async () => {
    const product = await prisma.product.findFirst();
    if (!product) return;
    await prisma.fifoReplayEpoch.upsert({
      where: { productId: product.id },
      create: { productId: product.id, nextSeq: 2, lastPublishedSeq: 2 },
      update: { nextSeq: 2, lastPublishedSeq: 2 },
    });
    const staleTicket = 1;
    const gate = await prisma.fifoReplayEpoch.updateMany({
      where: {
        productId: product.id,
        nextSeq: staleTicket,
        lastPublishedSeq: { lt: staleTicket },
      },
      data: { lastPublishedSeq: staleTicket },
    });
    assert.equal(gate.count, 0);
  });

  it('trial balance posts only POSTED+REVERSED and sums balance', async () => {
    const lines = await prisma.journalLine.findMany({
      where: { entry: { status: { in: ['POSTED', 'REVERSED'] } } },
    });
    const debit = lines.reduce((s, l) => s + toCents(l.debit), 0);
    const credit = lines.reduce((s, l) => s + toCents(l.credit), 0);
    assert.equal(debit, credit, `TB imbalance debit=${debit} credit=${credit}`);
  });
});
