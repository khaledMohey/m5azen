import { useEffect, useMemo, useState } from 'react';
import { Plus, Printer, Eye, Trash2, Pencil, ShoppingBag } from 'lucide-react';
import ExcelJS from 'exceljs';
import { api, formatDate, formatMoney, initialQuery } from '../lib/api';
import { dueTone } from '../lib/due';
import { DueAmount } from '../components/DueAmount';
import { AddLineButton, EditorErrors, EditorSection, InvoiceEditor, LineCard, SummaryRow } from '../components/InvoiceEditor';
import { useConfirm, useToast } from '../lib/feedback';
import { usePagedList } from '../lib/paging';
import { useColumns } from '../lib/columns';
import { IconAction, ListBar } from '../components/ListBar';
import {
  Button, Card, Empty, Input, Label, Modal, NumberInput, PageHeader, Pager, PrintHeader, Select, StatusBadge, Table, Td, Th, todayIso,
} from '../components/ui';

type Party = { id: string; name: string };
type Product = { id: string; name: string; sku: string; costPrice: number };
type Account = { id: string; name: string; balance?: number };
type Line = {
  productId: string;
  quantity: number | '';
  unitCost: number | '';
  discount: number | '';
  batchNumber: string;
  expiryDate: string;
};

type Invoice = {
  id: string;
  number: string;
  status: string;
  invoiceDate: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paidAmount: number;
  supplier: { id: string; name: string };
  warehouse: { id: string; name: string };
  lines: {
    productId: string;
    quantity: number;
    discount?: number;
    batchNumber?: string | null;
    expiryDate?: string | null;
    unitCost: number;
    total: number;
    product: { name: string; sku: string };
  }[];
};

const emptyLine = (): Line => ({
  productId: '', quantity: '', unitCost: '', discount: '', batchNumber: '', expiryDate: '',
});
const num = (v: number | '') => (v === '' ? 0 : v);
const PURCHASE_VIEW = 'm5azen.purchasesView';
type PurchaseFilter = 'all' | 'DRAFT' | 'CONFIRMED' | 'PARTIAL' | 'PAID' | 'CANCELLED' | 'due';
const PURCHASE_FILTERS: { id: PurchaseFilter; label: string }[] = [
  { id: 'all', label: 'كل الفواتير' },
  { id: 'due', label: 'عليها متبقي' },
  { id: 'PAID', label: 'مدفوعة' },
  { id: 'PARTIAL', label: 'سداد جزئي' },
  { id: 'CONFIRMED', label: 'مؤكدة' },
  { id: 'DRAFT', label: 'مسودة' },
  { id: 'CANCELLED', label: 'ملغاة' },
];

function owed(inv: { status: string; total: number; paidAmount: number }) {
  if (inv.status === 'CANCELLED') return 0;
  return Math.max(0, inv.total - inv.paidAmount);
}

