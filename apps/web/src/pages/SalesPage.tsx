import { useEffect, useMemo, useState } from 'react';
import { Printer, Eye, ShoppingCart, Receipt, Trash2, Pencil } from 'lucide-react';
import ExcelJS from 'exceljs';
import { api, formatDate, formatMoney, initialQuery, productImageUrl } from '../lib/api';
import { dueTone } from '../lib/due';
import { DueAmount } from '../components/DueAmount';
import { AddLineButton, EditorErrors, EditorSection, InvoiceEditor, LineCard, SummaryRow } from '../components/InvoiceEditor';
import { useConfirm, usePrompt, useToast } from '../lib/feedback';
import { usePagedList } from '../lib/paging';
import { useColumns } from '../lib/columns';
import { IconAction, ListBar } from '../components/ListBar';
import {
  Button, Card, Empty, Input, Label, Modal, NumberInput, PageHeader, Pager, PrintHeader, Select, StatusBadge, Table, Td, Th, todayIso,
} from '../components/ui';

type Party = { id: string; name: string; priceList?: string };
type Product = { id: string; name: string; sku: string; salePrice: number; wholesalePrice?: number; barcode?: string | null; imageFile?: string | null };
type Account = { id: string; name: string };
type Line = { productId: string; quantity: number | ''; unitPrice: number | ''; discount: number | '' };

type Invoice = {
  id: string;
  number: string;
  status: string;
  invoiceDate: string;
  total: number;
  paidAmount: number;
  discount: number;
  tax: number;
  subtotal: number;
  notes?: string | null;
  taxRate?: number;
  customer: { id: string; name: string };
  warehouse: { id: string; name: string };
  lines: { productId: string; quantity: number; unitPrice: number; discount?: number; total: number; product: { name: string; sku: string } }[];
  receipts?: { id: string; number: string; amount: number; paymentMethod: string; receivedAt: string; note?: string | null }[];
};

const METHODS: Record<string, string> = {
  CASH: 'نقدي',
  BANK_TRANSFER: 'تحويل بنكي',
  CHECK: 'شيك',
  CARD: 'بطاقة',
  INSTAPAY: 'إنستاباي',
  OTHER: 'أخرى',
};

const emptyLine = (): Line => ({ productId: '', quantity: '', unitPrice: '', discount: '' });
const num = (v: number | '') => (v === '' ? 0 : v);
const SALE_VIEW = 'm5azen.salesView';
type SaleFilter = 'all' | 'DRAFT' | 'CONFIRMED' | 'PARTIAL' | 'PAID' | 'CANCELLED' | 'due';
const SALE_FILTERS: { id: SaleFilter; label: string }[] = [
  { id: 'all', label: 'كل الفواتير' },
  { id: 'due', label: 'عليها متبقي' },
  { id: 'PAID', label: 'مدفوعة' },
  { id: 'PARTIAL', label: 'تحصيل جزئي' },
  { id: 'CONFIRMED', label: 'مؤكدة' },
  { id: 'DRAFT', label: 'مسودة' },
  { id: 'CANCELLED', label: 'ملغاة' },
];

function owed(inv: { status: string; total: number; paidAmount: number }) {
  if (inv.status === 'CANCELLED') return 0;
  return Math.max(0, inv.total - inv.paidAmount);
}

