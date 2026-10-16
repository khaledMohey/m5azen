import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowDownLeft, ArrowUpRight, Boxes, Coins, Download, FileSpreadsheet, Package, PackageX, Percent, Printer, ShoppingCart,
  TrendingDown, TrendingUp, Wallet,
} from 'lucide-react';
import ExcelJS from 'exceljs';
import { api, formatDate, formatMoney, getApiBase } from '../lib/api';
import { DueAmount } from '../components/DueAmount';
import {
  Badge, Button, Card, CardHeader, Empty, Input, Label, PageHeader, PrintHeader, SearchBox, Select, StatCard, StatGrid, StatusBadge, Table, Td, Th,
} from '../components/ui';

function ProfitView({ revenue, cogs, gross, invoiceDiff }: { revenue: number; cogs: number; gross: number; invoiceDiff: number }) {
  const margin = revenue > 0 ? (gross / revenue) * 100 : 0;
  const cogsPct = revenue > 0 ? Math.min(100, Math.max(0, (cogs / revenue) * 100)) : 0;
  return (
    <div className="space-y-4">
      <StatGrid>
        <StatCard label="صافي إيراد البيع" value={formatMoney(revenue)} hint="بعد المرتجعات" icon={ShoppingCart} tone="emerald" />
        <StatCard label="تكلفة البضاعة المباعة" value={formatMoney(cogs)} hint="من تكلفة الصنف وقت البيع" icon={Coins} tone="sky" />
        <StatCard label="مجمل الربح" value={<span className={gross >= 0 ? 'text-emerald-700' : 'text-rose-600'}>{formatMoney(gross)}</span>} hint={`فرق الفواتير ${formatMoney(invoiceDiff)}`} icon={TrendingUp} tone={gross >= 0 ? 'amber' : 'rose'} />
        <StatCard label="هامش الربح" value={`${margin.toFixed(1)}%`} hint="مجمل الربح ÷ الإيراد" icon={Percent} tone="violet" />
      </StatGrid>
      <Card>
        <CardHeader title="تركيب الإيراد" subtitle="كم من كل جنيه مبيعات يذهب للتكلفة وكم يبقى ربحًا" icon={TrendingUp} />
        <div className="flex h-5 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full bg-gradient-to-l from-sky-400 to-sky-600 transition-all" style={{ width: `${cogsPct}%` }} />
          <div className="h-full bg-gradient-to-l from-emerald-400 to-emerald-600 transition-all" style={{ width: `${Math.max(0, 100 - cogsPct)}%` }} />
        </div>
        <div className="mt-3 flex flex-wrap justify-between gap-3 text-sm">
          <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-sky-500" /> تكلفة البضاعة <b className="tabular-nums">{cogsPct.toFixed(1)}%</b></span>
          <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-emerald-500" /> مجمل الربح <b className="tabular-nums">{(100 - cogsPct).toFixed(1)}%</b></span>
        </div>
      </Card>
    </div>
  );
}

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
  const [salesCols, setSalesCols] = useState({ customer: true, date: true, total: true, status: true });
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

  async function load(nextFrom = from, nextTo = to) {
    const w = await api<{ id: string; name: string }[]>('/warehouses');
    setWarehouses(w);
    const q = [
      nextFrom ? `from=${nextFrom}` : '',
      nextTo ? `to=${nextTo}` : '',
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

  function applyPreset(kind: 'today' | 'week' | 'month' | 'year') {
    const end = new Date();
    const start = new Date();
    if (kind === 'week') start.setDate(end.getDate() - 6);
    if (kind === 'month') start.setDate(1);
    if (kind === 'year') start.setMonth(0, 1);
    const iso = (value: Date) => new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const range = { from: iso(start), to: iso(end) };
    setFrom(range.from);
    setTo(range.to);
    localStorage.setItem('m5azen_report_range', JSON.stringify(range));
    load(range.from, range.to);
  }

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
            <Button onClick={() => load()}><Download size={16} /> تحديث</Button>
          </>
        }
      />

      <PrintHeader title="تقرير AK Tech" subtitle={tab === 'inventory' ? 'المخزون' : tab === 'sales' ? 'المبيعات' : tab === 'profit' ? 'الأرباح' : tab === 'products' ? 'المنتجات' : 'الخزنة'} />

      <div className="mb-4 grid grid-cols-2 gap-2 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm sm:grid-cols-5 no-print">
        {([
          ['inventory', 'المخزون', Boxes],
          ['sales', 'المبيعات', ShoppingCart],
          ['products', 'المنتجات', Package],
          ['profit', 'الأرباح', TrendingUp],
          ['cash', 'الخزنة', Wallet],
        ] as const).map(([k, label, Icon]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`flex h-11 items-center justify-center gap-2 rounded-xl text-[13px] font-bold transition ${tab === k ? 'bg-gradient-to-br from-brand-600 to-brand-800 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}>
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>

      <Card className="mb-5 !p-3 no-print">
        <div className="flex flex-wrap items-end gap-3">
          {tab === 'inventory' ? (
            <div className="w-full sm:w-64">
              <Label>المخزن</Label>
              <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">كل المخازن</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </div>
          ) : (
            <>
              <div className="flex rounded-xl bg-slate-100 p-1">
                {([['today', 'اليوم'], ['week', 'الأسبوع'], ['month', 'الشهر'], ['year', 'السنة']] as const).map(([key, label]) => (
                  <button key={key} type="button" onClick={() => applyPreset(key)} className="h-8 rounded-lg px-3 text-xs font-bold text-slate-600 transition hover:bg-white hover:text-brand-800 hover:shadow-sm">{label}</button>
                ))}
              </div>
              <div className="w-40"><Label>من تاريخ</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
              <div className="w-40"><Label>إلى تاريخ</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
              <Button onClick={() => load()}>تطبيق الفلتر</Button>
            </>
          )}
        </div>
      </Card>

      {tab === 'inventory' && (
        <StatGrid cols={3}>
          <StatCard label="قيمة المخزون بالتكلفة" value={formatMoney(filteredInventory.reduce((s, r) => s + r.quantity * r.product.costPrice, 0))} icon={Coins} tone="brand" />
          <StatCard label="قيمة المخزون بسعر البيع" value={formatMoney(filteredInventory.reduce((s, r) => s + r.quantity * r.product.salePrice, 0))} icon={TrendingUp} tone="emerald" />
          <StatCard label="إجمالي الوحدات" value={filteredInventory.reduce((s, r) => s + r.quantity, 0).toLocaleString('ar-EG')} hint={`${filteredInventory.length} رصيد`} icon={Boxes} tone="sky" />
        </StatGrid>
      )}

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
                  <tr key={i} className={r.quantity <= 0 ? 'row-credit' : ''}>
                    <Td className="text-slate-600">{r.warehouse.name}</Td>
                    <Td><span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600" dir="ltr">{r.product.sku}</span></Td>
                    <Td className="font-bold text-slate-900">{r.product.name}</Td>
                    <Td className={`font-extrabold tabular-nums ${r.quantity <= 0 ? 'text-rose-600' : ''}`}>{r.quantity}</Td>
                    <Td className="tabular-nums text-slate-600">{formatMoney(r.product.costPrice)}</Td>
                    <Td className="tabular-nums text-slate-600">{formatMoney(r.product.salePrice)}</Td>
                    <Td className="whitespace-nowrap font-bold tabular-nums">{formatMoney(r.quantity * r.product.costPrice)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'sales' && sales && (
        <>
        <StatGrid>
          <StatCard label="إجمالي المبيعات" value={formatMoney(sales.total)} icon={ShoppingCart} tone="emerald" />
          <StatCard label="المحصل" value={formatMoney(sales.paid)} hint={sales.total > 0 ? `${((sales.paid / sales.total) * 100).toFixed(0)}% من الإجمالي` : undefined} icon={Wallet} tone="sky" />
          <StatCard label="المتبقي على العملاء" value={formatMoney(Math.max(0, sales.total - sales.paid))} icon={Coins} tone="rose" />
          <StatCard label="عدد الفواتير" value={sales.count} hint={sales.count ? `متوسط ${formatMoney(sales.total / sales.count)}` : undefined} icon={FileSpreadsheet} tone="amber" />
        </StatGrid>
        <Card>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm no-print">
            <span className="text-xs font-bold text-slate-500">الأعمدة:</span>
            {([['customer', 'العميل'], ['date', 'التاريخ'], ['total', 'الإجمالي'], ['status', 'الحالة']] as const).map(([key, label]) => (
              <label key={key} className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${salesCols[key] ? 'border-brand-200 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-500'}`}>
                <input type="checkbox" className="accent-[var(--color-brand-700)]" checked={salesCols[key]} onChange={(e) => setSalesCols({ ...salesCols, [key]: e.target.checked })} />
                {label}
              </label>
            ))}
          </div>
          <Table>
            <thead>
              <tr>
                <Th>الرقم</Th>
                {salesCols.customer && <Th>العميل</Th>}
                {salesCols.date && <Th>التاريخ</Th>}
                {salesCols.total && <Th>الإجمالي</Th>}
                <Th>المتبقي</Th>
                {salesCols.status && <Th>الحالة</Th>}
              </tr>
            </thead>
            <tbody>
              {sales.invoices.map((i) => (
                <tr key={i.number} className={`status-${i.status}`}>
                  <Td><span className="font-mono text-xs font-bold text-brand-700" dir="ltr">{i.number}</span></Td>
                  {salesCols.customer && <Td className="font-semibold text-slate-800">{i.customer.name}</Td>}
                  {salesCols.date && <Td className="whitespace-nowrap text-slate-500">{formatDate(i.invoiceDate)}</Td>}
                  {salesCols.total && <Td className="whitespace-nowrap font-bold">{formatMoney(i.total)}</Td>}
                  <Td>{i.status === 'CANCELLED' ? formatMoney(0) : <DueAmount date={i.invoiceDate} remaining={i.total - i.paidAmount} />}</Td>
                  {salesCols.status && <Td><StatusBadge status={i.status} /></Td>}
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        </>
      )}

      {tab === 'products' && products && (
        <div className="space-y-4">
          <StatGrid>
            <StatCard label="خسارة محققة" value={<span className="text-rose-700">{formatMoney(products.lossTotal)}</span>} hint="بيع بأقل من التكلفة" icon={TrendingDown} tone="rose" />
            <StatCard label="خسارة متوقعة على المخزون" value={<span className="text-amber-700">{formatMoney(products.potentialLossTotal)}</span>} hint="سعر البيع أقل من التكلفة" icon={AlertTriangle} tone="amber" />
            <StatCard label="أصناف لا تُباع" value={products.unsold.length} hint={`قيمة راكدة ${formatMoney(products.unsoldValue)}`} icon={PackageX} tone="slate" />
            <StatCard label="الأكثر مبيعاً" value={visibleSold.length} hint="صنف له مبيعات في الفترة" icon={TrendingUp} tone="emerald" />
          </StatGrid>

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
        <ProfitView
          revenue={profit.revenue ?? profit.salesTotal}
          cogs={profit.cogs || 0}
          gross={profit.netProfit ?? profit.grossProfit}
          invoiceDiff={profit.grossProfit}
        />
      )}

      {tab === 'cash' && cash && (
        <>
        <StatGrid cols={3}>
          <StatCard label="وارد" value={<span className="text-emerald-700">{formatMoney(cash.totalIn)}</span>} icon={ArrowDownLeft} tone="emerald" />
          <StatCard label="صادر" value={<span className="text-rose-600">{formatMoney(cash.totalOut)}</span>} icon={ArrowUpRight} tone="rose" />
          <StatCard label="صافي الحركة" value={formatMoney(cash.net)} hint={`${cash.transactions.length} حركة`} icon={Wallet} tone="brand" />
        </StatGrid>
        <Card>
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
                  <Td className="whitespace-nowrap text-slate-500">{formatDate(t.createdAt)}</Td>
                  <Td className="font-semibold text-slate-700">{t.account.name}</Td>
                  <Td className="text-slate-600">{t.description}</Td>
                  <Td><Badge tone={t.direction === 'IN' ? 'emerald' : 'rose'}>{t.direction === 'IN' ? 'وارد' : 'صادر'}</Badge></Td>
                  <Td className={`whitespace-nowrap font-extrabold ${t.direction === 'IN' ? 'text-emerald-700' : 'text-rose-600'}`}>{formatMoney(t.amount)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        </>
      )}
    </div>
  );
}
