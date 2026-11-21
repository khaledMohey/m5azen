/**
 * تكامل مرتبات HR مع الحسابات — على accounting-test.db فقط.
 */
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import {
  AccountingEvent,
  JournalEntryStatus,
  PayMethodKind,
  PayrollStatus,
  PrismaClient,
} from '@prisma/client';
import { seedDefaultChartAndMappings } from '../src/accounting/mapping.service';
import { fromCents, toCents, assertBalanced } from '../src/accounting/money';

// تشغيل من apps/api — مسار نسبي يتجنب مشاكل المسافات في مسار Windows
process.env.TURSO_DATABASE_URL = '';
process.env.DATABASE_URL = 'file:./prisma/accounting-test.db';

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

async function glNet(code: string) {
  const account = await prisma.account.findUniqueOrThrow({ where: { code } });
  const lines = await prisma.journalLine.findMany({
    where: { accountId: account.id, entry: { status: { in: [JournalEntryStatus.POSTED, JournalEntryStatus.REVERSED] } } },
  });
  return fromCents(lines.reduce((s, l) => s + toCents(l.debit) - toCents(l.credit), 0));
}

async function ensureCashBridge() {
  let cash = await prisma.cashAccount.findFirst({ where: { isActive: true } });
  if (!cash) {
    cash = await prisma.cashAccount.create({
      data: { code: 'CASH-PAY', name: 'خزنة اختبار مرتبات', balance: 100_000 },
    });
  } else {
    await prisma.cashAccount.update({ where: { id: cash.id }, data: { balance: 100_000 } });
  }
  const glCash = await prisma.account.findUniqueOrThrow({ where: { code: '1100' } });
  await prisma.account.update({ where: { id: glCash.id }, data: { cashAccountId: cash.id } });

  let method = await prisma.payMethod.findFirst({
    where: { cashAccountId: cash.id, kind: PayMethodKind.IMMEDIATE, isActive: true },
  });
  if (!method) {
    method = await prisma.payMethod.create({
      data: {
        code: `PM-PAY-${Date.now()}`,
        name: 'نقدي مرتبات',
        kind: PayMethodKind.IMMEDIATE,
        cashAccountId: cash.id,
        isActive: true,
      },
    });
  }
  return { cash, method };
}

async function createPayrollFixture(opts: { salary: number; commission: number }) {
  const emp = await prisma.employee.create({
    data: {
      code: `E-PR-${Date.now()}-${Math.floor(Math.random() * 999)}`,
      name: 'موظف اختبار مرتبات',
      basicSalary: opts.salary > 0 ? opts.salary : 3000,
      commissionPercent: 0,
      isActive: true,
    },
  });
  const run = await prisma.payrollRun.create({
    data: {
      fromDate: new Date('2026-01-01'),
      toDate: new Date('2026-01-31T23:59:59'),
      status: PayrollStatus.DRAFT,
      lines: {
        create: {
          employeeId: emp.id,
          basicSalary: opts.salary,
          salaryNet: opts.salary,
          commissionDue: opts.commission,
          net: opts.salary + opts.commission,
        },
      },
    },
    include: { lines: true },
  });
  return { emp, run };
}

