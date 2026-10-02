import { useEffect, useMemo, useState } from 'react';
import { FileText, Plus, Printer } from 'lucide-react';
import { api, formatDate, formatMoney } from '../lib/api';
import {
  Button, Card, Empty, Input, Label, Modal, NumberInput, PageHeader, PrintHeader, SearchBox, Select, Table, Td, Th,
} from '../components/ui';

type Customer = {
  id: string; code: string; name: string; phone?: string | null; balance: number; creditLimit: number; priceList?: string;
};

type StatementRow = {
  date: string; type: string; ref: string; debit: number; credit: number; balance: number;
  method?: string | null;
};

export function CustomersPage() {
  const [items, setItems] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [stmtOpen, setStmtOpen] = useState(false);
  const [statement, setStatement] = useState<{ customer: Customer; statement: StatementRow[]; balance: number } | null>(null);
  const [form, setForm] = useState({ code: '', name: '', phone: '', address: '', creditLimit: '' as number | '', priceList: 'RETAIL' });

  async function load() {
    setItems(await api<Customer[]>('/customers'));
  }

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) =>
      [c.code, c.name, c.phone || ''].some((x) => x.toLowerCase().includes(q)),
    );
  }, [items, search]);

  async function save() {
    await api('/customers', {
      method: 'POST',
      body: JSON.stringify({
        ...form,
        creditLimit: form.creditLimit === '' ? 0 : form.creditLimit,
        priceList: form.priceList,
      }),
    });
    setOpen(false);
    setForm({ code: '', name: '', phone: '', address: '', creditLimit: '', priceList: 'RETAIL' });
    load();
  }

  async function showStatement(id: string) {
    const data = await api<{ customer: Customer; statement: StatementRow[]; balance: number }>(`/customers/${id}/statement`);
    setStatement(data);
    setStmtOpen(true);
  }

  return (
    <div>
      <PageHeader
        title="العملاء"
        subtitle="بيانات العملاء وكشوف الحساب"
        actions={
          <>
            <SearchBox value={search} onChange={setSearch} placeholder="بحث عميل..." />
            <Button onClick={() => setOpen(true)}><Plus size={16} /> عميل جديد</Button>
          </>
        }
      />
      <Card>
        {filtered.length === 0 ? <Empty /> : (
          <Table>
            <thead>
              <tr>
                <Th>الكود</Th>
                <Th>الاسم</Th>
                <Th>الهاتف</Th>
                <Th>حد الائتمان</Th>
                <Th>الرصيد</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className={c.balance > 0 ? 'row-debit' : c.balance < 0 ? 'row-credit' : ''}>
                  <Td>{c.code}</Td>
                  <Td className="font-semibold">{c.name}</Td>
                  <Td>{c.phone || '—'}</Td>
                  <Td>{formatMoney(c.creditLimit)}</Td>
                  <Td className="font-bold">{formatMoney(c.balance)}</Td>
                  <Td>
                    <Button variant="ghost" onClick={() => showStatement(c.id)}>
                      <FileText size={14} /> كشف حساب
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="عميل جديد">
        <div className="space-y-3">
          <div><Label>كود العميل</Label><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
          <div><Label>اسم العميل</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><Label>رقم الهاتف</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
          <div>
            <Label>حد الائتمان</Label>
            <NumberInput value={form.creditLimit} onValueChange={(v) => setForm({ ...form, creditLimit: v })} />
            <p className="mt-1 text-xs text-muted">صفر يعني بدون حد. أي رقم أكبر يمنع فاتورة الآجل لو الرصيد هيتعداه.</p>
          </div>
          <div>
            <Label>قائمة السعر</Label>
            <Select value={form.priceList} onChange={(e) => setForm({ ...form, priceList: e.target.value })}>
              <option value="RETAIL">قطاعي</option>
              <option value="WHOLESALE">جملة</option>
            </Select>
          </div>
          <Button className="w-full" onClick={save}>حفظ</Button>
        </div>
      </Modal>

      <Modal open={stmtOpen} onClose={() => setStmtOpen(false)} title={`كشف حساب — ${statement?.customer.name || ''}`} wide>
        {statement && (
          <div>
            <PrintHeader title={`كشف حساب عميل: ${statement.customer.name}`} subtitle={`الرصيد الحالي: ${formatMoney(statement.balance)}`} />
            <div className="mb-3 text-sm font-semibold text-brand-800">
              الرصيد الحالي: {formatMoney(statement.balance)}
            </div>
            <div className="mb-4 flex justify-end no-print">
              <Button variant="secondary" onClick={() => window.print()}><Printer size={14} /> طباعة / PDF</Button>
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>التاريخ</Th>
                  <Th>النوع</Th>
                  <Th>المرجع</Th>
                  <Th>طريقة الدفع</Th>
                  <Th>مدين</Th>
                  <Th>دائن</Th>
                  <Th>الرصيد</Th>
                </tr>
              </thead>
              <tbody>
                {statement.statement.map((r, i) => (
                  <tr key={i} className={r.debit > 0 ? 'row-debit' : r.credit > 0 ? 'row-credit' : ''}>
                    <Td>{formatDate(r.date)}</Td>
                    <Td>{r.type}</Td>
                    <Td>{r.ref}</Td>
                    <Td>{r.method || '—'}</Td>
                    <Td>{r.debit ? formatMoney(r.debit) : '—'}</Td>
                    <Td>{r.credit ? formatMoney(r.credit) : '—'}</Td>
                    <Td className="font-bold">{formatMoney(r.balance)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Modal>
    </div>
  );
}
