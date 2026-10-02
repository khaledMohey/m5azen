import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, formatDate, formatMoney } from '../lib/api';
import {
  Button, Card, Empty, Input, Label, Modal, NumberInput, PageHeader, SearchBox, Select, Table, Td, Th,
} from '../components/ui';

type Party = { id: string; name: string };

type SalesLine = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  returnedQty: number;
  remainingQty: number;
  unitPrice: number;
  selected: boolean;
  returnQty: number | '';
};

type PurchaseLine = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  returnedQty: number;
  remainingQty: number;
  unitCost: number;
  selected: boolean;
  returnQty: number | '';
};

type SalesInvoiceGroup = {
  id: string;
  number: string;
  invoiceDate: string;
  warehouseId: string;
  warehouseName: string;
  total: number;
  lines: SalesLine[];
};

type PurchaseInvoiceGroup = {
  id: string;
  number: string;
  invoiceDate: string;
  warehouseId: string;
  warehouseName: string;
  total: number;
  lines: PurchaseLine[];
};

type SalesReturn = {
  id: string; number: string; returnDate: string; total: number;
  customer: { name: string }; warehouse: { name: string };
  salesInvoice: { number: string } | null;
  lines: { quantity: number; unitPrice: number; total: number; product: { name: string } }[];
};

type PurchaseReturn = {
  id: string; number: string; returnDate: string; total: number;
  supplier: { name: string }; warehouse: { name: string };
  purchaseInvoice: { number: string } | null;
  lines: { quantity: number; unitCost: number; total: number; product: { name: string } }[];
};

type SalesApiInvoice = {
  id: string;
  number: string;
  invoiceDate: string;
  warehouseId: string;
  warehouseName: string;
  total: number;
  lines: {
    productId: string; sku: string; name: string; unit: string;
    quantity: number; returnedQty: number; remainingQty: number; unitPrice: number;
  }[];
};

type PurchaseApiInvoice = {
  id: string;
  number: string;
  invoiceDate: string;
  warehouseId: string;
  warehouseName: string;
  total: number;
  lines: {
    productId: string; sku: string; name: string; unit: string;
    quantity: number; returnedQty: number; remainingQty: number; unitCost: number;
  }[];
};

