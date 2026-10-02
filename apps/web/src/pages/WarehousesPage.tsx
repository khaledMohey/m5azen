import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../lib/api';
import {
  Button, Card, Empty, Input, Label, Modal, PageHeader, SearchBox,
} from '../components/ui';

type Warehouse = {
  id: string;
  code: string;
  name: string;
  location?: string | null;
  description?: string | null;
  isActive: boolean;
};

export function WarehousesPage() {
  const [items, setItems] = useState<Warehouse[]>([]);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', location: '', description: '' });

  async function load() {
    setItems(await api<Warehouse[]>('/warehouses'));
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((w) =>
      [w.code, w.name, w.location || '', w.description || ''].some((x) => x.toLowerCase().includes(q)),
    );
  }, [items, search]);

  async function save() {
    await api('/warehouses', { method: 'POST', body: JSON.stringify(form) });
    setOpen(false);
    setForm({ code: '', name: '', location: '', description: '' });
    load();
  }

  return (
    <div>
      <PageHeader
        title="المخازن"
        subtitle="أماكن التخزين — الرصيد يتوزع حسب المخزن، الأصناف مشتركة"
        actions={
          <>
            <SearchBox value={search} onChange={setSearch} placeholder="بحث مخزن..." />
            <Button onClick={() => setOpen(true)}>
              <Plus size={16} /> مخزن جديد
            </Button>
          </>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {filtered.length === 0 && <Card><Empty text="لا توجد مخازن" /></Card>}
        {filtered.map((w) => (
          <Card key={w.id} className="border-brand-100 bg-gradient-to-br from-white to-brand-50/40">
            <div className="text-lg font-bold text-brand-900">{w.name}</div>
            <div className="mt-1 text-sm text-muted">
              {w.code}{w.location ? ` • ${w.location}` : ''}
            </div>
            {w.description && <p className="mt-2 text-sm text-slate-600">{w.description}</p>}
          </Card>
        ))}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="مخزن جديد">
        <div className="space-y-3">
          <div><Label>كود المخزن</Label><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
          <div><Label>اسم المخزن</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><Label>الموقع</Label><Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></div>
          <div><Label>الوصف</Label><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <Button className="w-full" onClick={save}>حفظ</Button>
        </div>
      </Modal>
    </div>
  );
}
