import { useEffect, useState } from 'react';
import {
  ShoppingCart,
  ShoppingBag,
  Wallet,
  AlertTriangle,
  Users,
  Truck,
} from 'lucide-react';
import { api, formatMoney, formatDate } from '../lib/api';
import { Card, PageHeader, StatusBadge, Table, Td, Th } from '../components/ui';

type Dash = {
  salesToday: { total: number; count: number };
  purchasesToday: { total: number; count: number };
  cashBalance: number;
  lowStock: { name: string; quantity: number; minStock: number; warehouseName: string }[];
  recentSales: { id: string; number: string; total: number; status: string; invoiceDate: string; customer: { name: string } }[];
  recentPurchases: { id: string; number: string; total: number; status: string; invoiceDate: string; supplier: { name: string } }[];
  customersCount: number;
  suppliersCount: number;
};

export function DashboardPage() {
  const [data, setData] = useState<Dash | null>(null);

  useEffect(() => {
    api<Dash>('/dashboard').then(setData).catch(console.error);
  }, []);

  if (!data) return <div className="text-muted">جاري تحميل لوحة التحكم...</div>;

  const stats = [
    { label: 'مبيعات اليوم', value: formatMoney(data.salesToday.total), sub: `${data.salesToday.count} فاتورة`, icon: ShoppingCart, color: 'bg-emerald-50 text-emerald-700' },
    { label: 'مشتريات اليوم', value: formatMoney(data.purchasesToday.total), sub: `${data.purchasesToday.count} فاتورة`, icon: ShoppingBag, color: 'bg-sky-50 text-sky-700' },
    { label: 'رصيد الخزنة', value: formatMoney(data.cashBalance), sub: 'كل الحسابات', icon: Wallet, color: 'bg-amber-50 text-amber-700' },
    { label: 'العملاء / الموردين', value: `${data.customersCount} / ${data.suppliersCount}`, sub: 'نشط', icon: Users, color: 'bg-violet-50 text-violet-700' },
  ];

  return (
    <div>
      <PageHeader title="لوحة التحكم" subtitle="ملخص يومي لعمليات المخازن والمبيعات" />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="relative overflow-hidden">
            <div className={`mb-3 inline-flex rounded-xl p-2.5 ${s.color}`}>
              <s.icon size={20} />
            </div>
            <div className="text-sm text-muted">{s.label}</div>
            <div className="mt-1 text-2xl font-extrabold">{s.value}</div>
            <div className="mt-1 text-xs text-muted">{s.sub}</div>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-3 flex items-center gap-2 font-bold">
            <AlertTriangle size={18} className="text-amber-600" />
            تنبيهات نقص المخزون
          </div>
          {data.lowStock.length === 0 ? (
            <div className="text-sm text-muted">لا توجد تنبيهات</div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>الصنف</Th>
                  <Th>المخزن</Th>
                  <Th>الكمية</Th>
                  <Th>الحد</Th>
                </tr>
              </thead>
              <tbody>
                {data.lowStock.map((r, i) => (
                  <tr key={i} className="bg-amber-50/50">
                    <Td>{r.name}</Td>
                    <Td>{r.warehouseName}</Td>
                    <Td className="font-bold text-rose-600">{r.quantity}</Td>
                    <Td>{r.minStock}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <div className="mb-3 flex items-center gap-2 font-bold">
            <ShoppingCart size={18} className="text-brand-600" />
            آخر المبيعات
          </div>
          <Table>
            <thead>
              <tr>
                <Th>رقم</Th>
                <Th>عميل</Th>
                <Th>المبلغ</Th>
                <Th>الحالة</Th>
              </tr>
            </thead>
            <tbody>
              {data.recentSales.map((s) => (
                <tr key={s.id}>
                  <Td>{s.number}</Td>
                  <Td>{s.customer.name}</Td>
                  <Td>{formatMoney(s.total)}</Td>
                  <Td><StatusBadge status={s.status} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card className="lg:col-span-2">
          <div className="mb-3 flex items-center gap-2 font-bold">
            <Truck size={18} className="text-sky-600" />
            آخر المشتريات
          </div>
          <Table>
            <thead>
              <tr>
                <Th>رقم</Th>
                <Th>مورد</Th>
                <Th>التاريخ</Th>
                <Th>المبلغ</Th>
                <Th>الحالة</Th>
              </tr>
            </thead>
            <tbody>
              {data.recentPurchases.map((s) => (
                <tr key={s.id}>
                  <Td>{s.number}</Td>
                  <Td>{s.supplier.name}</Td>
                  <Td>{formatDate(s.invoiceDate)}</Td>
                  <Td>{formatMoney(s.total)}</Td>
                  <Td><StatusBadge status={s.status} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
