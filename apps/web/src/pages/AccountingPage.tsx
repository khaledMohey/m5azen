import { useEffect, useState } from 'react';
import {
  BookOpen, Building2, Calculator, Coins, Landmark, Layers, LineChart, Plus, Receipt, Scale, ScrollText, Target, Wallet,
} from 'lucide-react';
import { api, formatDate, formatMoney } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/feedback';
import {
  Badge, Button, Card, CardHeader, Empty, ErrorState, Input, Label, NumberInput,
  PageHeader, PageSkeleton, Select, StatCard, StatGrid, Table, Td, Th, todayIso, type Tone,
} from '../components/ui';

type Tab = 'dashboard' | 'accounts' | 'journals' | 'trial' | 'openings' | 'gl' | 'statements' | 'tax' | 'centers' | 'assets';
type StatementView = 'balance' | 'income' | 'cash';

type DashboardTotals = {
  assets?: number;
  liabilities?: number;
  equity?: number;
  revenue?: number;
  expense?: number;
  draftEntries?: number;
  postedEntries?: number;
  dirtyCogs?: number;
  [key: string]: number | undefined;
};

type Account = {
  id: string;
  code: string;
  name: string;
  type: string;
  isPostable: boolean;
  isActive: boolean;
  normalBalance?: string;
  subledger?: string;
  parentId?: string | null;
  children?: Account[];
};

type JournalLine = {
  id?: string;
  accountId: string;
  debit: number;
  credit: number;
  description?: string | null;
  account?: { code: string; name: string };
};

type JournalEntry = {
  id: string;
  number: string;
  entryDate: string;
  description: string;
  status: string;
  sourceType?: string;
  lines?: JournalLine[];
};

type TrialRow = {
  accountId: string;
  code: string;
  name: string;
  type?: string;
  debit: number;
  credit: number;
  balance?: number;
};

type OpeningBatch = {
  id: string;
  fiscalYear: number;
  version: number;
  status: string;
  notes?: string | null;
  lines?: {
    id: string;
    accountId: string;
    debit: number;
    credit: number;
    account?: { code: string; name: string };
  }[];
};

type GlRow = {
  entryId: string;
  number: string;
  entryDate: string;
  description?: string | null;
  debit: number;
  credit: number;
  balance: number;
};

type GlReport = {
  account?: { id: string; code: string; name: string };
  from: string | null;
  to: string | null;
  rows: GlRow[];
};

type StmtRow = TrialRow & { balanceDebit?: number; balanceCredit?: number };

type BalanceSheetReport = {
  asOf: string | null;
  assets: StmtRow[];
  liabilities: StmtRow[];
  equity: StmtRow[];
  netIncome: number;
  totals: {
    assets: number;
    liabilities: number;
    equity: number;
    liabilitiesAndEquity: number;
    balanced: boolean;
  };
};

type IncomeStatementReport = {
  from: string | null;
  to: string | null;
  revenueRows: StmtRow[];
  expenseRows: StmtRow[];
  revenue: number;
  expense: number;
  netIncome: number;
};

type CashFlowReport = {
  from: string | null;
  to: string | null;
  netIncome: number;
  depreciationAddBack: number;
  workingCapital: { arIncrease: number; apIncrease: number };
  operatingCash: number;
  investingCash: number;
  financingCash: number;
  netCashChange: number;
  impliedCheck: number;
};

type TaxReport = {
  from: string | null;
  to: string | null;
  invoices: {
    salesTax: number;
    purchaseTax: number;
    netVatPayable: number;
    salesCount: number;
    purchaseCount: number;
  };
  gl: {
    salesTaxPayable2200: number;
    purchaseTaxReceivable1400: number;
    netVatPayable: number;
  };
};

type CostCenter = { id: string; code: string; name: string; isActive: boolean };

type FixedAsset = { id: string; name: string; value: number; acquiredAt: string; notes?: string | null; isActive: boolean };

const ACCOUNT_TYPES = [
  { id: 'ASSET', label: 'أصول' },
  { id: 'LIABILITY', label: 'خصوم' },
  { id: 'EQUITY', label: 'حقوق ملكية' },
  { id: 'REVENUE', label: 'إيرادات' },
  { id: 'EXPENSE', label: 'مصروفات' },
] as const;

const STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'مسودة', tone: 'amber' },
  POSTED: { label: 'مرحّل', tone: 'emerald' },
  REVERSED: { label: 'معكوس', tone: 'rose' },
  APPLIED: { label: 'مطبّق', tone: 'emerald' },
};

const TYPE_LABEL: Record<string, string> = Object.fromEntries(ACCOUNT_TYPES.map((t) => [t.id, t.label]));

function flattenAccounts(rows: Account[]): Account[] {
  const out: Account[] = [];
  const walk = (list: Account[], depth = 0) => {
    for (const row of list) {
      out.push({ ...row, name: `${'— '.repeat(depth)}${row.name}` });
      if (row.children?.length) walk(row.children, depth + 1);
    }
  };
  walk(rows);
  return out;
}

