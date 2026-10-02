import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Eye, Pencil, Printer, Trash2 } from 'lucide-react';
import { api, formatDate, formatMoney } from '../lib/api';
import {
  Button, Card, Empty, Input, Label, Modal, NumberInput, PageHeader, PrintHeader, SearchBox, Select, Table, Td, Th,
} from '../components/ui';

type FieldValue = { value: string; field: { label: string } };

type Batch = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  supplierName: string;
  warehouseName: string;
  quantity: number;
  unitCost: number;
  total: number;
  batchNumber?: string | null;
  expiryDate?: string | null;
};

type StockItem = {
  id: string;
  warehouseId: string;
  productId: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
  product: {
    id: string;
    sku: string;
    name: string;
    unit: string;
    costPrice: number;
    fieldValues: FieldValue[];
  };
  warehouse: { id: string; name: string };
  batches: Batch[];
};

type Movement = {
  id: string;
  type: string;
  quantity: number;
  unitCost: number;
  reference?: string | null;
  note?: string | null;
  createdAt: string;
  product: { sku: string; name: string };
  warehouse: { name: string };
};

type Warehouse = { id: string; name: string };
type Product = { id: string; name: string; sku: string };

const MOV_LABELS: Record<string, string> = {
  PURCHASE: 'شراء',
  SALE: 'بيع',
  PURCHASE_RETURN: 'مرتجع شراء',
  SALE_RETURN: 'مرتجع بيع',
  TRANSFER_IN: 'تحويل وارد',
  TRANSFER_OUT: 'تحويل صادر',
  ADJUSTMENT: 'تسوية',
};

