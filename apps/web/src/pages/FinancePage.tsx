import { useEffect, useMemo, useState } from 'react';
import { BookOpen, CalendarClock, FileCheck2, Plus, Receipt, Scale, Tags, Wallet } from 'lucide-react';
import { api, formatDate, formatMoney } from '../lib/api';
import { useConfirm, useToast } from '../lib/feedback';
import { BarList } from '../components/charts';
import {
  Badge, Button, Card, CardHeader, Empty, ErrorState, Input, Label, NumberInput, PageHeader, PageSkeleton, Select, StatCard, StatGrid, Table, Td, Th,
  type Tone,
} from '../components/ui';

type Tab = 'expenses' | 'checks' | 'ledger';

type Expense = { id: string; amount: number; expenseDate: string; notes?: string | null; category: { name: string }; account: { name: string } };
type Check = { id: string; direction: string; checkNumber: string; bankName: string; amount: number; dueDate: string; status: string; customer?: { name: string } | null; supplier?: { name: string } | null };
type LedgerAccount = { id: string; code: string; name: string; type: string };
type Entry = { id: string; number: string; description: string; entryDate: string; lines: { debit: number; credit: number; account: { name: string } }[] };

const CHECK_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'قيد الانتظار', tone: 'amber' },
  CLEARED: { label: 'تم التحصيل / الصرف', tone: 'emerald' },
  BOUNCED: { label: 'مرتد', tone: 'rose' },
  CANCELLED: { label: 'ملغي', tone: 'slate' },
};

const ACCOUNT_TYPE: Record<string, { label: string; tone: Tone }> = {
  ASSET: { label: 'أصول', tone: 'sky' },
  LIABILITY: { label: 'خصوم', tone: 'rose' },
  EQUITY: { label: 'حقوق ملكية', tone: 'violet' },
  REVENUE: { label: 'إيرادات', tone: 'emerald' },
  EXPENSE: { label: 'مصروفات', tone: 'amber' },
};

const num = (v: number | '') => (v === '' ? 0 : v);

