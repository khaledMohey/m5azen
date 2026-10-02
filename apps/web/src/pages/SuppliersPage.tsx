import { useEffect, useMemo, useState } from 'react';
import { FileText, Plus, Printer } from 'lucide-react';
import { api, formatDate, formatMoney } from '../lib/api';
import {
  Button, Card, Empty, Input, Label, Modal, PageHeader, PrintHeader, SearchBox, Table, Td, Th,
} from '../components/ui';

type Supplier = {
  id: string; code: string; name: string; phone?: string | null; balance: number; address?: string | null;
};

type StatementRow = {
  date: string; type: string; ref: string; debit: number; credit: number; balance: number;
  method?: string | null; note?: string | null;
};

export function SuppliersPage() {
  const [items, setItems] = useState<Supplier[]>([]);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [stmtOpen, setStmtOpen] = useState(false);
  const [statement, setStatement] = useState<{ supplier: Supplier; statement: StatementRow[]; balance: number } | null>(null);
  const [form, setForm] = useState({ code: '', name: '', phone: '', address: '' });

  async function load() {
    setItems(await api<Supplier[]>('/suppliers'));
  }

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((s) =>
      [s.code, s.name, s.phone || '', s.address || ''].some((x) => x.toLowerCase().includes(q)),
    );
  }, [items, search]);

  async function save() {
    await api('/suppliers', { method: 'POST', body: JSON.stringify(form) });
    setOpen(false);
    setForm({ code: '', name: '', phone: '', address: '' });
    load();
  }

  async function showStatement(id: string) {
    const data = await api<{ supplier: Supplier; statement: StatementRow[]; balance: number }>(`/suppliers/${id}/statement`);
    setStatement(data);
    setStmtOpen(true);
  }

  return (
    <div>
      <PageHeader
        title="الموردين"
        subtitle="بيانات الموردين وكشوف الحساب"
        actions={
          <>
            <SearchBox value={search} onChange={setSearch} placeholder="بحث مورد..." />
            <Button onClick={() => setOpen(true)}><Plus size={16} /> مورد جديد</Button>
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
                <Th>الرصيد</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} className={s.balance > 0 ? 'row-debit' : s.balance < 0 ? 'row-credit' : ''}>
                  <Td>{s.code}</Td>
                  <Td className="font-semibold">{s.name}</Td>
                  <Td>{s.phone || '—'}</Td>
                  <Td className="font-bold">{formatMoney(s.balance)}</Td>
                  <Td>
                    <Button variant="ghost" onClick={() => showStatement(s.id)}>
                      <FileText size={14} /> كشف حساب
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="مورد جديد">
        <div className="space-y-3">
          <div><Label>كود المورد</Label><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
          <div><Label>اسم المورد</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><Label>رقم الهاتف</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
          <div><Label>العنوان</Label><Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
          <Button className="w-full" onClick={save}>حفظ</Button>
        </div>
      </Modal>

      <Modal open={stmtOpen} onClose={() => setStmtOpen(false)} title={`كشف حساب — ${statement?.supplier.name || ''}`} wide>
        {statement && (
          <div>
            <PrintHeader title={`كشف حساب مورد: ${statement.supplier.name}`} subtitle={`الرصيد الحالي: ${formatMoney(statement.balance)}`} />
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