export function StockPage() {
  const [tab, setTab] = useState<'balances' | 'movements'>('balances');
  const [data, setData] = useState<{ items: StockItem[]; grandTotal: number; totalQty: number }>({
    items: [], grandTotal: 0, totalQty: 0,
  });
  const [movements, setMovements] = useState<Movement[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [search, setSearch] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);
  const [countOpen, setCountOpen] = useState(false);
  const [expiryOpen, setExpiryOpen] = useState(false);
  const [locOpen, setLocOpen] = useState(false);
  const [countForm, setCountForm] = useState({ warehouseId: '', productId: '', quantity: '' as number | '', note: '', mode: 'set' as 'set' | 'delta' });
  const [expiryRows, setExpiryRows] = useState<{ name: string; sku: string; expiryDate: string; warehouseName: string; invoiceNumber: string; batchNumber?: string | null; expired: boolean; quantity: number }[]>([]);
  const [locations, setLocations] = useState<{ id: string; code: string; name: string }[]>([]);
  const [locForm, setLocForm] = useState({ warehouseId: '', code: '', name: '', productId: '', locationId: '' });
  const [detail, setDetail] = useState<StockItem | null>(null);
  const [editMov, setEditMov] = useState<Movement | null>(null);
  const [editBatch, setEditBatch] = useState<Batch | null>(null);
  const [movForm, setMovForm] = useState({
    quantity: '' as number | '',
    unitCost: '' as number | '',
    note: '',
    reference: '',
  });
  const [batchForm, setBatchForm] = useState({
    batchNumber: '',
    expiryDate: '',
    unitCost: '' as number | '',
  });
  const [form, setForm] = useState({
    fromWarehouseId: '',
    toWarehouseId: '',
    productId: '',
    quantity: '' as number | '',
    note: '',
  });

  async function load() {
    const q = new URLSearchParams();
    if (warehouseId) q.set('warehouseId', warehouseId);
    const qs = q.toString() ? `?${q}` : '';
    const [val, w, p, mov] = await Promise.all([
      api<{ items: StockItem[]; grandTotal: number; totalQty: number }>(`/stock/valuation${qs}`),
      api<Warehouse[]>('/warehouses'),
      api<Product[]>('/products'),
      api<Movement[]>(`/stock/movements${qs}`),
    ]);
    setData(val);
    setWarehouses(w);
    setProducts(p);
    setMovements(mov);
    if (detail) {
      const refreshed = val.items.find((i) => i.id === detail.id);
      setDetail(refreshed || null);
    }
  }

  useEffect(() => {
    load();
  }, [warehouseId]);

  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data.items;
    return data.items.filter((b) => {
      const hay = [
        b.product.name,
        b.product.sku,
        b.warehouse.name,
        ...b.batches.flatMap((batch) => [
          batch.invoiceNumber,
          batch.supplierName,
          batch.batchNumber || '',
        ]),
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [data.items, search]);

  const visibleMovements = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return movements;
    return movements.filter((m) =>
      [m.product.name, m.product.sku, m.warehouse.name, m.reference || '', m.note || '', MOV_LABELS[m.type] || m.type]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [movements, search]);

  const visibleQty = visibleItems.reduce((s, i) => s + i.quantity, 0);
  const visibleCost = Math.round(visibleItems.reduce((s, i) => s + i.totalCost, 0) * 100) / 100;

  async function transfer() {
    await api('/stock/transfers', {
      method: 'POST',
      body: JSON.stringify({
        fromWarehouseId: form.fromWarehouseId,
        toWarehouseId: form.toWarehouseId,
        note: form.note,
        lines: [{ productId: form.productId, quantity: form.quantity === '' ? 0 : form.quantity }],
      }),
    });
    setTransferOpen(false);
    load();
  }

  function openEditMov(m: Movement) {
    setEditMov(m);
    setMovForm({
      quantity: m.quantity,
      unitCost: m.unitCost,
      note: m.note || '',
      reference: m.reference || '',
    });
  }

  async function saveMov() {
    if (!editMov) return;
    await api(`/stock/movements/${editMov.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        quantity: movForm.quantity === '' ? 0 : movForm.quantity,
        unitCost: movForm.unitCost === '' ? 0 : movForm.unitCost,
        note: movForm.note || undefined,
        reference: movForm.reference || undefined,
      }),
    });
    setEditMov(null);
    load();
  }

  async function deleteMov(id: string) {
    if (!confirm('حذف الحركة وتعديل الرصيد؟')) return;
    try {
      await api(`/stock/movements/${id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'تعذر الحذف');
    }
  }

  function openEditBatch(b: Batch) {
    setEditBatch(b);
    setBatchForm({
      batchNumber: b.batchNumber || '',
      expiryDate: b.expiryDate ? b.expiryDate.slice(0, 10) : '',
      unitCost: b.unitCost,
    });
  }

  async function saveBatch() {
    if (!editBatch) return;
    await api(`/stock/batches/${editBatch.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        batchNumber: batchForm.batchNumber,
        expiryDate: batchForm.expiryDate || '',
        unitCost: batchForm.unitCost === '' ? undefined : batchForm.unitCost,
      }),
    });
    setEditBatch(null);
    load();
  }

  async function deleteBatch(id: string) {
    if (!confirm('حذف الدفعة وخصم كميتها من المخزون؟')) return;
    try {
      await api(`/stock/batches/${id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'تعذر الحذف');
    }
  }

  return (
    <div>
      <PageHeader
        title="المخزون"
        subtitle="الأرصدة · دفعات الشراء · التكلفة · الحركات"
        actions={
          <>
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer size={16} /> طباعة
            </Button>
            <Button variant="secondary" onClick={() => { setCountForm({ ...countForm, mode: 'set' }); setCountOpen(true); }}>جرد / رصيد افتتاحي</Button>
            <Button variant="secondary" onClick={async () => {
              setExpiryRows(await api('/stock/expiry?days=30'));
              setExpiryOpen(true);
            }}>صلاحية</Button>
            <Button variant="secondary" onClick={() => setLocOpen(true)}>مواقع المخزن</Button>
            <Button onClick={() => setTransferOpen(true)}>
              <ArrowLeftRight size={16} /> تحويل
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-nowrap items-center justify-start gap-2 no-print">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="بحث صنف / كود / مخزن..."
          className="!w-72 shrink-0"
        />
        <Select className="!w-52 shrink-0" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
          <option value="">كل المخازن</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </Select>
      </div>

      <PrintHeader
        title="تقرير المخزون والتكلفة"
        subtitle={warehouseId ? warehouses.find((w) => w.id === warehouseId)?.name : 'كل المخازن'}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3 no-print">
        <Card className="!bg-brand-50 !border-brand-200">
          <div className="text-xs text-brand-700">عدد الأصناف</div>
          <div className="text-2xl font-extrabold text-brand-900">{visibleItems.length}</div>
        </Card>
        <Card className="!bg-emerald-50 !border-emerald-200">
          <div className="text-xs text-emerald-700">إجمالي الكميات</div>
          <div className="text-2xl font-extrabold text-emerald-900">{visibleQty}</div>
        </Card>
        <Card className="!bg-amber-50 !border-amber-200">
          <div className="text-xs text-amber-800">إجمالي تكلفة المخزون</div>
          <div className="text-2xl font-extrabold text-amber-950">{formatMoney(visibleCost)}</div>
        </Card>
      </div>

      <div className="mb-4 flex gap-2 no-print">
        <Button variant={tab === 'balances' ? 'primary' : 'secondary'} onClick={() => setTab('balances')}>
          الأرصدة والدفعات
        </Button>
        <Button variant={tab === 'movements' ? 'primary' : 'secondary'} onClick={() => setTab('movements')}>
          الحركات
        </Button>
      </div>

      {tab === 'balances' ? (
        <Card>
          {visibleItems.length === 0 ? <Empty text="لا توجد أرصدة" /> : (
            <Table>
              <thead>
                <tr>
                  <Th>المخزن</Th>
                  <Th>الكود</Th>
                  <Th>الصنف</Th>
                  <Th>الكمية</Th>
                  <Th>تكلفة الوحدة</Th>
                  <Th>إجمالي التكلفة</Th>
                  <Th>الدفعات</Th>
                  <Th className="no-print"></Th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((b) => (
                  <tr key={b.id} className={b.quantity <= 0 ? 'bg-rose-50/70' : 'bg-emerald-50/40'}>
                    <Td>{b.warehouse.name}</Td>
                    <Td className="font-mono text-xs">{b.product.sku}</Td>
                    <Td className="font-semibold">{b.product.name}</Td>
                    <Td className="font-bold">{b.quantity} {b.product.unit}</Td>
                    <Td>{formatMoney(b.unitCost)}</Td>
                    <Td className="font-bold text-brand-800">{formatMoney(b.totalCost)}</Td>
                    <Td>
                      <span className="rounded-lg bg-brand-100 px-2 py-0.5 text-xs font-bold text-brand-800">
                        {b.batches.length} دفعة
                      </span>
                    </Td>
                    <Td className="no-print">
                      <Button variant="ghost" onClick={() => setDetail(b)}>
                        <Eye size={14} /> تفاصيل
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-brand-800 px-4 py-3 text-white">
            <span className="font-semibold">إجمالي تكلفة المخزون المعروض</span>
            <span className="text-xl font-extrabold">{formatMoney(visibleCost)}</span>
          </div>
        </Card>
      ) : (
        <Card>
          {visibleMovements.length === 0 ? <Empty text="لا توجد حركات" /> : (
            <Table>
              <thead>
                <tr>
                  <Th>التاريخ</Th>
                  <Th>النوع</Th>
                  <Th>المخزن</Th>
                  <Th>الصنف</Th>
                  <Th>الكمية</Th>
                  <Th>التكلفة</Th>
                  <Th>المرجع</Th>
                  <Th>ملاحظة / تشغيلة</Th>
                  <Th className="no-print"></Th>
                </tr>
              </thead>
              <tbody>
                {visibleMovements.map((m) => (
                  <tr key={m.id} className={`mov-${m.type}`}>
                    <Td className="text-xs">{formatDate(m.createdAt)}</Td>
                    <Td className="font-semibold">{MOV_LABELS[m.type] || m.type}</Td>
                    <Td>{m.warehouse.name}</Td>
                    <Td>
                      <div className="font-semibold">{m.product.name}</div>
                      <div className="font-mono text-xs text-muted">{m.product.sku}</div>
                    </Td>
                    <Td className="font-bold">{m.quantity}</Td>
                    <Td>{formatMoney(m.unitCost)}</Td>
                    <Td className="font-mono text-xs">{m.reference || '—'}</Td>
                    <Td className="text-sm">{m.note || '—'}</Td>
                    <Td className="no-print">
                      <div className="flex gap-1">
                        <Button variant="ghost" className="!px-2" onClick={() => openEditMov(m)}>
                          <Pencil size={14} />
                        </Button>
                        <Button variant="ghost" className="!px-2 text-rose-600" onClick={() => deleteMov(m.id)}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `دفعات — ${detail.product.name}` : ''} wide>
        {detail && (
          <div className="space-y-4">
            <PrintHeader title={`دفعات شراء: ${detail.product.name}`} subtitle={detail.warehouse.name} />
            <div className="grid gap-2 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2">
              <div>المخزن: <strong>{detail.warehouse.name}</strong></div>
              <div>الكود: <strong className="font-mono">{detail.product.sku}</strong></div>
              <div>الرصيد الحالي: <strong>{detail.quantity} {detail.product.unit}</strong></div>
              <div>تكلفة الوحدة (آخر شراء): <strong>{formatMoney(detail.unitCost)}</strong></div>
              <div className="sm:col-span-2 text-brand-800">
                إجمالي تكلفة الرصيد: <strong className="text-lg">{formatMoney(detail.totalCost)}</strong>
              </div>
            </div>

            {detail.product.fieldValues?.length > 0 && (
              <div className="rounded-xl border border-brand-100 bg-brand-50/50 p-3">
                <div className="mb-2 text-sm font-semibold text-brand-800">حقول الصنف الإضافية</div>
                <div className="grid gap-1 text-sm sm:grid-cols-2">
                  {detail.product.fieldValues.map((fv, i) => (
                    <div key={i}>{fv.field.label}: <strong>{fv.value}</strong></div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-between no-print">
              <div className="text-sm font-semibold text-slate-700">دفعات الشراء (تشغيلة / صلاحية / سعر)</div>
              <Button variant="secondary" onClick={() => window.print()}><Printer size={14} /> طباعة</Button>
            </div>

            {detail.batches.length === 0 ? (
              <Empty text="لا توجد فواتير شراء مؤكدة لهذا الصنف في هذا المخزن" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>الفاتورة</Th>
                    <Th>التاريخ</Th>
                    <Th>المورد</Th>
                    <Th>الكمية</Th>
                    <Th>سعر الشراء</Th>
                    <Th>الإجمالي</Th>
                    <Th>التشغيلة</Th>
                    <Th>الصلاحية</Th>
                    <Th className="no-print"></Th>
                  </tr>
                </thead>
                <tbody>
                  {detail.batches.map((b) => (
                    <tr key={b.id} className="mov-PURCHASE">
                      <Td className="font-semibold">{b.invoiceNumber}</Td>
                      <Td>{formatDate(b.invoiceDate)}</Td>
                      <Td>{b.supplierName}</Td>
                      <Td className="font-bold">{b.quantity}</Td>
                      <Td>{formatMoney(b.unitCost)}</Td>
                      <Td className="font-bold">{formatMoney(b.total)}</Td>
                      <Td>
                        {b.batchNumber
                          ? <span className="rounded-lg bg-brand-100 px-2 py-0.5 text-xs font-bold text-brand-800">{b.batchNumber}</span>
                          : <span className="text-muted">—</span>}
                      </Td>
                      <Td>{b.expiryDate ? formatDate(b.expiryDate) : '—'}</Td>
                      <Td className="no-print">
                        <div className="flex gap-1">
                          <Button variant="ghost" className="!px-2" onClick={() => openEditBatch(b)}>
                            <Pencil size={14} />
                          </Button>
                          <Button variant="ghost" className="!px-2 text-rose-600" onClick={() => deleteBatch(b.id)}>
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        )}
      </Modal>

      <Modal open={countOpen} onClose={() => setCountOpen(false)} title={countForm.mode === 'set' ? 'جرد أو رصيد افتتاحي' : 'تسوية كمية'}>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Button variant={countForm.mode === 'set' ? 'primary' : 'secondary'} onClick={() => setCountForm({ ...countForm, mode: 'set' })}>رصيد فعلي</Button>
            <Button variant={countForm.mode === 'delta' ? 'primary' : 'secondary'} onClick={() => setCountForm({ ...countForm, mode: 'delta' })}>فرق +/-</Button>
          </div>
          <div>
            <Label>المخزن</Label>
            <Select value={countForm.warehouseId} onChange={(e) => setCountForm({ ...countForm, warehouseId: e.target.value })}>
              <option value="">اختر</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>الصنف</Label>
            <Select value={countForm.productId} onChange={(e) => setCountForm({ ...countForm, productId: e.target.value })}>
              <option value="">اختر</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>{countForm.mode === 'set' ? 'الكمية المعدودة' : 'الفرق'}</Label>
            <NumberInput value={countForm.quantity} onValueChange={(v) => setCountForm({ ...countForm, quantity: v })} />
          </div>
          <div><Label>ملاحظة</Label><Input value={countForm.note} onChange={(e) => setCountForm({ ...countForm, note: e.target.value })} /></div>
          <Button className="w-full" onClick={async () => {
            await api('/stock/adjustments', {
              method: 'POST',
              body: JSON.stringify({
                warehouseId: countForm.warehouseId,
                mode: countForm.mode,
                note: countForm.note,
                lines: [{ productId: countForm.productId, quantity: countForm.quantity === '' ? 0 : countForm.quantity }],
              }),
            });
            setCountOpen(false);
            load();
          }}>حفظ</Button>
        </div>
      </Modal>

      <Modal open={expiryOpen} onClose={() => setExpiryOpen(false)} title="دفعات قرب انتهاء الصلاحية" wide>
        {expiryRows.length === 0 ? <Empty /> : (
          <Table>
            <thead><tr><Th>الصنف</Th><Th>المخزن</Th><Th>الفاتورة</Th><Th>التشغيلة</Th><Th>الكمية</Th><Th>الصلاحية</Th></tr></thead>
            <tbody>
              {expiryRows.map((row, i) => (
                <tr key={i} className={row.expired ? 'row-credit' : ''}>
                  <Td>{row.name}<div className="font-mono text-xs text-muted">{row.sku}</div></Td>
                  <Td>{row.warehouseName}</Td>
                  <Td>{row.invoiceNumber}</Td>
                  <Td>{row.batchNumber || '—'}</Td>
                  <Td>{row.quantity}</Td>
                  <Td>{formatDate(row.expiryDate)}{row.expired ? ' · منتهية' : ''}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Modal>

      <Modal open={locOpen} onClose={() => setLocOpen(false)} title="مواقع داخل المخزن">
        <div className="space-y-3">
          <div>
            <Label>المخزن</Label>
            <Select value={locForm.warehouseId} onChange={async (e) => {
              const warehouseId = e.target.value;
              setLocForm({ ...locForm, warehouseId });
              if (warehouseId) setLocations(await api(`/stock/locations?warehouseId=${warehouseId}`));
            }}>
              <option value="">اختر</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="كود الموقع" value={locForm.code} onChange={(e) => setLocForm({ ...locForm, code: e.target.value })} />
            <Input placeholder="اسم الرف" value={locForm.name} onChange={(e) => setLocForm({ ...locForm, name: e.target.value })} />
          </div>
          <Button variant="secondary" onClick={async () => {
            await api('/stock/locations', { method: 'POST', body: JSON.stringify({ warehouseId: locForm.warehouseId, code: locForm.code, name: locForm.name }) });
            setLocations(await api(`/stock/locations?warehouseId=${locForm.warehouseId}`));
          }}>إضافة موقع</Button>
          <div>
            <Label>ربط صنف بموقع</Label>
            <Select value={locForm.productId} onChange={(e) => setLocForm({ ...locForm, productId: e.target.value })}>
              <option value="">الصنف</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <Select className="mt-2" value={locForm.locationId} onChange={(e) => setLocForm({ ...locForm, locationId: e.target.value })}>
              <option value="">الموقع</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.code} - {l.name}</option>)}
            </Select>
          </div>
          <Button className="w-full" onClick={async () => {
            await api('/stock/product-locations', {
              method: 'POST',
              body: JSON.stringify({ productId: locForm.productId, warehouseId: locForm.warehouseId, locationId: locForm.locationId }),
            });
            setLocOpen(false);
          }}>حفظ الربط</Button>
        </div>
      </Modal>

      <Modal open={transferOpen} onClose={() => setTransferOpen(false)} title="تحويل بين مخازن">
        <div className="space-y-3">
          <div>
            <Label>من مخزن</Label>
            <Select value={form.fromWarehouseId} onChange={(e) => setForm({ ...form, fromWarehouseId: e.target.value })}>
              <option value="">اختر</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>إلى مخزن</Label>
            <Select value={form.toWarehouseId} onChange={(e) => setForm({ ...form, toWarehouseId: e.target.value })}>
              <option value="">اختر</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>الصنف</Label>
            <Select value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })}>
              <option value="">اختر</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>الكمية المحوّلة</Label>
            <NumberInput value={form.quantity} onValueChange={(v) => setForm({ ...form, quantity: v })} />
          </div>
          <div><Label>ملاحظة</Label><Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
          <Button className="w-full" onClick={transfer}>تنفيذ التحويل</Button>
        </div>
      </Modal>

      <Modal open={!!editMov} onClose={() => setEditMov(null)} title="تعديل حركة مخزون">
        <div className="space-y-3">
          <div>
            <Label>الكمية (موجبة وارد / سالبة صادر)</Label>
            <NumberInput value={movForm.quantity} onValueChange={(v) => setMovForm({ ...movForm, quantity: v })} />
          </div>
          <div>
            <Label>تكلفة الوحدة</Label>
            <NumberInput value={movForm.unitCost} onValueChange={(v) => setMovForm({ ...movForm, unitCost: v })} />
          </div>
          <div>
            <Label>المرجع</Label>
            <Input value={movForm.reference} onChange={(e) => setMovForm({ ...movForm, reference: e.target.value })} />
          </div>
          <div>
            <Label>ملاحظة</Label>
            <Input value={movForm.note} onChange={(e) => setMovForm({ ...movForm, note: e.target.value })} />
          </div>
          <Button className="w-full" onClick={saveMov}>حفظ</Button>
        </div>
      </Modal>

      <Modal open={!!editBatch} onClose={() => setEditBatch(null)} title="تعديل دفعة شراء">
        <div className="space-y-3">
          <div>
            <Label>رقم التشغيلة</Label>
            <Input value={batchForm.batchNumber} onChange={(e) => setBatchForm({ ...batchForm, batchNumber: e.target.value })} />
          </div>
          <div>
            <Label>تاريخ الصلاحية</Label>
            <Input type="date" value={batchForm.expiryDate} onChange={(e) => setBatchForm({ ...batchForm, expiryDate: e.target.value })} />
          </div>
          <div>
            <Label>سعر الشراء للوحدة</Label>
            <NumberInput value={batchForm.unitCost} onValueChange={(v) => setBatchForm({ ...batchForm, unitCost: v })} />
          </div>
          <Button className="w-full" onClick={saveBatch}>حفظ</Button>
        </div>
      </Modal>
    </div>
  );
}
