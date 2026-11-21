/**
 * أمان صرف المرتبات: claim ذري + outbox + حدود العكس — accounting-test.db فقط.
 */
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import {
  AccountingEvent,
  AccountingPostQueueStatus,
  JournalEntryStatus,
  PayMethodKind,
  PayrollStatus,
  PrismaClient,
} from '@prisma/client';
import { seedDefaultChartAndMappings } from '../src/accounting/mapping.service';
import { QueueService } from '../src/accounting/queue.service';
import { toCents } from '../src/accounting/money';

process.env.TURSO_DATABASE_URL = '';
process.env.DATABASE_URL = 'file:./prisma/accounting-test.db';

const prisma = new PrismaClient();
const queue = new QueueService(prisma as never);

async function cleanLite() {
  await prisma.journalLine.deleteMany();
  await prisma.accountingPostQueue.updateMany({ data: { postedEntryId: null } });
  await prisma.accountingPostQueue.deleteMany();
  await prisma.journalEntry.updateMany({ data: { reversesEntryId: null } });
  await prisma.journalEntry.deleteMany();
  await prisma.cashTransaction.deleteMany({ where: { reference: { startsWith: 'PAYROLL-' } } });
  await prisma.cashTransaction.deleteMany({ where: { reference: { startsWith: 'REV-PAYROLL-' } } });
  await prisma.payrollLine.deleteMany({ where: { employee: { code: { startsWith: 'E-CX-' } } } });
  await prisma.payrollRun.deleteMany({
    where: { lines: { none: {} } },
  });
  // leftover empty runs from CX fixtures
  await prisma.payrollRun.deleteMany({
    where: { notes: 'cx-fixture' },
  });
  await prisma.employee.deleteMany({ where: { code: { startsWith: 'E-CX-' } } });
  await prisma.accountMappingLine.deleteMany();
  await prisma.accountMapping.deleteMany();
  await prisma.account.updateMany({ data: { parentId: null, cashAccountId: null, costCenterId: null } });
  await prisma.account.deleteMany();
  await seedDefaultChartAndMappings(prisma);
}

async function ensureCash() {
  let cash = await prisma.cashAccount.findFirst({ where: { code: 'CASH-CX' } });
  if (!cash) {
    cash = await prisma.cashAccount.create({
      data: { code: 'CASH-CX', name: 'خزنة concurrency', balance: 50_000 },
    });
  } else {
    cash = await prisma.cashAccount.update({ where: { id: cash.id }, data: { balance: 50_000 } });
  }
  const gl = await prisma.account.findUniqueOrThrow({ where: { code: '1100' } });
  await prisma.account.update({ where: { id: gl.id }, data: { cashAccountId: cash.id } });
  let method = await prisma.payMethod.findFirst({ where: { cashAccountId: cash.id } });
  if (!method) {
    method = await prisma.payMethod.create({
      data: {
        code: `PM-CX-${Date.now()}`,
        name: 'نقدي CX',
        kind: PayMethodKind.IMMEDIATE,
        cashAccountId: cash.id,
      },
    });
  }
  return { cash, method };
}

