import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountSubledger, AccountType, JournalEntryStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fromCents, roundMoney, toCents } from './money';

const POSTED_STATUSES: JournalEntryStatus[] = [
  JournalEntryStatus.POSTED,
  JournalEntryStatus.REVERSED,
];

@Injectable()
export class AccountingReportsService {
  constructor(private prisma: PrismaService) {}

  private parseBound(input?: string | Date | null, endOfDay = false) {
    if (input == null || input === '') return undefined;
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('نطاق التاريخ غير صالح');
    if (endOfDay && typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
      date.setHours(23, 59, 59, 999);
    }
    return date;
  }

  private dateFilter(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
    const gte = this.parseBound(from);
    const lte = this.parseBound(to, true);
    if (!gte && !lte) return undefined;
    return { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
  }

  async trialBalance(from?: string, to?: string) {
    const entryDate = this.dateFilter(from, to);
    const lines = await this.prisma.journalLine.findMany({
      where: {
        entry: {
          status: { in: POSTED_STATUSES },
          ...(entryDate ? { entryDate } : {}),
        },
      },
      include: {
        account: true,
      },
    });

    const map = new Map<
      string,
      {
        accountId: string;
        code: string;
        name: string;
        type: AccountType;
        debitCents: number;
        creditCents: number;
      }
    >();

    for (const line of lines) {
      const key = line.accountId;
      const row = map.get(key) || {
        accountId: line.accountId,
        code: line.account.code,
        name: line.account.name,
        type: line.account.type,
        debitCents: 0,
        creditCents: 0,
      };
      row.debitCents += toCents(line.debit);
      row.creditCents += toCents(line.credit);
      map.set(key, row);
    }

    const rows = [...map.values()]
      .map((row) => {
        const netCents = row.debitCents - row.creditCents;
        return {
          accountId: row.accountId,
          code: row.code,
          name: row.name,
          type: row.type,
          debit: fromCents(row.debitCents),
          credit: fromCents(row.creditCents),
          balanceDebit: netCents > 0 ? fromCents(netCents) : 0,
          balanceCredit: netCents < 0 ? fromCents(-netCents) : 0,
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code));

    const totals = rows.reduce(
      (acc, row) => {
        acc.debit = roundMoney(acc.debit + row.debit);
        acc.credit = roundMoney(acc.credit + row.credit);
        acc.balanceDebit = roundMoney(acc.balanceDebit + row.balanceDebit);
        acc.balanceCredit = roundMoney(acc.balanceCredit + row.balanceCredit);
        return acc;
      },
      { debit: 0, credit: 0, balanceDebit: 0, balanceCredit: 0 },
    );

    return { from: from || null, to: to || null, rows, totals };
  }

  async generalLedger(accountId: string, from?: string, to?: string) {
    const account = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (!account) throw new NotFoundException('الحساب غير موجود');
    const entryDate = this.dateFilter(from, to);
    const lines = await this.prisma.journalLine.findMany({
      where: {
        accountId,
        entry: {
          status: { in: POSTED_STATUSES },
          ...(entryDate ? { entryDate } : {}),
        },
      },
      include: {
        entry: { select: { id: true, number: true, entryDate: true, description: true, status: true } },
        customer: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
      orderBy: [{ entry: { entryDate: 'asc' } }, { lineOrder: 'asc' }],
    });

    let running = 0;
    const rows = lines.map((line) => {
      running += toCents(line.debit) - toCents(line.credit);
      return {
        entryId: line.entry.id,
        number: line.entry.number,
        entryDate: line.entry.entryDate,
        description: line.description || line.entry.description,
        status: line.entry.status,
        debit: line.debit,
        credit: line.credit,
        balance: fromCents(running),
        customer: line.customer,
        supplier: line.supplier,
      };
    });

    return { account, from: from || null, to: to || null, rows };
  }

  async accountStatement(accountId: string, from?: string, to?: string) {
    return this.generalLedger(accountId, from, to);
  }

  async dashboardTotals(from?: string, to?: string) {
    const tb = await this.trialBalance(from, to);
    const byType = {
      assets: 0,
      liabilities: 0,
      equity: 0,
      revenue: 0,
      expense: 0,
    };
    for (const row of tb.rows) {
      const net = roundMoney(row.balanceDebit - row.balanceCredit);
      if (row.type === AccountType.ASSET) byType.assets = roundMoney(byType.assets + net);
      if (row.type === AccountType.LIABILITY) byType.liabilities = roundMoney(byType.liabilities + -net);
      if (row.type === AccountType.EQUITY) byType.equity = roundMoney(byType.equity + -net);
      if (row.type === AccountType.REVENUE) byType.revenue = roundMoney(byType.revenue + -net);
      if (row.type === AccountType.EXPENSE) byType.expense = roundMoney(byType.expense + net);
    }
    const draftEntries = await this.prisma.journalEntry.count({ where: { status: 'DRAFT' } });
    const postedEntries = await this.prisma.journalEntry.count({
      where: { status: { in: ['POSTED', 'REVERSED'] } },
    });
    const dirtyCogs = await this.prisma.accountingCogsDirty.count();
    return {
      from: from || null,
      to: to || null,
      ...byType,
      netIncome: roundMoney(byType.revenue - byType.expense),
      draftEntries,
      postedEntries,
      dirtyCogs,
      trialBalance: tb.totals,
    };
  }

  async balanceSheet(asOf?: string) {
    const tb = await this.trialBalance(undefined, asOf);
    const assets: typeof tb.rows = [];
    const liabilities: typeof tb.rows = [];
    const equity: typeof tb.rows = [];
    let revenue = 0;
    let expense = 0;
    for (const row of tb.rows) {
      const net = roundMoney(row.balanceDebit - row.balanceCredit);
      if (row.type === AccountType.ASSET) assets.push(row);
      else if (row.type === AccountType.LIABILITY) liabilities.push(row);
      else if (row.type === AccountType.EQUITY) equity.push(row);
      else if (row.type === AccountType.REVENUE) revenue = roundMoney(revenue + -net);
      else if (row.type === AccountType.EXPENSE) expense = roundMoney(expense + net);
    }
    const netIncome = roundMoney(revenue - expense);
    const totalAssets = roundMoney(assets.reduce((s, r) => s + (r.balanceDebit - r.balanceCredit), 0));
    const totalLiabilities = roundMoney(
      liabilities.reduce((s, r) => s + (r.balanceCredit - r.balanceDebit), 0),
    );
    const totalEquity = roundMoney(
      equity.reduce((s, r) => s + (r.balanceCredit - r.balanceDebit), 0) + netIncome,
    );
    return {
      asOf: asOf || null,
      assets,
      liabilities,
      equity,
      netIncome,
      totals: {
        assets: totalAssets,
        liabilities: totalLiabilities,
        equity: totalEquity,
        liabilitiesAndEquity: roundMoney(totalLiabilities + totalEquity),
        balanced: toCents(totalAssets) === toCents(totalLiabilities + totalEquity),
      },
    };
  }

  async incomeStatement(from?: string, to?: string) {
    const tb = await this.trialBalance(from, to);
    const revenueRows = tb.rows.filter((r) => r.type === AccountType.REVENUE);
    const expenseRows = tb.rows.filter((r) => r.type === AccountType.EXPENSE);
    const revenue = roundMoney(
      revenueRows.reduce((s, r) => s + (r.balanceCredit - r.balanceDebit), 0),
    );
    const expense = roundMoney(
      expenseRows.reduce((s, r) => s + (r.balanceDebit - r.balanceCredit), 0),
    );
    return {
      from: from || null,
      to: to || null,
      revenueRows,
      expenseRows,
      revenue,
      expense,
      netIncome: roundMoney(revenue - expense),
    };
  }

  /**
   * Simplified indirect cash-flow from GL lines (not a full IAS 7 statement).
   * operating ≈ net income + depreciation (5300/1510) + AR/AP period nets;
   * investing ≈ fixed-asset (1500) purchases; financing ≈ equity 31xx movements
   * excluding P&L year-close markers; net cash change from cash GL accounts.
   */
  async cashFlowStatement(from?: string, to?: string) {
    const income = await this.incomeStatement(from, to);
    const entryDate = this.dateFilter(from, to);
    const lines = await this.prisma.journalLine.findMany({
      where: {
        entry: {
          status: { in: POSTED_STATUSES },
          ...(entryDate ? { entryDate } : {}),
        },
      },
      include: {
        account: true,
        entry: { select: { sourceId: true, sourceType: true } },
      },
    });

    let depreciationAddBack = 0;
    let arChange = 0; // increase in AR reduces operating cash
    let apChange = 0; // increase in AP increases operating cash
    let investingOutflow = 0;
    let financingNet = 0;
    let cashNetChange = 0;

    for (const line of lines) {
      const debit = toCents(line.debit);
      const credit = toCents(line.credit);
      const netDebitCents = debit - credit;
      const code = line.account.code;
      const isCash =
        line.account.cashAccountId != null || code.startsWith('11');

      if (isCash) {
        cashNetChange += netDebitCents;
      }

      // Depreciation expense (non-cash) — add back credits on accum / expense recognition
      if (code === '5300') {
        depreciationAddBack += debit; // expense debit → add back
      }
      if (code === '1510') {
        // accum dep credit is the non-cash side; already captured via 5300
      }

      // Working capital proxies from AR (1200) / AP (2100)
      if (code.startsWith('12') || line.account.subledger === AccountSubledger.AR) {
        arChange += netDebitCents; // AR increase (debit) reduces cash
      }
      if (code.startsWith('21') || line.account.subledger === AccountSubledger.AP) {
        apChange += -netDebitCents; // AP increase (credit) increases cash → credit − debit
      }

      // Investing: fixed asset purchases (1500 debits)
      if (code.startsWith('1500') || code === '1500') {
        if (debit > 0) investingOutflow += debit;
      }

      // Financing: equity 31xx excluding year-close
      if (code.startsWith('31') || code.startsWith('32')) {
        const isYearClose = Boolean(line.entry.sourceId?.startsWith('YEARCLOSE-'));
        if (!isYearClose) {
          // equity credit increases financing inflow
          financingNet += credit - debit;
        }
      }
    }

    const netIncomeCents = toCents(income.netIncome);
    const operatingCash = fromCents(
      netIncomeCents + depreciationAddBack - arChange + apChange,
    );
    const investingCash = fromCents(-investingOutflow);
    const financingCash = fromCents(financingNet);
    const netCashChange = fromCents(cashNetChange);

    return {
      from: from || null,
      to: to || null,
      method: 'simplified_indirect_gl',
      netIncome: income.netIncome,
      depreciationAddBack: fromCents(depreciationAddBack),
      workingCapital: {
        arIncrease: fromCents(arChange),
        apIncrease: fromCents(apChange),
      },
      operatingCash,
      investingCash,
      financingCash,
      netCashChange,
      impliedCheck: roundMoney(operatingCash + investingCash + financingCash),
    };
  }

  async taxReport(from?: string, to?: string) {
    const gte = this.parseBound(from);
    const lte = this.parseBound(to, true);
    const invoiceDate =
      gte || lte
        ? { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) }
        : undefined;

    const [sales, purchases] = await Promise.all([
      this.prisma.salesInvoice.findMany({
        where: {
          status: { notIn: ['DRAFT', 'CANCELLED'] },
          ...(invoiceDate ? { invoiceDate } : {}),
        },
        select: { id: true, number: true, invoiceDate: true, tax: true, total: true },
      }),
      this.prisma.purchaseInvoice.findMany({
        where: {
          status: { notIn: ['DRAFT', 'CANCELLED'] },
          ...(invoiceDate ? { invoiceDate } : {}),
        },
        select: { id: true, number: true, invoiceDate: true, tax: true, total: true },
      }),
    ]);

    const salesTax = roundMoney(sales.reduce((s, r) => s + Number(r.tax || 0), 0));
    const purchaseTax = roundMoney(purchases.reduce((s, r) => s + Number(r.tax || 0), 0));

    const entryDate = this.dateFilter(from, to);
    const taxLines = await this.prisma.journalLine.findMany({
      where: {
        account: { code: { in: ['2200', '1400'] } },
        entry: {
          status: { in: POSTED_STATUSES },
          ...(entryDate ? { entryDate } : {}),
        },
      },
      include: { account: { select: { code: true, name: true } } },
    });

    let glSalesTaxCredit = 0;
    let glPurchaseTaxDebit = 0;
    for (const line of taxLines) {
      if (line.account.code === '2200') {
        glSalesTaxCredit = roundMoney(
          glSalesTaxCredit + Number(line.credit || 0) - Number(line.debit || 0),
        );
      }
      if (line.account.code === '1400') {
        glPurchaseTaxDebit = roundMoney(
          glPurchaseTaxDebit + Number(line.debit || 0) - Number(line.credit || 0),
        );
      }
    }

    const netVatPayable = roundMoney(salesTax - purchaseTax);
    return {
      from: from || null,
      to: to || null,
      invoices: {
        salesTax,
        purchaseTax,
        netVatPayable,
        salesCount: sales.length,
        purchaseCount: purchases.length,
      },
      gl: {
        salesTaxPayable2200: glSalesTaxCredit,
        purchaseTaxReceivable1400: glPurchaseTaxDebit,
        netVatPayable: roundMoney(glSalesTaxCredit - glPurchaseTaxDebit),
      },
    };
  }

  private ageBucket(ageDays: number) {
    if (ageDays <= 30) return '0-30';
    if (ageDays <= 60) return '31-60';
    if (ageDays <= 90) return '61-90';
    return '90+';
  }

  async arAging() {
    const [customers, openInvoices] = await Promise.all([
      this.prisma.customer.findMany({
        where: { balance: { gt: 0 } },
        select: { id: true, code: true, name: true, balance: true },
        orderBy: { balance: 'desc' },
      }),
      this.prisma.salesInvoice.findMany({
        where: { status: { in: ['CONFIRMED', 'PARTIAL'] } },
        select: {
          id: true,
          number: true,
          customerId: true,
          invoiceDate: true,
          total: true,
          paidAmount: true,
          status: true,
        },
        orderBy: { invoiceDate: 'asc' },
      }),
    ]);

    const customerIds = new Set(customers.map((c) => c.id));
    const missingIds = [
      ...new Set(
        openInvoices.map((i) => i.customerId).filter((id) => !customerIds.has(id)),
      ),
    ];
    const extra =
      missingIds.length > 0
        ? await this.prisma.customer.findMany({
            where: { id: { in: missingIds } },
            select: { id: true, code: true, name: true, balance: true },
          })
        : [];

    const now = Date.now();
    const byCustomer = new Map<
      string,
      {
        customerId: string;
        code: string;
        name: string;
        balance: number;
        unpaid: {
          invoiceId: string;
          number: string;
          invoiceDate: Date;
          due: number;
          ageDays: number;
          bucket: string;
        }[];
      }
    >();

    for (const c of [...customers, ...extra]) {
      byCustomer.set(c.id, {
        customerId: c.id,
        code: c.code,
        name: c.name,
        balance: c.balance,
        unpaid: [],
      });
    }

    for (const inv of openInvoices) {
      const due = roundMoney(Number(inv.total) - Number(inv.paidAmount || 0));
      if (toCents(due) <= 0) continue;
      const row = byCustomer.get(inv.customerId);
      if (!row) continue;
      const ageDays = Math.max(
        0,
        Math.floor((now - new Date(inv.invoiceDate).getTime()) / 86_400_000),
      );
      row.unpaid.push({
        invoiceId: inv.id,
        number: inv.number,
        invoiceDate: inv.invoiceDate,
        due,
        ageDays,
        bucket: this.ageBucket(ageDays),
      });
    }

    const rows = [...byCustomer.values()].filter(
      (r) => r.balance > 0 || r.unpaid.length > 0,
    );
    return {
      rows,
      totals: {
        balance: roundMoney(rows.reduce((s, r) => s + r.balance, 0)),
        unpaidDue: roundMoney(
          rows.reduce((s, r) => s + r.unpaid.reduce((a, u) => a + u.due, 0), 0),
        ),
      },
    };
  }

  async apAging() {
    const [suppliers, openInvoices] = await Promise.all([
      this.prisma.supplier.findMany({
        where: { balance: { gt: 0 } },
        select: { id: true, code: true, name: true, balance: true },
        orderBy: { balance: 'desc' },
      }),
      this.prisma.purchaseInvoice.findMany({
        where: { status: { in: ['CONFIRMED', 'PARTIAL'] } },
        select: {
          id: true,
          number: true,
          supplierId: true,
          invoiceDate: true,
          total: true,
          paidAmount: true,
          status: true,
        },
        orderBy: { invoiceDate: 'asc' },
      }),
    ]);

    const supplierIds = new Set(suppliers.map((s) => s.id));
    const missingIds = [
      ...new Set(
        openInvoices.map((i) => i.supplierId).filter((id) => !supplierIds.has(id)),
      ),
    ];
    const extra =
      missingIds.length > 0
        ? await this.prisma.supplier.findMany({
            where: { id: { in: missingIds } },
            select: { id: true, code: true, name: true, balance: true },
          })
        : [];

    const now = Date.now();
    const bySupplier = new Map<
      string,
      {
        supplierId: string;
        code: string;
        name: string;
        balance: number;
        unpaid: {
          invoiceId: string;
          number: string;
          invoiceDate: Date;
          due: number;
          ageDays: number;
          bucket: string;
        }[];
      }
    >();

    for (const s of [...suppliers, ...extra]) {
      bySupplier.set(s.id, {
        supplierId: s.id,
        code: s.code,
        name: s.name,
        balance: s.balance,
        unpaid: [],
      });
    }

    for (const inv of openInvoices) {
      const due = roundMoney(Number(inv.total) - Number(inv.paidAmount || 0));
      if (toCents(due) <= 0) continue;
      const row = bySupplier.get(inv.supplierId);
      if (!row) continue;
      const ageDays = Math.max(
        0,
        Math.floor((now - new Date(inv.invoiceDate).getTime()) / 86_400_000),
      );
      row.unpaid.push({
        invoiceId: inv.id,
        number: inv.number,
        invoiceDate: inv.invoiceDate,
        due,
        ageDays,
        bucket: this.ageBucket(ageDays),
      });
    }

    const rows = [...bySupplier.values()].filter(
      (r) => r.balance > 0 || r.unpaid.length > 0,
    );
    return {
      rows,
      totals: {
        balance: roundMoney(rows.reduce((s, r) => s + r.balance, 0)),
        unpaidDue: roundMoney(
          rows.reduce((s, r) => s + r.unpaid.reduce((a, u) => a + u.due, 0), 0),
        ),
      },
    };
  }

  async costCenterReport(from?: string, to?: string) {
    const entryDate = this.dateFilter(from, to);
    const lines = await this.prisma.journalLine.findMany({
      where: {
        costCenterId: { not: null },
        account: { type: { in: [AccountType.REVENUE, AccountType.EXPENSE] } },
        entry: {
          status: { in: POSTED_STATUSES },
          ...(entryDate ? { entryDate } : {}),
        },
      },
      include: {
        account: { select: { type: true, code: true, name: true } },
        costCenter: { select: { id: true, code: true, name: true } },
      },
    });

    const map = new Map<
      string,
      {
        costCenterId: string;
        code: string;
        name: string;
        revenue: number;
        expense: number;
      }
    >();

    for (const line of lines) {
      if (!line.costCenter) continue;
      const key = line.costCenterId!;
      const row = map.get(key) || {
        costCenterId: line.costCenter.id,
        code: line.costCenter.code,
        name: line.costCenter.name,
        revenue: 0,
        expense: 0,
      };
      if (line.account.type === AccountType.REVENUE) {
        row.revenue = roundMoney(row.revenue + Number(line.credit) - Number(line.debit));
      } else {
        row.expense = roundMoney(row.expense + Number(line.debit) - Number(line.credit));
      }
      map.set(key, row);
    }

    const rows = [...map.values()]
      .map((r) => ({
        ...r,
        net: roundMoney(r.revenue - r.expense),
      }))
      .sort((a, b) => a.code.localeCompare(b.code));

    return {
      from: from || null,
      to: to || null,
      rows,
      totals: {
        revenue: roundMoney(rows.reduce((s, r) => s + r.revenue, 0)),
        expense: roundMoney(rows.reduce((s, r) => s + r.expense, 0)),
        net: roundMoney(rows.reduce((s, r) => s + r.net, 0)),
      },
    };
  }
}