export function PurchasesPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const [items, setItems] = useState<Invoice[]>([]);
  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [warehouses, setWarehouses] = useState<Party[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Invoice | null>(null);
  const [search, setSearch] = useState(initialQuery);
  const [status, setStatus] = useState<PurchaseFilter>('all');
  const [listView, setListView] = useState<'table' | 'cards'>(() => (localStorage.getItem(PURCHASE_VIEW) === 'cards' ? 'cards' : 'table'));
  const [form, setForm] = useState({
    supplierId: '',
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [triedSave, setTriedSave] = useState(false);

  async function load() {
    const [inv, s, w, p, a] = await Promise.all([
      api<Invoice[]>('/purchases'),
      api<Party[]>('/suppliers'),
      api<Party[]>('/warehouses'),
      api<Product[]>('/products'),
      api<Account[]>('/cash/accounts'),
    ]);
    setItems(inv);
    setSuppliers(s);
    setWarehouses(w);
    setProducts(p);
    setAccounts(a);
  }

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((inv) => {
      if (status === 'due' && owed(inv) <= 0.009) return false;
      if (status !== 'all' && status !== 'due' && inv.status !== status) return false;
      if (!q) return true;
      return [inv.number, inv.supplier.name, inv.warehouse.name, inv.status].some((x) => x.toLowerCase().includes(q));
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
  const purchaseColumns = useColumns('m5azen.cols.purchases', [
    { id: 'number', label: 'الرقم' },
    { id: 'supplier', label: 'المورد' },
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
        if (prod) next.unitCost = prod.costPrice;
      }
      return next;
    }));
  }

  const linesTotal = lines.reduce((s, l) => s + num(l.quantity) * num(l.unitCost) - num(l.discount), 0);
  const afterDiscount = linesTotal - num(form.discount);
  const taxPercent = num(form.tax);
  const taxAmount = Math.round(afterDiscount * taxPercent * 100) / 10000;
  const grand = afterDiscount + taxAmount;
  const remaining = Math.max(0, grand - num(form.paidAmount));
  const filledLines = lines.filter((l) => l.productId);
  const badLine = (l: Line) => !!l.productId && !(num(l.quantity) > 0);
  const formErrors = [
    !form.supplierId && 'اختر المورد',
    !form.warehouseId && 'اختر المخزن',
    !filledLines.length && 'أضف صنفًا واحدًا على الأقل',
    lines.some(badLine) && 'كل بند لازم يكون له كمية أكبر من صفر',
    num(form.paidAmount) > grand + 0.009 && 'المدفوع أكبر من إجمالي الفاتورة',
    form.confirm && num(form.paidAmount) > 0 && !form.cashAccountId && 'اختر حساب الخزنة للمبلغ المدفوع',
  ].filter(Boolean) as string[];

  async function save() {
    setTriedSave(true);
    if (formErrors.length) return;
    setSaving(true);
    try {
      await api(editingId ? `/purchases/${editingId}` : '/purchases', {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify({
          ...form,
          discount: num(form.discount),
          tax: taxPercent,
          paidAmount: num(form.paidAmount),
          lines: filledLines.map((l) => ({
            productId: l.productId,
            quantity: num(l.quantity),
            unitCost: num(l.unitCost),
            discount: num(l.discount),
            batchNumber: l.batchNumber || undefined,
            expiryDate: l.expiryDate || undefined,
          })),
        }),
      });
      toast.success(editingId ? 'تم تعديل الفاتورة' : 'تم حفظ الفاتورة');
      setEditingId(null);
      setOpen(false);
      setTriedSave(false);
      setForm({
        supplierId: '', warehouseId: '', discount: '', tax: '', paidAmount: '',
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

  function editInvoice(inv: Invoice) {
    setEditingId(inv.id);
    setTriedSave(false);
    setForm({
      supplierId: inv.supplier.id,
      warehouseId: inv.warehouse.id,
      discount: inv.discount,
      tax: inv.subtotal - inv.discount > 0 ? Math.round((inv.tax / (inv.subtotal - inv.discount)) * 10000) / 100 : 0,
      paidAmount: inv.paidAmount,
      cashAccountId: accounts[0]?.id || '',
      paymentMethod: 'CASH',
      notes: '',
      confirm: true,
    });
    setLines(inv.lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      unitCost: l.unitCost,
      discount: l.discount || '',
      batchNumber: l.batchNumber || '',
      expiryDate: l.expiryDate ? l.expiryDate.slice(0, 10) : '',
    })));
    setView(null);
    setOpen(true);
  }

  async function removeInvoice(id: string) {
    const ok = await confirm({
      title: 'حذف فاتورة الشراء',
      message: 'حذف الفاتورة وإلغاء أثرها على المخزون والحسابات؟',
      confirmLabel: 'حذف',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/purchases/${id}`, { method: 'DELETE' });
      if (view?.id === id) setView(null);
      toast.success('تم حذف الفاتورة');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر حذف الفاتورة');
    }
  }

  function openInvoiceForm() {
    setEditingId(null);
    setTriedSave(false);
    setForm({
      supplierId: '', warehouseId: warehouses.length === 1 ? warehouses[0].id : '', discount: '', tax: '', paidAmount: '',
      cashAccountId: accounts[0]?.id || '', paymentMethod: 'CASH', notes: '', confirm: true,
    });
    setLines([emptyLine()]);
    setOpen(true);
  }

  async function exportRows() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('المشتريات');
    sheet.addRow(['الرقم', 'المورد', 'المخزن', 'التاريخ', 'الإجمالي', 'المدفوع', 'المتبقي', 'الحالة']);
    filtered.forEach((inv) => sheet.addRow([inv.number, inv.supplier.name, inv.warehouse.name, formatDate(inv.invoiceDate), inv.total, inv.paidAmount, owed(inv), inv.status]));
    const buffer = await workbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer]));
    link.download = 'purchases.xlsx';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <div>
      <PageHeader
        title="المشتريات"
        subtitle="فواتير الموردين ودخول المخزون"
        actions={<Button onClick={openInvoiceForm}><Plus size={16} /> فاتورة شراء</Button>}
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {([
          { key: 'all' as const, label: 'فواتير الشراء', value: String(stats.count), hint: 'كل الحالات', stripe: 'bg-brand-700' },
          { key: 'all' as const, label: 'إجمالي المشتريات', value: formatMoney(stats.total), hint: 'بدون الملغى', stripe: 'bg-brand-500' },
          { key: 'PAID' as const, label: 'المدفوع للموردين', value: formatMoney(stats.paid), hint: 'سداد على الفواتير', stripe: 'bg-emerald-600' },
          { key: 'due' as const, label: 'المتبقي للموردين', value: formatMoney(stats.due), hint: 'ذمم لم تُسدَّد', stripe: stats.due > 0 ? 'bg-rose-600' : 'bg-emerald-600' },
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
          placeholder="بحث برقم الفاتورة أو المورد"
          view={listView}
          onView={(mode) => { setListView(mode); localStorage.setItem(PURCHASE_VIEW, mode); }}
          onExport={exportRows}
          columns={purchaseColumns.columns}
          onToggleColumn={purchaseColumns.toggle}
          filterActive={status !== 'all'}
          filter={(
            <div className="space-y-1">
              <div className="mb-2 text-xs font-bold text-muted">حالة الفاتورة</div>
              {PURCHASE_FILTERS.map((item) => (
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
                      <div className="mt-1 truncate text-base font-extrabold">{inv.supplier.name}</div>
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
                {purchaseColumns.visible('status') && <Th>الحالة</Th>}
                {purchaseColumns.visible('due') && <Th>المتبقي</Th>}
                {purchaseColumns.visible('paid') && <Th>المدفوع</Th>}
                {purchaseColumns.visible('total') && <Th>الإجمالي</Th>}
                {purchaseColumns.visible('date') && <Th>التاريخ</Th>}
                {purchaseColumns.visible('warehouse') && <Th>المخزن</Th>}
                {purchaseColumns.visible('supplier') && <Th>المورد</Th>}
                {purchaseColumns.visible('number') && <Th>الرقم</Th>}
                <Th>الإجراءات</Th>
              </tr>
            </thead>
            <tbody>
              {pager.slice.map((inv) => (
                <tr key={inv.id} className={`status-${inv.status}`}>
                  {purchaseColumns.visible('status') && <Td><StatusBadge status={inv.status} /></Td>}
                  {purchaseColumns.visible('due') && <Td><DueAmount date={inv.invoiceDate} remaining={owed(inv)} /></Td>}
                  {purchaseColumns.visible('paid') && <Td>{formatMoney(inv.paidAmount)}</Td>}
                  {purchaseColumns.visible('total') && <Td className="font-semibold">{formatMoney(inv.total)}</Td>}
                  {purchaseColumns.visible('date') && <Td>{formatDate(inv.invoiceDate)}</Td>}
                  {purchaseColumns.visible('warehouse') && <Td>{inv.warehouse.name}</Td>}
                  {purchaseColumns.visible('supplier') && <Td className="font-semibold">{inv.supplier.name}</Td>}
                  {purchaseColumns.visible('number') && <Td className="font-mono text-xs font-bold text-brand-800">{inv.number}</Td>}
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
        title={editingId ? 'تعديل فاتورة شراء' : 'فاتورة شراء جديدة'}
        subtitle="اختار المورد والمخزن، ضيف الأصناف والتشغيلات، وسجّل المدفوع"
        icon={<ShoppingBag size={18} />}
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
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}{typeof a.balance === 'number' ? ` (${formatMoney(a.balance)})` : ''}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label>طريقة الدفع</Label>
                  <Select value={form.paymentMethod} onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}>
                    <option value="CASH">نقدي</option>
                    <option value="BANK_TRANSFER">تحويل بنكي</option>
                    <option value="CHECK">شيك</option>
                    <option value="CARD">بطاقة</option>
                    <option value="INSTAPAY">إنستاباي</option>
                    <option value="OTHER">أخرى</option>
                  </Select>
                </div>
                <p className="col-span-2 text-xs text-muted">لو رصيد الخزنة مش كفاية هيتسجل بالسالب</p>
              </div>
            )}
            <div>
              <Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="رقم فاتورة المورد مثلًا" />
            </div>
            <div className="mt-auto space-y-2 rounded-2xl bg-brand-900 px-4 py-4 text-sm">
              <SummaryRow label={`البنود (${filledLines.length})`} value={formatMoney(linesTotal)} />
              <SummaryRow label="خصم الفاتورة" value={formatMoney(num(form.discount))} />
              <SummaryRow label={`الضريبة (${taxPercent}%)`} value={formatMoney(taxAmount)} />
              <SummaryRow label="الإجمالي" value={formatMoney(grand)} strong />
              <SummaryRow label="المدفوع" value={formatMoney(num(form.paidAmount))} />
              <div className="flex items-center justify-between rounded-xl bg-white px-3 py-2 font-bold text-slate-900">
                <span>المتبقي</span>
                <DueAmount date={formDueDate} remaining={remaining} />
              </div>
            </div>
            <label className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm">
              <input type="checkbox" checked={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.checked })} />
              تأكيد فوري (إضافة للمخزون وتحديث رصيد المورد)
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
              <Label>المورد</Label>
              <Select className={triedSave && !form.supplierId ? 'border-rose-300' : ''} value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
                <option value="">اختر المورد</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>
            <div>
              <Label>المخزن المستلم</Label>
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
                total={Math.max(0, num(l.quantity) * num(l.unitCost) - num(l.discount))}
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
                    <Label>تكلفة الوحدة</Label>
                    <NumberInput value={l.unitCost} onValueChange={(v) => updateLine(i, { unitCost: v })} />
                  </div>
                  <div className="sm:col-span-2">
                    <Label>خصم البند</Label>
                    <NumberInput value={l.discount} onValueChange={(v) => updateLine(i, { discount: v })} />
                  </div>
                  <div className="sm:col-span-6">
                    <Label>رقم التشغيلة (اختياري)</Label>
                    <Input value={l.batchNumber} onChange={(e) => updateLine(i, { batchNumber: e.target.value })} placeholder="LOT-001" />
                  </div>
                  <div className="sm:col-span-6">
                    <Label>تاريخ الصلاحية (اختياري)</Label>
                    <Input type="date" value={l.expiryDate} onChange={(e) => updateLine(i, { expiryDate: e.target.value })} />
                  </div>
                </div>
              </LineCard>
            ))}
          </div>
        </EditorSection>
      </InvoiceEditor>

      <Modal open={!!view} onClose={() => setView(null)} title={`فاتورة ${view?.number || ''}`} wide>
        {view && (
          <div>
            <PrintHeader title={`فاتورة شراء ${view.number}`} subtitle={view.supplier.name} />
            <div className="mb-4 overflow-hidden rounded-2xl bg-brand-900 px-5 py-4 text-white no-print">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs text-brand-200">فاتورة شراء</div>
                  <div className="text-2xl font-extrabold">{view.number}</div>
                  <div className="mt-1 text-sm text-brand-100">{view.supplier.name} · {view.warehouse.name} · {formatDate(view.invoiceDate)}</div>
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
                  <Th>تكلفة</Th>
                  <Th>تشغيلة</Th>
                  <Th>صلاحية</Th>
                  <Th>الإجمالي</Th>
                </tr>
              </thead>
              <tbody>
                {view.lines.map((l, i) => (
                  <tr key={i}>
                    <Td>{l.product.name}</Td>
                    <Td>{l.quantity}</Td>
                    <Td>{formatMoney(l.unitCost)}</Td>
                    <Td>{l.batchNumber || '—'}</Td>
                    <Td>{l.expiryDate ? formatDate(l.expiryDate) : '—'}</Td>
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
          </div>
        )}
      </Modal>
    </div>
  );
}
