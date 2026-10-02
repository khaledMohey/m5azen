import { useEffect, useState } from 'react';
import { Columns3, Pencil, Plus } from 'lucide-react';
import { api, formatMoney } from '../lib/api';
import {
  Button, Card, Empty, Input, Label, Modal, NumberInput, PageHeader, Select, Table, Td, Th,
} from '../components/ui';

type CustomField = {
  id: string;
  name: string;
  label: string;
  fieldType: string;
  options?: string | null;
  isRequired: boolean;
};

type Product = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  costPrice: number;
  salePrice: number;
  wholesalePrice?: number;
  minStock: number;
  barcode?: string | null;
  brand?: string | null;
  categoryId?: string | null;
  packUnit?: string | null;
  packSize?: number;
  fieldValues: { fieldId: string; value: string; field: CustomField }[];
  stockBalances: { quantity: number; warehouse: { name: string } }[];
};

const emptyCreate = {
  sku: '',
  name: '',
  unit: 'قطعة',
  salePrice: '' as number | '',
  wholesalePrice: '' as number | '',
  minStock: '' as number | '',
  barcode: '',
  brand: '',
  categoryId: '',
  packUnit: '',
  packSize: '' as number | '',
};

export function ProductsPage() {
  const [items, setItems] = useState<Product[]>([]);
  const [fields, setFields] = useState<CustomField[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [newCategory, setNewCategory] = useState('');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [createForm, setCreateForm] = useState(emptyCreate);
  const [createFieldValues, setCreateFieldValues] = useState<Record<string, string>>({});
  const [editForm, setEditForm] = useState({
    sku: '',
    name: '',
    unit: 'قطعة',
    salePrice: '' as number | '',
    wholesalePrice: '' as number | '',
    minStock: '' as number | '',
    barcode: '',
    brand: '',
    categoryId: '',
    packUnit: '',
    packSize: '' as number | '',
  });
  const [editFieldValues, setEditFieldValues] = useState<Record<string, string>>({});
  const [fieldForm, setFieldForm] = useState({
    name: '',
    label: '',
    fieldType: 'TEXT',
    options: '',
  });

  async function load() {
    const q = search ? `?search=${encodeURIComponent(search)}` : '';
    const [products, defs, cats] = await Promise.all([
      api<Product[]>(`/products${q}`),
      api<CustomField[]>('/products/fields'),
      api<{ id: string; name: string }[]>('/products/categories'),
    ]);
    setItems(products);
    setFields(defs);
    setCategories(cats);
  }

  useEffect(() => {
    load();
  }, []);

  function fieldPayload(values: Record<string, string>) {
    return fields
      .map((f) => ({ fieldId: f.id, value: (values[f.id] || '').trim() }))
      .filter((fv) => fv.value);
  }

  async function saveCreate() {
    await api('/products', {
      method: 'POST',
      body: JSON.stringify({
        sku: createForm.sku,
        name: createForm.name,
        unit: createForm.unit,
        costPrice: 0,
        salePrice: createForm.salePrice === '' ? 0 : createForm.salePrice,
        wholesalePrice: createForm.wholesalePrice === '' ? 0 : createForm.wholesalePrice,
        minStock: createForm.minStock === '' ? 0 : createForm.minStock,
        barcode: createForm.barcode,
        brand: createForm.brand,
        categoryId: createForm.categoryId || undefined,
        packUnit: createForm.packUnit,
        packSize: createForm.packSize === '' ? 1 : createForm.packSize,
        fieldValues: fieldPayload(createFieldValues),
      }),
    });
    setCreateOpen(false);
    setCreateForm(emptyCreate);
    setCreateFieldValues({});
    load();
  }

  function openEdit(p: Product) {
    setEditing(p);
    setEditForm({
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      salePrice: p.salePrice,
      wholesalePrice: p.wholesalePrice || '',
      minStock: p.minStock,
      barcode: p.barcode || '',
      brand: p.brand || '',
      categoryId: p.categoryId || '',
      packUnit: p.packUnit || '',
      packSize: p.packSize || '',
    });
    const map: Record<string, string> = {};
    for (const fv of p.fieldValues) map[fv.fieldId] = fv.value;
    setEditFieldValues(map);
    setEditOpen(true);
  }

  async function saveEdit() {
    if (!editing) return;
    await api(`/products/${editing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        sku: editForm.sku,
        name: editForm.name,
        unit: editForm.unit,
        salePrice: editForm.salePrice === '' ? 0 : editForm.salePrice,
        wholesalePrice: editForm.wholesalePrice === '' ? 0 : editForm.wholesalePrice,
        minStock: editForm.minStock === '' ? 0 : editForm.minStock,
        barcode: editForm.barcode,
        brand: editForm.brand,
        categoryId: editForm.categoryId || null,
        packUnit: editForm.packUnit,
        packSize: editForm.packSize === '' ? 1 : editForm.packSize,
        fieldValues: fieldPayload(editFieldValues),
      }),
    });
    setEditOpen(false);
    setEditing(null);
    load();
  }

  async function saveFieldDef() {
    await api('/products/fields', {
      method: 'POST',
      body: JSON.stringify(fieldForm),
    });
    setFieldForm({ name: '', label: '', fieldType: 'TEXT', options: '' });
    load();
  }

  async function deleteFieldDef(id: string) {
    if (!confirm('حذف الحقل من كل الأصناف؟')) return;
    await api(`/products/fields/${id}`, { method: 'DELETE' });
    load();
  }

  function renderFieldInputs(
    values: Record<string, string>,
    setValues: (v: Record<string, string>) => void,
  ) {
    if (!fields.length) return null;
    return (
      <div className="space-y-2 rounded-xl border border-dashed border-slate-200 p-3">
        <div className="text-sm font-semibold text-slate-700">حقول إضافية (اختياري)</div>
        <p className="text-xs text-muted">املأ اللي يخص الصنف ده، وسيب الباقي فاضي</p>
        {fields.map((f) => (
          <div key={f.id}>
            <Label>{f.label}</Label>
            {f.fieldType === 'SELECT' ? (
              <Select
                value={values[f.id] || ''}
                onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
              >
                <option value="">—</option>
                {(f.options || '').split(',').map((o) => o.trim()).filter(Boolean).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </Select>
            ) : (
              <Input
                type={f.fieldType === 'NUMBER' ? 'number' : f.fieldType === 'DATE' ? 'date' : 'text'}
                value={values[f.id] || ''}
                onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
              />
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="الأصناف"
        subtitle="التكلفة من آخر شراء · سعر البيع والحقول الإضافية هنا"
        actions={
          <>
            <Input
              className="w-56"
              placeholder="بحث..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
            />
            <Button variant="secondary" onClick={load}>بحث</Button>
            <Button variant="secondary" onClick={() => setFieldsOpen(true)}>
              <Columns3 size={16} /> إدارة الحقول
            </Button>
            <Button onClick={() => { setCreateFieldValues({}); setCreateOpen(true); }}>
              <Plus size={16} /> صنف جديد
            </Button>
          </>
        }
      />
      <Card>
        {items.length === 0 ? <Empty /> : (
          <Table>
            <thead>
              <tr>
                <Th>الكود</Th>
                <Th>الاسم</Th>
                <Th>الوحدة</Th>
                <Th>تكلفة (من الشراء)</Th>
                <Th>سعر البيع</Th>
                {fields.slice(0, 3).map((f) => <Th key={f.id}>{f.label}</Th>)}
                <Th>الرصيد</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => {
                const qty = p.stockBalances.reduce((s, b) => s + b.quantity, 0);
                const valueMap = Object.fromEntries(p.fieldValues.map((fv) => [fv.fieldId, fv.value]));
                return (
                  <tr key={p.id} className={qty <= p.minStock && p.minStock > 0 ? 'bg-amber-50/60' : ''}>
                    <Td className="font-mono text-xs">{p.sku}</Td>
                    <Td className="font-semibold">{p.name}</Td>
                    <Td>{p.unit}</Td>
                    <Td className="text-slate-600">{formatMoney(p.costPrice)}</Td>
                    <Td className="font-bold text-brand-800">{formatMoney(p.salePrice)}</Td>
                    {fields.slice(0, 3).map((f) => (
                      <Td key={f.id} className="text-sm text-slate-600">{valueMap[f.id] || '—'}</Td>
                    ))}
                    <Td className="font-bold">{qty}</Td>
                    <Td>
                      <Button variant="secondary" className="!px-2 !py-1" onClick={() => openEdit(p)}>
                        <Pencil size={14} /> تعديل
                      </Button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="صنف جديد">
        <div className="space-y-3">
          <div><Label>كود الصنف</Label><Input value={createForm.sku} onChange={(e) => setCreateForm({ ...createForm, sku: e.target.value })} /></div>
          <div><Label>اسم الصنف</Label><Input value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} /></div>
          <div><Label>وحدة القياس</Label><Input value={createForm.unit} onChange={(e) => setCreateForm({ ...createForm, unit: e.target.value })} /></div>
          <div><Label>الباركود</Label><Input value={createForm.barcode} onChange={(e) => setCreateForm({ ...createForm, barcode: e.target.value })} /></div>
          <div><Label>الماركة</Label><Input value={createForm.brand} onChange={(e) => setCreateForm({ ...createForm, brand: e.target.value })} /></div>
          <div>
            <Label>التصنيف</Label>
            <Select value={createForm.categoryId} onChange={(e) => setCreateForm({ ...createForm, categoryId: e.target.value })}>
              <option value="">بدون</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <div className="flex gap-2">
            <Input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="تصنيف جديد" />
            <Button type="button" variant="secondary" onClick={async () => {
              if (!newCategory.trim()) return;
              const cat = await api<{ id: string; name: string }>('/products/categories', { method: 'POST', body: JSON.stringify({ name: newCategory.trim() }) });
              setCategories((prev) => [...prev, cat]);
              setCreateForm((f) => ({ ...f, categoryId: cat.id }));
              setNewCategory('');
            }}>إضافة</Button>
          </div>
          <div>
            <Label>سعر الجملة</Label>
            <NumberInput value={createForm.wholesalePrice} onValueChange={(v) => setCreateForm({ ...createForm, wholesalePrice: v })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>وحدة العبوة</Label><Input value={createForm.packUnit} placeholder="كرتونة" onChange={(e) => setCreateForm({ ...createForm, packUnit: e.target.value })} /></div>
            <div><Label>القطع في العبوة</Label><NumberInput value={createForm.packSize} onValueChange={(v) => setCreateForm({ ...createForm, packSize: v })} /></div>
          </div>
          <div>
            <Label>سعر البيع</Label>
            <NumberInput value={createForm.salePrice} onValueChange={(v) => setCreateForm({ ...createForm, salePrice: v })} />
            <p className="mt-1 text-xs text-muted">سعر التكلفة يتحدث تلقائياً من فواتير الشراء</p>
          </div>
          <div>
            <Label>الحد الأدنى للمخزون</Label>
            <NumberInput value={createForm.minStock} onValueChange={(v) => setCreateForm({ ...createForm, minStock: v })} />
          </div>
          {renderFieldInputs(createFieldValues, setCreateFieldValues)}
          <Button className="w-full" onClick={saveCreate}>حفظ</Button>
        </div>
      </Modal>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="تعديل صنف">
        {editing && (
          <div className="space-y-3">
            <div><Label>كود الصنف</Label><Input value={editForm.sku} onChange={(e) => setEditForm({ ...editForm, sku: e.target.value })} /></div>
            <div><Label>اسم الصنف</Label><Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></div>
            <div><Label>وحدة القياس</Label><Input value={editForm.unit} onChange={(e) => setEditForm({ ...editForm, unit: e.target.value })} /></div>
            <div><Label>الباركود</Label><Input value={editForm.barcode} onChange={(e) => setEditForm({ ...editForm, barcode: e.target.value })} /></div>
            <div><Label>الماركة</Label><Input value={editForm.brand} onChange={(e) => setEditForm({ ...editForm, brand: e.target.value })} /></div>
            <div>
              <Label>التصنيف</Label>
              <Select value={editForm.categoryId} onChange={(e) => setEditForm({ ...editForm, categoryId: e.target.value })}>
                <option value="">بدون</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>
            <div>
              <Label>سعر الجملة</Label>
              <NumberInput value={editForm.wholesalePrice} onValueChange={(v) => setEditForm({ ...editForm, wholesalePrice: v })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>وحدة العبوة</Label><Input value={editForm.packUnit} placeholder="كرتونة" onChange={(e) => setEditForm({ ...editForm, packUnit: e.target.value })} /></div>
              <div><Label>القطع في العبوة</Label><NumberInput value={editForm.packSize} onValueChange={(v) => setEditForm({ ...editForm, packSize: v })} /></div>
            </div>
            <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm">
              <div className="text-muted">سعر التكلفة (من آخر شراء)</div>
              <div className="font-bold text-slate-800">{formatMoney(editing.costPrice)}</div>
            </div>
            <div>
              <Label>سعر البيع</Label>
              <NumberInput value={editForm.salePrice} onValueChange={(v) => setEditForm({ ...editForm, salePrice: v })} />
            </div>
            <div>
              <Label>الحد الأدنى للمخزون</Label>
              <NumberInput value={editForm.minStock} onValueChange={(v) => setEditForm({ ...editForm, minStock: v })} />
            </div>
            {renderFieldInputs(editFieldValues, setEditFieldValues)}
            <Button className="w-full" onClick={saveEdit}>حفظ التعديلات</Button>
          </div>
        )}
      </Modal>

      <Modal open={fieldsOpen} onClose={() => setFieldsOpen(false)} title="إدارة حقول الأصناف" wide>
        <div className="space-y-4">
          <p className="text-sm text-muted">
            حقول عامة اختيارية لكل الأصناف. الصنف اللي مش محتاج حقل معيّن يسيبه فاضي.
            بيانات التشغيلة والصلاحية تُدخل في فاتورة الشراء وليست هنا.
          </p>
          {fields.length === 0 ? <Empty text="لا توجد حقول بعد" /> : (
            <Table>
              <thead>
                <tr>
                  <Th>الاسم الداخلي</Th>
                  <Th>العنوان</Th>
                  <Th>النوع</Th>
                  <Th>خيارات</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => (
                  <tr key={f.id}>
                    <Td className="font-mono text-xs">{f.name}</Td>
                    <Td>{f.label}</Td>
                    <Td>{f.fieldType}</Td>
                    <Td>{f.options || '—'}</Td>
                    <Td>
                      <button type="button" className="text-xs text-rose-600" onClick={() => deleteFieldDef(f.id)}>حذف</button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <div className="grid gap-3 rounded-xl border border-slate-200 p-3 sm:grid-cols-2">
            <div>
              <Label>الاسم الداخلي (إنجليزي)</Label>
              <Input value={fieldForm.name} onChange={(e) => setFieldForm({ ...fieldForm, name: e.target.value })} placeholder="brand" />
            </div>
            <div>
              <Label>العنوان الظاهر</Label>
              <Input value={fieldForm.label} onChange={(e) => setFieldForm({ ...fieldForm, label: e.target.value })} placeholder="الماركة" />
            </div>
            <div>
              <Label>النوع</Label>
              <Select value={fieldForm.fieldType} onChange={(e) => setFieldForm({ ...fieldForm, fieldType: e.target.value })}>
                <option value="TEXT">نص</option>
                <option value="NUMBER">رقم</option>
                <option value="DATE">تاريخ</option>
                <option value="SELECT">قائمة</option>
              </Select>
            </div>
            {fieldForm.fieldType === 'SELECT' && (
              <div>
                <Label>الخيارات (مفصولة بفاصلة)</Label>
                <Input value={fieldForm.options} onChange={(e) => setFieldForm({ ...fieldForm, options: e.target.value })} />
              </div>
            )}
            <div className="sm:col-span-2">
              <Button onClick={saveFieldDef}>إضافة حقل</Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