function asList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    const obj = payload as { items?: T[]; rows?: T[]; accounts?: T[]; entries?: T[]; batches?: T[] };
    return obj.items || obj.rows || obj.accounts || obj.entries || obj.batches || [];
  }
  return [];
}

const emptyLine = (): { accountId: string; debit: number | ''; credit: number | ''; description: string } => ({
  accountId: '', debit: '', credit: '', description: '',
});

function stmtBalance(row: StmtRow): number {
  const d = row.balanceDebit ?? 0;
  const c = row.balanceCredit ?? 0;
  if (d || c) return d - c;
  return (row.debit || 0) - (row.credit || 0);
}

export function AccountingPage() {
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [tab, setTab] = useState<Tab>('dashboard');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);

  const [dashboard, setDashboard] = useState<DashboardTotals>({});
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [journals, setJournals] = useState<JournalEntry[]>([]);
  const [trial, setTrial] = useState<TrialRow[]>([]);
  const [openings, setOpenings] = useState<OpeningBatch[]>([]);

  const [rangeFrom, setRangeFrom] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-01-01`;
  });
  const [rangeTo, setRangeTo] = useState(todayIso());

  const [accountForm, setAccountForm] = useState({
    code: '', name: '', type: 'ASSET', parentId: '', notes: '',
  });
  const [journalForm, setJournalForm] = useState({
    entryDate: todayIso(),
    description: '',
    lines: [emptyLine(), emptyLine()],
  });
  const [openingYear, setOpeningYear] = useState(String(new Date().getFullYear()));

  const [glAccountId, setGlAccountId] = useState('');
  const [gl, setGl] = useState<GlReport | null>(null);
  const [statementView, setStatementView] = useState<StatementView>('balance');
  const [asOf, setAsOf] = useState(todayIso());
  const [balanceSheet, setBalanceSheet] = useState<BalanceSheetReport | null>(null);
  const [incomeStatement, setIncomeStatement] = useState<IncomeStatementReport | null>(null);
  const [cashFlow, setCashFlow] = useState<CashFlowReport | null>(null);
  const [tax, setTax] = useState<TaxReport | null>(null);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [centerForm, setCenterForm] = useState({ code: '', name: '' });
  const [fixedAssets, setFixedAssets] = useState<FixedAsset[]>([]);
  const [deprYear, setDeprYear] = useState(String(new Date().getFullYear()));
  const [deprMonth, setDeprMonth] = useState(String(new Date().getMonth() + 1));

  const flatAccounts = flattenAccounts(accounts);
  const postableAccounts = flatAccounts.filter((a) => a.isPostable && a.isActive);

  async function load() {
    setLoadError('');
    try {
      if (tab === 'dashboard') {
        const data = await api<DashboardTotals>('/accounting/reports/dashboard');
        setDashboard(data || {});
      } else if (tab === 'accounts') {
        const data = await api<unknown>('/accounting/accounts');
        setAccounts(asList<Account>(data));
      } else if (tab === 'journals') {
        const [acc, je] = await Promise.all([
          api<unknown>('/accounting/accounts'),
          api<unknown>('/accounting/journals'),
        ]);
        setAccounts(asList<Account>(acc));
        setJournals(asList<JournalEntry>(je));
      } else if (tab === 'trial') {
        const params = new URLSearchParams({ from: rangeFrom, to: rangeTo });
        const data = await api<unknown>(`/accounting/reports/trial-balance?${params}`);
        setTrial(asList<TrialRow>(data));
      } else if (tab === 'openings') {
        const [acc, batches] = await Promise.all([
          api<unknown>('/accounting/accounts'),
          api<unknown>('/accounting/openings'),
        ]);
        setAccounts(asList<Account>(acc));
        setOpenings(asList<OpeningBatch>(batches));
      } else if (tab === 'gl') {
        const acc = await api<unknown>('/accounting/accounts');
        setAccounts(asList<Account>(acc));
        if (glAccountId) {
          const params = new URLSearchParams({ accountId: glAccountId, from: rangeFrom, to: rangeTo });
          const data = await api<GlReport>(`/accounting/reports/gl?${params}`);
          setGl(data);
        } else {
          setGl(null);
        }
      } else if (tab === 'statements') {
        if (statementView === 'balance') {
          const params = asOf ? new URLSearchParams({ asOf }) : new URLSearchParams();
          const data = await api<BalanceSheetReport>(`/accounting/reports/balance-sheet?${params}`);
          setBalanceSheet(data);
          setIncomeStatement(null);
          setCashFlow(null);
        } else if (statementView === 'income') {
          const params = new URLSearchParams({ from: rangeFrom, to: rangeTo });
          const data = await api<IncomeStatementReport>(`/accounting/reports/income-statement?${params}`);
          setIncomeStatement(data);
          setBalanceSheet(null);
          setCashFlow(null);
        } else {
          const params = new URLSearchParams({ from: rangeFrom, to: rangeTo });
          const data = await api<CashFlowReport>(`/accounting/reports/cash-flow?${params}`);
          setCashFlow(data);
          setBalanceSheet(null);
          setIncomeStatement(null);
        }
      } else if (tab === 'tax') {
        const params = new URLSearchParams({ from: rangeFrom, to: rangeTo });
        const data = await api<TaxReport>(`/accounting/reports/tax?${params}`);
        setTax(data);
      } else if (tab === 'centers') {
        const data = await api<unknown>('/accounting/cost-centers');
        setCostCenters(asList<CostCenter>(data));
      } else if (tab === 'assets') {
        const data = await api<{ items: FixedAsset[] }>('/finance/fixed-assets');
        setFixedAssets(data.items || []);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'تعذر تحميل بيانات الحسابات');
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    setLoaded(false);
    load();
  }, [tab, rangeFrom, rangeTo, glAccountId, statementView, asOf]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      await load();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر تنفيذ العملية');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const tabs: { id: Tab; label: string; icon: typeof Calculator }[] = [
    { id: 'dashboard', label: 'لوحة', icon: Landmark },
    { id: 'accounts', label: 'دليل الحسابات', icon: BookOpen },
    { id: 'journals', label: 'القيود', icon: ScrollText },
    { id: 'trial', label: 'ميزان المراجعة', icon: Scale },
    { id: 'openings', label: 'الأرصدة الافتتاحية', icon: Building2 },
    { id: 'gl', label: 'دفتر الأستاذ', icon: LineChart },
    { id: 'statements', label: 'القوائم المالية', icon: Wallet },
    { id: 'tax', label: 'الضريبة', icon: Receipt },
    { id: 'centers', label: 'مراكز التكلفة', icon: Target },
    { id: 'assets', label: 'الأصول والإهلاك', icon: Layers },
  ];

  if (!loaded) {
    return (
      <div>
        <PageHeader title="الحسابات" subtitle="دليل الحسابات والقيود وميزان المراجعة" />
        <PageSkeleton />
      </div>
    );
  }

  const trialDebit = trial.reduce((s, r) => s + (r.debit || 0), 0);
  const trialCredit = trial.reduce((s, r) => s + (r.credit || 0), 0);

  return (
    <div>
      <PageHeader
        title="الحسابات"
        subtitle="دليل الحسابات والقيود وميزان المراجعة"
        actions={isAdmin ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => run(() => api('/accounting/seed', { method: 'POST', body: '{}' }), 'تم تهيئة الدليل الافتراضي')}
          >
            تهيئة الدليل
          </Button>
        ) : undefined}
      />
      {loadError && <Card className="mb-4"><ErrorState text={loadError} onRetry={load} /></Card>}

      <div className="mb-4 flex w-fit max-w-full flex-wrap rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`inline-flex h-9 items-center gap-2 rounded-lg px-4 text-[13px] font-bold transition ${tab === t.id ? 'bg-brand-700 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            <t.icon size={15} />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && (
        <StatGrid>
          <StatCard label="الأصول" value={formatMoney(dashboard.assets || 0)} icon={Landmark} tone="brand" />
          <StatCard label="الخصوم" value={formatMoney(dashboard.liabilities || 0)} icon={Scale} tone="rose" />
          <StatCard label="حقوق الملكية" value={formatMoney(dashboard.equity || 0)} icon={BookOpen} tone="emerald" />
          <StatCard label="الإيرادات" value={formatMoney(dashboard.revenue || 0)} icon={Calculator} tone="emerald" />
          <StatCard label="المصروفات" value={formatMoney(dashboard.expense || 0)} icon={ScrollText} tone="amber" />
          <StatCard
            label="قيود مسودة"
            value={String(dashboard.draftEntries ?? 0)}
            hint={`مرحّل ${dashboard.postedEntries ?? 0}`}
            icon={ScrollText}
            tone="amber"
            onClick={() => setTab('journals')}
          />
        </StatGrid>
      )}

      {tab === 'accounts' && (
        <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
          <Card>
            <CardHeader title="حساب جديد" subtitle="يُضاف لدليل الحسابات" icon={Plus} />
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!accountForm.code.trim() || !accountForm.name.trim()) return toast.error('أدخل الكود والاسم');
                const ok = await run(
                  () => api('/accounting/accounts', {
                    method: 'POST',
                    body: JSON.stringify({
                      code: accountForm.code.trim(),
                      name: accountForm.name.trim(),
                      type: accountForm.type,
                      parentId: accountForm.parentId || undefined,
                      notes: accountForm.notes || undefined,
                    }),
                  }),
                  'تمت إضافة الحساب',
                );
                if (ok) setAccountForm({ code: '', name: '', type: accountForm.type, parentId: '', notes: '' });
              }}
            >
              <div className="grid grid-cols-2 gap-2">
                <div><Label>الكود</Label><Input value={accountForm.code} onChange={(e) => setAccountForm({ ...accountForm, code: e.target.value })} dir="ltr" /></div>
                <div>
                  <Label>النوع</Label>
                  <Select value={accountForm.type} onChange={(e) => setAccountForm({ ...accountForm, type: e.target.value })}>
                    {ACCOUNT_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </Select>
                </div>
              </div>
              <div><Label>الاسم</Label><Input value={accountForm.name} onChange={(e) => setAccountForm({ ...accountForm, name: e.target.value })} /></div>
              <div>
                <Label>الحساب الأب</Label>
                <Select value={accountForm.parentId} onChange={(e) => setAccountForm({ ...accountForm, parentId: e.target.value })}>
                  <option value="">بدون</option>
                  {flatAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                </Select>
              </div>
              <div><Label>ملاحظة</Label><Input value={accountForm.notes} onChange={(e) => setAccountForm({ ...accountForm, notes: e.target.value })} placeholder="اختياري" /></div>
              <Button type="submit" className="w-full" disabled={busy}>إضافة الحساب</Button>
            </form>
          </Card>
          <Card>
            <CardHeader title="دليل الحسابات" subtitle={`${flatAccounts.length} حساب`} icon={BookOpen} />
            {flatAccounts.length === 0 ? (
              <Empty text="لا يوجد دليل حسابات" hint="يمكنك تهيئة الدليل الافتراضي من أعلى الصفحة" />
            ) : (
              <Table>
                <thead><tr><Th>الكود</Th><Th>الاسم</Th><Th>النوع</Th><Th>الحالة</Th></tr></thead>
                <tbody>
                  {flatAccounts.map((row) => (
                    <tr key={row.id}>
                      <Td className="font-mono text-xs font-bold ltr text-left">{row.code}</Td>
                      <Td className="font-semibold text-slate-800">{row.name}</Td>
                      <Td><Badge tone="slate">{TYPE_LABEL[row.type] || row.type}</Badge></Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          {!row.isActive && <Badge tone="rose">موقوف</Badge>}
                          {!row.isPostable && <Badge tone="amber">أب</Badge>}
                          {row.isActive && row.isPostable && <Badge tone="emerald">قابل للترحيل</Badge>}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {tab === 'journals' && (
        <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
          <Card>
            <CardHeader title="قيد يدوي" subtitle="مسودة متوازنة قبل الترحيل" icon={Plus} />
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const lines = journalForm.lines
                  .filter((l) => l.accountId && (Number(l.debit) > 0 || Number(l.credit) > 0))
                  .map((l) => ({
                    accountId: l.accountId,
                    debit: Number(l.debit) || 0,
                    credit: Number(l.credit) || 0,
                    description: l.description || undefined,
                  }));
                if (lines.length < 2) return toast.error('القيد يحتاج سطرين على الأقل');
                const ok = await run(
                  () => api('/accounting/journals', {
                    method: 'POST',
                    body: JSON.stringify({
                      entryDate: journalForm.entryDate,
                      description: journalForm.description || undefined,
                      lines,
                    }),
                  }),
                  'تم حفظ مسودة القيد',
                );
                if (ok) setJournalForm({ entryDate: todayIso(), description: '', lines: [emptyLine(), emptyLine()] });
              }}
            >
              <div><Label>التاريخ</Label><Input type="date" value={journalForm.entryDate} onChange={(e) => setJournalForm({ ...journalForm, entryDate: e.target.value })} /></div>
              <div><Label>البيان</Label><Input value={journalForm.description} onChange={(e) => setJournalForm({ ...journalForm, description: e.target.value })} placeholder="وصف القيد" /></div>
              <div className="space-y-2">
                {journalForm.lines.map((line, idx) => (
                  <div key={idx} className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 space-y-2">
                    <Select
                      value={line.accountId}
                      onChange={(e) => {
                        const lines = [...journalForm.lines];
                        lines[idx] = { ...line, accountId: e.target.value };
                        setJournalForm({ ...journalForm, lines });
                      }}
                    >
                      <option value="">الحساب</option>
                      {postableAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                    </Select>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label>مدين</Label>
                        <NumberInput
                          value={line.debit}
                          onValueChange={(v) => {
                            const lines = [...journalForm.lines];
                            lines[idx] = { ...line, debit: v, credit: v ? '' : line.credit };
                            setJournalForm({ ...journalForm, lines });
                          }}
                        />
                      </div>
                      <div>
                        <Label>دائن</Label>
                        <NumberInput
                          value={line.credit}
                          onValueChange={(v) => {
                            const lines = [...journalForm.lines];
                            lines[idx] = { ...line, credit: v, debit: v ? '' : line.debit };
                            setJournalForm({ ...journalForm, lines });
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full"
                  onClick={() => setJournalForm({ ...journalForm, lines: [...journalForm.lines, emptyLine()] })}
                >
                  سطر إضافي
                </Button>
              </div>
              <Button type="submit" className="w-full" disabled={busy}>حفظ المسودة</Button>
            </form>
          </Card>
          <Card>
            <CardHeader title="سجل القيود" subtitle={`${journals.length} قيد`} icon={ScrollText} />
            {journals.length === 0 ? <Empty text="لا توجد قيود" /> : (
              <Table>
                <thead><tr><Th>الرقم</Th><Th>التاريخ</Th><Th>البيان</Th><Th>الحالة</Th><Th></Th></tr></thead>
                <tbody>
                  {journals.map((row) => {
                    const st = STATUS[row.status] || { label: row.status, tone: 'slate' as Tone };
                    return (
                      <tr key={row.id}>
                        <Td className="font-mono text-xs font-bold ltr text-left">{row.number}</Td>
                        <Td className="whitespace-nowrap text-slate-500">{formatDate(row.entryDate)}</Td>
                        <Td className="max-w-xs truncate">{row.description || '—'}</Td>
                        <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
                        <Td>
                          <div className="flex flex-wrap gap-1.5">
                            {row.status === 'DRAFT' && (
                              <Button size="sm" variant="soft" disabled={busy} onClick={() => run(() => api(`/accounting/journals/${row.id}/post`, { method: 'POST', body: '{}' }), 'تم ترحيل القيد')}>
                                ترحيل
                              </Button>
                            )}
                            {row.status === 'POSTED' && (
                              <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => api(`/accounting/journals/${row.id}/reverse`, { method: 'POST', body: JSON.stringify({ entryDate: todayIso() }) }), 'تم عكس القيد')}>
                                عكس
                              </Button>
                            )}
                          </div>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {tab === 'trial' && (
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="ميزان المراجعة"
              subtitle={`${formatDate(rangeFrom)} → ${formatDate(rangeTo)}`}
              icon={Scale}
              actions={(
                <div className="flex flex-wrap items-end gap-2">
                  <div><Label>من</Label><Input type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} /></div>
                  <div><Label>إلى</Label><Input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} /></div>
                </div>
              )}
            />
            {trial.length === 0 ? <Empty text="لا توجد أرصدة في الفترة" /> : (
              <>
                <Table>
                  <thead><tr><Th>الكود</Th><Th>الحساب</Th><Th>مدين</Th><Th>دائن</Th></tr></thead>
                  <tbody>
                    {trial.map((row) => (
                      <tr key={row.accountId || row.code}>
                        <Td className="font-mono text-xs font-bold ltr text-left">{row.code}</Td>
                        <Td>{row.name}</Td>
                        <Td className="font-bold tabular-nums">{row.debit ? formatMoney(row.debit) : '—'}</Td>
                        <Td className="font-bold tabular-nums">{row.credit ? formatMoney(row.credit) : '—'}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <div className="mt-3 flex flex-wrap gap-4 border-t border-slate-100 pt-3 text-sm font-extrabold">
                  <span>إجمالي مدين: {formatMoney(trialDebit)}</span>
                  <span>إجمالي دائن: {formatMoney(trialCredit)}</span>
                  <span className={Math.abs(trialDebit - trialCredit) < 0.005 ? 'text-emerald-700' : 'text-rose-600'}>
                    {Math.abs(trialDebit - trialCredit) < 0.005 ? 'متوازن' : 'غير متوازن'}
                  </span>
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      {tab === 'openings' && (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <Card>
            <CardHeader title="دفعة افتتاحية" subtitle="مسودة لسنة مالية" icon={Plus} />
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const year = Number(openingYear);
                if (!year || year < 2000) return toast.error('أدخل سنة صحيحة');
                await run(
                  () => api('/accounting/openings', { method: 'POST', body: JSON.stringify({ fiscalYear: year }) }),
                  'تم إنشاء دفعة الأرصدة الافتتاحية',
                );
              }}
            >
              <div><Label>السنة المالية</Label><Input value={openingYear} onChange={(e) => setOpeningYear(e.target.value)} dir="ltr" /></div>
              <Button type="submit" className="w-full" disabled={busy}>إنشاء مسودة</Button>
            </form>
          </Card>
          <Card>
            <CardHeader title="الأرصدة الافتتاحية" subtitle={`${openings.length} دفعة`} icon={Building2} />
            {openings.length === 0 ? <Empty text="لا توجد دفعات افتتاحية" /> : (
              <Table>
                <thead><tr><Th>السنة</Th><Th>الإصدار</Th><Th>الحالة</Th><Th>البنود</Th><Th></Th></tr></thead>
                <tbody>
                  {openings.map((row) => {
                    const st = STATUS[row.status] || { label: row.status, tone: 'slate' as Tone };
                    return (
                      <tr key={row.id}>
                        <Td className="font-bold tabular-nums">{row.fiscalYear}</Td>
                        <Td className="tabular-nums">v{row.version}</Td>
                        <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
                        <Td className="tabular-nums">{row.lines?.length ?? 0}</Td>
                        <Td>
                          {row.status === 'DRAFT' && (
                            <Button size="sm" variant="soft" disabled={busy} onClick={() => run(() => api(`/accounting/openings/${row.id}/apply`, { method: 'POST', body: '{}' }), 'تم تطبيق الأرصدة الافتتاحية')}>
                              تطبيق
                            </Button>
                          )}
                          {row.status === 'APPLIED' && (
                            <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => api(`/accounting/openings/${row.id}/reverse`, { method: 'POST', body: '{}' }), 'تم عكس الدفعة الافتتاحية')}>
                              عكس
                            </Button>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {tab === 'gl' && (
        <Card>
          <CardHeader
            title="دفتر الأستاذ العام"
            subtitle={gl?.account ? `${gl.account.code} — ${gl.account.name}` : 'اختر حساباً'}
            icon={LineChart}
            actions={(
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[200px]">
                  <Label>الحساب</Label>
                  <Select value={glAccountId} onChange={(e) => setGlAccountId(e.target.value)}>
                    <option value="">— اختر —</option>
                    {postableAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                  </Select>
                </div>
                <div><Label>من</Label><Input type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} /></div>
                <div><Label>إلى</Label><Input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} /></div>
              </div>
            )}
          />
          {!glAccountId ? (
            <Empty text="اختر حساباً لعرض الحركات" hint="يُعرض الرصيد الجاري بعد كل قيد" />
          ) : !gl?.rows?.length ? (
            <Empty text="لا توجد حركات في الفترة" />
          ) : (
            <Table>
              <thead>
                <tr><Th>الرقم</Th><Th>التاريخ</Th><Th>البيان</Th><Th>مدين</Th><Th>دائن</Th><Th>الرصيد</Th></tr>
              </thead>
              <tbody>
                {gl.rows.map((row) => (
                  <tr key={`${row.entryId}-${row.number}`}>
                    <Td className="font-mono text-xs font-bold ltr text-left">{row.number}</Td>
                    <Td className="whitespace-nowrap text-slate-500">{formatDate(row.entryDate)}</Td>
                    <Td className="max-w-xs truncate">{row.description || '—'}</Td>
                    <Td className="font-bold tabular-nums">{row.debit ? formatMoney(row.debit) : '—'}</Td>
                    <Td className="font-bold tabular-nums">{row.credit ? formatMoney(row.credit) : '—'}</Td>
                    <Td className="font-bold tabular-nums">{formatMoney(row.balance)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'statements' && (
        <div className="space-y-4">
          <div className="flex w-fit max-w-full flex-wrap rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
            {([
              { id: 'balance' as const, label: 'الميزانية العمومية' },
              { id: 'income' as const, label: 'قائمة الدخل' },
              { id: 'cash' as const, label: 'التدفقات النقدية' },
            ]).map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setStatementView(v.id)}
                className={`inline-flex h-9 items-center rounded-lg px-4 text-[13px] font-bold transition ${statementView === v.id ? 'bg-slate-800 text-white' : 'text-slate-500 hover:text-slate-800'}`}
              >
                {v.label}
              </button>
            ))}
          </div>

          {statementView === 'balance' && balanceSheet && (
            <Card>
              <CardHeader
                title="الميزانية العمومية"
                subtitle={balanceSheet.asOf ? `حتى ${formatDate(balanceSheet.asOf)}` : 'كل الفترات'}
                icon={Scale}
                actions={(
                  <div><Label>تاريخ الجرد</Label><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>
                )}
              />
              <div className="grid gap-4 lg:grid-cols-2">
                {([
                  { title: 'الأصول', rows: balanceSheet.assets, total: balanceSheet.totals.assets },
                  { title: 'الخصوم', rows: balanceSheet.liabilities, total: balanceSheet.totals.liabilities },
                  { title: 'حقوق الملكية', rows: balanceSheet.equity, total: balanceSheet.totals.equity - balanceSheet.netIncome },
                ] as const).map((section) => (
                  <div key={section.title}>
                    <p className="mb-2 text-sm font-extrabold text-slate-800">{section.title}</p>
                    {section.rows.length === 0 ? (
                      <p className="text-sm text-slate-400">لا توجد بنود</p>
                    ) : (
                      <Table>
                        <thead><tr><Th>الكود</Th><Th>البند</Th><Th>الرصيد</Th></tr></thead>
                        <tbody>
                          {section.rows.map((row) => (
                            <tr key={row.accountId || row.code}>
                              <Td className="font-mono text-xs font-bold ltr text-left">{row.code}</Td>
                              <Td>{row.name}</Td>
                              <Td className="font-bold tabular-nums">{formatMoney(Math.abs(stmtBalance(row)))}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    )}
                    <p className="mt-2 text-sm font-extrabold">الإجمالي: {formatMoney(section.total)}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap gap-4 border-t border-slate-100 pt-3 text-sm font-extrabold">
                <span>صافي الدخل (مضمّن في حقوق الملكية): {formatMoney(balanceSheet.netIncome)}</span>
                <span>الخصوم + حقوق الملكية: {formatMoney(balanceSheet.totals.liabilitiesAndEquity)}</span>
                <span className={balanceSheet.totals.balanced ? 'text-emerald-700' : 'text-rose-600'}>
                  {balanceSheet.totals.balanced ? 'متوازنة' : 'غير متوازنة'}
                </span>
              </div>
            </Card>
          )}

          {statementView === 'income' && incomeStatement && (
            <Card>
              <CardHeader
                title="قائمة الدخل"
                subtitle={`${formatDate(rangeFrom)} → ${formatDate(rangeTo)}`}
                icon={Coins}
                actions={(
                  <div className="flex flex-wrap items-end gap-2">
                    <div><Label>من</Label><Input type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} /></div>
                    <div><Label>إلى</Label><Input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} /></div>
                  </div>
                )}
              />
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <p className="mb-2 text-sm font-extrabold text-emerald-800">الإيرادات</p>
                  {incomeStatement.revenueRows.length === 0 ? <p className="text-sm text-slate-400">لا توجد إيرادات</p> : (
                    <Table>
                      <thead><tr><Th>الكود</Th><Th>البند</Th><Th>المبلغ</Th></tr></thead>
                      <tbody>
                        {incomeStatement.revenueRows.map((row) => (
                          <tr key={row.accountId || row.code}>
                            <Td className="font-mono text-xs font-bold ltr text-left">{row.code}</Td>
                            <Td>{row.name}</Td>
                            <Td className="font-bold tabular-nums">{formatMoney((row.balanceCredit ?? 0) - (row.balanceDebit ?? 0))}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  )}
                  <p className="mt-2 text-sm font-extrabold">إجمالي الإيرادات: {formatMoney(incomeStatement.revenue)}</p>
                </div>
                <div>
                  <p className="mb-2 text-sm font-extrabold text-amber-800">المصروفات</p>
                  {incomeStatement.expenseRows.length === 0 ? <p className="text-sm text-slate-400">لا توجد مصروفات</p> : (
                    <Table>
                      <thead><tr><Th>الكود</Th><Th>البند</Th><Th>المبلغ</Th></tr></thead>
                      <tbody>
                        {incomeStatement.expenseRows.map((row) => (
                          <tr key={row.accountId || row.code}>
                            <Td className="font-mono text-xs font-bold ltr text-left">{row.code}</Td>
                            <Td>{row.name}</Td>
                            <Td className="font-bold tabular-nums">{formatMoney((row.balanceDebit ?? 0) - (row.balanceCredit ?? 0))}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  )}
                  <p className="mt-2 text-sm font-extrabold">إجمالي المصروفات: {formatMoney(incomeStatement.expense)}</p>
                </div>
              </div>
              <p className="mt-4 border-t border-slate-100 pt-3 text-sm font-extrabold">
                صافي الدخل: <span className={incomeStatement.netIncome >= 0 ? 'text-emerald-700' : 'text-rose-600'}>{formatMoney(incomeStatement.netIncome)}</span>
              </p>
            </Card>
          )}

          {statementView === 'cash' && cashFlow && (
            <Card>
              <CardHeader
                title="قائمة التدفقات النقدية"
                subtitle={`${formatDate(rangeFrom)} → ${formatDate(rangeTo)} · مبسّطة من الدفتر`}
                icon={Wallet}
                actions={(
                  <div className="flex flex-wrap items-end gap-2">
                    <div><Label>من</Label><Input type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} /></div>
                    <div><Label>إلى</Label><Input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} /></div>
                  </div>
                )}
              />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <StatCard label="التشغيلية" value={formatMoney(cashFlow.operatingCash)} icon={Calculator} tone="brand" />
                <StatCard label="الاستثمارية" value={formatMoney(cashFlow.investingCash)} icon={Building2} tone="amber" />
                <StatCard label="التمويلية" value={formatMoney(cashFlow.financingCash)} icon={Landmark} tone="emerald" />
              </div>
              <div className="mt-4">
                <Table>
                  <tbody>
                    <tr><Td className="font-semibold">صافي الدخل</Td><Td className="font-bold tabular-nums">{formatMoney(cashFlow.netIncome)}</Td></tr>
                    <tr><Td className="font-semibold">إضافة إهلاك (غير نقدي)</Td><Td className="font-bold tabular-nums">{formatMoney(cashFlow.depreciationAddBack)}</Td></tr>
                    <tr><Td className="font-semibold">تغيّر الذمم المدينة</Td><Td className="font-bold tabular-nums">{formatMoney(cashFlow.workingCapital.arIncrease)}</Td></tr>
                    <tr><Td className="font-semibold">تغيّر الذمم الدائنة</Td><Td className="font-bold tabular-nums">{formatMoney(cashFlow.workingCapital.apIncrease)}</Td></tr>
                    <tr><Td className="font-extrabold text-slate-900">صافي تغيّر النقد (حسابات النقد)</Td><Td className="font-extrabold tabular-nums">{formatMoney(cashFlow.netCashChange)}</Td></tr>
                    <tr><Td className="text-slate-500">التحقق (تشغيل + استثمار + تمويل)</Td><Td className="tabular-nums text-slate-500">{formatMoney(cashFlow.impliedCheck)}</Td></tr>
                  </tbody>
                </Table>
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === 'tax' && tax && (
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="تقرير ضريبة القيمة المضافة"
              subtitle={`${formatDate(rangeFrom)} → ${formatDate(rangeTo)}`}
              icon={Receipt}
              actions={(
                <div className="flex flex-wrap items-end gap-2">
                  <div><Label>من</Label><Input type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} /></div>
                  <div><Label>إلى</Label><Input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} /></div>
                </div>
              )}
            />
            <p className="mb-3 text-sm font-extrabold text-slate-700">من الفواتير</p>
            <StatGrid>
              <StatCard label="ضريبة المبيعات" value={formatMoney(tax.invoices.salesTax)} hint={`${tax.invoices.salesCount} فاتورة`} icon={Receipt} tone="emerald" />
              <StatCard label="ضريبة المشتريات" value={formatMoney(tax.invoices.purchaseTax)} hint={`${tax.invoices.purchaseCount} فاتورة`} icon={Receipt} tone="amber" />
              <StatCard label="صافي الضريبة (فواتير)" value={formatMoney(tax.invoices.netVatPayable)} icon={Scale} tone="brand" />
            </StatGrid>
            <p className="mb-2 mt-6 text-sm font-extrabold text-slate-700">من الدفتر (2200 / 1400)</p>
            <Table>
              <tbody>
                <tr><Td className="font-semibold">ضريبة مبيعات مستحقة (2200)</Td><Td className="font-bold tabular-nums">{formatMoney(tax.gl.salesTaxPayable2200)}</Td></tr>
                <tr><Td className="font-semibold">ضريبة مشتريات (1400)</Td><Td className="font-bold tabular-nums">{formatMoney(tax.gl.purchaseTaxReceivable1400)}</Td></tr>
                <tr><Td className="font-extrabold">صافي الضريبة (دفتر)</Td><Td className="font-extrabold tabular-nums">{formatMoney(tax.gl.netVatPayable)}</Td></tr>
              </tbody>
            </Table>
          </Card>
        </div>
      )}

      {tab === 'centers' && (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <Card>
            <CardHeader title="مركز تكلفة جديد" subtitle="كود فريد" icon={Plus} />
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!centerForm.code.trim() || !centerForm.name.trim()) return toast.error('أدخل الكود والاسم');
                const ok = await run(
                  () => api('/accounting/cost-centers', {
                    method: 'POST',
                    body: JSON.stringify({ code: centerForm.code.trim(), name: centerForm.name.trim() }),
                  }),
                  'تم إنشاء مركز التكلفة',
                );
                if (ok) setCenterForm({ code: '', name: '' });
              }}
            >
              <div><Label>الكود</Label><Input value={centerForm.code} onChange={(e) => setCenterForm({ ...centerForm, code: e.target.value })} className="ltr text-left" /></div>
              <div><Label>الاسم</Label><Input value={centerForm.name} onChange={(e) => setCenterForm({ ...centerForm, name: e.target.value })} /></div>
              <Button type="submit" className="w-full" disabled={busy}>إضافة</Button>
            </form>
          </Card>
          <Card>
            <CardHeader title="مراكز التكلفة" subtitle={`${costCenters.length} مركز`} icon={Target} />
            {costCenters.length === 0 ? <Empty text="لا توجد مراكز تكلفة" /> : (
              <Table>
                <thead><tr><Th>الكود</Th><Th>الاسم</Th><Th>الحالة</Th></tr></thead>
                <tbody>
                  {costCenters.map((row) => (
                    <tr key={row.id}>
                      <Td className="font-mono text-xs font-bold ltr text-left">{row.code}</Td>
                      <Td className="font-semibold">{row.name}</Td>
                      <Td><Badge tone={row.isActive ? 'emerald' : 'rose'}>{row.isActive ? 'نشط' : 'موقوف'}</Badge></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {tab === 'assets' && (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <Card>
            <CardHeader title="تشغيل الإهلاك الشهري" subtitle="يُنشئ قيوداً محاسبية" icon={Calculator} />
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const year = Number(deprYear);
                const month = Number(deprMonth);
                if (!year || month < 1 || month > 12) return toast.error('أدخل سنة وشهراً صحيحين');
                await run(
                  () => api('/accounting/depreciation/run', {
                    method: 'POST',
                    body: JSON.stringify({ year, month }),
                  }),
                  'تم تشغيل إهلاك الشهر',
                );
              }}
            >
              <div className="grid grid-cols-2 gap-2">
                <div><Label>السنة</Label><Input value={deprYear} onChange={(e) => setDeprYear(e.target.value)} className="ltr text-left" /></div>
                <div>
                  <Label>الشهر</Label>
                  <Select value={deprMonth} onChange={(e) => setDeprMonth(e.target.value)}>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                      <option key={m} value={String(m)}>{m}</option>
                    ))}
                  </Select>
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={busy}>تشغيل الإهلاك</Button>
            </form>
          </Card>
          <Card>
            <CardHeader title="الأصول الثابتة" subtitle={`${fixedAssets.length} أصل · من المالية`} icon={Layers} />
            {fixedAssets.length === 0 ? (
              <Empty text="لا توجد أصول ثابتة" hint="سجّل الأصول من صفحة المالية" />
            ) : (
              <Table>
                <thead><tr><Th>الاسم</Th><Th>القيمة</Th><Th>تاريخ الشراء</Th><Th>الحالة</Th></tr></thead>
                <tbody>
                  {fixedAssets.map((row) => (
                    <tr key={row.id}>
                      <Td className="font-semibold">{row.name}</Td>
                      <Td className="font-bold tabular-nums">{formatMoney(row.value)}</Td>
                      <Td className="whitespace-nowrap text-slate-500">{formatDate(row.acquiredAt)}</Td>
                      <Td><Badge tone={row.isActive ? 'emerald' : 'slate'}>{row.isActive ? 'نشط' : 'موقوف'}</Badge></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