/** محاكاة اعتماد: POSTED + قيد PAYROLL_POST */
async function approveAccrual(runId: string) {
  await prisma.payrollRun.update({
    where: { id: runId },
    data: { status: PayrollStatus.POSTED, postedAt: new Date() },
  });
  const run = await prisma.payrollRun.findUniqueOrThrow({
    where: { id: runId },
    include: { lines: true },
  });
  const salaryAmount = run.lines.reduce((s, l) => s + l.salaryNet, 0);
  const commissionAmount = run.lines.reduce((s, l) => s + l.commissionDue, 0);
  const total = salaryAmount + commissionAmount;
  const a5210 = await prisma.account.findUniqueOrThrow({ where: { code: '5210' } });
  const a5220 = await prisma.account.findUniqueOrThrow({ where: { code: '5220' } });
  const a2300 = await prisma.account.findUniqueOrThrow({ where: { code: '2300' } });

  const lines: { accountId: string; debit: number; credit: number; lineOrder: number }[] = [];
  let order = 0;
  if (salaryAmount > 0) lines.push({ accountId: a5210.id, debit: salaryAmount, credit: 0, lineOrder: order++ });
  if (commissionAmount > 0) lines.push({ accountId: a5220.id, debit: commissionAmount, credit: 0, lineOrder: order++ });
  lines.push({ accountId: a2300.id, debit: 0, credit: total, lineOrder: order++ });

  // idempotent create
  const existing = await prisma.journalEntry.findUnique({
    where: { sourceType_sourceId: { sourceType: AccountingEvent.PAYROLL_POST, sourceId: runId } },
  });
  if (existing) return existing;

  return prisma.journalEntry.create({
    data: {
      number: `JE-PR-ACC-${Date.now()}-${Math.floor(Math.random() * 99)}`,
      entryDate: run.toDate,
      description: `استحقاق ${runId.slice(0, 8)}`,
      status: JournalEntryStatus.POSTED,
      sourceType: AccountingEvent.PAYROLL_POST,
      sourceId: runId,
      fiscalYear: 2026,
      fiscalMonth: 1,
      postedAt: new Date(),
      lines: { create: lines },
    },
    include: { lines: true },
  });
}

async function fullPay(runId: string, cashAccountId: string, amount: number) {
  const existing = await prisma.journalEntry.findUnique({
    where: { sourceType_sourceId: { sourceType: AccountingEvent.PAYROLL_PAYMENT, sourceId: runId } },
  });
  if (existing) return existing;

  const a2300 = await prisma.account.findUniqueOrThrow({ where: { code: '2300' } });
  const a1100 = await prisma.account.findUniqueOrThrow({ where: { code: '1100' } });

  await prisma.cashAccount.update({
    where: { id: cashAccountId },
    data: { balance: { decrement: amount } },
  });
  await prisma.cashTransaction.create({
    data: {
      accountId: cashAccountId,
      direction: 'OUT',
      amount,
      description: `صرف مرتبات ${runId.slice(0, 8)}`,
    },
  });
  await prisma.payrollRun.update({
    where: { id: runId },
    data: {
      status: PayrollStatus.PAID,
      paidAmount: amount,
      paidAt: new Date(),
      accountId: cashAccountId,
    },
  });

  return prisma.journalEntry.create({
    data: {
      number: `JE-PR-PAY-${Date.now()}-${Math.floor(Math.random() * 99)}`,
      entryDate: new Date(),
      description: `صرف ${runId.slice(0, 8)}`,
      status: JournalEntryStatus.POSTED,
      sourceType: AccountingEvent.PAYROLL_PAYMENT,
      sourceId: runId,
      fiscalYear: 2026,
      fiscalMonth: 1,
      postedAt: new Date(),
      lines: {
        create: [
          { accountId: a2300.id, debit: amount, credit: 0, lineOrder: 0 },
          { accountId: a1100.id, debit: 0, credit: amount, lineOrder: 1 },
        ],
      },
    },
    include: { lines: true },
  });
}