export function SalesPage() {
  const confirm = useConfirm();
  const promptText = usePrompt();
  const toast = useToast();
  const [items, setItems] = useState<Invoice[]>([]);
  const [customers, setCustomers] = useState<Party[]>([]);
  const [warehouses, setWarehouses] = useState<Party[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Invoice | null>(null);
  const [search, setSearch] = useState(initialQuery);
  const [status, setStatus] = useState<SaleFilter>('all');
  const [listView, setListView] = useState<'table' | 'cards'>(() => (localStorage.getItem(SALE_VIEW) === 'cards' ? 'cards' : 'table'));
  const [form, setForm] = useState({
    customerId: '',
    warehouseId: '',
    discount: '' as number | '',
    tax: '' as number | '',
    paidAmount: '' as number | '',
    cashAccountId: '',
    paymentMethod: 'CASH',
    notes: '',
    confirm: true,
  });
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [posOpen, setPosOpen] = useState(false);
  const [posSearch, setPosSearch] = useState('');
  const [posCart, setPosCart] = useState<Line[]>([]);
  const [posForm, setPosForm] = useState({
    customerId: '',
    warehouseId: '',
    paidAmount: '' as number | '',
    cashAccountId: '',
    paymentMethod: 'CASH',
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [triedSave, setTriedSave] = useState(false);
  const [shift, setShift] = useState<{ id: string; openingCash: number; account: { name: string } } | null>(null);
  const [useShift, setUseShift] = useState(false);
  const [customerPrices, setCustomerPrices] = useState<Record<string, number>>({});

  async function load() {
    const [inv, c, w, p, a] = await Promise.all([
      api<Invoice[]>('/sales'),
      api<Party[]>('/customers'),
      api<Party[]>('/warehouses'),
      api<Product[]>('/products'),
      api<Account[]>('/cash/accounts'),
    ]);
    setItems(inv);
    setCustomers(c);
    setWarehouses(w);
    setProducts(p);
    setAccounts(a);
    api<{ id: string; openingCash: number; account: { name: string } } | null>('/finance/shifts/current')
      .then((row) => setShift(row))
      .catch(() => setShift(null));
  }

  useEffect(() => {
    if (!form.customerId) {
      setCustomerPrices({});
      return;
    }
    api<{ productId: string; price: number }[]>(`/customers/${form.customerId}/prices`)
      .then((rows) => {
        const map: Record<string, number> = {};
        rows.forEach((row) => { map[row.productId] = row.price; });
        setCustomerPrices(map);
      })
      .catch(() => setCustomerPrices({}));
  }, [form.customerId]);

  function priceFor(product: Product, customerId = form.customerId) {
    if (customerPrices[product.id]) return customerPrices[product.id];
    const customer = customers.find((c) => c.id === customerId);
    if (customer?.priceList === 'WHOLESALE' && (product.wholesalePrice || 0) > 0) return product.wholesalePrice || 0;
    return product.salePrice;
  }

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((inv) => {
      if (status === 'due' && owed(inv) <= 0.009) return false;
      if (status !== 'all' && status !== 'due' && inv.status !== status) return false;
      if (!q) return true;
      return [inv.number, inv.customer.name, inv.warehouse.name, inv.status].some((x) => x.toLowerCase().includes(q));
    });
  }, [items, search, status]);

  const pager = usePagedList(filtered, `${search}:${status}`);
  const dueCounts = useMemo(() => {
    const counts = { red: 0, yellow: 0, green: 0 };
    for (const inv of items) {
      if (inv.status === 'CANCELLED') continue;
      const tone = dueTone(inv.invoiceDate, inv.total - inv.paidAmount);
      if (tone === 'red' || tone === 'yellow' || tone === 'green') counts[tone] += 1;
    }
    return counts;
  }, [items]);
  const formDueDate = (editingId ? items.find((row) => row.id === editingId)?.invoiceDate : '') || todayIso();
  const stats = useMemo(() => {
    const live = items.filter((inv) => inv.status !== 'CANCELLED');
    return {
      count: items.length,
      total: live.reduce((sum, inv) => sum + inv.total, 0),
      paid: live.reduce((sum, inv) => sum + inv.paidAmount, 0),
      due: live.reduce((sum, inv) => sum + owed(inv), 0),
    };
  }, [items]);
  const saleColumns = useColumns('m5azen.cols.sales', [
    { id: 'number', label: 'الرقم' },
    { id: 'customer', label: 'العميل' },
    { id: 'warehouse', label: 'المخزن' },
    { id: 'date', label: 'التاريخ' },
    { id: 'total', label: 'الإجمالي' },
    { id: 'paid', label: 'المدفوع' },
    { id: 'due', label: 'المتبقي' },
    { id: 'status', label: 'الحالة' },
  ]);

  useEffect(() => {
    const open = new URLSearchParams(window.location.search).get('open');
    if (!open || !items.length) return;
    const invoice = items.find((row) => row.id === open || row.number === open);
    if (invoice) setView(invoice);
  }, [items]);

  function updateLine(i: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, idx) => {
      if (idx !== i) return l;
      const next = { ...l, ...patch };
      if (patch.productId) {
        const prod = products.find((p) => p.id === patch.productId);
        if (prod) next.unitPrice = priceFor(prod);
      }
      return next;
    }));
  }

  const linesTotal = lines.reduce((s, l) => s + num(l.quantity) * num(l.unitPrice) - num(l.discount), 0);
  const taxAmount = Math.round((linesTotal - num(form.discount)) * num(form.tax) * 100) / 10000;
  const grand = linesTotal - num(form.discount) + taxAmount;
  const remaining = Math.max(0, grand - num(form.paidAmount));
  const filledLines = lines.filter((l) => l.productId);
  const badLine = (l: Line) => !!l.productId && !(num(l.quantity) > 0);
  const formErrors = [
    !form.customerId && 'اختر العميل',
    !form.warehouseId && 'اختر المخزن',
    !filledLines.length && 'أضف صنفًا واحدًا على الأقل',
    lines.some(badLine) && 'كل بند لازم يكون له كمية أكبر من صفر',
    num(form.paidAmount) > grand + 0.009 && 'المدفوع أكبر من إجمالي الفاتورة',
    form.confirm && num(form.paidAmount) > 0 && !form.cashAccountId && 'اختر حساب الخزنة للمبلغ المدفوع',
  ].filter(Boolean) as string[];

  const posLinesTotal = posCart.reduce((s, l) => s + num(l.quantity) * num(l.unitPrice), 0);
  const posPaid = posForm.paidAmount === '' ? posLinesTotal : num(posForm.paidAmount);
  const posRemaining = Math.max(0, posLinesTotal - posPaid);
  const posProducts = products.filter((p) => {
    const q = posSearch.trim().toLowerCase();
    if (!q) return true;
    return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q);
  });

  function playAddSound() {
    const audio = new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(740, audio.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1180, audio.currentTime + 0.07);
    gain.gain.setValueAtTime(0.05, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.16);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.17);
    osc.onended = () => audio.close();
  }

  function addPosProduct(p: Product) {
    playAddSound();
    setPosCart((prev) => {
      const idx = prev.findIndex((l) => l.productId === p.id);
      if (idx >= 0) {
        return prev.map((l, i) => i === idx ? { ...l, quantity: num(l.quantity) + 1 } : l);
      }
      return [...prev, { productId: p.id, quantity: 1, unitPrice: priceFor(p, posForm.customerId), discount: '' }];
    });
  }

  function openPos() {
    setPosCart([]);
    setPosSearch('');
    setPosForm({
      customerId: customers[0]?.id || '',
      warehouseId: warehouses[0]?.id || '',
      paidAmount: '',
      cashAccountId: accounts[0]?.id || '',
      paymentMethod: 'CASH',
    });
    setPosOpen(true);
  }

  async function save() {
    setTriedSave(true);
    if (formErrors.length) return;
    const payload = {
      customerId: form.customerId,
      warehouseId: form.warehouseId,
      discount: num(form.discount),
      taxRate: num(form.tax),
      paidAmount: num(form.paidAmount),
      cashAccountId: form.cashAccountId || undefined,
      paymentMethod: form.paymentMethod,
      notes: form.notes || undefined,
      confirm: form.confirm,
      shiftId: useShift && shift ? shift.id : undefined,
      lines: lines.filter((l) => l.productId).map((l) => ({
        productId: l.productId,
        quantity: num(l.quantity),
        unitPrice: num(l.unitPrice),
        discount: num(l.discount),
      })),
    };
    setSaving(true);
    try {
      await api(editingId ? `/sales/${editingId}` : '/sales', {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      });
      toast.success(editingId ? 'تم تعديل الفاتورة' : 'تم حفظ الفاتورة');
      setEditingId(null);
      setOpen(false);
      setTriedSave(false);
      setForm({
        customerId: '', warehouseId: '', discount: '', tax: '', paidAmount: '',
        cashAccountId: '', paymentMethod: 'CASH', notes: '', confirm: true,
      });
      setLines([emptyLine()]);
      load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'تعذر حفظ الفاتورة');
    } finally {
      setSaving(false);
    }
  }

  function printInvoice(inv: Invoice) {
    setView(inv);
    setTimeout(() => window.print(), 300);
  }

  async function removeInvoice(id: string) {
    const ok = await confirm({
      title: 'حذف فاتورة البيع',
      message: 'حذف الفاتورة وإلغاء أثرها على المخزون والحسابات؟',
      confirmLabel: 'حذف',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/sales/${id}`, { method: 'DELETE' });
      if (view?.id === id) setView(null);
      toast.success('تم حذف الفاتورة');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر حذف الفاتورة');
    }
  }

  async function editInvoice(inv: Invoice) {
    setEditingId(inv.id);
    setTriedSave(false);
    setForm({
      customerId: inv.customer.id,
      warehouseId: inv.warehouse.id,
      discount: inv.discount,
      tax: inv.taxRate || 0,
      paidAmount: inv.paidAmount,
      cashAccountId: accounts[0]?.id || '',
      paymentMethod: 'CASH',
      notes: inv.notes || '',
      confirm: true,
    });
    setLines(inv.lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount: l.discount || '',
    })));
    setView(null);
    setOpen(true);
  }

  async function openShift() {
    const accountId = accounts[0]?.id;
    if (!accountId) {
      toast.error('أضف حساب خزنة أولاً');
      return;
    }
    const raw = await promptText({ title: 'رصيد بداية الوردية', defaultValue: '0', confirmLabel: 'فتح' });
    if (raw == null) return;
    const opening = Number(raw || '0');
    const row = await api<{ id: string; openingCash: number; account: { name: string } }>('/finance/shifts', {
      method: 'POST',
      body: JSON.stringify({ cashAccountId: accountId, openingCash: opening }),
    });
    setShift(row);
    setUseShift(false);
    toast.success('تم فتح الوردية');
  }

  async function closeShift() {
    if (!shift) return;
    const raw = await promptText({ title: 'النقدية المعدودة في الدرج', defaultValue: String(shift.openingCash), confirmLabel: 'قفل' });
    if (raw == null) return;
    const closing = Number(raw || '0');
    const closed = await api<{ difference: number }>(`/finance/shifts/${shift.id}/close`, {
      method: 'POST',
      body: JSON.stringify({ closingCash: closing }),
    });
    toast.success(`اتقفلت الوردية. الفرق: ${formatMoney(closed.difference)}`);
    setShift(null);
    setUseShift(false);
  }

  async function scanPosBarcode() {
    const code = posSearch.trim();
    if (!code) return;
    try {
      const product = await api<Product>(`/products/barcode/${encodeURIComponent(code)}`);
      addPosProduct(product);
      setPosSearch('');
    } catch {
      /* البحث بالاسم يفضل ظاهر */
    }
  }

  async function savePos() {
    const pay = posForm.paidAmount === '' ? posLinesTotal : num(posForm.paidAmount);
    await api('/sales', {
      method: 'POST',
      body: JSON.stringify({
        customerId: posForm.customerId,
        warehouseId: posForm.warehouseId,
        discount: 0,
        taxRate: 0,
        paidAmount: pay,
        cashAccountId: pay > 0 ? posForm.cashAccountId : undefined,
        paymentMethod: posForm.paymentMethod,
        shiftId: useShift && shift ? shift.id : undefined,
        confirm: true,
        lines: posCart.filter((l) => l.productId && num(l.quantity) > 0).map((l) => ({
          productId: l.productId,
          quantity: num(l.quantity),
          unitPrice: num(l.unitPrice),
          discount: 0,
        })),
      }),
    });
    setPosOpen(false);
    load();
  }

  function openInvoiceForm() {
    setEditingId(null);
    setTriedSave(false);
    setForm({
      customerId: '', warehouseId: warehouses.length === 1 ? warehouses[0].id : '', discount: '', tax: '', paidAmount: '',
      cashAccountId: accounts[0]?.id || '', paymentMethod: 'CASH', notes: '', confirm: true,
    });
    setLines([emptyLine()]);
    setOpen(true);
  }

  async function exportRows() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('المبيعات');
    sheet.addRow(['الرقم', 'العميل', 'المخزن', 'التاريخ', 'الإجمالي', 'المدفوع', 'المتبقي', 'الحالة']);
    filtered.forEach((inv) => sheet.addRow([inv.number, inv.customer.name, inv.warehouse.name, formatDate(inv.invoiceDate), inv.total, inv.paidAmount, owed(inv), inv.status]));
    const buffer = await workbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer]));
    link.download = 'sales.xlsx';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <div>
      <PageHeader title="المبيعات" subtitle="نقطة البيع وفواتير العملاء والتحصيل" />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {([
          { key: 'all' as const, label: 'فواتير البيع', value: String(stats.count), hint: 'كل الحالات', stripe: 'bg-brand-700' },
          { key: 'all' as const, label: 'إجمالي المبيعات', value: formatMoney(stats.total), hint: 'بدون الملغى', stripe: 'bg-brand-500' },
          { key: 'PAID' as const, label: 'المحصّل', value: formatMoney(stats.paid), hint: 'مدفوع على الفواتير', stripe: 'bg-emerald-600' },
          { key: 'due' as const, label: 'المتبقي على العملاء', value: formatMoney(stats.due), hint: 'ذمم لم تُحصَّل', stripe: stats.due > 0 ? 'bg-rose-600' : 'bg-emerald-600' },
        ]).map((card) => (
          <button key={card.label} type="button" onClick={() => setStatus(card.key)} className={`overflow-hidden rounded-2xl border bg-white text-right shadow-sm ${status === card.key && card.key !== 'all' ? 'border-brand-700 ring-2 ring-brand-700/30' : 'border-slate-200'}`}>
            <div className={`h-1 ${card.stripe}`} />
            <div className="px-4 py-3">
              <div className="text-xs font-bold text-muted">{card.label}</div>
              <div className="mt-1 text-xl font-extrabold text-slate-900">{card.value}</div>
              <div className="mt-1 text-[11px] text-muted">{card.hint}</div>
            </div>
          </button>
        ))}
      </div>

      <div className="mb-4 grid gap-3 lg:grid-cols-[1.2fr_1fr_1.1fr]">
        <button type="button" onClick={openPos} className="rounded-2xl bg-gradient-to-br from-brand-700 to-brand-950 p-5 text-right text-white shadow-sm">
          <span className="mb-3 grid h-11 w-11 place-items-center rounded-2xl bg-white/10"><ShoppingCart size={20} /></span>
          <div className="text-lg font-extrabold">نقطة البيع</div>
          <div className="mt-1 text-sm text-brand-100">بيع سريع بالصورة والصوت، ثم التحصيل</div>
        </button>
        <button type="button" onClick={openInvoiceForm} className="rounded-2xl border border-slate-200 bg-white p-5 text-right shadow-sm hover:border-brand-300">
          <span className="mb-3 grid h-11 w-11 place-items-center rounded-2xl bg-brand-50 text-brand-700"><Receipt size={20} /></span>
          <div className="text-lg font-extrabold text-slate-900">فاتورة مبيعات</div>
          <div className="mt-1 text-sm text-muted">خصم، ضريبة، وتحصيل جزئي</div>
        </button>
        <div className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          {shift ? (
            <>
              <div>
                <div className="text-xs font-bold text-brand-700">وردية مفتوحة</div>
                <div className="mt-1 font-extrabold">{shift.account?.name}</div>
                <div className="mt-1 text-sm text-muted">رصيد البداية {formatMoney(shift.openingCash)}</div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={useShift} onChange={(e) => setUseShift(e.target.checked)} />
                  احسب البيع على الوردية
                </label>
                <Button variant="secondary" onClick={closeShift}>قفل الوردية</Button>
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="text-xs font-bold text-muted">الوردية</div>
                <div className="mt-1 font-extrabold">البيع متاح من غيرها</div>
                <div className="mt-1 text-sm text-muted">افتح وردية لو عايز تقفل الصندوق في آخر اليوم</div>
              </div>
              <Button className="mt-3" variant="secondary" onClick={openShift}>فتح وردية</Button>
            </>
          )}
        </div>
      </div>

      <Card>
        {(dueCounts.red + dueCounts.yellow + dueCounts.green) > 0 && (
          <div className="mb-3 flex flex-wrap gap-2 text-xs font-bold">
            {dueCounts.red > 0 && <span className="rounded-full bg-rose-100 px-3 py-1 text-rose-700">متأخر: {dueCounts.red}</span>}
            {dueCounts.yellow > 0 && <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-800">أقل من 5 أيام: {dueCounts.yellow}</span>}
            {dueCounts.green > 0 && <span className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-800">باقي 5 أيام: {dueCounts.green}</span>}
          </div>
        )}
        <ListBar
          search={search}
          onSearch={setSearch}
          placeholder="بحث برقم الفاتورة أو العميل"
          view={listView}
          onView={(mode) => { setListView(mode); localStorage.setItem(SALE_VIEW, mode); }}
          onExport={exportRows}
          columns={saleColumns.columns}
          onToggleColumn={saleColumns.toggle}
          filterActive={status !== 'all'}
          filter={(
            <div className="space-y-1">
              <div className="mb-2 text-xs font-bold text-muted">حالة الفاتورة</div>
              {SALE_FILTERS.map((item) => (
                <button key={item.id} type="button" className={`block w-full rounded-lg px-2 py-1.5 text-right text-sm ${status === item.id ? 'bg-brand-700 font-bold text-white' : 'hover:bg-slate-50'}`} onClick={() => setStatus(item.id)}>{item.label}</button>
              ))}
            </div>
          )}
        />
        {filtered.length === 0 ? <Empty text="لا توجد فواتير مطابقة" hint="غيّر البحث أو حالة الفاتورة" /> : listView === 'cards' ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {pager.slice.map((inv) => (
                <div key={inv.id} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-brand-700">{inv.number}</div>
                      <div className="mt-1 truncate text-base font-extrabold">{inv.customer.name}</div>
                      <div className="mt-1 text-xs text-muted">{inv.warehouse.name} · {formatDate(inv.invoiceDate)}</div>
                    </div>
                    <StatusBadge status={inv.status} />
                  </div>
                  <div className="mt-4 flex items-end justify-between gap-3">
                    <div>
                      <div className="text-xs text-muted">الإجمالي</div>
                      <div className="font-extrabold">{formatMoney(inv.total)}</div>
                      <div className="mt-1"><DueAmount date={inv.invoiceDate} remaining={owed(inv)} /></div>
                    </div>
                    <div className="flex gap-1">
                      <IconAction label="عرض" onClick={() => setView(inv)}><Eye size={14} /></IconAction>
                      <IconAction label="تعديل" onClick={() => editInvoice(inv)}><Pencil size={14} /></IconAction>
                      <IconAction label="طباعة" onClick={() => printInvoice(inv)}><Printer size={14} /></IconAction>
                      <IconAction label="حذف" danger onClick={() => removeInvoice(inv.id)}><Trash2 size={14} /></IconAction>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <Pager page={pager.page} pages={pager.pages} total={pager.total} from={pager.from} to={pager.to} pageSize={pager.pageSize} onPageSize={pager.setPageSize} onPage={pager.setPage} />
          </>
        ) : (
          <>
          <Table>
            <thead>
              <tr>
                {saleColumns.visible('status') && <Th>الحالة</Th>}
                {saleColumns.visible('due') && <Th>المتبقي</Th>}
                {saleColumns.visible('paid') && <Th>المدفوع</Th>}
                {saleColumns.visible('total') && <Th>الإجمالي</Th>}
                {saleColumns.visible('date') && <Th>التاريخ</Th>}
                {saleColumns.visible('warehouse') && <Th>المخزن</Th>}
                {saleColumns.visible('customer') && <Th>العميل</Th>}
                {saleColumns.visible('number') && <Th>الرقم</Th>}
                <Th>الإجراءات</Th>
              </tr>
            </thead>
            <tbody>
              {pager.slice.map((inv) => (
                <tr key={inv.id} className={`status-${inv.status}`}>
                  {saleColumns.visible('status') && <Td><StatusBadge status={inv.status} /></Td>}
                  {saleColumns.visible('due') && <Td><DueAmount date={inv.invoiceDate} remaining={owed(inv)} /></Td>}
                  {saleColumns.visible('paid') && <Td>{formatMoney(inv.paidAmount)}</Td>}
                  {saleColumns.visible('total') && <Td className="font-semibold">{formatMoney(inv.total)}</Td>}
                  {saleColumns.visible('date') && <Td>{formatDate(inv.invoiceDate)}</Td>}
                  {saleColumns.visible('warehouse') && <Td>{inv.warehouse.name}</Td>}
                  {saleColumns.visible('customer') && <Td className="font-semibold">{inv.customer.name}</Td>}
                  {saleColumns.visible('number') && <Td className="font-mono text-xs font-bold text-brand-800">{inv.number}</Td>}
                  <Td>
                    <div className="flex gap-1">
                      <IconAction label="عرض" onClick={() => setView(inv)}><Eye size={14} /></IconAction>
                      <IconAction label="تعديل" onClick={() => editInvoice(inv)}><Pencil size={14} /></IconAction>
                      <IconAction label="طباعة" onClick={() => printInvoice(inv)}><Printer size={14} /></IconAction>
                      <IconAction label="حذف" danger onClick={() => removeInvoice(inv.id)}><Trash2 size={14} /></IconAction>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pager page={pager.page} pages={pager.pages} total={pager.total} from={pager.from} to={pager.to} pageSize={pager.pageSize} onPageSize={pager.setPageSize} onPage={pager.setPage} />
          </>
        )}
      </Card>

      <InvoiceEditor
        open={open}
        title={editingId ? 'تعديل فاتورة بيع' : 'فاتورة بيع جديدة'}
        subtitle="اختار العميل والمخزن، ضيف الأصناف، وسجّل المدفوع"
        icon={<Receipt size={18} />}
        total={grand}
        onClose={() => { setOpen(false); setEditingId(null); }}
        side={(
          <>
            <div className="text-sm font-extrabold text-slate-800">الحساب والدفع</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>خصم الفاتورة</Label>
                <NumberInput value={form.discount} onValueChange={(v) => setForm({ ...form, discount: v })} />
              </div>
              <div>
                <Label>الضريبة %</Label>
                <NumberInput value={form.tax} onValueChange={(v) => setForm({ ...form, tax: v })} />
              </div>
            </div>
            <div>
              <Label>المدفوع الآن</Label>
              <div className="flex gap-2">
                <NumberInput value={form.paidAmount} onValueChange={(v) => setForm({ ...form, paidAmount: v })} />
                <button type="button" className="shrink-0 rounded-xl border border-brand-200 bg-brand-50 px-3 text-xs font-bold text-brand-700 hover:bg-brand-100" onClick={() => setForm({ ...form, paidAmount: Math.round(grand * 100) / 100 })}>كامل</button>
              </div>
            </div>
            {num(form.paidAmount) > 0 && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>الخزنة / البنك</Label>
                  <Select value={form.cashAccountId} onChange={(e) => setForm({ ...form, cashAccountId: e.target.value })}>
                    <option value="">اختر الحساب</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>
                </div>
                <div>
                  <Label>طريقة الدفع</Label>
                  <Select value={form.paymentMethod} onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}>
                    {Object.entries(METHODS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </Select>
                </div>
              </div>
            )}
            <div>
              <Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="تظهر على الفاتورة" />
            </div>
            <div className="mt-auto space-y-2 rounded-2xl bg-brand-900 px-4 py-4 text-sm">
              <SummaryRow label={`البنود (${filledLines.length})`} value={formatMoney(linesTotal)} />
              <SummaryRow label="خصم الفاتورة" value={formatMoney(num(form.discount))} />
              <SummaryRow label={`الضريبة (${num(form.tax)}%)`} value={formatMoney(taxAmount)} />
              <SummaryRow label="الإجمالي" value={formatMoney(grand)} strong />
              <SummaryRow label="المدفوع" value={formatMoney(num(form.paidAmount))} />
              <div className="flex items-center justify-between rounded-xl bg-white px-3 py-2 font-bold text-slate-900">
                <span>المتبقي</span>
                <DueAmount date={formDueDate} remaining={remaining} />
              </div>
            </div>
            <label className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm">
              <input type="checkbox" checked={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.checked })} />
              تأكيد فوري (خصم المخزون وتحديث رصيد العميل)
            </label>
            {triedSave && <EditorErrors errors={formErrors} />}
            <Button className="w-full !py-3 text-base" onClick={save} disabled={saving}>
              {saving ? 'جاري الحفظ...' : editingId ? 'حفظ التعديل' : 'حفظ الفاتورة'}
            </Button>
          </>
        )}
      >
        <EditorSection title="بيانات الفاتورة">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>العميل</Label>
              <Select className={triedSave && !form.customerId ? 'border-rose-300' : ''} value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
                <option value="">اختر العميل</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
              {form.customerId && customers.find((c) => c.id === form.customerId)?.priceList === 'WHOLESALE' && <p className="mt-1 text-xs font-semibold text-brand-700">عميل جملة: الأسعار من قائمة الجملة</p>}
            </div>
            <div>
              <Label>المخزن</Label>
              <Select className={triedSave && !form.warehouseId ? 'border-rose-300' : ''} value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}>
                <option value="">اختر المخزن</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </div>
          </div>
        </EditorSection>

        <EditorSection title={`بنود الفاتورة (${filledLines.length})`} action={<AddLineButton onClick={() => setLines((prev) => [...prev, emptyLine()])} />}>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <LineCard
                key={i}
                index={i}
                total={Math.max(0, num(l.quantity) * num(l.unitPrice) - num(l.discount))}
                invalid={triedSave && badLine(l)}
                canRemove={lines.length > 1}
                onRemove={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
              >
                <div className="grid gap-2 sm:grid-cols-12">
                  <div className="sm:col-span-6">
                    <Label>الصنف</Label>
                    <Select value={l.productId} onChange={(e) => updateLine(i, { productId: e.target.value })}>
                      <option value="">اختر الصنف</option>
                      {products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
                    </Select>
                  </div>
                  <div className="sm:col-span-2">
                    <Label>الكمية</Label>
                    <NumberInput value={l.quantity} onValueChange={(v) => updateLine(i, { quantity: v })} />
                  </div>
                  <div className="sm:col-span-2">
                    <Label>سعر الوحدة</Label>
                    <NumberInput value={l.unitPrice} onValueChange={(v) => updateLine(i, { unitPrice: v })} />
                  </div>
                  <div className="sm:col-span-2">
                    <Label>خصم البند</Label>
                    <NumberInput value={l.discount} onValueChange={(v) => updateLine(i, { discount: v })} />
                  </div>
                </div>
              </LineCard>
            ))}
          </div>
        </EditorSection>
      </InvoiceEditor>

      {posOpen && (
        <div className="fixed inset-0 z-[80] flex flex-col bg-slate-100">
          <div className="flex items-center justify-between gap-3 bg-brand-950 px-5 py-3 text-white">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-2xl bg-white/10"><ShoppingCart size={18} /></span>
              <div>
                <div className="text-lg font-extrabold">نقطة البيع</div>
                <div className="text-xs text-brand-100">اضغط الصنف لإضافته</div>
              </div>
            </div>
            <div className="text-left">
              <div className="text-[11px] text-brand-200">الإجمالي</div>
              <div className="text-xl font-extrabold">{formatMoney(posLinesTotal)}</div>
            </div>
            <button type="button" className="rounded-xl bg-white/10 px-4 py-2 text-sm font-bold" onClick={() => setPosOpen(false)}>إغلاق</button>
          </div>
        <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[1fr_22rem]">
          <div className="flex min-h-0 flex-col">
            <Input
              value={posSearch}
              onChange={(e) => setPosSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); scanPosBarcode(); } }}
              placeholder="اسم أو كود أو باركود ثم Enter"
            />
            <div className="mt-3 grid flex-1 auto-rows-max grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 xl:grid-cols-4">
              {posProducts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => addPosProduct(p)}
                  className="overflow-hidden rounded-2xl border border-slate-200 bg-white text-right shadow-sm transition hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-md"
                >
                  <div className="grid h-28 place-items-center bg-slate-50">
                    {p.imageFile ? <img src={productImageUrl(p.id, p.imageFile)} alt="" className="h-full w-full object-cover" /> : <ShoppingCart className="text-slate-300" size={28} />}
                  </div>
                  <div className="px-3 py-2">
                    <div className="truncate text-sm font-bold">{p.name}</div>
                    <div className="text-xs text-muted">{p.sku}</div>
                    <div className="mt-1 text-sm font-semibold text-brand-800">{formatMoney(p.salePrice)}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-2xl bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">السلة</div>
            {posCart.length === 0 ? <Empty text="اضغط على صنف لإضافته" /> : (
              <div className="space-y-2">
                {posCart.map((l, i) => {
                  const prod = products.find((p) => p.id === l.productId);
                  return (
                    <div key={l.productId} className="grid grid-cols-12 items-end gap-2 rounded-xl bg-slate-50 p-2">
                      <div className="col-span-5 flex items-center gap-2 text-sm font-semibold">
                        {prod?.imageFile && <img src={productImageUrl(prod.id, prod.imageFile)} alt="" className="h-10 w-10 rounded-lg object-cover" />}
                        <span className="truncate">{prod?.name}</span>
                      </div>
                      <div className="col-span-3">
                        <Label>كمية</Label>
                        <NumberInput value={l.quantity} onValueChange={(v) => setPosCart((prev) => prev.map((row, idx) => idx === i ? { ...row, quantity: v } : row))} />
                      </div>
                      <div className="col-span-3">
                        <Label>سعر</Label>
                        <NumberInput value={l.unitPrice} onValueChange={(v) => setPosCart((prev) => prev.map((row, idx) => idx === i ? { ...row, unitPrice: v } : row))} />
                      </div>
                      <button type="button" className="col-span-1 pb-2 text-rose-600" onClick={() => setPosCart((prev) => prev.filter((_, idx) => idx !== i))}>×</button>
                    </div>
                  );
                })}
              </div>
            )}
            <div>
              <Label>العميل</Label>
              <Select value={posForm.customerId} onChange={(e) => setPosForm({ ...posForm, customerId: e.target.value })}>
                <option value="">اختر العميل</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>
            <div>
              <Label>المخزن</Label>
              <Select value={posForm.warehouseId} onChange={(e) => setPosForm({ ...posForm, warehouseId: e.target.value })}>
                <option value="">اختر المخزن</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </div>
            <div>
              <Label>المدفوع الآن (فاضي = المبلغ كامل)</Label>
              <NumberInput value={posForm.paidAmount} onValueChange={(v) => setPosForm({ ...posForm, paidAmount: v })} />
            </div>
            {posPaid > 0 && (
              <>
                <div>
                  <Label>حساب الخزنة</Label>
                  <Select value={posForm.cashAccountId} onChange={(e) => setPosForm({ ...posForm, cashAccountId: e.target.value })}>
                    <option value="">اختر الحساب</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>
                </div>
                <div>
                  <Label>طريقة الدفع</Label>
                  <Select value={posForm.paymentMethod} onChange={(e) => setPosForm({ ...posForm, paymentMethod: e.target.value })}>
                    {Object.entries(METHODS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </Select>
                </div>
              </>
            )}
            <div className="space-y-1 rounded-2xl bg-brand-900 px-4 py-3 text-sm text-white">
              <div className="flex justify-between"><span className="text-brand-100">الإجمالي</span><strong className="text-lg">{formatMoney(posLinesTotal)}</strong></div>
              <div className="flex justify-between text-brand-100"><span>المدفوع</span><span className="text-white">{formatMoney(posPaid)}</span></div>
              <div className="flex justify-between border-t border-white/10 pt-2 font-bold"><span>المتبقي</span><span>{formatMoney(posRemaining)}</span></div>
            </div>
            <Button className="w-full" onClick={savePos} disabled={!posCart.length}>إتمام البيع</Button>
          </div>
        </div>
        </div>
      )}

      <Modal open={!!view} onClose={() => setView(null)} title={`فاتورة ${view?.number || ''}`} wide>
        {view && (
          <div>
            <PrintHeader title={`فاتورة بيع ${view.number}`} subtitle={view.customer.name} />
            <div className="mb-4 overflow-hidden rounded-2xl bg-brand-900 px-5 py-4 text-white no-print">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs text-brand-200">فاتورة بيع</div>
                  <div className="text-2xl font-extrabold">{view.number}</div>
                  <div className="mt-1 text-sm text-brand-100">{view.customer.name} · {view.warehouse.name} · {formatDate(view.invoiceDate)}</div>
                </div>
                <StatusBadge status={view.status} />
              </div>
              <div className="mt-4 grid gap-3 border-t border-white/10 pt-3 sm:grid-cols-3">
                <div><div className="text-[11px] text-brand-200">الإجمالي</div><div className="text-lg font-extrabold">{formatMoney(view.total)}</div></div>
                <div><div className="text-[11px] text-brand-200">المدفوع</div><div className="text-lg font-extrabold">{formatMoney(view.paidAmount)}</div></div>
                <div><div className="text-[11px] text-brand-200">المتبقي</div><div className="mt-1 inline-flex rounded-xl bg-white px-2 py-1">{view.status === 'CANCELLED' ? <span className="font-bold text-emerald-700">{formatMoney(0)}</span> : <DueAmount date={view.invoiceDate} remaining={owed(view)} />}</div></div>
              </div>
            </div>
            <div className="mb-4 flex justify-end gap-2 no-print">
              <Button variant="secondary" onClick={() => window.print()}><Printer size={14} /> طباعة / PDF</Button>
              <Button variant="secondary" onClick={() => editInvoice(view)}><Pencil size={14} /> تعديل</Button>
              <Button variant="danger" onClick={() => removeInvoice(view.id)}><Trash2 size={14} /> حذف</Button>
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>الصنف</Th>
                  <Th>كمية</Th>
                  <Th>سعر</Th>
                  <Th>الإجمالي</Th>
                </tr>
              </thead>
              <tbody>
                {view.lines.map((l, i) => (
                  <tr key={i}>
                    <Td>{l.product.name}</Td>
                    <Td>{l.quantity}</Td>
                    <Td>{formatMoney(l.unitPrice)}</Td>
                    <Td>{formatMoney(l.total)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="mt-4 space-y-1 text-sm">
              <div className="flex justify-between"><span>المدفوع</span><span>{formatMoney(view.paidAmount)}</span></div>
              <div className="flex justify-between font-bold">
                <span>المتبقي</span>
                {view.status === 'CANCELLED' ? <span>{formatMoney(0)}</span> : <DueAmount date={view.invoiceDate} remaining={view.total - view.paidAmount} />}
              </div>
              <div className="flex justify-between text-lg font-extrabold">
                <span>الإجمالي</span>
                <span>{formatMoney(view.total)}</span>
              </div>
            </div>
            <div className="mt-4">
              <div className="mb-2 text-sm font-semibold text-slate-700">حركات التحصيل</div>
              {!view.receipts?.length ? (
                <div className="text-sm text-muted">لا توجد حركات تحصيل على الفاتورة</div>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>التاريخ</Th>
                      <Th>رقم الحركة</Th>
                      <Th>طريقة الدفع</Th>
                      <Th>المبلغ</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.receipts.map((r) => (
                      <tr key={r.id} className="row-debit">
                        <Td>{formatDate(r.receivedAt)}</Td>
                        <Td className="font-semibold">{r.number}</Td>
                        <Td>{METHODS[r.paymentMethod] || r.paymentMethod}</Td>
                        <Td className="font-bold">{formatMoney(r.amount)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
