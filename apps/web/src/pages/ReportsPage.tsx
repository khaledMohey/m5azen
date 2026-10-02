import { useEffect, useMemo, useState } from 'react';
import { Download, FileSpreadsheet, Printer } from 'lucide-react';
import ExcelJS from 'exceljs';
import { api, formatDate, formatMoney, getApiBase } from '../lib/api';
import {
  Button, Card, Empty, Input, Label, PageHeader, PrintHeader, SearchBox, Select, StatusBadge, Table, Td, Th,
} from '../components/ui';

type InventoryRow = {
  quantity: number;
  product: { sku: string; name: string; unit: string; costPrice: number; salePrice: number };
  warehouse: { name: string };
};

type SalesReport = {
  invoices: { number: string; total: number; paidAmount: number; status: string; invoiceDate: string; customer: { name: string } }[];
  total: number;
  paid: number;
  count: number;
};

type Profit = {
  salesTotal: number;
  purchasesTotal: number;
  grossProfit: number;
  salesCount: number;
  purchasesCount: number;
  revenue?: number;
  cogs?: number;
  netProfit?: number;
};

type ProductRow = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  costPrice: number;
  salePrice: number;
  stockQty: number;
  quantity: number;
  amount: number;
};

type LossRow = ProductRow & { revenue: number; cost: number; loss: number };

type UnderpricedRow = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  stockQty: number;
  costPrice: number;
  salePrice: number;
  gap: number;
  potentialLoss: number;
};

type UnsoldRow = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  stockQty: number;
  stockValue: number;
  purchasedQty: number;
  costPrice: number;
  salePrice: number;
};

type ProductInsights = {
  topSold: ProductRow[];
  topPurchased: ProductRow[];
  losses: LossRow[];
  lossTotal: number;
  underpriced: UnderpricedRow[];
  potentialLossTotal: number;
  unsold: UnsoldRow[];
  unsoldValue: number;
};

