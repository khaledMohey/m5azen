import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Server } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { getApiBase, setApiBase } from '../lib/api';
import { Button, Card, Input, Label } from '../components/ui';

export function LoginPage() {
  const { user, login } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [apiUrl, setApiUrl] = useState(getApiBase() || 'http://localhost:3001');
  const [showApi, setShowApi] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      setApiBase(apiUrl);
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فشل تسجيل الدخول');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative grid min-h-full place-items-center overflow-hidden bg-[radial-gradient(ellipse_at_top,_#e4eaf2_0%,_#f3f5f8_45%,_#d5dde8_100%)] px-4">
      <div className="pointer-events-none absolute -start-20 top-10 h-72 w-72 rounded-full bg-brand-600/20 blur-3xl" />
      <div className="pointer-events-none absolute -end-16 bottom-0 h-80 w-80 rounded-full bg-brand-800/15 blur-3xl" />
      <Card className="relative w-full max-w-md border-0 shadow-xl shadow-brand-900/15">
        <div className="mb-6 text-center">
          <img
            src="/ak-tech-logo.png"
            alt="AK Tech"
            className="mx-auto mb-4 h-28 w-28 rounded-2xl bg-white object-contain p-2 shadow-lg shadow-brand-900/10"
          />
          <h1 className="text-2xl font-extrabold text-brand-800">نظام AK Tech لإدارة المخازن</h1>
          <p className="mt-1 text-sm text-muted">Enterprise Premium Quality Solutions</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <Label>اسم المستخدم</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </div>
          <div>
            <Label>كلمة المرور</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button
            type="button"
            onClick={() => setShowApi((v) => !v)}
            className="flex items-center gap-1 text-xs text-brand-700"
          >
            <Server size={14} />
            إعدادات السيرفر المحلي
          </button>
          {showApi && (
            <div>
              <Label>عنوان الـ API</Label>
              <Input
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="http://192.168.1.10:3001"
              />
            </div>
          )}
          {error && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'جاري الدخول...' : 'دخول'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
