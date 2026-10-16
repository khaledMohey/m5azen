import { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, Search, Users, XCircle } from 'lucide-react';
import { api, formatRelative } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  Badge, Button, Card, CardHeader, Empty, ErrorState, Input, PageHeader, Pager, StatCard, StatGrid, Table, TableSkeleton, Td, Th, type Tone,
} from '../components/ui';

type Log = {
  id: string;
  userName: string | null;
  action: string;
  method: string;
  path: string;
  status: string;
  createdAt: string;
};

const METHOD: Record<string, { label: string; tone: Tone }> = {
  POST: { label: 'إنشاء', tone: 'emerald' },
  PATCH: { label: 'تعديل', tone: 'sky' },
  PUT: { label: 'تعديل', tone: 'sky' },
  DELETE: { label: 'حذف', tone: 'rose' },
};

export function AuditPage() {
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Log[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'ALL' | 'success' | 'failed'>('ALL');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  async function load(next = query) {
    setError('');
    setRows(null);
    try {
      const path = user?.role === 'ADMIN' ? `/ops/audit${next ? `?q=${encodeURIComponent(next)}` : ''}` : '/ops/activity';
      setRows(await api<Log[]>(path));
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : 'تعذر تحميل السجل');
    }
    setPage(1);
  }

  useEffect(() => { load(''); }, [user?.role]);

  const all = rows || [];
  const visible = useMemo(() => all.filter((r) => filter === 'ALL' || (filter === 'success' ? r.status === 'success' : r.status !== 'success')), [all, filter]);
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const slice = visible.slice((page - 1) * pageSize, page * pageSize);
  const failed = all.filter((r) => r.status !== 'success').length;
  const usersCount = new Set(all.map((r) => r.userName).filter(Boolean)).size;

  return (
    <div>
      <PageHeader
        title="سجل العمليات"
        subtitle={user?.role === 'ADMIN' ? 'كل عمليات الإنشاء والتعديل والحذف مع اسم المستخدم' : 'عملياتك أنت'}
      />

      <StatGrid>
        <StatCard label="إجمالي العمليات" value={all.length} icon={Activity} tone="brand" onClick={() => { setFilter('ALL'); setPage(1); }} active={filter === 'ALL'} />
        <StatCard label="ناجحة" value={all.length - failed} icon={CheckCircle2} tone="emerald" onClick={() => { setFilter('success'); setPage(1); }} active={filter === 'success'} />
        <StatCard label="فشلت" value={failed} icon={XCircle} tone="rose" onClick={() => { setFilter('failed'); setPage(1); }} active={filter === 'failed'} />
        <StatCard label="مستخدمون نشطون" value={usersCount} icon={Users} tone="violet" />
      </StatGrid>

      <Card>
        <CardHeader
          title="العمليات المسجلة"
          subtitle={`${visible.length} عملية`}
          icon={Activity}
          actions={user?.role === 'ADMIN' ? (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); load(); }}>
              <div className="relative">
                <Search size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input className="w-64 pr-9" placeholder="بحث بالاسم أو العملية" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <Button type="submit" variant="secondary">بحث</Button>
              {query && <Button type="button" variant="ghost" onClick={() => { setQuery(''); load(''); }}>مسح</Button>}
            </form>
          ) : undefined}
        />
        {error ? <ErrorState text="تعذر تحميل السجل" hint={error} onRetry={() => load()} /> : !rows ? <TableSkeleton /> : visible.length === 0 ? (
          <Empty text="لا عمليات مسجلة" hint="أي حفظ أو حذف جديد سيظهر هنا" />
        ) : (
          <>
            <Table>
              <thead>
                <tr><Th>المستخدم</Th><Th>العملية</Th><Th>النوع</Th><Th>المسار</Th><Th>الحالة</Th><Th>الوقت</Th></tr>
              </thead>
              <tbody>
                {slice.map((row) => {
                  const m = METHOD[row.method] || { label: row.method, tone: 'slate' as Tone };
                  const ok = row.status === 'success';
                  return (
                    <tr key={row.id} className={ok ? '' : 'row-credit'}>
                      <Td>
                        <div className="flex items-center gap-2">
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-extrabold text-brand-700">{(row.userName || '؟').slice(0, 1)}</span>
                          <span className="font-semibold text-slate-800">{row.userName || '—'}</span>
                        </div>
                      </Td>
                      <Td className="text-slate-700">{row.action}</Td>
                      <Td><Badge tone={m.tone}>{m.label}</Badge></Td>
                      <Td><span className="font-mono text-[11px] text-slate-500" dir="ltr">{row.method} {row.path}</span></Td>
                      <Td><Badge tone={ok ? 'emerald' : 'rose'}>{ok ? 'تمت' : 'فشلت'}</Badge></Td>
                      <Td className="whitespace-nowrap text-slate-500">{formatRelative(row.createdAt)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <Pager page={page} pages={pages} total={visible.length} from={(page - 1) * pageSize + 1} to={Math.min(page * pageSize, visible.length)} pageSize={pageSize} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
          </>
        )}
      </Card>
    </div>
  );
}
