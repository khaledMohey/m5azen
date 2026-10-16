import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Plus, Wallet, Banknote, Building2,
} from 'lucide-react';
import { api, formatDate, formatMoney } from '../lib/api';
import { dueTone } from '../lib/due';
import { DueAmount } from '../components/DueAmount';
import {
  Badge, Button, Card, CardHeader, Empty, Input, Label, Modal, NumberInput, PageHeader, SearchBox, Select, StatCard, StatGrid, Table, Td, Th,
} from '../components/ui';

const PAYMENT_METHODS = [
  { value: 'CASH', label: 'نقدي' },
  { value: 'BANK_TRANSFER', label: 'تحويل بنكي' },
  { value: 'CHECK', label: 'شيك' },
  { value: 'CARD', label: 'بطاقة' },
  { value: 'INSTAPAY', label: 'إنستاباي' },
  { value: 'OTHER', label: 'أخرى' },
] as const;

const METHOD_MAP = Object.fromEntries(PAYMENT_METHODS.map((m) => [m.value, m.label]));

type Account = { id: string; code: string; name: string; balance: number; accountType?: string };
type Tx = {
  id: string; direction: 'IN' | 'OUT'; amount: number; description: string; createdAt: string;
  paymentMethod?: string; reference?: string | null;
  account: { name: string };
};
type Party = { id: string; name: string; balance?: number; code?: string };
type OpenInvoice = {
  id: string; number: string; total: number; paidAmount: number; remaining: number; status: string; invoiceDate: string;
};
type Receipt = {
  id: string; number: string; amount: number; paymentMethod: string; receivedAt: string;
  referenceNo?: string | null; note?: string | null;
  customer: { name: string }; cashAccount: { name: string };
  salesInvoice?: { number: string } | null;
};
type Payment = {
  id: string; number: string; amount: number; paymentMethod: string; paidAt: string;
  referenceNo?: string | null; note?: string | null;
  supplier: { name: string }; cashAccount: { name: string };
  purchaseInvoice?: { number: string } | null;
};

type Tab = 'overview' | 'receipts' | 'payments' | 'movements';

function oldestOpen(rows: OpenInvoice[]) {
  const open = rows.filter((row) => row.remaining > 0.009);
  const source = open.length ? open : rows;
  return source.reduce((best, row) => (row.invoiceDate < best ? row.invoiceDate : best), source[0].invoiceDate);
}

function dueBox(rows: OpenInvoice[]) {
  const tones = rows.filter((row) => row.remaining > 0.009).map((row) => dueTone(row.invoiceDate, row.remaining));
  if (tones.includes('red')) return 'border-rose-200 bg-rose-50';
  if (tones.includes('yellow')) return 'border-amber-200 bg-amber-50';
  if (tones.includes('green')) return 'border-emerald-200 bg-emerald-50';
  return 'border-slate-200 bg-slate-50';
}

