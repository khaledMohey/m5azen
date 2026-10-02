import { useEffect, useMemo, useState } from 'react';
import { Printer, Eye, ShoppingCart, Receipt, Trash2, Pencil } from 'lucide-react';
import { api, formatDate, formatMoney } from '../lib/api';
import {
  Button, Card, Empty, Input, Label, Modal, NumberInput, PageHeader, PrintHeader, SearchBox, Select, StatusBadge, Table, Td, Th,
} from '../components/ui';

type Party = { id: string; name: string; priceList?: string };
type Product = { id: string; name: string; sku: string; salePrice: number; wholesalePrice?: number; barcode?: string | null };
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

export function SalesPage() {
  const [items, setItems] = useState<Invoice[]>([]);
  const [customers, setCustomers] = useState<Party[]>([]);
  const [warehouses, setWarehouses] = useState<Party[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Invoice | null>(null);
  const [search, setSearch] = useState('');
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
    if (!q) return items;
    return items.filter((inv) =>
      [inv.number, inv.customer.name, inv.warehouse.name, inv.status].some((x) => x.toLowerCase().includes(q)),
    );
  }, [items, search]);

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

  const posLinesTotal = posCart.reduce((s, l) => s + num(l.quantity) * num(l.unitPrice), 0);
  const posPaid = posForm.paidAmount === '' ? posLinesTotal : num(posForm.paidAmount);
  const posRemaining = Math.max(0, posLinesTotal - posPaid);
  const posProducts = products.filter((p) => {
    const q = posSearch.trim().toLowerCase();
    if (!q) return true;
    return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q);
  });

  function addPosProduct(p: Product) {
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
    await api(editingId ? `/sales/${editingId}` : '/sales', {
      method: editingId ? 'PATCH' : 'POST',
      body: JSON.stringify(payload),
    });
    setEditingId(null);
    setOpen(false);
    setForm({
      customerId: '', warehouseId: '', discount: '', tax: '', paidAmount: '',
      cashAccountId: '', paymentMethod: 'CASH', notes: '', confirm: true,
    });
    setLines([emptyLine()]);
    load();
  }

  function printInvoice(inv: Invoice) {
    setView(inv);
    setTimeout(() => window.print(), 300);
  }

  async function removeInvoice(id: string) {
    if (!confirm('حذف الفاتورة وإلغاء أثرها على المخزون والحسابات؟')) return;
    try {
      await api(`/sales/${id}`, { method: 'DELETE' });
      if (view?.id === id) setView(null);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'تعذر حذف الفاتورة');
    }
  }

  async function editInvoice(inv: Invoice) {
    setEditingId(inv.id);
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
    if (!accountId) return alert('أضف حساب خزنة أولاً');
    const opening = Number(prompt('رصيد بداية الوردية', '0') || '0');
    const row = await api<{ id: string; openingCash: number; account: { name: string } }>('/finance/shifts', {
      method: 'POST',
      body: JSON.stringify({ cashAccountId: accountId, openingCash: opening }),
    });
    setShift(row);
    setUseShift(false);
  }

  async function closeShift() {
    if (!shift) return;
    const closing = Number(prompt('النقدية المعدودة في الدرج', String(shift.openingCash)) || '0');
    const closed = await api<{ difference: number }>(`/finance/shifts/${shift.id}/close`, {
      method: 'POST',
      body: JSON.stringify({ closingCash: closing }),
    });
    alert(`اتقفلت الوردية. الفرق: ${formatMoney(closed.difference)}`);
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

  return (
    <div>
      <PageHeader
        title="المبيعات"
        subtitle="اختر نقطة البيع أو فاتورة مبيعات"
        actions={
          <SearchBox value={search} onChange={setSearch} placeholder="بحث فاتورة / عميل..." />
        }
      />

      <Card className="mb-4">
        {shift ? (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div>
              <div className="font-bold">وردية مفتوحة — {shift.account?.name}</div>
              <div className="text-muted">رصيد البداية {formatMoney(shift.openingCash)}. البيع يشتغل حتى لو مش محسوب على الوردية.</div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={useShift} onChange={(e) => setUseShift(e.target.checked)} />
                احتساب العملية الجاية في الوردية
              </label>
              <Button variant="secondary" onClick={closeShift}>قفل الوردية</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div>
              <div className="font-bold">من غير وردية</div>
              <div className="text-muted">فتح الوردية اختياري. تقدر تبيع فاتورة أو من نقطة البيع من غيرها.</div>
            </div>
            <Button variant="secondary" onClick={openShift}>فتح وردية</Button>
          </div>
        )}
      </Card>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={openPos}
          className="rounded-2xl border border-brand-200 bg-gradient-to-br from-brand-700 to-brand-900 p-5 text-right text-white shadow-sm"
        >
          <ShoppingCart className="mb-2" size={22} />
          <div className="text-lg font-extrabold">نقطة البيع POS</div>
          <div className="mt-1 text-sm text-brand-100">بيع سريع: اختار الصنف، الكمية، وادفع</div>
        </button>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-2xl border border-slate-200 bg-white p-5 text-right shadow-sm hover:border-brand-300"
        >
          <Receipt className="mb-2 text-brand-700" size={22} />
          <div className="text-lg font-extrabold text-slate-900">فاتورة مبيعات</div>
          <div className="mt-1 text-sm text-muted">فاتورة كاملة بخصم وضريبة وتحصيل جزئي</div>
        </button>
      </div>
      <Card>
        {filtered.length === 0 ? <Empty /> : (
          <Table>
            <thead>
              <tr>
                <Th>الرقم</Th>
                <Th>العميل</Th>
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
              {filtered.map((inv) => (
                <tr key={inv.id} className={`status-${inv.status}`}>
                  <Td className="font-semibold">{inv.number}</Td>
                  <Td>{inv.customer.name}</Td>
                  <Td>{inv.warehouse.name}</Td>
                  <Td>{formatDate(inv.invoiceDate)}</Td>
                  <Td>{formatMoney(inv.total)}</Td>
                  <Td>{formatMoney(inv.paidAmount)}</Td>
                  <Td className={inv.total - inv.paidAmount > 0 ? 'font-bold text-amber-700' : 'text-emerald-700'}>
                    {formatMoney(Math.max(0, inv.total - inv.paidAmount))}
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
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={open} onClose={() => { setOpen(false); setEditingId(null); }} title={editingId ? 'تعديل فاتورة بيع' : 'فاتورة بيع جديدة'} wide>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>العميل</Label>
              <Select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
                <option value="">اختر العميل</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
                    <Label>سعر الوحدة</Label>
                    <NumberInput value={l.unitPrice} onValueChange={(v) => updateLine(i, { unitPrice: v })} />
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
              <div className="mt-1 text-xs text-muted">قيمة الضريبة: {formatMoney(taxAmount)}</div>
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
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
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
            </>
          )}
          <div>
            <Label>ملاحظات</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <div className="space-y-1 rounded-xl bg-slate-50 px-4 py-3 text-sm">
            <div className="flex justify-between"><span>الإجمالي</span><strong className="text-lg">{formatMoney(grand)}</strong></div>
            <div className="flex justify-between"><span>المدفوع</span><span>{formatMoney(num(form.paidAmount))}</span></div>
            <div className="flex justify-between font-bold text-amber-800">
              <span>المتبقي</span>
              <span>{formatMoney(remaining)}</span>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.checked })} />
            تأكيد فوري (خصم مخزون وتحديث ذمم)
          </label>
          <Button className="w-full" onClick={save}>حفظ الفاتورة</Button>
        </div>
      </Modal>

      <Modal open={posOpen} onClose={() => setPosOpen(false)} title="نقطة البيع" wide>
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <Label>بحث صنف</Label>
            <Input
              value={posSearch}
              onChange={(e) => setPosSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); scanPosBarcode(); } }}
              placeholder="اسم أو كود أو باركود ثم Enter"
            />
            <div className="mt-3 grid max-h-80 grid-cols-2 gap-2 overflow-y-auto">
              {posProducts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => addPosProduct(p)}
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-right hover:border-brand-400 hover:bg-brand-50"
                >
                  <div className="text-sm font-bold">{p.name}</div>
                  <div className="text-xs text-muted">{p.sku}</div>
                  <div className="mt-1 text-sm font-semibold text-brand-800">{formatMoney(p.salePrice)}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <div className="text-sm font-semibold">السلة</div>
            {posCart.length === 0 ? <Empty text="اضغط على صنف لإضافته" /> : (
              <div className="space-y-2">
                {posCart.map((l, i) => {
                  const prod = products.find((p) => p.id === l.productId);
                  return (
                    <div key={l.productId} className="grid grid-cols-12 items-end gap-2 rounded-xl bg-slate-50 p-2">
                      <div className="col-span-5 text-sm font-semibold">{prod?.name}</div>
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
            <div className="space-y-1 rounded-xl bg-slate-50 px-4 py-3 text-sm">
              <div className="flex justify-between"><span>الإجمالي</span><strong>{formatMoney(posLinesTotal)}</strong></div>
              <div className="flex justify-between"><span>المدفوع</span><span>{formatMoney(posPaid)}</span></div>
              <div className="flex justify-between font-bold text-amber-800"><span>المتبقي</span><span>{formatMoney(posRemaining)}</span></div>
            </div>
            <Button className="w-full" onClick={savePos} disabled={!posCart.length}>إتمام البيع</Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!view} onClose={() => setView(null)} title={`فاتورة ${view?.number || ''}`} wide>
        {view && (
          <div>
            <PrintHeader title={`فاتورة بيع ${view.number}`} subtitle={view.customer.name} />
            <div className="mb-4 flex justify-between no-print">
              <StatusBadge status={view.status} />
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => window.print()}><Printer size={14} /> طباعة / PDF</Button>
                <Button variant="secondary" onClick={() => editInvoice(view)}><Pencil size={14} /> تعديل</Button>
                <Button variant="danger" onClick={() => removeInvoice(view.id)}><Trash2 size={14} /> حذف</Button>
              </div>
            </div>
            <div className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
              <div>العميل: <strong>{view.customer.name}</strong></div>
              <div>المخزن: <strong>{view.warehouse.name}</strong></div>
              <div>التاريخ: {formatDate(view.invoiceDate)}</div>
              <div>المدفوع: {formatMoney(view.paidAmount)}</div>
              <div className="font-bold text-amber-800">
                المتبقي: {formatMoney(Math.max(0, view.total - view.paidAmount))}
              </div>
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
              <div className="flex justify-between font-bold text-amber-800">
                <span>المتبقي</span>
                <span>{formatMoney(Math.max(0, view.total - view.paidAmount))}</span>
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
