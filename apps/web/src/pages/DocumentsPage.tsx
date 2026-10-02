import { useEffect, useState } from 'react';
import { api, formatDate, formatMoney } from '../lib/api';
import { Button, Card, Empty, Input, Label, Modal, NumberInput, PageHeader, Select, Table, Td, Th } from '../components/ui';

type Kind = 'QUOTATION' | 'SALES_ORDER' | 'PURCHASE_ORDER';
const KINDS: { id: Kind; label: string }[] = [
  { id: 'QUOTATION', label: 'عرض سعر' },
  { id: 'SALES_ORDER', label: 'أمر بيع' },
  { id: 'PURCHASE_ORDER', label: 'أمر شراء' },
];

type Doc = {
  id: string;
  number: string;
  kind: Kind;
  status: string;
  total: number;
  docDate: string;
  customer?: { name: string } | null;
  supplier?: { name: string } | null;
};

export function DocumentsPage() {
  const [kind, setKind] = useState<Kind>('QUOTATION');
  const [docs, setDocs] = useState<Doc[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [products, setProducts] = useState<{ id: string; name: string; salePrice: number; costPrice: number }[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ partyId: '', warehouseId: '', notes: '', taxRate: '' as number | '' });
  const [line, setLine] = useState({ productId: '', quantity: '' as number | '', unitPrice: '' as number | '' });

  async function load() {
    const [d, c, s, w, p] = await Promise.all([
      api<Doc[]>(`/documents?kind=${kind}`),
      api<{ id: string; name: string }[]>('/customers'),
      api<{ id: string; name: string }[]>('/suppliers'),
      api<{ id: string; name: string }[]>('/warehouses'),
      api<{ id: string; name: string; salePrice: number; costPrice: number }[]>('/products'),
    ]);
    setDocs(d);
    setCustomers(c);
    setSuppliers(s);
    setWarehouses(w);
    setProducts(p);
  }

  useEffect(() => { load(); }, [kind]);

  const parties = kind === 'PURCHASE_ORDER' ? suppliers : customers;

  async function save() {
    const product = products.find((p) => p.id === line.productId);
    const unitPrice = line.unitPrice === '' ? (kind === 'PURCHASE_ORDER' ? product?.costPrice || 0 : product?.salePrice || 0) : line.unitPrice;
    await api('/documents', {
      method: 'POST',
      body: JSON.stringify({
        kind,
        customerId: kind === 'PURCHASE_ORDER' ? undefined : form.partyId,
        supplierId: kind === 'PURCHASE_ORDER' ? form.partyId : undefined,
        warehouseId: form.warehouseId || undefined,
        notes: form.notes || undefined,
        taxRate: form.taxRate === '' ? 0 : form.taxRate,
        lines: [{ productId: line.productId, quantity: line.quantity === '' ? 0 : line.quantity, unitPrice }],
      }),
    });
    setOpen(false);
    load();
  }

  return (
    <div>
      <PageHeader
        title="عروض وأوامر"
        subtitle="عرض سعر وأمر بيع وأمر شراء، وتقدر تحولهم لمسودة فاتورة"
        actions={<Button onClick={() => setOpen(true)}>مستند جديد</Button>}
      />
      <div className="mb-4 flex gap-2">
        {KINDS.map((item) => (
          <Button key={item.id} variant={kind === item.id ? 'primary' : 'secondary'} onClick={() => setKind(item.id)}>{item.label}</Button>
        ))}
      </div>
      <Card>
        {docs.length === 0 ? <Empty /> : (
          <Table>
            <thead><tr><Th>الرقم</Th><Th>الطرف</Th><Th>التاريخ</Th><Th>الإجمالي</Th><Th>الحالة</Th><Th></Th></tr></thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id}>
                  <Td className="font-semibold">{doc.number}</Td>
                  <Td>{doc.customer?.name || doc.supplier?.name || '—'}</Td>
                  <Td>{formatDate(doc.docDate)}</Td>
                  <Td>{formatMoney(doc.total)}</Td>
                  <Td>{doc.status}</Td>
                  <Td>
                    {doc.status === 'OPEN' && (
                      <div className="flex gap-2">
                        <Button variant="secondary" onClick={async () => { await api(`/documents/${doc.id}/convert`, { method: 'POST' }); load(); }}>تحويل لفاتورة</Button>
                        <Button variant="ghost" onClick={async () => { await api(`/documents/${doc.id}/cancel`, { method: 'POST' }); load(); }}>إلغاء</Button>
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title={KINDS.find((k) => k.id === kind)?.label || ''}>
        <div className="space-y-3">
          <div>
            <Label>{kind === 'PURCHASE_ORDER' ? 'المورد' : 'العميل'}</Label>
            <Select value={form.partyId} onChange={(e) => setForm({ ...form, partyId: e.target.value })}>
              <option value="">اختر</option>
              {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>المخزن</Label>
            <Select value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}>
              <option value="">اختر</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>الصنف</Label>
            <Select value={line.productId} onChange={(e) => setLine({ ...line, productId: e.target.value })}>
              <option value="">اختر</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>الكمية</Label><NumberInput value={line.quantity} onValueChange={(v) => setLine({ ...line, quantity: v })} /></div>
            <div><Label>السعر</Label><NumberInput value={line.unitPrice} onValueChange={(v) => setLine({ ...line, unitPrice: v })} /></div>
          </div>
          <div><Label>ضريبة %</Label><NumberInput value={form.taxRate} onValueChange={(v) => setForm({ ...form, taxRate: v })} /></div>
          <div><Label>ملاحظات</Label><Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          <Button className="w-full" onClick={save}>حفظ المستند</Button>
        </div>
      </Modal>
    </div>
  );
}
