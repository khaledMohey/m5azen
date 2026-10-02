import { useEffect, useState } from 'react';
import { DatabaseBackup, Save, Server } from 'lucide-react';
import { api, getApiBase, setApiBase } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Card, Input, Label, PageHeader, Select } from '../components/ui';

export function SettingsPage() {
  const { user } = useAuth();
  const [companyName, setCompanyName] = useState('');
  const [taxNumber, setTaxNumber] = useState('');
  const [commercialRegister, setCommercialRegister] = useState('');
  const [companyAddress, setCompanyAddress] = useState('');
  const [apiUrl, setApiUrl] = useState(getApiBase() || 'http://localhost:3001');
  const [users, setUsers] = useState<{ id: string; username: string; fullName: string; role: string; isActive: boolean }[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [userForm, setUserForm] = useState({ username: '', password: '', fullName: '', role: 'SALES', warehouseId: '' });
  const [backups, setBackups] = useState<string[]>([]);
  const [message, setMessage] = useState('');

  useEffect(() => {
    api<Record<string, string>>('/settings').then((s) => {
      setCompanyName(s.companyName || '');
      setTaxNumber(s.taxNumber || '');
      setCommercialRegister(s.commercialRegister || '');
      setCompanyAddress(s.companyAddress || '');
    });
    if (user?.role === 'ADMIN') {
      api<typeof users>('/users').then(setUsers).catch(() => setUsers([]));
      api<{ id: string; name: string }[]>('/warehouses').then(setWarehouses).catch(() => setWarehouses([]));
    }
    api<string[]>('/settings/backups').then(setBackups).catch(() => setBackups([]));
  }, [user?.role]);

  async function saveSettings() {
    setApiBase(apiUrl);
    await api('/settings', {
      method: 'POST',
      body: JSON.stringify({ data: { companyName, apiUrl, taxNumber, commercialRegister, companyAddress } }),
    });
    setMessage('تم حفظ الإعدادات');
  }

  async function backup() {
    const res = await api<{ ok: boolean; fileName?: string; message?: string }>('/settings/backup', {
      method: 'POST',
    });
    if (res.ok) {
      setMessage(`تم إنشاء نسخة احتياطية: ${res.fileName}`);
      setBackups(await api<string[]>('/settings/backups'));
    } else {
      setMessage(res.message || 'فشل النسخ');
    }
  }

  return (
    <div>
      <PageHeader title="الإعدادات" subtitle="إعدادات نظام AK Tech لإدارة المخازن والسيرفر المحلي والنسخ الاحتياطي" />

      {message && (
        <div className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-4 flex items-center gap-2 font-bold">
            <Server size={18} className="text-brand-600" />
            الشركة والـ API
          </div>
          <div className="space-y-3">
            <div>
              <Label>اسم الشركة</Label>
              <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            </div>
            <div>
              <Label>الرقم الضريبي</Label>
              <Input value={taxNumber} onChange={(e) => setTaxNumber(e.target.value)} />
            </div>
            <div>
              <Label>السجل التجاري</Label>
              <Input value={commercialRegister} onChange={(e) => setCommercialRegister(e.target.value)} />
            </div>
            <div>
              <Label>عنوان الفاتورة</Label>
              <Input value={companyAddress} onChange={(e) => setCompanyAddress(e.target.value)} />
            </div>
            <div>
              <Label>عنوان الـ API المحلي</Label>
              <Input
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="http://192.168.1.10:3001"
              />
              <p className="mt-1 text-xs text-muted">
                للديسكتوب والأجهزة على الشبكة: ضع IP جهاز السيرفر
              </p>
            </div>
            <Button onClick={saveSettings}><Save size={16} /> حفظ</Button>
          </div>
        </Card>

        <Card>
          <div className="mb-4 flex items-center gap-2 font-bold">
            <DatabaseBackup size={18} className="text-amber-600" />
            النسخ الاحتياطي
          </div>
          <p className="mb-4 text-sm text-muted">
            يتم نسخ ملف قاعدة البيانات SQLite إلى مجلد backups على السيرفر.
          </p>
          <Button onClick={backup} className="mb-4">إنشاء نسخة احتياطية الآن</Button>
          <div className="text-sm font-semibold mb-2">النسخ السابقة</div>
          {backups.length === 0 ? (
            <div className="text-sm text-muted">لا توجد نسخ بعد</div>
          ) : (
            <ul className="space-y-1 text-sm">
              {backups.map((b) => (
                <li key={b} className="rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs">{b}</li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {user?.role === 'ADMIN' && (
        <Card className="mt-4">
          <div className="mb-4 font-bold">المستخدمين وصلاحية المخزن</div>
          <div className="mb-4 grid gap-3 sm:grid-cols-5">
            <Input placeholder="اسم الدخول" value={userForm.username} onChange={(e) => setUserForm({ ...userForm, username: e.target.value })} />
            <Input placeholder="الاسم" value={userForm.fullName} onChange={(e) => setUserForm({ ...userForm, fullName: e.target.value })} />
            <Input placeholder="كلمة السر" type="password" value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} />
            <Select value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}>
              <option value="ADMIN">مدير</option>
              <option value="ACCOUNTANT">حسابات</option>
              <option value="WAREHOUSE">مخزن</option>
              <option value="SALES">مبيعات</option>
            </Select>
            <Button onClick={async () => {
              const created = await api<{ id: string }>('/users', { method: 'POST', body: JSON.stringify(userForm) });
              if (userForm.warehouseId) {
                await api(`/users/${created.id}/warehouses`, { method: 'PUT', body: JSON.stringify({ warehouseIds: [userForm.warehouseId] }) });
              }
              setUserForm({ username: '', password: '', fullName: '', role: 'SALES', warehouseId: '' });
              setUsers(await api('/users'));
            }}>إضافة</Button>
          </div>
          <div className="mb-4">
            <Label>تقييد المستخدم الجديد على مخزن (فاضي = كل المخازن)</Label>
            <Select value={userForm.warehouseId} onChange={(e) => setUserForm({ ...userForm, warehouseId: e.target.value })}>
              <option value="">كل المخازن</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          <ul className="space-y-1 text-sm">
            {users.map((u) => (
              <li key={u.id} className="flex justify-between rounded-lg bg-slate-50 px-3 py-2">
                <span>{u.fullName} · {u.username}</span>
                <span>{u.role}{u.isActive ? '' : ' · موقوف'}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">
            الفاتورة المطبوعة تستخدم الرقم الضريبي والسجل من الإعدادات. الربط المباشر مع منظومة الفاتورة الإلكترونية محتاج شهادة توقيع منفصلة.
          </p>
        </Card>
      )}
    </div>
  );
}
