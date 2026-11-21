import { Injectable } from '@nestjs/common';
import { AccountSubledger, JournalEntryStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fromCents, roundMoney, toCents } from './money';

const LEDGER_STATUSES: JournalEntryStatus[] = [
  JournalEntryStatus.POSTED,
  JournalEntryStatus.REVERSED,
];

/**
 * تقرير مطابقة للقراءة فقط — لا يعدّل أرصدة تشغيلية ولا محاسبية.
 */
@Injectable()
export class ReconciliationService {
  constructor(private prisma: PrismaService) {}

  private async accountNetCents(accountId: string) {
    const lines = await this.prisma.journalLine.findMany({
      where: { accountId, entry: { status: { in: LEDGER_STATUSES } } },
      select: { debit: true, credit: true },
    });
    return lines.reduce((s, l) => s + toCents(l.debit) - toCents(l.credit), 0);
  }

  async runAudit() {
    const issues: { code: string; severity: 'error' | 'warn' | 'info'; message: string; detail?: unknown }[] = [];

    // 1) كل قيد مرحّل/معكوس متوازن
    const entries = await this.prisma.journalEntry.findMany({
      where: { status: { in: LEDGER_STATUSES } },
      include: { lines: true },
    });
    let unbalanced = 0;
    for (const entry of entries) {
      const d = entry.lines.reduce((s, l) => s + toCents(l.debit), 0);
      const c = entry.lines.reduce((s, l) => s + toCents(l.credit), 0);
      if (d !== c) {
        unbalanced += 1;
        issues.push({
          code: 'UNBALANCED_ENTRY',
          severity: 'error',
          message: `قيد غير متوازن ${entry.number}`,
          detail: { id: entry.id, debitCents: d, creditCents: c },
        });
      }
    }

    // 2) ميزان المراجعة
    const allLines = await this.prisma.journalLine.findMany({
      where: { entry: { status: { in: LEDGER_STATUSES } } },
      select: { debit: true, credit: true },
    });
    const tbDebit = allLines.reduce((s, l) => s + toCents(l.debit), 0);
    const tbCredit = allLines.reduce((s, l) => s + toCents(l.credit), 0);
    if (tbDebit !== tbCredit) {
      issues.push({
        code: 'TB_IMBALANCE',
        severity: 'error',
        message: 'ميزان المراجعة غير متوازن',
        detail: { tbDebit, tbCredit },
      });
    }

    // 3) مسودات مستبعدة من التقارير أعلاه (تأكيد)
    const draftCents = await this.prisma.journalLine.aggregate({
      where: { entry: { status: JournalEntryStatus.DRAFT } },
      _sum: { debit: true, credit: true },
    });

    // 4) تكرار مصادر (غير مسموح أصلًا بالـ unique — نبلّغ عن REV-/duplicates المنطقية)
    const dupMap = new Map<string, number>();
    for (const entry of entries) {
      if (!entry.sourceId) continue;
      const key = `${entry.sourceType}:${entry.sourceId}`;
      dupMap.set(key, (dupMap.get(key) || 0) + 1);
    }
    for (const [key, count] of dupMap) {
      if (count > 1) {
        issues.push({
          code: 'DUPLICATE_SOURCE',
          severity: 'error',
          message: `مصدر مكرر ${key}`,
          detail: { count },
        });
      }
    }

    // 5) AR subledger vs control
    const arAccounts = await this.prisma.account.findMany({ where: { subledger: AccountSubledger.AR } });
    const arParty: { accountCode: string; glNet: number; partyNet: number; delta: number }[] = [];
    for (const account of arAccounts) {
      const lines = await this.prisma.journalLine.findMany({
        where: { accountId: account.id, entry: { status: { in: LEDGER_STATUSES } } },
        select: { debit: true, credit: true, customerId: true },
      });
      const glNet = fromCents(lines.reduce((s, l) => s + toCents(l.debit) - toCents(l.credit), 0));
      const partyNet = fromCents(
        lines
          .filter((l) => l.customerId)
          .reduce((s, l) => s + toCents(l.debit) - toCents(l.credit), 0),
      );
      const unassigned = roundMoney(glNet - partyNet);
      arParty.push({ accountCode: account.code, glNet, partyNet, delta: unassigned });
      if (toCents(unassigned) !== 0) {
        issues.push({
          code: 'AR_UNASSIGNED',
          severity: 'warn',
          message: `AR ${account.code}: فرق بين التحكم والمجموع حسب العميل`,
          detail: { glNet, partyNet, unassigned },
        });
      }
    }

    // 6) AP subledger vs control
    const apAccounts = await this.prisma.account.findMany({ where: { subledger: AccountSubledger.AP } });
    const apParty: { accountCode: string; glNet: number; partyNet: number; delta: number }[] = [];
    for (const account of apAccounts) {
      const lines = await this.prisma.journalLine.findMany({
        where: { accountId: account.id, entry: { status: { in: LEDGER_STATUSES } } },
        select: { debit: true, credit: true, supplierId: true },
      });
      // AP credit-nature: credit - debit as liability
      const glNet = fromCents(lines.reduce((s, l) => s + toCents(l.credit) - toCents(l.debit), 0));
      const partyNet = fromCents(
        lines
          .filter((l) => l.supplierId)
          .reduce((s, l) => s + toCents(l.credit) - toCents(l.debit), 0),
      );
      const unassigned = roundMoney(glNet - partyNet);
      apParty.push({ accountCode: account.code, glNet, partyNet, delta: unassigned });
      if (toCents(unassigned) !== 0) {
        issues.push({
          code: 'AP_UNASSIGNED',
          severity: 'warn',
          message: `AP ${account.code}: فرق بين التحكم والمجموع حسب المورد`,
          detail: { glNet, partyNet, unassigned },
        });
      }
    }

    // 7) CashAccount.balance vs GL bridge
    const cashLinks = await this.prisma.account.findMany({
      where: { cashAccountId: { not: null } },
      include: { cashAccount: true },
    });
    const cashCompare: {
      cashAccountId: string;
      cashCode: string;
      operational: number;
      glNet: number;
      delta: number;
    }[] = [];
    for (const account of cashLinks) {
      const op = roundMoney(account.cashAccount?.balance || 0);
      // cash asset: debit - credit
      const glNet = fromCents(await this.accountNetCents(account.id));
      const delta = roundMoney(op - glNet);
      cashCompare.push({
        cashAccountId: account.cashAccountId!,
        cashCode: account.cashAccount?.code || account.code,
        operational: op,
        glNet,
        delta,
      });
      if (toCents(delta) !== 0) {
        issues.push({
          code: 'CASH_OPS_VS_GL',
          severity: 'info',
          message: `خزنة ${account.cashAccount?.code}: فرق تشغيلي مقابل GL (متوقع إن لم يُرحَّل التاريخ بالكامل)`,
          detail: { operational: op, glNet, delta },
        });
      }
    }

    // 8) Customer.balance vs AR party lines (may diverge by design)
    const customers = await this.prisma.customer.findMany({
      where: { balance: { not: 0 } },
      select: { id: true, code: true, name: true, balance: true },
      take: 500,
    });
    const customerCompare: { code: string; operational: number; glNet: number; delta: number }[] = [];
    for (const customer of customers) {
      const lines = await this.prisma.journalLine.findMany({
        where: {
          customerId: customer.id,
          entry: { status: { in: LEDGER_STATUSES } },
          account: { subledger: AccountSubledger.AR },
        },
        select: { debit: true, credit: true },
      });
      const glNet = fromCents(lines.reduce((s, l) => s + toCents(l.debit) - toCents(l.credit), 0));
      const op = roundMoney(customer.balance);
      const delta = roundMoney(op - glNet);
      customerCompare.push({ code: customer.code, operational: op, glNet, delta });
      if (toCents(delta) !== 0) {
        issues.push({
          code: 'CUSTOMER_OPS_VS_AR',
          severity: 'info',
          message: `عميل ${customer.code}: رصيد تشغيلي ≠ أستاذ AR (طبقتان منفصلتان حتى اكتمال الترحيل التاريخي)`,
          detail: { operational: op, glNet, delta },
        });
      }
    }

    const suppliers = await this.prisma.supplier.findMany({
      where: { balance: { not: 0 } },
      select: { id: true, code: true, name: true, balance: true },
      take: 500,
    });
    const supplierCompare: { code: string; operational: number; glNet: number; delta: number }[] = [];
    for (const supplier of suppliers) {
      const lines = await this.prisma.journalLine.findMany({
        where: {
          supplierId: supplier.id,
          entry: { status: { in: LEDGER_STATUSES } },
          account: { subledger: AccountSubledger.AP },
        },
        select: { debit: true, credit: true },
      });
      const glNet = fromCents(lines.reduce((s, l) => s + toCents(l.credit) - toCents(l.debit), 0));
      const op = roundMoney(supplier.balance);
      const delta = roundMoney(op - glNet);
      supplierCompare.push({ code: supplier.code, operational: op, glNet, delta });
      if (toCents(delta) !== 0) {
        issues.push({
          code: 'SUPPLIER_OPS_VS_AP',
          severity: 'info',
          message: `مورد ${supplier.code}: رصيد تشغيلي ≠ أستاذ AP`,
          detail: { operational: op, glNet, delta },
        });
      }
    }

    const inventoryAccount = await this.prisma.account.findUnique({ where: { code: '1300' } });
    let inventoryGl = 0;
    if (inventoryAccount) {
      inventoryGl = fromCents(await this.accountNetCents(inventoryAccount.id));
    }

    const errors = issues.filter((i) => i.severity === 'error').length;
    const warns = issues.filter((i) => i.severity === 'warn').length;

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        postedOrReversedEntries: entries.length,
        unbalancedEntries: unbalanced,
        trialBalanceBalanced: tbDebit === tbCredit,
        tbDebitCents: tbDebit,
        tbCreditCents: tbCredit,
        draftDebit: draftCents._sum.debit || 0,
        draftCredit: draftCents._sum.credit || 0,
        errorCount: errors,
        warnCount: warns,
        infoCount: issues.length - errors - warns,
      },
      arParty,
      apParty,
      cashCompare,
      customerCompare,
      supplierCompare,
      inventoryGl,
      issues,
      assumptions: [
        'الأرصدة التشغيلية (Customer/Supplier/CashAccount) مصدر حقيقة للعمليات؛ GL طبقة محاسبية إضافية.',
        'الفروق info متوقعة قبل ترحيل تاريخي كامل أو قبل ربط كل الخزائن بـ Account.cashAccountId.',
        'مرتجع المبيعات التشغيلي قد يمثل خردة/استهلاك وليس إشعار دائن تقليدي.',
        'قائمة التدفقات وإقفال السنة مبسّطان من قيود GL.',
        'التزامن متعدد العمال على Turso غير مُختبَر في هذه البيئة.',
      ],
    };
  }
}