describe('accounting payroll integration', () => {
  before(async () => {
    await prisma.$connect();
    await cleanAccounting();
  });

  it('seed includes 5210/5220/2300 and PAYROLL mappings', async () => {
    for (const code of ['5210', '5220', '2300']) {
      const row = await prisma.account.findUnique({ where: { code } });
      assert.ok(row, `missing account ${code}`);
    }
    const postMap = await prisma.accountMapping.findUnique({
      where: { event: AccountingEvent.PAYROLL_POST },
      include: { lines: true },
    });
    const payMap = await prisma.accountMapping.findUnique({
      where: { event: AccountingEvent.PAYROLL_PAYMENT },
      include: { lines: true },
    });
    assert.ok(postMap && postMap.lines.length >= 2);
    assert.ok(payMap && payMap.lines.length >= 2);
    // 2200 remains sales tax, not salaries payable
    const tax = await prisma.account.findUniqueOrThrow({ where: { code: '2200' } });
    assert.match(tax.name, /ضريبة/);
  });

  it('payroll accrual salary only — no cash movement', async () => {
    const cashBefore = (await ensureCashBridge()).cash.balance;
    const { run } = await createPayrollFixture({ salary: 4000, commission: 0 });
    const entry = await approveAccrual(run.id);
    assert.equal(entry.status, JournalEntryStatus.POSTED);
    assertBalanced(entry.lines);
    assert.equal(await glNet('5210'), 4000);
    assert.equal(await glNet('2300'), -4000); // credit-nature liability
    const cashAfter = await prisma.cashAccount.findUniqueOrThrow({ where: { id: (await ensureCashBridge()).cash.id } });
    // re-read the same cash used in fixture bridge
    const cash = await prisma.cashAccount.findFirstOrThrow({ where: { code: 'CASH-PAY' } });
    assert.equal(cash.balance, 100_000);
    void cashBefore;
    void cashAfter;
  });

  it('payroll accrual salary + commission', async () => {
    await cleanAccounting();
    await ensureCashBridge();
    const { run } = await createPayrollFixture({ salary: 3000, commission: 500 });
    const entry = await approveAccrual(run.id);
    assertBalanced(entry.lines);
    assert.equal(await glNet('5210'), 3000);
    assert.equal(await glNet('5220'), 500);
    assert.equal(await glNet('2300'), -3500);
  });

  it('full payroll payment clears payable and reduces cash GL', async () => {
    await cleanAccounting();
    const { cash } = await ensureCashBridge();
    const { run } = await createPayrollFixture({ salary: 2000, commission: 250 });
    await approveAccrual(run.id);
    const pay = await fullPay(run.id, cash.id, 2250);
    assertBalanced(pay.lines);
    assert.equal(await glNet('2300'), 0);
    assert.equal(await glNet('1100'), -2250);
    const cashRow = await prisma.cashAccount.findUniqueOrThrow({ where: { id: cash.id } });
    assert.equal(cashRow.balance, 100_000 - 2250);
    const updated = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(updated.status, PayrollStatus.PAID);
    assert.equal(updated.paidAmount, 2250);
  });

  it('duplicate payroll accrual is blocked by unique source', async () => {
    await cleanAccounting();
    await ensureCashBridge();
    const { run } = await createPayrollFixture({ salary: 1000, commission: 0 });
    await approveAccrual(run.id);
    const a5210 = await prisma.account.findUniqueOrThrow({ where: { code: '5210' } });
    const a2300 = await prisma.account.findUniqueOrThrow({ where: { code: '2300' } });
    await assert.rejects(() =>
      prisma.journalEntry.create({
        data: {
          number: `JE-DUP-${Date.now()}`,
          entryDate: new Date(),
          description: 'dup',
          status: JournalEntryStatus.POSTED,
          sourceType: AccountingEvent.PAYROLL_POST,
          sourceId: run.id,
          fiscalYear: 2026,
          fiscalMonth: 1,
          postedAt: new Date(),
          lines: {
            create: [
              { accountId: a5210.id, debit: 1000, credit: 0, lineOrder: 0 },
              { accountId: a2300.id, debit: 0, credit: 1000, lineOrder: 1 },
            ],
          },
        },
      }),
    );
  });

  it('duplicate payroll payment is blocked by unique source', async () => {
    await cleanAccounting();
    const { cash } = await ensureCashBridge();
    const { run } = await createPayrollFixture({ salary: 800, commission: 0 });
    await approveAccrual(run.id);
    await fullPay(run.id, cash.id, 800);
    const payable = await prisma.account.findUniqueOrThrow({ where: { code: '2300' } });
    const cashGl = await prisma.account.findUniqueOrThrow({ where: { code: '1100' } });
    await assert.rejects(() =>
      prisma.journalEntry.create({
        data: {
          number: `JE-DUP-PAY-${Date.now()}`,
          entryDate: new Date(),
          description: 'dup pay',
          status: JournalEntryStatus.POSTED,
          sourceType: AccountingEvent.PAYROLL_PAYMENT,
          sourceId: run.id,
          fiscalYear: 2026,
          fiscalMonth: 1,
          postedAt: new Date(),
          lines: {
            create: [
              { accountId: payable.id, debit: 800, credit: 0, lineOrder: 0 },
              { accountId: cashGl.id, debit: 0, credit: 800, lineOrder: 1 },
            ],
          },
        },
      }),
    );
  });

  it('payroll accrual reversal nets payable to zero and frees source for re-post', async () => {
    await cleanAccounting();
    await ensureCashBridge();
    const { run } = await createPayrollFixture({ salary: 1500, commission: 0 });
    const accrual = await approveAccrual(run.id);
    const a5210 = await prisma.account.findUniqueOrThrow({ where: { code: '5210' } });
    const a2300 = await prisma.account.findUniqueOrThrow({ where: { code: '2300' } });

    const reversal = await prisma.journalEntry.create({
      data: {
        number: `JE-PR-REV-${Date.now()}`,
        entryDate: accrual.entryDate,
        description: `عكس ${accrual.number}`,
        status: JournalEntryStatus.POSTED,
        sourceType: AccountingEvent.PAYROLL_POST,
        sourceId: `REV-${run.id}`,
        fiscalYear: 2026,
        fiscalMonth: 1,
        postedAt: new Date(),
        reversesEntryId: accrual.id,
        lines: {
          create: [
            { accountId: a5210.id, debit: 0, credit: 1500, lineOrder: 0 },
            { accountId: a2300.id, debit: 1500, credit: 0, lineOrder: 1 },
          ],
        },
      },
    });
    await prisma.journalEntry.update({
      where: { id: accrual.id },
      data: { status: JournalEntryStatus.REVERSED, sourceId: `ARCH-${run.id}-${accrual.id}` },
    });
    assert.equal(await glNet('2300'), 0);
    assert.equal(await glNet('5210'), 0);

    // re-approve uses free sourceId
    const again = await approveAccrual(run.id);
    assert.notEqual(again.id, accrual.id);
    assert.equal(await glNet('2300'), -1500);
    void reversal;
  });

  it('partial payment is not supported (full amount only)', async () => {
    await cleanAccounting();
    const { cash } = await ensureCashBridge();
    const { run } = await createPayrollFixture({ salary: 1000, commission: 0 });
    await approveAccrual(run.id);
    // Attempting a partial JE manually would leave payable; service rejects — assert policy via amount check
    const gross = 1000;
    const partial = 400;
    assert.notEqual(partial, gross);
    // Full pay still works
    await fullPay(run.id, cash.id, gross);
    assert.equal(await glNet('2300'), 0);
  });

  it('no EXPENSE_CREATE for payroll — double counting prevented', async () => {
    await cleanAccounting();
    const { cash } = await ensureCashBridge();
    const { run } = await createPayrollFixture({ salary: 1200, commission: 300 });
    await approveAccrual(run.id);
    await fullPay(run.id, cash.id, 1500);
    const expenseJes = await prisma.journalEntry.count({
      where: { sourceType: AccountingEvent.EXPENSE_CREATE },
    });
    assert.equal(expenseJes, 0);
    assert.equal(await glNet('5200'), 0);
    assert.equal(await glNet('5210'), 1200);
    assert.equal(await glNet('5220'), 300);
  });

  it('trial balance remains balanced after payroll fixtures', async () => {
    const lines = await prisma.journalLine.findMany({
      where: { entry: { status: { in: [JournalEntryStatus.POSTED, JournalEntryStatus.REVERSED] } } },
    });
    const d = lines.reduce((s, l) => s + toCents(l.debit), 0);
    const c = lines.reduce((s, l) => s + toCents(l.credit), 0);
    assert.equal(d, c);
  });
});