export function CashPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [customers, setCustomers] = useState<Party[]>([]);
  const [suppliers, setSuppliers] = useState<Party[]>([]);

  const [txOpen, setTxOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [accOpen, setAccOpen] = useState(false);

  const [txForm, setTxForm] = useState({
    accountId: '', direction: 'IN', amount: '' as number | '', description: '', paymentMethod: 'CASH',
  });
  const [receiptForm, setReceiptForm] = useState({
    customerId: '', cashAccountId: '', amount: '' as number | '', salesInvoiceId: '',
    paymentMethod: 'CASH', referenceNo: '', note: '',
  });
  const [paymentForm, setPaymentForm] = useState({
    supplierId: '', cashAccountId: '', amount: '' as number | '', purchaseInvoiceId: '',
    paymentMethod: 'CASH', referenceNo: '', note: '',
  });
  const [accForm, setAccForm] = useState({ code: '', name: '', balance: '' as number | '', accountType: 'CASH' });

  const [customerSummary, setCustomerSummary] = useState<{ balance: number; openInvoices: OpenInvoice[] } | null>(null);
  const [supplierSummary, setSupplierSummary] = useState<{ balance: number; openInvoices: OpenInvoice[] } | null>(null);
  const [search, setSearch] = useState('');

  async function load() {
    const [a, t, c, s, r, p] = await Promise.all([
      api<Account[]>('/cash/accounts'),
      api<Tx[]>('/cash/transactions'),
      api<Party[]>('/customers'),
      api<Party[]>('/suppliers'),
      api<Receipt[]>('/cash/receipts'),
      api<Payment[]>('/cash/payments'),
    ]);
    setAccounts(a);
    setTxs(t);
    setCustomers(c);
    setSuppliers(s);
    setReceipts(r);
    setPayments(p);
  }

  useEffect(() => { load(); }, []);

  const filteredReceipts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return receipts;
    return receipts.filter((r) =>
      [r.number, r.customer.name, r.cashAccount.name, r.note || ''].some((x) => x.toLowerCase().includes(q)),
    );
  }, [receipts, search]);

  const filteredPayments = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return payments;
    return payments.filter((p) =>
      [p.number, p.supplier.name, p.cashAccount.name, p.note || ''].some((x) => x.toLowerCase().includes(q)),
    );
  }, [payments, search]);

  const filteredTxs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return txs;
    return txs.filter((t) =>
      [t.description, t.account.name, t.reference || ''].some((x) => x.toLowerCase().includes(q)),
    );
  }, [txs, search]);

  useEffect(() => {
    if (!receiptForm.customerId) {
      setCustomerSummary(null);
      return;
    }
    api<{ balance: number; openInvoices: OpenInvoice[] }>(`/cash/customers/${receiptForm.customerId}/summary`)
      .then(setCustomerSummary)
      .catch(() => setCustomerSummary(null));
  }, [receiptForm.customerId]);

  useEffect(() => {
    if (!paymentForm.supplierId) {
      setSupplierSummary(null);
      return;
    }
    api<{ balance: number; openInvoices: OpenInvoice[] }>(`/cash/suppliers/${paymentForm.supplierId}/summary`)
      .then(setSupplierSummary)
      .catch(() => setSupplierSummary(null));
  }, [paymentForm.supplierId]);

  async function saveTx() {
    await api('/cash/transactions', {
      method: 'POST',
      body: JSON.stringify({ ...txForm, amount: txForm.amount === '' ? 0 : txForm.amount }),
    });
    setTxOpen(false);
    setTxForm({ accountId: '', direction: 'IN', amount: '', description: '', paymentMethod: 'CASH' });
    load();
  }

  async function saveReceipt() {
    await api('/cash/receipts', {
      method: 'POST',
      body: JSON.stringify({
        ...receiptForm,
        amount: receiptForm.amount === '' ? 0 : receiptForm.amount,
        salesInvoiceId: receiptForm.salesInvoiceId || undefined,
        referenceNo: receiptForm.referenceNo || undefined,
        note: receiptForm.note || undefined,
      }),
    });
    setReceiptOpen(false);
    setReceiptForm({
      customerId: '', cashAccountId: '', amount: '', salesInvoiceId: '',
      paymentMethod: 'CASH', referenceNo: '', note: '',
    });
    setTab('receipts');
    load();
  }

  async function savePayment() {
    await api('/cash/payments', {
      method: 'POST',
      body: JSON.stringify({
        ...paymentForm,
        amount: paymentForm.amount === '' ? 0 : paymentForm.amount,
        purchaseInvoiceId: paymentForm.purchaseInvoiceId || undefined,
        referenceNo: paymentForm.referenceNo || undefined,
        note: paymentForm.note || undefined,
      }),
    });
    setPaymentOpen(false);
    setPaymentForm({
      supplierId: '', cashAccountId: '', amount: '', purchaseInvoiceId: '',
      paymentMethod: 'CASH', referenceNo: '', note: '',
    });
    setTab('payments');
    load();
  }

  async function saveAccount() {
    await api('/cash/accounts', {
      method: 'POST',
      body: JSON.stringify({
        ...accForm,
        balance: accForm.balance === '' ? 0 : accForm.balance,
      }),
    });
    setAccOpen(false);
    setAccForm({ code: '', name: '', balance: '', accountType: 'CASH' });
    load();
  }

  const total = accounts.reduce((s, a) => s + a.balance, 0);
  const cashAccounts = useMemo(() => accounts.filter((a) => (a.accountType || 'CASH') === 'CASH'), [accounts]);
  const bankAccounts = useMemo(() => accounts.filter((a) => a.accountType === 'BANK'), [accounts]);

  const cashTotal = cashAccounts.reduce((s, a) => s + a.balance, 0);
  const bankTotal = bankAccounts.reduce((s, a) => s + a.balance, 0);
  const inflow = txs.filter((t) => t.direction === 'IN').reduce((s, t) => s + t.amount, 0);
  const outflow = txs.filter((t) => t.direction !== 'IN').reduce((s, t) => s + t.amount, 0);
  const netFlow = inflow - outflow;

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'overview', label: 'الحسابات', count: accounts.length },
    { id: 'receipts', label: 'التحصيلات', count: receipts.length },
    { id: 'payments', label: 'السدادات', count: payments.length },
    { id: 'movements', label: 'الحركات', count: txs.length },
  ];

  return (
    <div>
      <PageHeader
        title="الخزنة"
        subtitle="حسابات نقدية وبنكية · تحصيل · سداد · طرق دفع"
        actions={
          <>
            <SearchBox value={search} onChange={setSearch} placeholder="بحث في الخزنة..." />
            <Button variant="secondary" onClick={() => setAccOpen(true)}><Plus size={16} /> حساب</Button>
            <Button variant="secondary" onClick={() => setReceiptOpen(true)}><ArrowDownLeft size={16} /> تحصيل</Button>
            <Button variant="secondary" onClick={() => setPaymentOpen(true)}><ArrowUpRight size={16} /> سداد</Button>
            <Button onClick={() => setTxOpen(true)}>حركة يدوية</Button>
          </>
        }
      />

      <StatGrid>
        <StatCard label="إجمالي الأرصدة" value={formatMoney(total)} hint={`${accounts.length} حساب نشط`} icon={Wallet} tone="brand" />
        <StatCard label="النقدية بالخزن" value={formatMoney(cashTotal)} hint={`${cashAccounts.length} خزنة`} icon={Banknote} tone="emerald" />
        <StatCard label="أرصدة البنوك" value={formatMoney(bankTotal)} hint={`${bankAccounts.length} حساب بنكي`} icon={Building2} tone="sky" />
        <StatCard label="صافي الحركة المسجلة" value={formatMoney(netFlow)} hint={`وارد ${formatMoney(inflow)} · صادر ${formatMoney(outflow)}`} icon={ArrowLeftRight} tone={netFlow >= 0 ? 'emerald' : 'rose'} />
      </StatGrid>

      <div className="mb-4 flex w-fit max-w-full flex-wrap rounded-xl border border-slate-200 bg-white p-1 shadow-sm no-print">
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`inline-flex h-9 items-center gap-2 rounded-lg px-4 text-[13px] font-bold transition ${tab === t.id ? 'bg-brand-700 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
            {t.label}
            {t.count !== undefined && <span className={`rounded-md px-1.5 text-[11px] tabular-nums ${tab === t.id ? 'bg-white/20' : 'bg-slate-100'}`}>{t.count}</span>}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-2">
          {([['الخزن النقدية', cashAccounts, Banknote, 'from-emerald-500 to-teal-800'], ['الحسابات البنكية', bankAccounts, Building2, 'from-brand-600 to-brand-950']] as const).map(([title, list, Icon, gradient]) => (
            <Card key={title}>
              <CardHeader title={title} subtitle={`الإجمالي ${formatMoney(list.reduce((s, a) => s + a.balance, 0))}`} icon={Icon} />
              {list.length === 0 ? <Empty text={`لا توجد ${title}`} /> : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {list.map((a) => (
                    <div key={a.id} className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${gradient} p-4 text-white shadow-lg`}>
                      <div className="pointer-events-none absolute -left-6 -top-8 h-24 w-24 rounded-full bg-white/10" />
                      <div className="pointer-events-none absolute -bottom-10 left-12 h-24 w-24 rounded-full bg-white/5" />
                      <div className="relative flex items-center justify-between text-xs text-white/80">
                        <span className="flex items-center gap-1.5 font-semibold"><Icon size={14} />{a.name}</span>
                        <span className="font-mono tracking-widest" dir="ltr">{a.code}</span>
                      </div>
                      <div className="relative mt-5 text-[1.35rem] font-black tracking-tight tabular-nums">{formatMoney(a.balance)}</div>
                      <div className="relative mt-1 text-[11px] text-white/70">{total > 0 ? `${((a.balance / total) * 100).toFixed(1)}% من إجمالي الأرصدة` : '—'}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {tab === 'receipts' && (
        <Card>
          <CardHeader title="سجل التحصيلات من العملاء" subtitle={`${filteredReceipts.length} عملية · ${formatMoney(filteredReceipts.reduce((s, r) => s + r.amount, 0))}`} icon={ArrowDownLeft} />
          {receipts.length === 0 ? <Empty /> : (
            <Table>
              <thead>
                <tr>
                  <Th>الرقم</Th><Th>العميل</Th><Th>الفاتورة</Th><Th>الحساب</Th>
                  <Th>طريقة الدفع</Th><Th>المبلغ</Th><Th>التاريخ</Th>
                </tr>
              </thead>
              <tbody>
                {filteredReceipts.map((r) => (
                  <tr key={r.id} className="row-debit">
                    <Td><span className="font-mono text-xs font-bold text-brand-700" dir="ltr">{r.number}</span></Td>
                    <Td className="font-bold text-slate-900">{r.customer.name}</Td>
                    <Td><span className="font-mono text-xs text-slate-500" dir="ltr">{r.salesInvoice?.number || '—'}</span></Td>
                    <Td className="text-slate-600">{r.cashAccount.name}</Td>
                    <Td><Badge tone="sky">{METHOD_MAP[r.paymentMethod] || r.paymentMethod}</Badge></Td>
                    <Td className="whitespace-nowrap font-extrabold text-emerald-700">+ {formatMoney(r.amount)}</Td>
                    <Td className="whitespace-nowrap text-slate-500">{formatDate(r.receivedAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'payments' && (
        <Card>
          <CardHeader title="سجل السداد للموردين" subtitle={`${filteredPayments.length} عملية · ${formatMoney(filteredPayments.reduce((s, p) => s + p.amount, 0))}`} icon={ArrowUpRight} />
          {payments.length === 0 ? <Empty /> : (
            <Table>
              <thead>
                <tr>
                  <Th>الرقم</Th><Th>المورد</Th><Th>الفاتورة</Th><Th>الحساب</Th>
                  <Th>طريقة الدفع</Th><Th>المبلغ</Th><Th>التاريخ</Th>
                </tr>
              </thead>
              <tbody>
                {filteredPayments.map((p) => (
                  <tr key={p.id} className="row-credit">
                    <Td><span className="font-mono text-xs font-bold text-brand-700" dir="ltr">{p.number}</span></Td>
                    <Td className="font-bold text-slate-900">{p.supplier.name}</Td>
                    <Td><span className="font-mono text-xs text-slate-500" dir="ltr">{p.purchaseInvoice?.number || '—'}</span></Td>
                    <Td className="text-slate-600">{p.cashAccount.name}</Td>
                    <Td><Badge tone="sky">{METHOD_MAP[p.paymentMethod] || p.paymentMethod}</Badge></Td>
                    <Td className="whitespace-nowrap font-extrabold text-rose-600">− {formatMoney(p.amount)}</Td>
                    <Td className="whitespace-nowrap text-slate-500">{formatDate(p.paidAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'movements' && (
        <Card>
          <CardHeader title="كل حركات الخزنة" subtitle={`${filteredTxs.length} حركة`} icon={ArrowLeftRight} />
          {txs.length === 0 ? <Empty /> : (
            <Table>
              <thead>
                <tr>
                  <Th>التاريخ</Th><Th>الحساب</Th><Th>الوصف</Th><Th>طريقة الدفع</Th><Th>النوع</Th><Th>المبلغ</Th>
                </tr>
              </thead>
              <tbody>
                {filteredTxs.map((t) => (
                  <tr key={t.id} className={t.direction === 'IN' ? 'row-debit' : 'row-credit'}>
                    <Td className="whitespace-nowrap text-slate-500">{formatDate(t.createdAt)}</Td>
                    <Td className="font-semibold text-slate-700">{t.account.name}</Td>
                    <Td className="max-w-md truncate text-slate-600" >{t.description}</Td>
                    <Td className="text-muted">{METHOD_MAP[t.paymentMethod || ''] || '—'}</Td>
                    <Td><Badge tone={t.direction === 'IN' ? 'emerald' : 'rose'}>{t.direction === 'IN' ? 'وارد' : 'صادر'}</Badge></Td>
                    <Td className={`whitespace-nowrap font-extrabold ${t.direction === 'IN' ? 'text-emerald-700' : 'text-rose-600'}`}>{t.direction === 'IN' ? '+' : '−'} {formatMoney(t.amount)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      <Modal open={receiptOpen} onClose={() => setReceiptOpen(false)} title="تحصيل من عميل" wide>
        <div className="space-y-3">
          <div>
            <Label>العميل</Label>
            <Select
              value={receiptForm.customerId}
              onChange={(e) => setReceiptForm({ ...receiptForm, customerId: e.target.value, salesInvoiceId: '', amount: '' })}
            >
              <option value="">اختر</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>

          {customerSummary && (
            <div className={`rounded-xl border px-4 py-3 text-sm ${dueBox(customerSummary.openInvoices)}`}>
              <div className="font-bold">
                المستحق على العميل: {customerSummary.openInvoices.length > 0
                  ? <DueAmount date={oldestOpen(customerSummary.openInvoices)} remaining={customerSummary.balance} />
                  : formatMoney(customerSummary.balance)}
              </div>
              {customerSummary.openInvoices.filter((row) => row.remaining > 0.009).length > 0 && (
                <div className="mt-2 space-y-1">
                  {customerSummary.openInvoices.filter((row) => row.remaining > 0.009).map((row) => (
                    <div key={row.id} className="flex items-center justify-between gap-2 text-xs">
                      <span>{row.number}</span>
                      <DueAmount date={row.invoiceDate} remaining={row.remaining} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {customerSummary && customerSummary.openInvoices.length > 0 && (
            <div>
              <Label>ربط بفاتورة (اختياري)</Label>
              <Select
                value={receiptForm.salesInvoiceId}
                onChange={(e) => {
                  const inv = customerSummary.openInvoices.find((i) => i.id === e.target.value);
                  setReceiptForm({
                    ...receiptForm,
                    salesInvoiceId: e.target.value,
                    amount: inv ? inv.remaining : '',
                  });
                }}
              >
                <option value="">بدون فاتورة محددة</option>
                {customerSummary.openInvoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.number} — متبقي {formatMoney(i.remaining)}
                  </option>
                ))}
              </Select>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>حساب الخزنة / البنك</Label>
              <Select value={receiptForm.cashAccountId} onChange={(e) => setReceiptForm({ ...receiptForm, cashAccountId: e.target.value })}>
                <option value="">اختر</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({formatMoney(a.balance)})</option>)}
              </Select>
            </div>
            <div>
              <Label>طريقة الدفع</Label>
              <Select value={receiptForm.paymentMethod} onChange={(e) => setReceiptForm({ ...receiptForm, paymentMethod: e.target.value })}>
                {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </Select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>المبلغ المحصّل</Label>
              <NumberInput value={receiptForm.amount} onValueChange={(v) => setReceiptForm({ ...receiptForm, amount: v })} />
            </div>
            <div><Label>رقم مرجعي (شيك/تحويل)</Label><Input value={receiptForm.referenceNo} onChange={(e) => setReceiptForm({ ...receiptForm, referenceNo: e.target.value })} /></div>
          </div>
          <div><Label>ملاحظة</Label><Input value={receiptForm.note} onChange={(e) => setReceiptForm({ ...receiptForm, note: e.target.value })} /></div>
          <Button className="w-full" onClick={saveReceipt}>تأكيد التحصيل</Button>
        </div>
      </Modal>

      <Modal open={paymentOpen} onClose={() => setPaymentOpen(false)} title="سداد لمورد" wide>
        <div className="space-y-3">
          <div>
            <Label>المورد</Label>
            <Select
              value={paymentForm.supplierId}
              onChange={(e) => setPaymentForm({ ...paymentForm, supplierId: e.target.value, purchaseInvoiceId: '', amount: '' })}
            >
              <option value="">اختر</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>

          {supplierSummary && (
            <div className={`rounded-xl border px-4 py-3 text-sm ${dueBox(supplierSummary.openInvoices)}`}>
              <div className="font-bold">
                المستحق للمورد: {supplierSummary.openInvoices.length > 0
                  ? <DueAmount date={oldestOpen(supplierSummary.openInvoices)} remaining={supplierSummary.balance} />
                  : formatMoney(supplierSummary.balance)}
              </div>
              {supplierSummary.openInvoices.filter((row) => row.remaining > 0.009).length > 0 && (
                <div className="mt-2 space-y-1">
                  {supplierSummary.openInvoices.filter((row) => row.remaining > 0.009).map((row) => (
                    <div key={row.id} className="flex items-center justify-between gap-2 text-xs">
                      <span>{row.number}</span>
                      <DueAmount date={row.invoiceDate} remaining={row.remaining} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {supplierSummary && supplierSummary.openInvoices.length > 0 && (
            <div>
              <Label>ربط بفاتورة (اختياري)</Label>
              <Select
                value={paymentForm.purchaseInvoiceId}
                onChange={(e) => {
                  const inv = supplierSummary.openInvoices.find((i) => i.id === e.target.value);
                  setPaymentForm({
                    ...paymentForm,
                    purchaseInvoiceId: e.target.value,
                    amount: inv ? inv.remaining : '',
                  });
                }}
              >
                <option value="">بدون فاتورة محددة</option>
                {supplierSummary.openInvoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.number} — متبقي {formatMoney(i.remaining)}
                  </option>
                ))}
              </Select>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>حساب الخزنة / البنك</Label>
              <Select value={paymentForm.cashAccountId} onChange={(e) => setPaymentForm({ ...paymentForm, cashAccountId: e.target.value })}>
                <option value="">اختر</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({formatMoney(a.balance)})</option>)}
              </Select>
            </div>
            <div>
              <Label>طريقة الدفع</Label>
              <Select value={paymentForm.paymentMethod} onChange={(e) => setPaymentForm({ ...paymentForm, paymentMethod: e.target.value })}>
                {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </Select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>المبلغ المسدَّد</Label>
              <NumberInput value={paymentForm.amount} onValueChange={(v) => setPaymentForm({ ...paymentForm, amount: v })} />
            </div>
            <div><Label>رقم مرجعي (شيك/تحويل)</Label><Input value={paymentForm.referenceNo} onChange={(e) => setPaymentForm({ ...paymentForm, referenceNo: e.target.value })} /></div>
          </div>
          <div><Label>ملاحظة</Label><Input value={paymentForm.note} onChange={(e) => setPaymentForm({ ...paymentForm, note: e.target.value })} /></div>
          <Button className="w-full" onClick={savePayment}>تأكيد السداد</Button>
        </div>
      </Modal>

      <Modal open={txOpen} onClose={() => setTxOpen(false)} title="حركة خزنة يدوية">
        <div className="space-y-3">
          <div>
            <Label>الحساب</Label>
            <Select value={txForm.accountId} onChange={(e) => setTxForm({ ...txForm, accountId: e.target.value })}>
              <option value="">اختر</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>النوع</Label>
              <Select value={txForm.direction} onChange={(e) => setTxForm({ ...txForm, direction: e.target.value })}>
                <option value="IN">وارد</option>
                <option value="OUT">صادر</option>
              </Select>
            </div>
            <div>
              <Label>طريقة الدفع</Label>
              <Select value={txForm.paymentMethod} onChange={(e) => setTxForm({ ...txForm, paymentMethod: e.target.value })}>
                {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </Select>
            </div>
          </div>
          <div>
            <Label>المبلغ</Label>
            <NumberInput value={txForm.amount} onValueChange={(v) => setTxForm({ ...txForm, amount: v })} />
          </div>
          <div><Label>وصف الحركة</Label><Input value={txForm.description} onChange={(e) => setTxForm({ ...txForm, description: e.target.value })} /></div>
          <Button className="w-full" onClick={saveTx}>حفظ</Button>
        </div>
      </Modal>

      <Modal open={accOpen} onClose={() => setAccOpen(false)} title="حساب جديد">
        <div className="space-y-3">
          <div>
            <Label>نوع الحساب</Label>
            <Select value={accForm.accountType} onChange={(e) => setAccForm({ ...accForm, accountType: e.target.value })}>
              <option value="CASH">خزنة نقدية</option>
              <option value="BANK">حساب بنكي</option>
            </Select>
          </div>
          <div><Label>كود الحساب</Label><Input value={accForm.code} onChange={(e) => setAccForm({ ...accForm, code: e.target.value })} /></div>
          <div><Label>اسم الحساب</Label><Input value={accForm.name} onChange={(e) => setAccForm({ ...accForm, name: e.target.value })} /></div>
          <div>
            <Label>رصيد افتتاحي</Label>
            <NumberInput value={accForm.balance} onValueChange={(v) => setAccForm({ ...accForm, balance: v })} />
          </div>
          <Button className="w-full" onClick={saveAccount}>حفظ</Button>
        </div>
      </Modal>
    </div>
  );
}