export function ReturnsPage() {
  const [tab, setTab] = useState<'sales' | 'purchases'>('sales');
  const [salesReturns, setSalesReturns] = useState<SalesReturn[]>([]);
  const [purchaseReturns, setPurchaseReturns] = useState<PurchaseReturn[]>([]);
  const [customers, setCustomers] = useState<Party[]>([]);
  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [warehouses, setWarehouses] = useState<Party[]>([]);
  const [open, setOpen] = useState(false);
  const [loadingItems, setLoadingItems] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const [salesForm, setSalesForm] = useState({
    customerId: '', warehouseId: '', notes: '',
  });
  const [purchaseForm, setPurchaseForm] = useState({
    supplierId: '', warehouseId: '', notes: '',
  });
  const [salesInvoices, setSalesInvoices] = useState<SalesInvoiceGroup[]>([]);
  const [purchaseInvoices, setPurchaseInvoices] = useState<PurchaseInvoiceGroup[]>([]);

  async function load() {
    const [sr, pr, c, s, w] = await Promise.all([
      api<SalesReturn[]>('/returns/sales'),
      api<PurchaseReturn[]>('/returns/purchases'),
      api<Party[]>('/customers'),
      api<Party[]>('/suppliers'),
      api<Party[]>('/warehouses'),
    ]);
    setSalesReturns(sr);
    setPurchaseReturns(pr);
    setCustomers(c);
    setSuppliers(s);
    setWarehouses(w);
  }

  useEffect(() => { load(); }, []);

  const filteredSales = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return salesReturns;
    return salesReturns.filter((r) =>
      [r.number, r.customer.name, r.warehouse.name, r.salesInvoice?.number].some((x) => x?.toLowerCase().includes(q)),
    );
  }, [salesReturns, search]);

  const filteredPurchases = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return purchaseReturns;
    return purchaseReturns.filter((r) =>
      [r.number, r.supplier.name, r.warehouse.name, r.purchaseInvoice?.number].some((x) => x?.toLowerCase().includes(q)),
    );
  }, [purchaseReturns, search]);

  async function loadSalesReturnable(customerId: string) {
    if (!customerId) {
      setSalesInvoices([]);
      return;
    }
    setLoadingItems(true);
    setError('');
    try {
      const res = await api<{ invoices: SalesApiInvoice[] }>(`/returns/sales/returnable/${customerId}`);
      setSalesInvoices(
        res.invoices.map((inv) => ({
          ...inv,
          lines: inv.lines.map((line) => ({ ...line, selected: false, returnQty: '' })),
        })),
      );
      if (res.invoices[0]?.warehouseId) {
        setSalesForm((f) => ({ ...f, warehouseId: f.warehouseId || res.invoices[0].warehouseId }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تحميل الأصناف');
      setSalesInvoices([]);
    } finally {
      setLoadingItems(false);
    }
  }

  async function loadPurchaseReturnable(supplierId: string) {
    if (!supplierId) {
      setPurchaseInvoices([]);
      return;
    }
    setLoadingItems(true);
    setError('');
    try {
      const res = await api<{ invoices: PurchaseApiInvoice[] }>(`/returns/purchases/returnable/${supplierId}`);
      setPurchaseInvoices(
        res.invoices.map((inv) => ({
          ...inv,
          lines: inv.lines.map((line) => ({ ...line, selected: false, returnQty: '' })),
        })),
      );
      if (res.invoices[0]?.warehouseId) {
        setPurchaseForm((f) => ({ ...f, warehouseId: f.warehouseId || res.invoices[0].warehouseId }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تحميل الأصناف');
      setPurchaseInvoices([]);
    } finally {
      setLoadingItems(false);
    }
  }

  function openModal() {
    setError('');
    setSalesForm({ customerId: '', warehouseId: '', notes: '' });
    setPurchaseForm({ supplierId: '', warehouseId: '', notes: '' });
    setSalesInvoices([]);
    setPurchaseInvoices([]);
    setOpen(true);
  }

  async function save() {
    setError('');
    try {
      if (tab === 'sales') {
        const chosen = salesInvoices.flatMap((inv) =>
          inv.lines
            .filter((line) => line.selected && line.returnQty !== '' && Number(line.returnQty) > 0)
            .map((line) => ({ inv, line })),
        );
        if (!salesForm.customerId) {
          setError('اختر العميل');
          return;
        }
        if (!chosen.length) {
          setError('حدد أصنافاً وكمية الإرجاع من الفواتير');
          return;
        }
        for (const { line } of chosen) {
          const qty = Number(line.returnQty || 0);
          if (qty > line.remainingQty) {
            setError(`الكمية المرتجعة للصنف ${line.name} أكبر من المتاح (${line.remainingQty})`);
            return;
          }
        }
        const byInvoice = new Map<string, typeof chosen>();
        for (const row of chosen) {
          const list = byInvoice.get(row.inv.id) || [];
          list.push(row);
          byInvoice.set(row.inv.id, list);
        }
        for (const [invoiceId, rows] of byInvoice) {
          await api('/returns/sales', {
            method: 'POST',
            body: JSON.stringify({
              customerId: salesForm.customerId,
              warehouseId: salesForm.warehouseId || rows[0].inv.warehouseId,
              salesInvoiceId: invoiceId,
              notes: salesForm.notes || undefined,
              lines: rows.map(({ line }) => ({
                productId: line.productId,
                quantity: Number(line.returnQty),
                unitPrice: line.unitPrice,
              })),
            }),
          });
        }
      } else {
        const chosen = purchaseInvoices.flatMap((inv) =>
          inv.lines
            .filter((line) => line.selected && line.returnQty !== '' && Number(line.returnQty) > 0)
            .map((line) => ({ inv, line })),
        );
        if (!purchaseForm.supplierId) {
          setError('اختر المورد');
          return;
        }
        if (!chosen.length) {
          setError('حدد أصنافاً وكمية الإرجاع من الفواتير');
          return;
        }
        for (const { line } of chosen) {
          const qty = Number(line.returnQty || 0);
          if (qty > line.remainingQty) {
            setError(`الكمية المرتجعة للصنف ${line.name} أكبر من المتاح (${line.remainingQty})`);
            return;
          }
        }
        const byInvoice = new Map<string, typeof chosen>();
        for (const row of chosen) {
          const list = byInvoice.get(row.inv.id) || [];
          list.push(row);
          byInvoice.set(row.inv.id, list);
        }
        for (const [invoiceId, rows] of byInvoice) {
          await api('/returns/purchases', {
            method: 'POST',
            body: JSON.stringify({
              supplierId: purchaseForm.supplierId,
              warehouseId: purchaseForm.warehouseId || rows[0].inv.warehouseId,
              purchaseInvoiceId: invoiceId,
              notes: purchaseForm.notes || undefined,
              lines: rows.map(({ line }) => ({
                productId: line.productId,
                quantity: Number(line.returnQty),
                unitCost: line.unitCost,
              })),
            }),
          });
        }
      }
      setOpen(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'فشل حفظ المرتجع');
    }
  }

  return (
    <div>
      <PageHeader
        title="المرتجعات"
        subtitle="مرتجع بيع ومرتجع شراء من الأصناف السابق التعامل عليها"
        actions={
          <>
            <SearchBox value={search} onChange={setSearch} placeholder="بحث مرتجع..." />
            <Button onClick={openModal}>
              <Plus size={16} /> {tab === 'sales' ? 'مرتجع بيع' : 'مرتجع شراء'}
            </Button>
          </>
        }
      />

      <div className="mb-4 flex gap-2 no-print">
        <Button variant={tab === 'sales' ? 'primary' : 'secondary'} onClick={() => setTab('sales')}>مرتجعات البيع</Button>
        <Button variant={tab === 'purchases' ? 'primary' : 'secondary'} onClick={() => setTab('purchases')}>مرتجعات الشراء</Button>
      </div>

      <Card>
        {tab === 'sales' ? (
          salesReturns.length === 0 ? <Empty /> : (
            <Table>
              <thead>
                <tr>
                  <Th>الرقم</Th>
                  <Th>العميل</Th>
                  <Th>فاتورة البيع</Th>
                  <Th>المخزن</Th>
                  <Th>التاريخ</Th>
                  <Th>الإجمالي</Th>
                </tr>
              </thead>
              <tbody>
                {filteredSales.map((r) => (
                  <tr key={r.id} className="row-credit">
                    <Td className="font-semibold">{r.number}</Td>
                    <Td>{r.customer.name}</Td>
                    <Td>{r.salesInvoice?.number || '—'}</Td>
                    <Td>{r.warehouse.name}</Td>
                    <Td>{formatDate(r.returnDate)}</Td>
                    <Td className="font-bold">{formatMoney(r.total)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        ) : (
          purchaseReturns.length === 0 ? <Empty /> : (
            <Table>
              <thead>
                <tr>
                  <Th>الرقم</Th>
                  <Th>المورد</Th>
                  <Th>فاتورة الشراء</Th>
                  <Th>المخزن</Th>
                  <Th>التاريخ</Th>
                  <Th>الإجمالي</Th>
                </tr>
              </thead>
              <tbody>
                {filteredPurchases.map((r) => (
                  <tr key={r.id} className="row-debit">
                    <Td className="font-semibold">{r.number}</Td>
                    <Td>{r.supplier.name}</Td>
                    <Td>{r.purchaseInvoice?.number || '—'}</Td>
                    <Td>{r.warehouse.name}</Td>
                    <Td>{formatDate(r.returnDate)}</Td>
                    <Td className="font-bold">{formatMoney(r.total)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        )}
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title={tab === 'sales' ? 'مرتجع بيع' : 'مرتجع شراء'} wide>
        {tab === 'sales' ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>العميل</Label>
                <Select
                  value={salesForm.customerId}
                  onChange={(e) => {
                    const customerId = e.target.value;
                    setSalesForm({ ...salesForm, customerId });
                    loadSalesReturnable(customerId);
                  }}
                >
                  <option value="">اختر العميل</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </div>
              <div>
                <Label>المخزن المستلم للمرتجع</Label>
                <Select value={salesForm.warehouseId} onChange={(e) => setSalesForm({ ...salesForm, warehouseId: e.target.value })}>
                  <option value="">اختر المخزن</option>
                  {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </Select>
              </div>
            </div>

            {loadingItems && <div className="text-sm text-muted">جاري تحميل أصناف العميل...</div>}

            {!loadingItems && salesForm.customerId && salesInvoices.length === 0 && (
              <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
                لا توجد فواتير قابلة للإرجاع لهذا العميل
              </div>
            )}

            {salesInvoices.map((inv) => (
              <div key={inv.id} className="rounded-xl border border-brand-200 bg-brand-50/40 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-bold text-brand-900">فاتورة {inv.number}</div>
                    <div className="text-xs text-muted">{formatDate(inv.invoiceDate)} · {inv.warehouseName}</div>
                  </div>
                  <div className="text-sm font-semibold">{formatMoney(inv.total)}</div>
                </div>
                <Table>
                  <thead>
                    <tr>
                      <Th></Th>
                      <Th>الصنف</Th>
                      <Th>مباع</Th>
                      <Th>مرتجع</Th>
                      <Th>متاح</Th>
                      <Th>السعر</Th>
                      <Th>كمية الإرجاع</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.lines.map((line) => (
                      <tr key={line.productId} className={line.selected ? 'bg-white' : ''}>
                        <Td>
                          <input
                            type="checkbox"
                            checked={line.selected}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setSalesInvoices((prev) => prev.map((row) => row.id !== inv.id ? row : {
                                ...row,
                                lines: row.lines.map((item) => item.productId !== line.productId ? item : {
                                  ...item,
                                  selected: checked,
                                  returnQty: checked ? (item.returnQty === '' ? item.remainingQty : item.returnQty) : '',
                                }),
                              }));
                            }}
                          />
                        </Td>
                        <Td>
                          <div className="font-semibold">{line.name}</div>
                          <div className="font-mono text-xs text-muted">{line.sku}</div>
                        </Td>
                        <Td>{line.quantity}</Td>
                        <Td>{line.returnedQty}</Td>
                        <Td className="font-bold text-brand-700">{line.remainingQty}</Td>
                        <Td>{formatMoney(line.unitPrice)}</Td>
                        <Td>
                          <NumberInput
                            className="w-24"
                            value={line.returnQty}
                            onValueChange={(v) => {
                              setSalesInvoices((prev) => prev.map((row) => row.id !== inv.id ? row : {
                                ...row,
                                lines: row.lines.map((item) => item.productId !== line.productId ? item : {
                                  ...item, selected: true, returnQty: v,
                                }),
                              }));
                            }}
                          />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            ))}

            <div>
              <Label>ملاحظات</Label>
              <Input value={salesForm.notes} onChange={(e) => setSalesForm({ ...salesForm, notes: e.target.value })} />
            </div>
            {error && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
            <Button className="w-full" onClick={save}>حفظ المرتجع</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>المورد</Label>
                <Select
                  value={purchaseForm.supplierId}
                  onChange={(e) => {
                    const supplierId = e.target.value;
                    setPurchaseForm({ ...purchaseForm, supplierId });
                    loadPurchaseReturnable(supplierId);
                  }}
                >
                  <option value="">اختر المورد</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </div>
              <div>
                <Label>المخزن الخارج منه المرتجع</Label>
                <Select value={purchaseForm.warehouseId} onChange={(e) => setPurchaseForm({ ...purchaseForm, warehouseId: e.target.value })}>
                  <option value="">اختر المخزن</option>
                  {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </Select>
              </div>
            </div>

            {loadingItems && <div className="text-sm text-muted">جاري تحميل أصناف المورد...</div>}

            {!loadingItems && purchaseForm.supplierId && purchaseInvoices.length === 0 && (
              <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
                لا توجد فواتير قابلة للإرجاع من هذا المورد
              </div>
            )}

            {purchaseInvoices.map((inv) => (
              <div key={inv.id} className="rounded-xl border border-amber-200 bg-amber-50/40 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-bold text-amber-950">فاتورة {inv.number}</div>
                    <div className="text-xs text-muted">{formatDate(inv.invoiceDate)} · {inv.warehouseName}</div>
                  </div>
                  <div className="text-sm font-semibold">{formatMoney(inv.total)}</div>
                </div>
                <Table>
                  <thead>
                    <tr>
                      <Th></Th>
                      <Th>الصنف</Th>
                      <Th>مشترى</Th>
                      <Th>مرتجع</Th>
                      <Th>متاح</Th>
                      <Th>التكلفة</Th>
                      <Th>كمية الإرجاع</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.lines.map((line) => (
                      <tr key={line.productId} className={line.selected ? 'bg-white' : ''}>
                        <Td>
                          <input
                            type="checkbox"
                            checked={line.selected}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setPurchaseInvoices((prev) => prev.map((row) => row.id !== inv.id ? row : {
                                ...row,
                                lines: row.lines.map((item) => item.productId !== line.productId ? item : {
                                  ...item,
                                  selected: checked,
                                  returnQty: checked ? (item.returnQty === '' ? item.remainingQty : item.returnQty) : '',
                                }),
                              }));
                            }}
                          />
                        </Td>
                        <Td>
                          <div className="font-semibold">{line.name}</div>
                          <div className="font-mono text-xs text-muted">{line.sku}</div>
                        </Td>
                        <Td>{line.quantity}</Td>
                        <Td>{line.returnedQty}</Td>
                        <Td className="font-bold text-brand-700">{line.remainingQty}</Td>
                        <Td>{formatMoney(line.unitCost)}</Td>
                        <Td>
                          <NumberInput
                            className="w-24"
                            value={line.returnQty}
                            onValueChange={(v) => {
                              setPurchaseInvoices((prev) => prev.map((row) => row.id !== inv.id ? row : {
                                ...row,
                                lines: row.lines.map((item) => item.productId !== line.productId ? item : {
                                  ...item, selected: true, returnQty: v,
                                }),
                              }));
                            }}
                          />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            ))}

            <div>
              <Label>ملاحظات</Label>
              <Input value={purchaseForm.notes} onChange={(e) => setPurchaseForm({ ...purchaseForm, notes: e.target.value })} />
            </div>
            {error && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
            <Button className="w-full" onClick={save}>حفظ المرتجع</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