export function FinancePage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>('expenses');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [ledgerAccounts, setLedgerAccounts] = useState<LedgerAccount[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [catName, setCatName] = useState('');
  const [expense, setExpense] = useState({ categoryId: '', accountId: '', amount: '' as number | '', notes: '' });
  const [checkForm, setCheckForm] = useState({ direction: 'IN', checkNumber: '', bankName: '', amount: '' as number | '', dueDate: '', accountId: '' });
  const [journal, setJournal] = useState({ description: '', accountId: '', debit: '' as number | '', credit: '' as number | '', accountId2: '', debit2: '' as number | '', credit2: '' as number | '' });
  const [checkFilter, setCheckFilter] = useState<'ALL' | 'PENDING' | 'IN' | 'OUT'>('ALL');

  async function load() {
    setLoadError('');
    try {
      const [a, cats, ex, ch, la, en] = await Promise.all([
        api<{ id: string; name: string }[]>('/cash/accounts'),
        api<{ id: string; name: string }[]>('/finance/expense-categories'),
        api<Expense[]>('/finance/expenses'),
        api<Check[]>('/finance/checks'),
        api<LedgerAccount[]>('/ledger/accounts'),
        api<Entry[]>('/ledger/entries'),
      ]);
      setAccounts(a);
      setCategories(cats);
      setExpenses(ex);
      setChecks(ch);
      setLedgerAccounts(la);
      setEntries(en);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'تعذر تحميل البيانات المالية');
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => { load(); }, []);

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

  const monthStart = useMemo(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }, []);
  const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0);
  const expenseMonth = expenses.filter((e) => new Date(e.expenseDate).getTime() >= monthStart).reduce((s, e) => s + e.amount, 0);
  const pendingChecks = checks.filter((c) => c.status === 'PENDING');
  const pendingIn = pendingChecks.filter((c) => c.direction === 'IN').reduce((s, c) => s + c.amount, 0);
  const pendingOut = pendingChecks.filter((c) => c.direction !== 'IN').reduce((s, c) => s + c.amount, 0);
  const byCategory = useMemo(() => {
    const map = new Map<string, number>();
    expenses.forEach((e) => map.set(e.category.name, (map.get(e.category.name) || 0) + e.amount));
    return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 8);
  }, [expenses]);
  const visibleChecks = checks.filter((c) => checkFilter === 'ALL' || (checkFilter === 'PENDING' ? c.status === 'PENDING' : c.direction === checkFilter));
  const journalDebit = num(journal.debit) + num(journal.debit2);
  const journalCredit = num(journal.credit) + num(journal.credit2);
  const journalBalanced = journalDebit > 0 && Math.abs(journalDebit - journalCredit) < 0.005;

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'expenses', label: 'المصروفات', count: expenses.length },
    { id: 'checks', label: 'الشيكات', count: checks.length },
    { id: 'ledger', label: 'القيود', count: entries.length },
  ];

  if (!loaded) return <div><PageHeader title="المالية" subtitle="مصروفات مصنفة، دفتر شيكات، وقيود يومية" /><PageSkeleton /></div>;

  return (
    <div>
      <PageHeader title="المالية" subtitle="مصروفات مصنفة، دفتر شيكات، وقيود يومية" />
      {loadError && <Card className="mb-4"><ErrorState text={loadError} onRetry={load} /></Card>}

      <StatGrid>
        <StatCard label="مصروفات الشهر" value={formatMoney(expenseMonth)} hint={`الإجمالي المسجل ${formatMoney(expenseTotal)}`} icon={Receipt} tone="amber" onClick={() => setTab('expenses')} active={tab === 'expenses'} />
        <StatCard label="شيكات واردة معلقة" value={formatMoney(pendingIn)} hint={`${pendingChecks.filter((c) => c.direction === 'IN').length} شيك`} icon={FileCheck2} tone="emerald" onClick={() => { setTab('checks'); setCheckFilter('IN'); }} />
        <StatCard label="شيكات صادرة معلقة" value={formatMoney(pendingOut)} hint={`${pendingChecks.filter((c) => c.direction !== 'IN').length} شيك`} icon={CalendarClock} tone="rose" onClick={() => { setTab('checks'); setCheckFilter('OUT'); }} />
        <StatCard label="قيود اليومية" value={entries.length} hint={`${ledgerAccounts.length} حساب في الدليل`} icon={BookOpen} tone="violet" onClick={() => setTab('ledger')} active={tab === 'ledger'} />
      </StatGrid>

      <div className="mb-4 flex w-fit max-w-full flex-wrap rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`inline-flex h-9 items-center gap-2 rounded-lg px-4 text-[13px] font-bold transition ${tab === t.id ? 'bg-brand-700 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
            {t.label}
            <span className={`rounded-md px-1.5 text-[11px] tabular-nums ${tab === t.id ? 'bg-white/20' : 'bg-slate-100'}`}>{t.count}</span>
          </button>
        ))}
      </div>

      {tab === 'expenses' && (
        <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
          <div className="space-y-4">
            <Card>
              <CardHeader title="تسجيل مصروف" subtitle="يُخصم من الخزنة المختارة فورًا" icon={Plus} />
              <form
                className="space-y-3"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!expense.categoryId || !expense.accountId) return toast.error('اختر البند والخزنة');
                  if (num(expense.amount) <= 0) return toast.error('أدخل مبلغًا أكبر من صفر');
                  const ok = await run(() => api('/finance/expenses', { method: 'POST', body: JSON.stringify({ ...expense, amount: num(expense.amount) }) }), 'تم تسجيل المصروف');
                  if (ok) setExpense({ ...expense, amount: '', notes: '' });
                }}
              >
                <div>
                  <Label>البند</Label>
                  <Select value={expense.categoryId} onChange={(e) => setExpense({ ...expense, categoryId: e.target.value })}>
                    <option value="">اختر</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </div>
                <div>
                  <Label>الخزنة</Label>
                  <Select value={expense.accountId} onChange={(e) => setExpense({ ...expense, accountId: e.target.value })}>
                    <option value="">اختر</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>
                </div>
                <div><Label>المبلغ</Label><NumberInput value={expense.amount} onValueChange={(v) => setExpense({ ...expense, amount: v })} /></div>
                <div><Label>ملاحظة</Label><Input value={expense.notes} onChange={(e) => setExpense({ ...expense, notes: e.target.value })} placeholder="اختياري" /></div>
                <Button type="submit" className="w-full" disabled={busy}>تسجيل المصروف</Button>
              </form>
            </Card>
            <Card>
              <CardHeader title="بنود المصروفات" subtitle={`${categories.length} بند`} icon={Tags} />
              <form
                className="flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!catName.trim()) return toast.error('اكتب اسم البند');
                  const ok = await run(() => api('/finance/expense-categories', { method: 'POST', body: JSON.stringify({ name: catName.trim() }) }), 'تمت إضافة البند');
                  if (ok) setCatName('');
                }}
              >
                <Input value={catName} onChange={(e) => setCatName(e.target.value)} placeholder="بند مصروف جديد" />
                <Button type="submit" variant="secondary" disabled={busy}>إضافة</Button>
              </form>
              {categories.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {categories.map((c) => <Badge key={c.id} tone="slate">{c.name}</Badge>)}
                </div>
              )}
            </Card>
          </div>
          <div className="space-y-4">
            {byCategory.length > 0 && (
              <Card>
                <CardHeader title="توزيع المصروفات حسب البند" subtitle={`الإجمالي ${formatMoney(expenseTotal)}`} icon={Scale} />
                <BarList rows={byCategory} color="from-amber-400 to-amber-600" />
              </Card>
            )}
            <Card>
              <CardHeader title="سجل المصروفات" subtitle={`${expenses.length} مصروف`} icon={Receipt} />
              {expenses.length === 0 ? <Empty text="لا توجد مصروفات مسجلة" hint="سجّل أول مصروف من النموذج" /> : (
                <Table>
                  <thead><tr><Th>التاريخ</Th><Th>البند</Th><Th>الخزنة</Th><Th>ملاحظة</Th><Th>المبلغ</Th></tr></thead>
                  <tbody>
                    {expenses.map((row) => (
                      <tr key={row.id} className="row-credit">
                        <Td className="whitespace-nowrap text-slate-500">{formatDate(row.expenseDate)}</Td>
                        <Td><Badge tone="amber">{row.category.name}</Badge></Td>
                        <Td className="text-slate-600">{row.account.name}</Td>
                        <Td className="max-w-xs truncate text-muted">{row.notes || '—'}</Td>
                        <Td className="whitespace-nowrap font-extrabold text-rose-600">{formatMoney(row.amount)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>
        </div>
      )}

      {tab === 'checks' && (
        <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
          <Card>
            <CardHeader title="تسجيل شيك" subtitle="وارد من عميل أو صادر لمورد" icon={Plus} />
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!checkForm.checkNumber.trim() || !checkForm.bankName.trim()) return toast.error('أدخل رقم الشيك واسم البنك');
                if (num(checkForm.amount) <= 0) return toast.error('أدخل مبلغًا أكبر من صفر');
                if (!checkForm.dueDate) return toast.error('حدد تاريخ الاستحقاق');
                const ok = await run(() => api('/finance/checks', { method: 'POST', body: JSON.stringify({ ...checkForm, amount: num(checkForm.amount) }) }), 'تم تسجيل الشيك');
                if (ok) setCheckForm({ ...checkForm, checkNumber: '', bankName: '', amount: '', dueDate: '' });
              }}
            >
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
                {[['IN', 'شيك وارد'], ['OUT', 'شيك صادر']].map(([v, l]) => (
                  <button key={v} type="button" onClick={() => setCheckForm({ ...checkForm, direction: v })} className={`h-9 rounded-lg text-[13px] font-bold transition ${checkForm.direction === v ? 'bg-white text-brand-800 shadow-sm' : 'text-slate-500'}`}>{l}</button>
                ))}
              </div>
              <div><Label>رقم الشيك</Label><Input value={checkForm.checkNumber} onChange={(e) => setCheckForm({ ...checkForm, checkNumber: e.target.value })} dir="ltr" /></div>
              <div><Label>البنك</Label><Input value={checkForm.bankName} onChange={(e) => setCheckForm({ ...checkForm, bankName: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-2">
                <div><Label>المبلغ</Label><NumberInput value={checkForm.amount} onValueChange={(v) => setCheckForm({ ...checkForm, amount: v })} /></div>
                <div><Label>الاستحقاق</Label><Input type="date" value={checkForm.dueDate} onChange={(e) => setCheckForm({ ...checkForm, dueDate: e.target.value })} /></div>
              </div>
              <div>
                <Label>حساب التحصيل أو الصرف</Label>
                <Select value={checkForm.accountId} onChange={(e) => setCheckForm({ ...checkForm, accountId: e.target.value })}>
                  <option value="">عند تغيير الحالة</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              </div>
              <Button type="submit" className="w-full" disabled={busy}>تسجيل الشيك</Button>
            </form>
          </Card>
          <Card>
            <CardHeader
              title="دفتر الشيكات"
              subtitle={`${visibleChecks.length} شيك`}
              icon={FileCheck2}
              actions={
                <div className="flex rounded-xl bg-slate-100 p-1">
                  {([['ALL', 'الكل'], ['PENDING', 'معلقة'], ['IN', 'واردة'], ['OUT', 'صادرة']] as const).map(([v, l]) => (
                    <button key={v} type="button" onClick={() => setCheckFilter(v)} className={`h-8 rounded-lg px-3 text-xs font-bold transition ${checkFilter === v ? 'bg-white text-brand-800 shadow-sm' : 'text-slate-500'}`}>{l}</button>
                  ))}
                </div>
              }
            />
            {visibleChecks.length === 0 ? <Empty text="لا توجد شيكات" /> : (
              <Table>
                <thead><tr><Th>الشيك</Th><Th>الطرف</Th><Th>البنك</Th><Th>الاستحقاق</Th><Th>المبلغ</Th><Th>الحالة</Th><Th></Th></tr></thead>
                <tbody>
                  {visibleChecks.map((row) => {
                    const st = CHECK_STATUS[row.status] || { label: row.status, tone: 'slate' as Tone };
                    const overdue = row.status === 'PENDING' && new Date(row.dueDate).getTime() < Date.now();
                    return (
                      <tr key={row.id} className={row.direction === 'IN' ? 'row-debit' : 'row-credit'}>
                        <Td>
                          <div className="font-mono text-xs font-bold text-slate-800" dir="ltr">{row.checkNumber}</div>
                          <div className="mt-0.5"><Badge tone={row.direction === 'IN' ? 'emerald' : 'rose'}>{row.direction === 'IN' ? 'وارد' : 'صادر'}</Badge></div>
                        </Td>
                        <Td className="font-semibold text-slate-700">{row.customer?.name || row.supplier?.name || '—'}</Td>
                        <Td className="text-slate-600">{row.bankName}</Td>
                        <Td className={`whitespace-nowrap ${overdue ? 'font-bold text-rose-600' : 'text-slate-500'}`}>{formatDate(row.dueDate)}{overdue && <div className="text-[11px]">مستحق</div>}</Td>
                        <Td className="whitespace-nowrap font-extrabold">{formatMoney(row.amount)}</Td>
                        <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
                        <Td>
                          {row.status === 'PENDING' && (
                            <div className="flex gap-1.5">
                              <Button size="sm" variant="soft" disabled={busy} onClick={() => run(() => api(`/finance/checks/${row.id}`, {
                                method: 'PATCH',
                                body: JSON.stringify({ status: 'CLEARED', accountId: checkForm.accountId || undefined }),
                              }), row.direction === 'IN' ? 'تم تحصيل الشيك' : 'تم صرف الشيك')}>{row.direction === 'IN' ? 'تحصيل' : 'صرف'}</Button>
                              <Button size="sm" variant="ghost" disabled={busy} onClick={async () => {
                                if (!(await confirm({ title: 'تسجيل شيك مرتد', message: `هل تريد تسجيل الشيك ${row.checkNumber} كمرتد؟`, confirmLabel: 'مرتد', danger: true }))) return;
                                await run(() => api(`/finance/checks/${row.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'BOUNCED' }) }), 'تم تسجيل الشيك كمرتد');
                              }}>مرتد</Button>
                            </div>
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

      {tab === 'ledger' && (
        <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
          <Card>
            <CardHeader
              title="دليل الحسابات"
              subtitle={`${ledgerAccounts.length} حساب`}
              icon={BookOpen}
              actions={
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => api('/ledger/accounts/seed', { method: 'POST' }), 'تم تحديث الدليل الافتراضي')}>دليل افتراضي</Button>
              }
            />
            {ledgerAccounts.length === 0 ? <Empty text="لا يوجد دليل حسابات" hint="أنشئ الدليل الافتراضي للبدء" /> : (
              <Table>
                <thead><tr><Th>الكود</Th><Th>الاسم</Th><Th>النوع</Th></tr></thead>
                <tbody>
                  {ledgerAccounts.map((a) => {
                    const t = ACCOUNT_TYPE[a.type] || { label: a.type, tone: 'slate' as Tone };
                    return (
                      <tr key={a.id}>
                        <Td><span className="font-mono text-xs font-bold text-brand-700" dir="ltr">{a.code}</span></Td>
                        <Td className="font-semibold text-slate-800">{a.name}</Td>
                        <Td><Badge tone={t.tone}>{t.label}</Badge></Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
          <div className="space-y-4">
            <Card>
              <CardHeader title="قيد يومية جديد" subtitle="يجب أن يتساوى المدين مع الدائن" icon={Plus} />
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!journal.description.trim()) return toast.error('اكتب بيان القيد');
                  if (!journal.accountId || !journal.accountId2) return toast.error('اختر الحسابين');
                  if (!journalBalanced) return toast.error('القيد غير متوازن: المدين لا يساوي الدائن');
                  const ok = await run(() => api('/ledger/entries', {
                    method: 'POST',
                    body: JSON.stringify({
                      description: journal.description,
                      lines: [
                        { accountId: journal.accountId, debit: num(journal.debit), credit: num(journal.credit) },
                        { accountId: journal.accountId2, debit: num(journal.debit2), credit: num(journal.credit2) },
                      ],
                    }),
                  }), 'تم حفظ القيد');
                  if (ok) setJournal({ description: '', accountId: '', debit: '', credit: '', accountId2: '', debit2: '', credit2: '' });
                }}
              >
                <div className="mb-3"><Label>البيان</Label><Input value={journal.description} onChange={(e) => setJournal({ ...journal, description: e.target.value })} /></div>
                <div className="overflow-hidden rounded-xl border border-slate-200">
                  <div className="grid grid-cols-[1fr_110px_110px] gap-2 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">
                    <span>الحساب</span><span>مدين</span><span>دائن</span>
                  </div>
                  {([['accountId', 'debit', 'credit', 'الحساب الأول'], ['accountId2', 'debit2', 'credit2', 'الحساب الثاني']] as const).map(([acc, dr, cr, ph]) => (
                    <div key={acc} className="grid grid-cols-[1fr_110px_110px] gap-2 border-t border-slate-100 px-3 py-2">
                      <Select value={journal[acc]} onChange={(e) => setJournal({ ...journal, [acc]: e.target.value })}>
                        <option value="">{ph}</option>
                        {ledgerAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                      </Select>
                      <NumberInput value={journal[dr]} onValueChange={(v) => setJournal({ ...journal, [dr]: v })} />
                      <NumberInput value={journal[cr]} onValueChange={(v) => setJournal({ ...journal, [cr]: v })} />
                    </div>
                  ))}
                  <div className={`grid grid-cols-[1fr_110px_110px] gap-2 border-t px-3 py-2 text-sm font-extrabold tabular-nums ${journalBalanced ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-100 bg-slate-50 text-slate-600'}`}>
                    <span>{journalBalanced ? 'القيد متوازن' : 'الإجمالي'}</span><span>{formatMoney(journalDebit)}</span><span>{formatMoney(journalCredit)}</span>
                  </div>
                </div>
                <Button type="submit" className="mt-3" disabled={busy || ledgerAccounts.length === 0}>حفظ القيد</Button>
              </form>
            </Card>
            <Card>
              <CardHeader title="آخر القيود" subtitle={`${entries.length} قيد`} icon={Wallet} />
              {entries.length === 0 ? <Empty text="لا توجد قيود بعد" /> : (
                <div className="space-y-3">
                  {entries.map((entry) => (
                    <div key={entry.id} className="rounded-xl border border-slate-200 p-3 text-sm">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="font-bold text-slate-800"><span className="font-mono text-xs text-brand-700" dir="ltr">{entry.number}</span> · {entry.description}</div>
                        <div className="whitespace-nowrap text-xs text-muted">{formatDate(entry.entryDate)}</div>
                      </div>
                      {entry.lines.map((line, i) => (
                        <div key={i} className="flex items-center justify-between border-t border-slate-100 py-1.5 text-[13px]">
                          <span className="text-slate-700">{line.account.name}</span>
                          <span className="flex gap-4 tabular-nums">
                            <span className={line.debit ? 'font-bold text-emerald-700' : 'text-slate-400'}>مدين {formatMoney(line.debit)}</span>
                            <span className={line.credit ? 'font-bold text-rose-600' : 'text-slate-400'}>دائن {formatMoney(line.credit)}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