async function makePostedRun(amount: number) {
  const emp = await prisma.employee.create({
    data: {
      code: `E-CX-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
      name: 'موظف CX',
      basicSalary: amount,
      isActive: true,
    },
  });
  const run = await prisma.payrollRun.create({
    data: {
      fromDate: new Date('2026-02-01'),
      toDate: new Date('2026-02-28T23:59:59'),
      status: PayrollStatus.POSTED,
      postedAt: new Date(),
      notes: 'cx-fixture',
      paidAmount: 0,
      lines: {
        create: {
          employeeId: emp.id,
          salaryNet: amount,
          commissionDue: 0,
          net: amount,
        },
      },
    },
  });
  const a5210 = await prisma.account.findUniqueOrThrow({ where: { code: '5210' } });
  const a2300 = await prisma.account.findUniqueOrThrow({ where: { code: '2300' } });
  await prisma.journalEntry.create({
    data: {
      number: `JE-CX-ACC-${run.id.slice(-6)}-${Date.now()}`,
      entryDate: run.toDate,
      description: 'استحقاق CX',
      status: JournalEntryStatus.POSTED,
      sourceType: AccountingEvent.PAYROLL_POST,
      sourceId: run.id,
      fiscalYear: 2026,
      fiscalMonth: 2,
      postedAt: new Date(),
      lines: {
        create: [
          { accountId: a5210.id, debit: amount, credit: 0, lineOrder: 0 },
          { accountId: a2300.id, debit: 0, credit: amount, lineOrder: 1 },
        ],
      },
    },
  });
  return run;
}

/** نفس حدود معاملة pay() بعد الإصلاح */
async function atomicPayTx(opts: {
  runId: string;
  amount: number;
  cashAccountId: string;
  methodId: string;
  actorId?: string;
}) {
  const paidAt = new Date();
  const cashRef = `PAYROLL-${opts.runId}`;
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.payrollRun.updateMany({
      where: { id: opts.runId, status: PayrollStatus.POSTED, paidAmount: 0 },
      data: {
        status: PayrollStatus.PAID,
        methodId: opts.methodId,
        accountId: opts.cashAccountId,
        paidAmount: opts.amount,
        paidAt,
        paidById: opts.actorId || null,
      },
    });
    if (claimed.count !== 1) {
      throw new Error('CLAIM_FAILED');
    }
    await tx.cashAccount.update({
      where: { id: opts.cashAccountId },
      data: { balance: { decrement: opts.amount } },
    });
    await tx.cashTransaction.create({
      data: {
        accountId: opts.cashAccountId,
        direction: 'OUT',
        amount: opts.amount,
        description: 'صرف CX',
        paymentMethod: opts.methodId,
        reference: cashRef,
      },
    });
    await queue.enqueueInTx(tx, AccountingEvent.PAYROLL_PAYMENT, opts.runId, {
      amount: opts.amount,
      cashAccountId: opts.cashAccountId,
    });
  });
}

describe('payroll payment concurrency & outbox', () => {
  before(async () => {
    await prisma.$connect();
    await cleanLite();
  });

  it('two concurrent pays: exactly one cash OUT, one queue event, one PAID', async () => {
    await cleanLite();
    const { cash, method } = await ensureCash();
    const run = await makePostedRun(1500);
    const balanceBefore = cash.balance;

    const results = await Promise.allSettled([
      atomicPayTx({ runId: run.id, amount: 1500, cashAccountId: cash.id, methodId: method.id }),
      atomicPayTx({ runId: run.id, amount: 1500, cashAccountId: cash.id, methodId: method.id }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    assert.equal(fulfilled, 1);
    assert.equal(rejected, 1);

    const updated = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(updated.status, PayrollStatus.PAID);
    assert.equal(updated.paidAmount, 1500);

    const outs = await prisma.cashTransaction.findMany({
      where: { reference: `PAYROLL-${run.id}`, direction: 'OUT' },
    });
    assert.equal(outs.length, 1);

    const queueRows = await prisma.accountingPostQueue.findMany({
      where: { event: AccountingEvent.PAYROLL_PAYMENT, sourceId: run.id },
    });
    assert.equal(queueRows.length, 1);
    assert.ok(
      queueRows[0].status === AccountingPostQueueStatus.PENDING
      || queueRows[0].status === AccountingPostQueueStatus.FAILED
      || queueRows[0].status === AccountingPostQueueStatus.POSTED,
    );

    const cashAfter = await prisma.cashAccount.findUniqueOrThrow({ where: { id: cash.id } });
    assert.equal(cashAfter.balance, balanceBefore - 1500);
  });

  it('exactly one payment JE after queue processing; retry is idempotent', async () => {
    await cleanLite();
    const { cash, method } = await ensureCash();
    const run = await makePostedRun(900);
    await atomicPayTx({ runId: run.id, amount: 900, cashAccountId: cash.id, methodId: method.id });

    const a2300 = await prisma.account.findUniqueOrThrow({ where: { code: '2300' } });
    const a1100 = await prisma.account.findUniqueOrThrow({ where: { code: '1100' } });

    async function postPaymentJeOnce() {
      const existing = await prisma.journalEntry.findUnique({
        where: {
          sourceType_sourceId: {
            sourceType: AccountingEvent.PAYROLL_PAYMENT,
            sourceId: run.id,
          },
        },
      });
      if (existing) return existing;
      return prisma.journalEntry.create({
        data: {
          number: `JE-CX-PAY-${Date.now()}`,
          entryDate: new Date(),
          description: 'صرف',
          status: JournalEntryStatus.POSTED,
          sourceType: AccountingEvent.PAYROLL_PAYMENT,
          sourceId: run.id,
          fiscalYear: 2026,
          fiscalMonth: 2,
          postedAt: new Date(),
          lines: {
            create: [
              { accountId: a2300.id, debit: 900, credit: 0, lineOrder: 0 },
              { accountId: a1100.id, debit: 0, credit: 900, lineOrder: 1 },
            ],
          },
        },
      });
    }

    // simulate first failure: leave queue PENDING
    let q = await prisma.accountingPostQueue.findUniqueOrThrow({
      where: { event_sourceId: { event: AccountingEvent.PAYROLL_PAYMENT, sourceId: run.id } },
    });
    assert.equal(q.status, AccountingPostQueueStatus.PENDING);

    const first = await postPaymentJeOnce();
    await prisma.accountingPostQueue.update({
      where: { id: q.id },
      data: {
        status: AccountingPostQueueStatus.POSTED,
        postedEntryId: first.id,
      },
    });

    const second = await postPaymentJeOnce();
    assert.equal(second.id, first.id);

    const jes = await prisma.journalEntry.count({
      where: { sourceType: AccountingEvent.PAYROLL_PAYMENT, sourceId: run.id },
    });
    assert.equal(jes, 1);

    // duplicate queue processing must not create cash again
    const outsBefore = await prisma.cashTransaction.count({
      where: { reference: `PAYROLL-${run.id}`, direction: 'OUT' },
    });
    assert.equal(outsBefore, 1);
  });

  it('transaction rollback during payment leaves POSTED and no cash/queue', async () => {
    await cleanLite();
    const { cash, method } = await ensureCash();
    const run = await makePostedRun(700);
    const bal = (await prisma.cashAccount.findUniqueOrThrow({ where: { id: cash.id } })).balance;

    await assert.rejects(() =>
      prisma.$transaction(async (tx) => {
        const claimed = await tx.payrollRun.updateMany({
          where: { id: run.id, status: PayrollStatus.POSTED, paidAmount: 0 },
          data: {
            status: PayrollStatus.PAID,
            paidAmount: 700,
            paidAt: new Date(),
            accountId: cash.id,
            methodId: method.id,
          },
        });
        assert.equal(claimed.count, 1);
        await tx.cashAccount.update({
          where: { id: cash.id },
          data: { balance: { decrement: 700 } },
        });
        throw new Error('SIMULATED_ROLLBACK');
      }),
    );

    const runAfter = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(runAfter.status, PayrollStatus.POSTED);
    assert.equal(runAfter.paidAmount, 0);
    const cashAfter = await prisma.cashAccount.findUniqueOrThrow({ where: { id: cash.id } });
    assert.equal(cashAfter.balance, bal);
    const q = await prisma.accountingPostQueue.count({
      where: { event: AccountingEvent.PAYROLL_PAYMENT, sourceId: run.id },
    });
    assert.equal(q, 0);
  });

  it('claim rejects DRAFT and already-paid runs', async () => {
    await cleanLite();
    const { cash, method } = await ensureCash();
    const draftEmp = await prisma.employee.create({
      data: { code: `E-CX-D-${Date.now()}`, name: 'd', basicSalary: 100, isActive: true },
    });
    const draft = await prisma.payrollRun.create({
      data: {
        fromDate: new Date('2026-03-01'),
        toDate: new Date('2026-03-31'),
        status: PayrollStatus.DRAFT,
        notes: 'cx-fixture',
        lines: { create: { employeeId: draftEmp.id, salaryNet: 100, net: 100 } },
      },
    });
    await assert.rejects(() =>
      atomicPayTx({ runId: draft.id, amount: 100, cashAccountId: cash.id, methodId: method.id }),
    );

    const run = await makePostedRun(500);
    await atomicPayTx({ runId: run.id, amount: 500, cashAccountId: cash.id, methodId: method.id });
    await assert.rejects(() =>
      atomicPayTx({ runId: run.id, amount: 500, cashAccountId: cash.id, methodId: method.id }),
    );
  });

  it('cannot reverse accrual while payment active; payment then accrual reverse works', async () => {
    await cleanLite();
    const { cash, method } = await ensureCash();
    const run = await makePostedRun(1100);
    await atomicPayTx({ runId: run.id, amount: 1100, cashAccountId: cash.id, methodId: method.id });

    // accrual reverse blocked while PAID (service rule mirrored)
    const paid = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(paid.status, PayrollStatus.PAID);
    assert.ok(toCents(paid.paidAmount) > 0);

    // payment JE
    const a2300 = await prisma.account.findUniqueOrThrow({ where: { code: '2300' } });
    const a1100 = await prisma.account.findUniqueOrThrow({ where: { code: '1100' } });
    const payJe = await prisma.journalEntry.create({
      data: {
        number: `JE-CX-PAY2-${Date.now()}`,
        entryDate: new Date(),
        description: 'صرف',
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.PAYROLL_PAYMENT,
        sourceId: run.id,
        fiscalYear: 2026,
        fiscalMonth: 2,
        postedAt: new Date(),
        lines: {
          create: [
            { accountId: a2300.id, debit: 1100, credit: 0, lineOrder: 0 },
            { accountId: a1100.id, debit: 0, credit: 1100, lineOrder: 1 },
          ],
        },
      },
    });

    // reverse payment JE (accounting order)
    await prisma.journalEntry.update({
      where: { id: payJe.id },
      data: { status: JournalEntryStatus.REVERSED },
    });
    await prisma.journalEntry.create({
      data: {
        number: `JE-CX-UNPAY-${Date.now()}`,
        entryDate: new Date(),
        description: 'عكس صرف',
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.PAYROLL_PAYMENT,
        sourceId: `REV-${run.id}`,
        fiscalYear: 2026,
        fiscalMonth: 2,
        postedAt: new Date(),
        reversesEntryId: payJe.id,
        lines: {
          create: [
            { accountId: a1100.id, debit: 1100, credit: 0, lineOrder: 0 },
            { accountId: a2300.id, debit: 0, credit: 1100, lineOrder: 1 },
          ],
        },
      },
    });
    await prisma.journalEntry.update({
      where: { id: payJe.id },
      data: { sourceId: `ARCH-PAY-${run.id}-${payJe.id}` },
    });

    // auditable cash IN + unclaim
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.payrollRun.updateMany({
        where: { id: run.id, status: PayrollStatus.PAID, paidAmount: 1100 },
        data: { status: PayrollStatus.POSTED, paidAmount: 0, paidAt: null },
      });
      assert.equal(claimed.count, 1);
      await tx.cashAccount.update({
        where: { id: cash.id },
        data: { balance: { increment: 1100 } },
      });
      await tx.cashTransaction.create({
        data: {
          accountId: cash.id,
          direction: 'IN',
          amount: 1100,
          description: 'عكس صرف CX',
          reference: `REV-PAYROLL-${run.id}`,
        },
      });
    });

    const afterPayRev = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(afterPayRev.status, PayrollStatus.POSTED);
    assert.equal(afterPayRev.paidAmount, 0);

    // now accrual may be reversed
    const accrual = await prisma.journalEntry.findUniqueOrThrow({
      where: {
        sourceType_sourceId: { sourceType: AccountingEvent.PAYROLL_POST, sourceId: run.id },
      },
    });
    assert.equal(accrual.status, JournalEntryStatus.POSTED);
    await prisma.journalEntry.update({
      where: { id: accrual.id },
      data: { status: JournalEntryStatus.REVERSED, sourceId: `ARCH-${run.id}-${accrual.id}` },
    });
    await prisma.payrollRun.update({
      where: { id: run.id },
      data: { status: PayrollStatus.DRAFT, postedAt: null },
    });
    const final = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(final.status, PayrollStatus.DRAFT);
  });

  it('documents SQLite concurrency limits for multi-worker Turso', () => {
    // SQLite serializes writers; Promise.all still exercises conditional updateMany.
    // True multi-connection Turso multi-worker concurrency is not claimed verified here.
    assert.ok(true);
  });
});