export function ReportsPage() {
  const [tab, setTab] = useState<'inventory' | 'sales' | 'profit' | 'cash' | 'products'>('inventory');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [sales, setSales] = useState<SalesReport | null>(null);
  const [profit, setProfit] = useState<Profit | null>(null);
  const [cash, setCash] = useState<{ totalIn: number; totalOut: number; net: number; transactions: { direction: string; amount: number; description: string; createdAt: string; account: { name: string } }[] } | null>(null);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState<ProductInsights | null>(null);

  const filteredInventory = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return inventory;
    return inventory.filter((r) =>
      [r.product.sku, r.product.name, r.warehouse.name].some((x) => x.toLowerCase().includes(q)),
    );
  }, [inventory, search]);

  const productQuery = search.trim().toLowerCase();
  const matchProduct = (row: { sku: string; name: string }) =>
    !productQuery || [row.sku, row.name].some((value) => value.toLowerCase().includes(productQuery));
  const visibleSold = products?.topSold.filter(matchProduct) || [];
  const visiblePurchased = products?.topPurchased.filter(matchProduct) || [];
  const visibleLosses = products?.losses.filter(matchProduct) || [];
  const visibleUnderpriced = products?.underpriced.filter(matchProduct) || [];
  const visibleUnsold = products?.unsold.filter(matchProduct) || [];

  async function load() {
    const w = await api<{ id: string; name: string }[]>('/warehouses');
    setWarehouses(w);
    const q = [
      from ? `from=${from}` : '',
      to ? `to=${to}` : '',
    ].filter(Boolean).join('&');
    const suffix = q ? `?${q}` : '';

    if (tab === 'inventory') {
      const iq = warehouseId ? `?warehouseId=${warehouseId}` : '';
      setInventory(await api<InventoryRow[]>(`/reports/inventory${iq}`));
    } else if (tab === 'sales') {
      setSales(await api<SalesReport>(`/reports/sales${suffix}`));
    } else if (tab === 'profit') {
      setProfit(await api<Profit>(`/reports/profit${suffix}`));
    } else if (tab === 'cash') {
      setCash(await api(`/reports/cash${suffix}`));
    } else {
      setProducts(await api<ProductInsights>(`/reports/products${suffix}`));
    }
  }

  useEffect(() => { load(); }, [tab, warehouseId]);

  async function exportExcel() {
    if (tab === 'inventory') {
      const token = localStorage.getItem('m5azen_token');
      const q = warehouseId ? `?warehouseId=${warehouseId}` : '';
      const res = await fetch(`${getApiBase()}/api/reports/inventory/excel${q}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'inventory.xlsx';
      a.click();
      return;
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('تقرير');
    if (tab === 'sales' && sales) {
      ws.columns = [
        { header: 'الرقم', key: 'number', width: 14 },
        { header: 'العميل', key: 'customer', width: 24 },
        { header: 'التاريخ', key: 'date', width: 14 },
        { header: 'الإجمالي', key: 'total', width: 14 },
        { header: 'المدفوع', key: 'paid', width: 14 },
        { header: 'الحالة', key: 'status', width: 12 },
      ];
      sales.invoices.forEach((i) => {
        ws.addRow({
          number: i.number,
          customer: i.customer.name,
          date: formatDate(i.invoiceDate),
          total: i.total,
          paid: i.paidAmount,
          status: i.status,
        });
      });
    } else if (tab === 'profit' && profit) {
      ws.addRow(['البند', 'القيمة']);
      ws.addRow(['إجمالي المبيعات', profit.salesTotal]);
      ws.addRow(['إجمالي المشتريات', profit.purchasesTotal]);
      ws.addRow(['إجمالي الربح', profit.grossProfit]);
    } else if (tab === 'products' && products) {
      const soldSheet = wb.addWorksheet('الأكثر مبيعاً');
      soldSheet.columns = [
        { header: 'الصنف', key: 'name', width: 28 },
        { header: 'الكود', key: 'sku', width: 14 },
        { header: 'الكمية', key: 'quantity', width: 12 },
        { header: 'الإيراد', key: 'amount', width: 14 },
      ];
      products.topSold.forEach((row) => soldSheet.addRow(row));
      const buySheet = wb.addWorksheet('الأكثر شراءً');
      buySheet.columns = [
        { header: 'الصنف', key: 'name', width: 28 },
        { header: 'الكود', key: 'sku', width: 14 },
        { header: 'الكمية', key: 'quantity', width: 12 },
        { header: 'التكلفة', key: 'amount', width: 14 },
      ];
      products.topPurchased.forEach((row) => buySheet.addRow(row));
      const lossSheet = wb.addWorksheet('الخسارة');
      lossSheet.columns = [
        { header: 'الصنف', key: 'name', width: 28 },
        { header: 'كمية مباعة', key: 'quantity', width: 14 },
        { header: 'إيراد', key: 'revenue', width: 14 },
        { header: 'تكلفة', key: 'cost', width: 14 },
        { header: 'خسارة', key: 'loss', width: 14 },
      ];
      products.losses.forEach((row) => lossSheet.addRow(row));
      const pricedSheet = wb.addWorksheet('تحت التكلفة');
      pricedSheet.columns = [
        { header: 'الصنف', key: 'name', width: 28 },
        { header: 'المخزون', key: 'stockQty', width: 12 },
        { header: 'التكلفة', key: 'costPrice', width: 14 },
        { header: 'سعر البيع', key: 'salePrice', width: 14 },
        { header: 'خسارة متوقعة', key: 'potentialLoss', width: 16 },
      ];
      products.underpriced.forEach((row) => pricedSheet.addRow(row));
      const deadSheet = wb.addWorksheet('لا تباع');
      deadSheet.columns = [
        { header: 'الصنف', key: 'name', width: 28 },
        { header: 'الكود', key: 'sku', width: 14 },
        { header: 'المخزون', key: 'stockQty', width: 12 },
        { header: 'قيمة المخزون', key: 'stockValue', width: 16 },
      ];
      products.unsold.forEach((row) => deadSheet.addRow(row));
    } else if (tab === 'cash' && cash) {
      ws.columns = [
        { header: 'التاريخ', key: 'date', width: 14 },
        { header: 'الحساب', key: 'account', width: 18 },
        { header: 'الوصف', key: 'desc', width: 30 },
        { header: 'النوع', key: 'dir', width: 10 },
        { header: 'المبلغ', key: 'amount', width: 12 },
      ];
      cash.transactions.forEach((t) => {
        ws.addRow({
          date: formatDate(t.createdAt),
          account: t.account.name,
          desc: t.description,
          dir: t.direction === 'IN' ? 'وارد' : 'صادر',
          amount: t.amount,
        });
      });
    }
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `report-${tab}.xlsx`;
    a.click();
  }

  return (
    <div>
      <PageHeader
        title="التقارير"
        subtitle="تقارير المخزون والمبيعات والأرباح والخزنة — طباعة و Excel"
        actions={
          <>
            <SearchBox value={search} onChange={setSearch} placeholder="بحث في التقرير..." />
            <Button variant="secondary" onClick={() => window.print()}><Printer size={16} /> طباعة / PDF</Button>
            <Button variant="secondary" onClick={exportExcel}><FileSpreadsheet size={16} /> Excel</Button>
            <Button onClick={load}><Download size={16} /> تحديث</Button>
          </>
        }
      />

      <PrintHeader title="تقرير AK Tech" subtitle={tab === 'inventory' ? 'المخزون' : tab === 'sales' ? 'المبيعات' : tab === 'profit' ? 'الأرباح' : tab === 'products' ? 'المنتجات' : 'الخزنة'} />

      <div className="mb-4 flex flex-wrap gap-2 no-print">
        {([
          ['inventory', 'المخزون'],
          ['sales', 'المبيعات'],
          ['products', 'المنتجات'],
          ['profit', 'الأرباح'],
          ['cash', 'الخزنة'],
        ] as const).map(([k, label]) => (
          <Button key={k} variant={tab === k ? 'primary' : 'secondary'} onClick={() => setTab(k)}>
            {label}
          </Button>
        ))}
      </div>

      <Card className="mb-4 no-print">
        <div className="grid gap-3 sm:grid-cols-4">
          {tab === 'inventory' ? (
            <div>
              <Label>المخزن</Label>
              <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">الكل</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </div>
          ) : (
            <>
              <div><Label>من تاريخ</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
              <div><Label>إلى تاريخ</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
              <div className="flex items-end"><Button onClick={load}>تطبيق الفلتر</Button></div>
            </>
          )}
        </div>
      </Card>

      {tab === 'inventory' && (
        <Card>
          {filteredInventory.length === 0 ? <Empty /> : (
            <Table>
              <thead>
                <tr>
                  <Th>المخزن</Th>
                  <Th>الكود</Th>
                  <Th>الصنف</Th>
                  <Th>كمية</Th>
                  <Th>تكلفة</Th>
                  <Th>بيع</Th>
                  <Th>قيمة</Th>
                </tr>
              </thead>
              <tbody>
                {filteredInventory.map((r, i) => (
                  <tr key={i}>
                    <Td>{r.warehouse.name}</Td>
                    <Td className="font-mono text-xs">{r.product.sku}</Td>
                    <Td>{r.product.name}</Td>
                    <Td className="font-bold">{r.quantity}</Td>
                    <Td>{formatMoney(r.product.costPrice)}</Td>
                    <Td>{formatMoney(r.product.salePrice)}</Td>
                    <Td>{formatMoney(r.quantity * r.product.costPrice)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'sales' && sales && (
        <Card>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-emerald-50 p-3"><div className="text-xs text-muted">الإجمالي</div><div className="text-xl font-extrabold">{formatMoney(sales.total)}</div></div>
            <div className="rounded-xl bg-sky-50 p-3"><div className="text-xs text-muted">المحصل</div><div className="text-xl font-extrabold">{formatMoney(sales.paid)}</div></div>
            <div className="rounded-xl bg-amber-50 p-3"><div className="text-xs text-muted">عدد الفواتير</div><div className="text-xl font-extrabold">{sales.count}</div></div>
          </div>
          <Table>
            <thead>
              <tr>
                <Th>الرقم</Th>
                <Th>العميل</Th>
                <Th>التاريخ</Th>
                <Th>الإجمالي</Th>
                <Th>الحالة</Th>
              </tr>
            </thead>
            <tbody>
              {sales.invoices.map((i) => (
                <tr key={i.number} className={`status-${i.status}`}>
                  <Td>{i.number}</Td>
                  <Td>{i.customer.name}</Td>
                  <Td>{formatDate(i.invoiceDate)}</Td>
                  <Td>{formatMoney(i.total)}</Td>
                  <Td><StatusBadge status={i.status} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {tab === 'products' && products && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-xl bg-rose-50 p-3">
              <div className="text-xs text-muted">خسارة محققة</div>
              <div className="text-xl font-extrabold text-rose-800">{formatMoney(products.lossTotal)}</div>
            </div>
            <div className="rounded-xl bg-orange-50 p-3">
              <div className="text-xs text-muted">خسارة متوقعة على المخزون</div>
              <div className="text-xl font-extrabold text-orange-800">{formatMoney(products.potentialLossTotal)}</div>
            </div>
            <div className="rounded-xl bg-amber-50 p-3">
              <div className="text-xs text-muted">أصناف لا تُباع</div>
              <div className="text-xl font-extrabold">{products.unsold.length}</div>
            </div>
            <div className="rounded-xl bg-slate-50 p-3">
              <div className="text-xs text-muted">قيمة المخزون الراكد</div>
              <div className="text-xl font-extrabold">{formatMoney(products.unsoldValue)}</div>
            </div>
          </div>

          <Card>
            <div className="mb-3 font-bold text-emerald-800">الأكثر مبيعاً</div>
            {visibleSold.length === 0 ? <Empty /> : (
              <Table>
                <thead>
                  <tr>
                    <Th>#</Th>
                    <Th>الصنف</Th>
                    <Th>الكمية</Th>
                    <Th>الإيراد</Th>
                    <Th>متوسط السعر</Th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSold.map((row, index) => (
                    <tr key={row.productId} className="row-debit">
                      <Td>{index + 1}</Td>
                      <Td>
                        <div className="font-semibold">{row.name}</div>
                        <div className="font-mono text-xs text-muted">{row.sku}</div>
                      </Td>
                      <Td className="font-bold">{row.quantity} {row.unit}</Td>
                      <Td>{formatMoney(row.amount)}</Td>
                      <Td>{formatMoney(row.quantity ? row.amount / row.quantity : 0)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <div className="mb-3 font-bold text-sky-800">الأكثر شراءً</div>
            {visiblePurchased.length === 0 ? <Empty /> : (
              <Table>
                <thead>
                  <tr>
                    <Th>#</Th>
                    <Th>الصنف</Th>
                    <Th>الكمية</Th>
                    <Th>التكلفة</Th>
                    <Th>متوسط التكلفة</Th>
                  </tr>
                </thead>
                <tbody>
                  {visiblePurchased.map((row, index) => (
                    <tr key={row.productId}>
                      <Td>{index + 1}</Td>
                      <Td>
                        <div className="font-semibold">{row.name}</div>
                        <div className="font-mono text-xs text-muted">{row.sku}</div>
                      </Td>
                      <Td className="font-bold">{row.quantity} {row.unit}</Td>
                      <Td>{formatMoney(row.amount)}</Td>
                      <Td>{formatMoney(row.quantity ? row.amount / row.quantity : 0)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <div className="mb-1 font-bold text-rose-800">الخسارة المحققة</div>
            <div className="mb-3 text-xs text-muted">أصناف اتباعت وإيرادها أقل من تكلفتها الحالية</div>
            {visibleLosses.length === 0 ? <Empty /> : (
              <Table>
                <thead>
                  <tr>
                    <Th>الصنف</Th>
                    <Th>كمية مباعة</Th>
                    <Th>إيراد</Th>
                    <Th>تكلفة</Th>
                    <Th>خسارة</Th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLosses.map((row) => (
                    <tr key={row.productId} className="row-credit">
                      <Td>
                        <div className="font-semibold">{row.name}</div>
                        <div className="font-mono text-xs text-muted">{row.sku}</div>
                      </Td>
                      <Td>{row.quantity}</Td>
                      <Td>{formatMoney(row.revenue)}</Td>
                      <Td>{formatMoney(row.cost)}</Td>
                      <Td className="font-bold text-rose-700">{formatMoney(row.loss)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <div className="mb-1 font-bold text-orange-800">سعر البيع أقل من التكلفة</div>
            <div className="mb-3 text-xs text-muted">خسارة متوقعة لو المخزون الحالي اتباع بسعر البيع المسجّل</div>
            {visibleUnderpriced.length === 0 ? <Empty /> : (
              <Table>
                <thead>
                  <tr>
                    <Th>الصنف</Th>
                    <Th>المخزون</Th>
                    <Th>التكلفة</Th>
                    <Th>سعر البيع</Th>
                    <Th>الفرق</Th>
                    <Th>خسارة متوقعة</Th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUnderpriced.map((row) => (
                    <tr key={row.productId}>
                      <Td>
                        <div className="font-semibold">{row.name}</div>
                        <div className="font-mono text-xs text-muted">{row.sku}</div>
                      </Td>
                      <Td>{row.stockQty}</Td>
                      <Td>{formatMoney(row.costPrice)}</Td>
                      <Td>{formatMoney(row.salePrice)}</Td>
                      <Td>{formatMoney(row.gap)}</Td>
                      <Td className="font-bold text-orange-700">{formatMoney(row.potentialLoss)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <div className="mb-1 font-bold text-amber-900">منتجات لا تُباع</div>
            <div className="mb-3 text-xs text-muted">مخزون أو مشتريات من غير أي بيع في الفترة</div>
            {visibleUnsold.length === 0 ? <Empty /> : (
              <Table>
                <thead>
                  <tr>
                    <Th>الصنف</Th>
                    <Th>المخزون</Th>
                    <Th>قيمة المخزون</Th>
                    <Th>مشترى</Th>
                    <Th>التكلفة</Th>
                    <Th>سعر البيع</Th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUnsold.map((row) => (
                    <tr key={row.productId}>
                      <Td>
                        <div className="font-semibold">{row.name}</div>
                        <div className="font-mono text-xs text-muted">{row.sku}</div>
                      </Td>
                      <Td className="font-bold">{row.stockQty} {row.unit}</Td>
                      <Td>{formatMoney(row.stockValue)}</Td>
                      <Td>{row.purchasedQty}</Td>
                      <Td>{formatMoney(row.costPrice)}</Td>
                      <Td>{formatMoney(row.salePrice)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {tab === 'profit' && profit && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="bg-emerald-50 border-emerald-100">
            <div className="text-sm text-muted">صافي إيراد البيع</div>
            <div className="mt-2 text-3xl font-extrabold text-emerald-800">{formatMoney(profit.revenue ?? profit.salesTotal)}</div>
            <div className="mt-1 text-xs text-muted">بعد المرتجعات</div>
          </Card>
          <Card className="bg-sky-50 border-sky-100">
            <div className="text-sm text-muted">تكلفة البضاعة المباعة</div>
            <div className="mt-2 text-3xl font-extrabold text-sky-800">{formatMoney(profit.cogs || 0)}</div>
            <div className="mt-1 text-xs text-muted">من تكلفة الصنف وقت البيع</div>
          </Card>
          <Card className="bg-amber-50 border-amber-100">
            <div className="text-sm text-muted">مجمل الربح</div>
            <div className="mt-2 text-3xl font-extrabold text-amber-800">{formatMoney(profit.netProfit ?? profit.grossProfit)}</div>
            <div className="mt-1 text-xs text-muted">الإيراد ناقص تكلفة البضاعة. فرق الفواتير {formatMoney(profit.grossProfit)}</div>
          </Card>
        </div>
      )}

      {tab === 'cash' && cash && (
        <Card>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-emerald-50 p-3"><div className="text-xs text-muted">وارد</div><div className="text-xl font-extrabold">{formatMoney(cash.totalIn)}</div></div>
            <div className="rounded-xl bg-rose-50 p-3"><div className="text-xs text-muted">صادر</div><div className="text-xl font-extrabold">{formatMoney(cash.totalOut)}</div></div>
            <div className="rounded-xl bg-brand-50 p-3"><div className="text-xs text-muted">صافي</div><div className="text-xl font-extrabold">{formatMoney(cash.net)}</div></div>
          </div>
          <Table>
            <thead>
              <tr>
                <Th>التاريخ</Th>
                <Th>الحساب</Th>
                <Th>الوصف</Th>
                <Th>النوع</Th>
                <Th>المبلغ</Th>
              </tr>
            </thead>
            <tbody>
              {cash.transactions.map((t, i) => (
                <tr key={i} className={t.direction === 'IN' ? 'row-debit' : 'row-credit'}>
                  <Td>{formatDate(t.createdAt)}</Td>
                  <Td>{t.account.name}</Td>
                  <Td>{t.description}</Td>
                  <Td>{t.direction === 'IN' ? 'وارد' : 'صادر'}</Td>
                  <Td className="font-bold">{formatMoney(t.amount)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
