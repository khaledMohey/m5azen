import { useEffect, useMemo, useState } from 'react';
import { Plus, Printer, Eye, Trash2, Pencil } from 'lucide-react';
import { api, formatDate, formatMoney } from '../lib/api';
import {
  Button, Card, Empty, Input, Label, Modal, NumberInput, PageHeader, PrintHeader, SearchBox, Select, StatusBadge, Table, Td, Th,
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

export function PurchasesPage() {
  const [items, setItems] = useState<Invoice[]>([]);
  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [warehouses, setWarehouses] = useState<Party[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Invoice | null>(null);
  const [search, setSearch] = useState('');
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
    if (!q) return items;
    return items.filter((inv) =>
      [inv.number, inv.supplier.name, inv.warehouse.name, inv.status].some((x) => x.toLowerCase().includes(q)),
    );
  }, [items, search]);

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

  async function save() {
    await api(editingId ? `/purchases/${editingId}` : '/purchases', {
      method: editingId ? 'PATCH' : 'POST',
      body: JSON.stringify({
        ...form,
        discount: num(form.discount),
        tax: taxPercent,
        paidAmount: num(form.paidAmount),
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: num(l.quantity),
          unitCost: num(l.unitCost),
          discount: num(l.discount),
          batchNumber: l.batchNumber || undefined,
          expiryDate: l.expiryDate || undefined,
        })),
      }),
    });
    setEditingId(null);
    setOpen(false);
    setForm({
      supplierId: '', warehouseId: '', discount: '', tax: '', paidAmount: '',
      cashAccountId: '', paymentMethod: 'CASH', notes: '', confirm: true,
    });
    setLines([emptyLine()]);
    load();
  }

  function printInvoice(inv: Invoice) {
    setView(inv);
    setTimeout(() => window.print(), 300);
  }

  function editInvoice(inv: Invoice) {
    setEditingId(inv.id);
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
    if (!confirm('حذف الفاتورة وإلغاء أثرها على المخزون والحسابات؟')) return;
    try {
      await api(`/purchases/${id}`, { method: 'DELETE' });
      if (view?.id === id) setView(null);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'تعذر حذف الفاتورة');
    }
  }

  return (
    <div>
      <PageHeader
        title="المشتريات"
        subtitle="فواتير الشراء وإضافة المخزون"
        actions={
          <>
            <SearchBox value={search} onChange={setSearch} placeholder="بحث فاتورة / مورد..." />
            <Button onClick={() => setOpen(true)}><Plus size={16} /> فاتورة شراء</Button>
          </>
        }
      />
      <Card>
        {filtered.length === 0 ? <Empty /> : (
          <Table>
            <thead>
              <tr>
                <Th>الرقم</Th>
                <Th>المورد</Th>
                <Th>المخزن</Th>
                <Th>التاريخ</Th>
                <Th>الإجمالي</Th>
                <Th>المدفوع</Th>
                <Th>المتبقي</Th>
                <Th>الحالة</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const due = Math.max(0, inv.total - inv.paidAmount);
                return (
                  <tr key={inv.id} className={`status-${inv.status}`}>
                    <Td className="font-semibold">{inv.number}</Td>
                    <Td>{inv.supplier.name}</Td>
                    <Td>{inv.warehouse.name}</Td>
                    <Td>{formatDate(inv.invoiceDate)}</Td>
                    <Td>{formatMoney(inv.total)}</Td>
                    <Td>{formatMoney(inv.paidAmount)}</Td>
                    <Td className={due > 0 ? 'font-bold text-amber-700' : 'text-emerald-700'}>
                      {formatMoney(due)}
                    </Td>
                    <Td><StatusBadge status={inv.status} /></Td>
                    <Td>
                      <div className="flex gap-1">
                        <Button variant="ghost" onClick={() => setView(inv)}><Eye size={14} /></Button>
                        <Button variant="ghost" onClick={() => printInvoice(inv)}><Printer size={14} /></Button>
                        <Button variant="ghost" className="text-rose-600" onClick={() => removeInvoice(inv.id)}><Trash2 size={14} /></Button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={open} onClose={() => { setOpen(false); setEditingId(null); }} title={editingId ? 'تعديل فاتورة شراء' : 'فاتورة شراء جديدة'} wide>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>المورد</Label>
              <Select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
                <option value="">اختر المورد</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>
            <div>
              <Label>المخزن</Label>
              <Select value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}>
                <option value="">اختر المخزن</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </div>
          </div>

          <div className="space-y-3">
            <div className="text-sm font-semibold text-slate-700">بنود الفاتورة</div>
            {lines.map((l, i) => (
              <div key={i} className="rounded-xl border border-slate-200 bg-slate-50/50 p-3">
                <div className="mb-2 grid gap-2 sm:grid-cols-12">
                  <div className="sm:col-span-5">
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
                  <div className="flex items-end sm:col-span-1">
                    <button type="button" className="mb-1 w-full rounded-xl py-2 text-rose-600 hover:bg-rose-50" onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}>
                      حذف
                    </button>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <Label>رقم التشغيلة / الباتش (اختياري)</Label>
                    <Input value={l.batchNumber} onChange={(e) => updateLine(i, { batchNumber: e.target.value })} placeholder="LOT-001" />
                  </div>
                  <div>
                    <Label>تاريخ الصلاحية (اختياري)</Label>
                    <Input type="date" value={l.expiryDate} onChange={(e) => updateLine(i, { expiryDate: e.target.value })} />
                  </div>
                </div>
              </div>
            ))}
            <Button variant="secondary" type="button" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
              + إضافة بند
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>خصم الفاتورة</Label>
              <NumberInput value={form.discount} onValueChange={(v) => setForm({ ...form, discount: v })} />
            </div>
            <div>
              <Label>الضريبة %</Label>
              <NumberInput value={form.tax} onValueChange={(v) => setForm({ ...form, tax: v })} />
              <p className="mt-1 text-xs text-muted">
                قيمة الضريبة: {formatMoney(taxAmount)}
              </p>
            </div>
            <div>
              <Label>المبلغ المدفوع الآن</Label>
              <NumberInput value={form.paidAmount} onValueChange={(v) => setForm({ ...form, paidAmount: v })} />
            </div>
          </div>
          {num(form.paidAmount) > 0 && (
            <>
              <div>
                <Label>حساب الخزنة / البنك</Label>
                <Select value={form.cashAccountId} onChange={(e) => setForm({ ...form, cashAccountId: e.target.value })}>
                  <option value="">اختر الحساب</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}{typeof a.balance === 'number' ? ` (${formatMoney(a.balance)})` : ''}
                    </option>
                  ))}
                </Select>
                <p className="mt-1 text-xs text-muted">إذا الرصيد غير كافٍ هيتسجل بالسالب</p>
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
            </>
          )}
          <div>
            <Label>ملاحظات</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <div className="space-y-1 rounded-xl bg-slate-50 px-4 py-3 text-sm">
            <div className="flex justify-between"><span>المجموع قبل الضريبة</span><span>{formatMoney(afterDiscount)}</span></div>
            <div className="flex justify-between"><span>الضريبة ({taxPercent}%)</span><span>{formatMoney(taxAmount)}</span></div>
            <div className="flex justify-between border-t border-slate-200 pt-1 text-base">
              <span>الإجمالي</span>
              <strong className="text-lg">{formatMoney(grand)}</strong>
            </div>
            <div className="flex justify-between"><span>المدفوع</span><span>{formatMoney(num(form.paidAmount))}</span></div>
            <div className="flex justify-between font-bold text-amber-800">
              <span>المتبقي</span>
              <span>{formatMoney(remaining)}</span>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.checked })} />
            تأكيد فوري (إضافة مخزون وتحديث ذمم)
          </label>
          <Button className="w-full" onClick={save}>حفظ الفاتورة</Button>
        </div>
      </Modal>

      <Modal open={!!view} onClose={() => setView(null)} title={`فاتورة ${view?.number || ''}`} wide>
        {view && (
          <div>
            <PrintHeader title={`فاتورة شراء ${view.number}`} subtitle={view.supplier.name} />
            <div className="mb-4 flex justify-between no-print">
              <StatusBadge status={view.status} />
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => window.print()}><Printer size={14} /> طباعة / PDF</Button>
                <Button variant="secondary" onClick={() => editInvoice(view)}><Pencil size={14} /> تعديل</Button>
                <Button variant="danger" onClick={() => removeInvoice(view.id)}><Trash2 size={14} /> حذف</Button>
              </div>
            </div>
            <div className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
              <div>المورد: <strong>{view.supplier.name}</strong></div>
              <div>المخزن: <strong>{view.warehouse.name}</strong></div>
              <div>التاريخ: {formatDate(view.invoiceDate)}</div>
              <div>المدفوع: {formatMoney(view.paidAmount)}</div>
              <div>الضريبة: {formatMoney(view.tax)}</div>
              <div className="font-bold text-amber-800">
                المتبقي: {formatMoney(Math.max(0, view.total - view.paidAmount))}
              </div>
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
              <div className="flex justify-between font-bold text-amber-800">
                <span>المتبقي</span>
                <span>{formatMoney(Math.max(0, view.total - view.paidAmount))}</span>
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
