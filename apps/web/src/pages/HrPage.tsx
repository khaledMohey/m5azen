import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BadgeCheck, Briefcase, CalendarDays, CircleDollarSign, ClipboardList, Clock, Gift, Printer,
  Settings2, UserPlus, Users, Wallet,
} from 'lucide-react';
import type { AccessMap } from '@m5azen/shared';
import { api, formatDate, formatMoney } from '../lib/api';
import { useAuth, useAccess } from '../lib/auth';
import { useConfirm, usePrompt, useToast } from '../lib/feedback';
import { ROLE_LABELS } from '../lib/nav';
import { WarehouseMultiSelect } from '../components/WarehouseMultiSelect';
import { UserAccess } from '../components/UserAccess';
import {
  Badge, Button, Card, CardHeader, Empty, ErrorState, Input, Label, Modal, NumberInput,
  PageHeader, PageSkeleton, PrintHeader, Select, StatCard, StatGrid, Table, Td, Th, todayIso, type Tone,
} from '../components/ui';

type Tab =
  | 'requests' | 'employees' | 'attendance' | 'leaves' | 'movements'
  | 'payroll' | 'payments' | 'commissions' | 'settings';

type Employee = {
  id: string;
  code: string;
  name: string;
  phone?: string | null;
  nationalId?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  hireDate?: string | null;
  basicSalary: number;
  commissionPercent: number;
  userId?: string | null;
  bankAccount?: string | null;
  notes?: string | null;
  isActive: boolean;
  user?: {
    id: string;
    username: string;
    fullName: string;
    role: string;
    isActive: boolean;
    permissions: string | null;
    warehouseLinks?: { warehouseId: string }[];
  } | null;
};

type HrRequest = {
  id: string;
  kind: 'LEAVE' | 'ADVANCE' | 'PERMISSION';
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  leaveType?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  hours: number;
  amount: number;
  reason?: string | null;
  notes?: string | null;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
  rejectReason?: string | null;
  deductHours?: number | null;
  createdAt: string;
  employee: { id: string; code: string; name: string };
};

type AttendanceRow = {
  id: string;
  date: string;
  checkIn?: string | null;
  checkOut?: string | null;
  status: string;
  lateMinutes: number;
  notes?: string | null;
  employee: { id: string; code: string; name: string };
};

type LeaveRow = {
  id: string;
  type: string;
  fromDate: string;
  toDate: string;
  hours: number;
  notes?: string | null;
  employee: { id: string; code: string; name: string };
};

type MovementRow = {
  id: string;
  kind: string;
  amount: number;
  movementDate: string;
  notes?: string | null;
  settled: boolean;
  employee: { id: string; code: string; name: string };
};

type PayrollLinePreview = {
  employeeId: string;
  code: string;
  name: string;
  presentDays: number;
  absentDays: number;
  lateMinutes: number;
  salaryNet: number;
  commissionDue: number;
  net: number;
};

type PayrollCalc = {
  from: string;
  to: string;
  workDays: number;
  lines: PayrollLinePreview[];
  skipped: { employeeId: string; name: string; reason: string }[];
  totalNet: number;
};

type PayrollRun = {
  id: string;
  fromDate: string;
  toDate: string;
  status: 'DRAFT' | 'POSTED' | 'PAID';
  methodId?: string | null;
  notes?: string | null;
  postedAt?: string | null;
  paidAt?: string | null;
  paidAmount?: number;
  lines: {
    id: string;
    net: number;
    salaryNet: number;
    commissionDue: number;
    employee: { id: string; code: string; name: string };
  }[];
  _count?: { lines: number };
};

type HrSettings = {
  workStart: string;
  workEnd: string;
  graceMinutes: number;
  monthWorkDays: number;
  weekendDays: string;
  lateDeductPerMinute: number;
};

type Holiday = { id: string; date: string; name: string; yearly: boolean };

type CommissionSummary = {
  from: string;
  to: string;
  rows: {
    employeeId: string;
    code: string;
    name: string;
    linked: boolean;
    commissionPercent: number;
    salesTotal: number;
    accrued: number;
    paid: number;
    remaining: number;
  }[];
  unlinkedSales: {
    userId: string;
    fullName: string;
    username: string;
    salesTotal: number;
    count: number;
  }[];
};

const REQUEST_KIND: Record<string, string> = { LEAVE: 'إجازة', ADVANCE: 'سلفة', PERMISSION: 'إذن' };
const REQUEST_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'معلّق', tone: 'amber' },
  APPROVED: { label: 'موافق', tone: 'emerald' },
  REJECTED: { label: 'مرفوض', tone: 'rose' },
  CANCELLED: { label: 'ملغي', tone: 'slate' },
};
const LEAVE_TYPES: Record<string, string> = {
  ANNUAL: 'اعتيادية', SICK: 'مرضية', UNPAID: 'بدون مرتب', PERMISSION: 'إذن', OTHER: 'أخرى',
};
const LEAVE_FOR_REQUEST = ['ANNUAL', 'SICK', 'UNPAID', 'OTHER'] as const;
const MOVEMENT_KIND: Record<string, string> = { ADVANCE: 'سلفة', BONUS: 'مكافأة', DEDUCTION: 'خصم' };
const ATT_STATUS: Record<string, string> = {
  PRESENT: 'حاضر', ABSENT: 'غائب', LEAVE: 'إجازة', HOLIDAY: 'عطلة', WEEKEND: 'عطلة أسبوعية',
};
const ROLES = ['SALES', 'WAREHOUSE', 'ACCOUNTANT', 'ADMIN'] as const;
const WEEKDAYS = [
  { v: 0, label: 'الأحد' }, { v: 1, label: 'الإثنين' }, { v: 2, label: 'الثلاثاء' },
  { v: 3, label: 'الأربعاء' }, { v: 4, label: 'الخميس' }, { v: 5, label: 'الجمعة' }, { v: 6, label: 'السبت' },
];

const num = (v: number | '') => (v === '' ? 0 : v);

function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function formatTime(d: string) {
  return new Intl.DateTimeFormat('ar-EG', { hour: '2-digit', minute: '2-digit' }).format(new Date(d));
}

function toDateInput(d?: string | null) {
  if (!d) return '';
  return d.slice(0, 10);
}

function parseWeekends(raw: string) {
  try {
    const parsed = JSON.parse(raw || '[6]');
    return Array.isArray(parsed) ? parsed.map(Number) : [6];
  } catch {
    return [6];
  }
}

type EmployeeForm = {
  code: string;
  name: string;
  phone: string;
  nationalId: string;
  jobTitle: string;
  department: string;
  hireDate: string;
  basicSalary: number | '';
  commissionPercent: number | '';
  bankAccount: string;
  notes: string;
  isActive: boolean;
  userId: string;
};

const emptyEmployee: EmployeeForm = {
  code: '', name: '', phone: '', nationalId: '', jobTitle: '', department: '', hireDate: '',
  basicSalary: '', commissionPercent: '', bankAccount: '', notes: '', isActive: true, userId: '',
};

export function HrPage() {
  const { user } = useAuth();
  const { can, see } = useAccess();
  const toast = useToast();
  const confirm = useConfirm();
  const promptText = usePrompt();

  const isStaff = can('hr', 'edit') || can('hr', 'post') || user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT';
  const canRequest = can('hr', 'request');
  const seeSalary = see('hr', 'salary');

  const [tab, setTab] = useState<Tab>('requests');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);

  const [meEmployee, setMeEmployee] = useState<Employee | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [linkableUsers, setLinkableUsers] = useState<{ id: string; username: string; fullName: string; role: string }[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [methods, setMethods] = useState<{ id: string; name: string }[]>([]);

  const [rangeFrom, setRangeFrom] = useState(monthStart);
  const [rangeTo, setRangeTo] = useState(todayIso);
  const [employeeFilter, setEmployeeFilter] = useState('');

  const [requests, setRequests] = useState<HrRequest[]>([]);
  const [requestFilter, setRequestFilter] = useState('');
  const [reqForm, setReqForm] = useState({
    kind: 'LEAVE' as 'LEAVE' | 'ADVANCE' | 'PERMISSION',
    employeeId: '',
    leaveType: 'ANNUAL',
    fromDate: todayIso(),
    toDate: todayIso(),
    hours: '' as number | '',
    amount: '' as number | '',
    reason: '',
  });

  const [empModal, setEmpModal] = useState(false);
  const [editingEmpId, setEditingEmpId] = useState<string | null>(null);
  const [empForm, setEmpForm] = useState<EmployeeForm>(emptyEmployee);
  const [accountForm, setAccountForm] = useState({
    username: '', password: '', fullName: '', role: 'SALES', isActive: true, warehouseIds: [] as string[],
  });
  const [editingEmp, setEditingEmp] = useState<Employee | null>(null);

  const [attendance, setAttendance] = useState<AttendanceRow[]>([]);
  const [attForm, setAttForm] = useState({
    employeeId: '', date: todayIso(), checkIn: '', checkOut: '', status: 'PRESENT', notes: '',
  });

  const [leaves, setLeaves] = useState<LeaveRow[]>([]);
  const [leaveForm, setLeaveForm] = useState({
    employeeId: '', type: 'ANNUAL', fromDate: todayIso(), toDate: todayIso(), hours: '' as number | '', notes: '',
  });

  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [movForm, setMovForm] = useState({
    employeeId: '', kind: 'ADVANCE' as 'ADVANCE' | 'BONUS' | 'DEDUCTION', amount: '' as number | '', movementDate: todayIso(), notes: '',
  });

  const [payrollCalc, setPayrollCalc] = useState<PayrollCalc | null>(null);
  const [payrollRuns, setPayrollRuns] = useState<PayrollRun[]>([]);
  const [payrollDraftNotes, setPayrollDraftNotes] = useState('');
  const [postMethodByRun, setPostMethodByRun] = useState<Record<string, string>>({});

  const [postedPayrolls, setPostedPayrolls] = useState<PayrollRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<PayrollRun | null>(null);

  const [commission, setCommission] = useState<CommissionSummary | null>(null);

  const [hrSettings, setHrSettings] = useState<HrSettings | null>(null);
  const [weekendSel, setWeekendSel] = useState<number[]>([6]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [holidayForm, setHolidayForm] = useState({ date: todayIso(), name: '', yearly: false });

  const tabs = useMemo(() => {
    if (isStaff) {
      return [
        { id: 'requests' as Tab, label: 'طلبات', icon: ClipboardList },
        { id: 'employees' as Tab, label: 'الموظفين', icon: Users },
        { id: 'attendance' as Tab, label: 'الحضور', icon: Clock },
        { id: 'leaves' as Tab, label: 'الإجازات', icon: CalendarDays },
        { id: 'movements' as Tab, label: 'الحركات', icon: Wallet },
        { id: 'payroll' as Tab, label: 'المرتبات', icon: CircleDollarSign },
        { id: 'payments' as Tab, label: 'مدفوعات الرواتب', icon: BadgeCheck },
        { id: 'commissions' as Tab, label: 'العمولات', icon: Gift },
        { id: 'settings' as Tab, label: 'إعدادات HR', icon: Settings2 },
      ];
    }
    if (canRequest) return [{ id: 'requests' as Tab, label: 'طلباتي', icon: ClipboardList }];
    return [];
  }, [isStaff, canRequest]);

  const activeEmployees = useMemo(() => employees.filter((e) => e.isActive), [employees]);
  const pendingRequests = requests.filter((r) => r.status === 'PENDING').length;

  const employeeName = (id: string) => employees.find((e) => e.id === id)?.name || id;

  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    try {
      await action();
      if (success) toast.success(success);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر تنفيذ العملية');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const reloadTab = useCallback(async () => {
    setLoadError('');
    try {
      const listParams = new URLSearchParams();
      if (rangeFrom) listParams.set('from', rangeFrom);
      if (rangeTo) listParams.set('to', rangeTo);
      if (employeeFilter) listParams.set('employeeId', employeeFilter);

      if (tab === 'requests') {
        const q = new URLSearchParams();
        if (!isStaff) q.set('mine', '1');
        if (requestFilter) q.set('status', requestFilter);
        if (isStaff && employeeFilter) q.set('employeeId', employeeFilter);
        setRequests(await api<HrRequest[]>(`/hr/requests?${q}`));
      } else if (tab === 'employees' && isStaff) {
        setEmployees(await api<Employee[]>('/hr/employees'));
      } else if (tab === 'attendance' && isStaff) {
        setAttendance(await api<AttendanceRow[]>(`/hr/attendance?${listParams}`));
      } else if (tab === 'leaves' && isStaff) {
        setLeaves(await api<LeaveRow[]>(`/hr/leaves?${listParams}`));
      } else if (tab === 'movements' && isStaff) {
        setMovements(await api<MovementRow[]>(`/hr/movements?${listParams}`));
      } else if (tab === 'payroll' && isStaff) {
        setPayrollRuns(await api<PayrollRun[]>('/hr/payroll/runs'));
      } else if (tab === 'payments' && isStaff) {
        setPostedPayrolls(await api<PayrollRun[]>('/hr/payroll/payments'));
      } else if (tab === 'commissions' && isStaff) {
        const cq = new URLSearchParams();
        if (rangeFrom) cq.set('from', rangeFrom);
        if (rangeTo) cq.set('to', rangeTo);
        setCommission(await api<CommissionSummary>(`/hr/commissions?${cq}`));
      } else if (tab === 'settings' && isStaff) {
        const s = await api<HrSettings>('/hr/settings');
        setHrSettings(s);
        setWeekendSel(parseWeekends(s.weekendDays));
        setHolidays(await api<Holiday[]>('/hr/holidays'));
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'تعذر تحميل البيانات');
    }
  }, [tab, isStaff, rangeFrom, rangeTo, employeeFilter, requestFilter]);

  async function bootstrap() {
    setLoadError('');
    try {
      const me = await api<Employee | null>('/hr/me');
      setMeEmployee(me);
      if (isStaff) {
        const [emps, wh, payMethods] = await Promise.all([
          api<Employee[]>('/hr/employees'),
          api<{ id: string; name: string }[]>('/warehouses'),
          api<{ id: string; name: string }[]>('/cash/methods'),
        ]);
        setEmployees(emps);
        setWarehouses(wh);
        setMethods(payMethods);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'تعذر تحميل بيانات الموارد البشرية');
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => { bootstrap(); }, [isStaff]);
  useEffect(() => { if (loaded) reloadTab(); }, [loaded, reloadTab]);

  if (!isStaff && !canRequest) {
    return (
      <div>
        <PageHeader title="الموارد البشرية" subtitle="لا تملك صلاحية الوصول" />
        <Card><Empty text="تواصل مع المسؤول لتفعيل صلاحية الطلبات أو الإدارة." /></Card>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div>
        <PageHeader title="الموارد البشرية" subtitle="طلبات، حضور، مرتبات، وعمولات" />
        <PageSkeleton />
      </div>
    );
  }

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    if (reqForm.kind === 'LEAVE' && (!reqForm.fromDate || !reqForm.toDate)) return toast.error('حدد فترة الإجازة');
    if (reqForm.kind === 'PERMISSION' && num(reqForm.hours) <= 0) return toast.error('ساعات الإذن مطلوبة');
    if (reqForm.kind === 'ADVANCE' && num(reqForm.amount) <= 0) return toast.error('مبلغ السلفة مطلوب');
    if (isStaff && !reqForm.employeeId && !meEmployee) return toast.error('حدد الموظف');
    const body: Record<string, unknown> = {
      kind: reqForm.kind,
      reason: reqForm.reason || undefined,
    };
    if (isStaff && reqForm.employeeId) body.employeeId = reqForm.employeeId;
    if (reqForm.kind === 'LEAVE') {
      body.leaveType = reqForm.leaveType;
      body.fromDate = reqForm.fromDate;
      body.toDate = reqForm.toDate;
    } else if (reqForm.kind === 'PERMISSION') {
      body.fromDate = reqForm.fromDate;
      body.hours = num(reqForm.hours);
    } else {
      body.amount = num(reqForm.amount);
    }
    const ok = await run(
      () => api('/hr/requests', { method: 'POST', body: JSON.stringify(body) }),
      'تم إرسال الطلب',
    );
    if (ok) {
      setReqForm((f) => ({ ...f, reason: '', hours: '', amount: '' }));
      await reloadTab();
    }
  }

  async function approveRequest(row: HrRequest) {
    let body: { deductHours?: number } | undefined;
    if (row.kind === 'PERMISSION') {
      const answer = await promptText({
        title: 'موافقة على إذن',
        message: 'كام ساعة تتخصم؟ (0 = بدون خصم)',
        defaultValue: String(row.hours || 0),
        confirmLabel: 'موافقة',
      });
      if (answer === null) return;
      const deductHours = Math.max(0, Number(answer) || 0);
      body = { deductHours };
    } else if (!(await confirm({ title: 'موافقة على الطلب', message: `تأكيد الموافقة على طلب ${REQUEST_KIND[row.kind]} للموظف ${row.employee.name}؟` }))) {
      return;
    }
    const ok = await run(() => api(`/hr/requests/${row.id}/approve`, { method: 'POST', body: JSON.stringify(body) }), 'تمت الموافقة');
    if (ok) await reloadTab();
  }

  async function rejectRequest(row: HrRequest) {
    const reason = await promptText({ title: 'رفض الطلب', message: 'سبب الرفض (اختياري)' });
    if (reason === null) return;
    const ok = await run(
      () => api(`/hr/requests/${row.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: reason || undefined }) }),
      'تم الرفض',
    );
    if (ok) await reloadTab();
  }

  async function cancelRequest(row: HrRequest) {
    if (!(await confirm({ title: 'إلغاء الطلب', message: 'تأكيد إلغاء الطلب؟', danger: true }))) return;
    const ok = await run(() => api(`/hr/requests/${row.id}/cancel`, { method: 'POST' }), 'تم الإلغاء');
    if (ok) await reloadTab();
  }

  function openEmpCreate() {
    setEditingEmpId(null);
    setEditingEmp(null);
    setEmpForm(emptyEmployee);
    setAccountForm({ username: '', password: '', fullName: '', role: 'SALES', isActive: true, warehouseIds: [] });
    api<{ code: string }>('/hr/employees/next-code').then((r) => setEmpForm((f) => ({ ...f, code: r.code }))).catch(() => undefined);
    api<{ id: string; username: string; fullName: string; role: string }[]>('/hr/linkable-users').then(setLinkableUsers).catch(() => setLinkableUsers([]));
    setEmpModal(true);
  }

  function openEmpEdit(row: Employee) {
    setEditingEmpId(row.id);
    setEditingEmp(row);
    setEmpForm({
      code: row.code,
      name: row.name,
      phone: row.phone || '',
      nationalId: row.nationalId || '',
      jobTitle: row.jobTitle || '',
      department: row.department || '',
      hireDate: toDateInput(row.hireDate),
      basicSalary: seeSalary ? row.basicSalary : '',
      commissionPercent: seeSalary ? row.commissionPercent : '',
      bankAccount: row.bankAccount || '',
      notes: row.notes || '',
      isActive: row.isActive,
      userId: row.userId || '',
    });
    if (row.user) {
      setAccountForm({
        username: row.user.username,
        password: '',
        fullName: row.user.fullName,
        role: row.user.role,
        isActive: row.user.isActive,
        warehouseIds: (row.user.warehouseLinks || []).map((w) => w.warehouseId),
      });
    } else {
      setAccountForm({ username: '', password: '', fullName: row.name, role: 'SALES', isActive: true, warehouseIds: [] });
    }
    api<{ id: string; username: string; fullName: string; role: string }[]>(`/hr/linkable-users?employeeId=${row.id}`).then(setLinkableUsers).catch(() => setLinkableUsers([]));
    setEmpModal(true);
  }

  async function saveEmployee(e: React.FormEvent) {
    e.preventDefault();
    if (!empForm.name.trim()) return toast.error('اسم الموظف مطلوب');
    const payload: Record<string, unknown> = {
      code: empForm.code.trim(),
      name: empForm.name.trim(),
      phone: empForm.phone || undefined,
      nationalId: empForm.nationalId || undefined,
      jobTitle: empForm.jobTitle || undefined,
      department: empForm.department || undefined,
      hireDate: empForm.hireDate || undefined,
      bankAccount: empForm.bankAccount || undefined,
      notes: empForm.notes || undefined,
      userId: empForm.userId || null,
    };
    if (seeSalary) {
      payload.basicSalary = num(empForm.basicSalary);
      payload.commissionPercent = num(empForm.commissionPercent);
    }
    if (editingEmpId) payload.isActive = empForm.isActive;

    let empId = editingEmpId;
    const ok = await run(async () => {
      if (editingEmpId) {
        await api(`/hr/employees/${editingEmpId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        const created = await api<Employee>('/hr/employees', { method: 'POST', body: JSON.stringify(payload) });
        empId = created.id;
        setEditingEmpId(created.id);
        setEditingEmp(created);
      }
    }, 'تم حفظ بيانات الموظف');
    if (!ok || !empId) return;

    if (!editingEmp?.userId && accountForm.username.trim() && accountForm.password.length >= 4) {
      await run(
        () => api(`/hr/employees/${empId}/account`, {
          method: 'POST',
          body: JSON.stringify({
            username: accountForm.username.trim(),
            password: accountForm.password,
            fullName: accountForm.fullName || empForm.name,
            role: accountForm.role,
            warehouseIds: accountForm.warehouseIds,
          }),
        }),
        'تم إنشاء حساب الدخول',
      );
    }
    setEmployees(await api<Employee[]>('/hr/employees'));
    await reloadTab();
  }

  async function saveEmployeeAccess(access: AccessMap) {
    if (!editingEmpId || !editingEmp?.userId) return;
    const ok = await run(
      () => api(`/hr/employees/${editingEmpId}/account`, {
        method: 'PATCH',
        body: JSON.stringify({
          fullName: accountForm.fullName,
          role: accountForm.role,
          isActive: accountForm.isActive,
          warehouseIds: accountForm.warehouseIds,
          permissions: access,
          ...(accountForm.password ? { password: accountForm.password } : {}),
        }),
      }),
      'تم تحديث الحساب',
    );
    if (ok) {
      const fresh = await api<Employee>(`/hr/employees/${editingEmpId}`);
      setEditingEmp(fresh);
      setEmployees(await api<Employee[]>('/hr/employees'));
    }
  }

  async function saveAttendance(e: React.FormEvent) {
    e.preventDefault();
    if (!attForm.employeeId || !attForm.date) return toast.error('حدد الموظف والتاريخ');
    const body = {
      employeeId: attForm.employeeId,
      date: attForm.date,
      checkIn: attForm.checkIn ? new Date(attForm.checkIn).toISOString() : null,
      checkOut: attForm.checkOut ? new Date(attForm.checkOut).toISOString() : null,
      status: attForm.status,
      notes: attForm.notes || undefined,
    };
    const ok = await run(() => api('/hr/attendance', { method: 'POST', body: JSON.stringify(body) }), 'تم حفظ الحضور');
    if (ok) await reloadTab();
  }

  async function saveLeave(e: React.FormEvent) {
    e.preventDefault();
    if (!leaveForm.employeeId) return toast.error('حدد الموظف');
    const body = {
      employeeId: leaveForm.employeeId,
      type: leaveForm.type,
      fromDate: leaveForm.fromDate,
      toDate: leaveForm.toDate,
      hours: leaveForm.type === 'PERMISSION' ? num(leaveForm.hours) : undefined,
      notes: leaveForm.notes || undefined,
    };
    const ok = await run(() => api('/hr/leaves', { method: 'POST', body: JSON.stringify(body) }), 'تم تسجيل الإجازة');
    if (ok) await reloadTab();
  }

  async function saveMovement(e: React.FormEvent) {
    e.preventDefault();
    if (!movForm.employeeId || num(movForm.amount) <= 0) return toast.error('حدد الموظف والمبلغ');
    const ok = await run(
      () => api('/hr/movements', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: movForm.employeeId,
          kind: movForm.kind,
          amount: num(movForm.amount),
          movementDate: movForm.movementDate,
          notes: movForm.notes || undefined,
        }),
      }),
      'تم تسجيل الحركة',
    );
    if (ok) await reloadTab();
  }

  async function calcPayroll() {
    const ok = await run(async () => {
      const res = await api<PayrollCalc>('/hr/payroll/calc', {
        method: 'POST',
        body: JSON.stringify({ from: rangeFrom, to: rangeTo, ...(employeeFilter ? { employeeIds: [employeeFilter] } : {}) }),
      });
      setPayrollCalc(res);
    });
    if (!ok) setPayrollCalc(null);
  }

  async function savePayrollDraft() {
    if (!payrollCalc?.lines.length) return toast.error('احسب المرتبات أولاً');
    const ok = await run(
      () => api('/hr/payroll/runs', {
        method: 'POST',
        body: JSON.stringify({
          from: rangeFrom,
          to: rangeTo,
          notes: payrollDraftNotes || undefined,
          ...(employeeFilter ? { employeeIds: [employeeFilter] } : {}),
        }),
      }),
      'تم حفظ مسودة كشف المرتبات',
    );
    if (ok) {
      setPayrollCalc(null);
      setPayrollDraftNotes('');
      await reloadTab();
    }
  }

  async function postPayroll(payrollRun: PayrollRun) {
    const methodId = postMethodByRun[payrollRun.id] || methods[0]?.id || undefined;
    if (!(await confirm({
      title: 'اعتماد كشف المرتبات',
      message: 'هيتعمل قيد استحقاق (مصروف رواتب ↔ رواتب مستحقة) من غير صرف نقدي. الصرف من تبويب المدفوعات.',
    }))) return;
    const ok = await run(
      () => api(`/hr/payroll/runs/${payrollRun.id}/post`, {
        method: 'POST',
        body: JSON.stringify(methodId ? { methodId } : {}),
      }),
      'تم اعتماد كشف المرتبات',
    );
    if (ok) await reloadTab();
  }

  async function payPayroll(payrollRun: PayrollRun) {
    const methodId = postMethodByRun[payrollRun.id] || payrollRun.methodId || methods[0]?.id;
    if (!methodId) return toast.error('حدد طريقة الدفع');
    if (!(await confirm({
      title: 'صرف المرتبات',
      message: 'هيتم خصم المبلغ من الخزنة وتقفيل المستحقات المحاسبية. الدفع الجزئي غير مدعوم.',
    }))) return;
    const ok = await run(
      () => api(`/hr/payroll/runs/${payrollRun.id}/pay`, { method: 'POST', body: JSON.stringify({ methodId }) }),
      'تم صرف كشف المرتبات',
    );
    if (ok) await reloadTab();
  }

  async function deletePayrollDraft(payrollRun: PayrollRun) {
    if (!(await confirm({ title: 'حذف المسودة', message: 'حذف كشف المرتبات؟', danger: true }))) return;
    const ok = await run(() => api(`/hr/payroll/runs/${payrollRun.id}`, { method: 'DELETE' }), 'تم الحذف');
    if (ok) await reloadTab();
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!hrSettings) return;
    const ok = await run(
      () => api('/hr/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          workStart: hrSettings.workStart,
          workEnd: hrSettings.workEnd,
          graceMinutes: hrSettings.graceMinutes,
          monthWorkDays: hrSettings.monthWorkDays,
          weekendDays: JSON.stringify(weekendSel),
          lateDeductPerMinute: hrSettings.lateDeductPerMinute,
        }),
      }),
      'تم حفظ إعدادات HR',
    );
    if (ok) await reloadTab();
  }

  const showRange = ['attendance', 'leaves', 'movements', 'payroll', 'commissions'].includes(tab);
  const printTitle = {
    attendance: 'تقرير الحضور',
    leaves: 'تقرير الإجازات',
    movements: 'تقرير الحركات المالية',
    payroll: 'معاينة المرتبات',
    commissions: 'تقرير العمولات',
  }[tab as string] || 'تقرير';

  return (
    <div>
      <PageHeader
        title="الموارد البشرية"
        subtitle={isStaff ? 'إدارة الموظفين والحضور والمرتبات' : 'إرسال ومتابعة طلباتك'}
        actions={showRange ? (
          <Button type="button" variant="secondary" onClick={() => window.print()}>
            <Printer className="h-4 w-4" />
            طباعة
          </Button>
        ) : undefined}
      />

      {loadError && <Card className="mb-4"><ErrorState text={loadError} onRetry={reloadTab} /></Card>}

      {isStaff && (
        <StatGrid>
          <StatCard label="طلبات معلّقة" value={String(pendingRequests)} hint="بانتظار الموافقة" icon={ClipboardList} tone="amber" onClick={() => setTab('requests')} active={tab === 'requests'} />
          <StatCard label="موظفون نشطون" value={String(activeEmployees.length)} hint={`من ${employees.length} إجمالي`} icon={Users} tone="brand" onClick={() => setTab('employees')} active={tab === 'employees'} />
          <StatCard label="كشوف مسودة" value={String(payrollRuns.filter((r) => r.status === 'DRAFT').length)} hint="مرتبات لم تُرحّل" icon={CircleDollarSign} tone="violet" onClick={() => setTab('payroll')} active={tab === 'payroll'} />
        </StatGrid>
      )}

      <div className="mb-4 flex w-fit max-w-full flex-wrap rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] font-bold transition ${tab === t.id ? 'bg-brand-700 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {t.label}
            </button>
          );
        })}
      </div>

      {showRange && isStaff && (
        <Card className="mb-4 print:hidden">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label>من تاريخ</Label>
              <Input type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
            </div>
            <div>
              <Label>إلى تاريخ</Label>
              <Input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
            </div>
            {tab !== 'payroll' && (
              <div className="min-w-[180px] flex-1">
                <Label>موظف (اختياري)</Label>
                <Select value={employeeFilter} onChange={(e) => setEmployeeFilter(e.target.value)}>
                  <option value="">الكل</option>
                  {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.code} — {emp.name}</option>)}
                </Select>
              </div>
            )}
            <Button type="button" variant="secondary" onClick={() => reloadTab()}>تطبيق</Button>
          </div>
        </Card>
      )}

      {showRange && (
        <div className="print-only mb-4 hidden print:block">
          <PrintHeader
            title={printTitle}
            subtitle={`${rangeFrom} → ${rangeTo}${employeeFilter ? ` — ${employeeName(employeeFilter)}` : ''}`}
          />
        </div>
      )}

      {tab === 'requests' && (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <Card className="print:hidden">
            <CardHeader title={isStaff ? 'طلب جديد' : 'طلب جديد لك'} subtitle="إجازة · إذن · سلفة" icon={UserPlus} />
            {!isStaff && !meEmployee && <Empty text="حسابك غير مربوط بملف موظف — تواصل مع الإدارة." />}
            {(isStaff || meEmployee) && (
              <form className="space-y-3" onSubmit={submitRequest}>
                <div>
                  <Label>نوع الطلب</Label>
                  <Select value={reqForm.kind} onChange={(e) => setReqForm({ ...reqForm, kind: e.target.value as typeof reqForm.kind })}>
                    <option value="LEAVE">إجازة</option>
                    <option value="PERMISSION">إذن</option>
                    <option value="ADVANCE">سلفة</option>
                  </Select>
                </div>
                {isStaff && (
                  <div>
                    <Label>الموظف</Label>
                    <Select value={reqForm.employeeId} onChange={(e) => setReqForm({ ...reqForm, employeeId: e.target.value })}>
                      <option value="">اختر موظفاً</option>
                      {activeEmployees.map((emp) => <option key={emp.id} value={emp.id}>{emp.code} — {emp.name}</option>)}
                    </Select>
                  </div>
                )}
                {reqForm.kind === 'LEAVE' && (
                  <>
                    <div>
                      <Label>نوع الإجازة</Label>
                      <Select value={reqForm.leaveType} onChange={(e) => setReqForm({ ...reqForm, leaveType: e.target.value })}>
                        {LEAVE_FOR_REQUEST.map((t) => <option key={t} value={t}>{LEAVE_TYPES[t]}</option>)}
                      </Select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label>من</Label>
                        <Input type="date" value={reqForm.fromDate} onChange={(e) => setReqForm({ ...reqForm, fromDate: e.target.value })} />
                      </div>
                      <div>
                        <Label>إلى</Label>
                        <Input type="date" value={reqForm.toDate} onChange={(e) => setReqForm({ ...reqForm, toDate: e.target.value })} />
                      </div>
                    </div>
                  </>
                )}
                {reqForm.kind === 'PERMISSION' && (
                  <>
                    <div>
                      <Label>اليوم</Label>
                      <Input type="date" value={reqForm.fromDate} onChange={(e) => setReqForm({ ...reqForm, fromDate: e.target.value })} />
                    </div>
                    <div>
                      <Label>عدد الساعات</Label>
                      <NumberInput value={reqForm.hours} onValueChange={(v) => setReqForm({ ...reqForm, hours: v })} min={0} step={0.5} />
                    </div>
                  </>
                )}
                {reqForm.kind === 'ADVANCE' && (
                  <div>
                    <Label>المبلغ</Label>
                    <NumberInput value={reqForm.amount} onValueChange={(v) => setReqForm({ ...reqForm, amount: v })} min={0} />
                  </div>
                )}
                <div>
                  <Label>السبب / ملاحظات</Label>
                  <Input value={reqForm.reason} onChange={(e) => setReqForm({ ...reqForm, reason: e.target.value })} />
                </div>
                <Button type="submit" disabled={busy} className="w-full">إرسال الطلب</Button>
              </form>
            )}
          </Card>

          <Card>
            <CardHeader
              title={isStaff ? 'قائمة الطلبات' : 'طلباتي'}
              icon={ClipboardList}
              actions={isStaff ? (
                <Select className="max-w-[140px]" value={requestFilter} onChange={(e) => setRequestFilter(e.target.value)}>
                  <option value="">كل الحالات</option>
                  {Object.entries(REQUEST_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </Select>
              ) : undefined}
            />
            {requests.length === 0 ? (
              <Empty text="لا توجد طلبات في الفترة الحالية." />
            ) : (
              <Table>
                <thead>
                  <tr>
                    {isStaff && <Th>الموظف</Th>}
                    <Th>النوع</Th>
                    <Th>التفاصيل</Th>
                    <Th>الحالة</Th>
                    <Th>التاريخ</Th>
                    <Th className="print:hidden">إجراء</Th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((row) => {
                    const st = REQUEST_STATUS[row.status] || { label: row.status, tone: 'slate' as Tone };
                    let detail = '';
                    if (row.kind === 'LEAVE') {
                      detail = `${row.leaveType ? LEAVE_TYPES[row.leaveType] || row.leaveType : ''} ${row.fromDate ? formatDate(row.fromDate) : ''}${row.toDate && row.toDate !== row.fromDate ? ` → ${formatDate(row.toDate)}` : ''}`;
                    } else if (row.kind === 'PERMISSION') {
                      detail = `${formatDate(row.fromDate || row.createdAt)} — ${row.hours} ساعة`;
                    } else {
                      detail = formatMoney(row.amount);
                    }
                    return (
                      <tr key={row.id}>
                        {isStaff && <Td className="font-bold">{row.employee.name}</Td>}
                        <Td>{REQUEST_KIND[row.kind]}</Td>
                        <Td>
                          <div>{detail}</div>
                          {row.reason && <div className="text-xs text-muted">{row.reason}</div>}
                          {row.rejectReason && <div className="text-xs text-rose-600">سبب الرفض: {row.rejectReason}</div>}
                        </Td>
                        <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
                        <Td>{formatDate(row.createdAt)}</Td>
                        <Td className="print:hidden">
                          <div className="flex flex-wrap gap-1">
                            {row.status === 'PENDING' && isStaff && (
                              <>
                                <Button type="button" variant="secondary" onClick={() => approveRequest(row)} disabled={busy}>موافقة</Button>
                                <Button type="button" variant="danger" onClick={() => rejectRequest(row)} disabled={busy}>رفض</Button>
                              </>
                            )}
                            {row.status === 'PENDING' && (
                              <Button type="button" variant="secondary" onClick={() => cancelRequest(row)} disabled={busy}>إلغاء</Button>
                            )}
                          </div>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {tab === 'employees' && isStaff && (
        <Card>
          <CardHeader
            title="سجل الموظفين"
            subtitle="البيانات الأساسية وربط حسابات الدخول"
            icon={Briefcase}
            actions={<Button type="button" onClick={openEmpCreate}><UserPlus className="h-4 w-4" />موظف جديد</Button>}
          />
          {employees.length === 0 ? (
            <Empty text="لا يوجد موظفون مسجلون بعد." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>الكود</Th>
                  <Th>الاسم</Th>
                  <Th>الوظيفة</Th>
                  <Th>حساب الدخول</Th>
                  {seeSalary && <Th>الراتب</Th>}
                  <Th>الحالة</Th>
                  <Th>إجراء</Th>
                </tr>
              </thead>
              <tbody>
                {employees.map((row) => (
                  <tr key={row.id}>
                    <Td className="font-mono text-xs">{row.code}</Td>
                    <Td className="font-bold">{row.name}</Td>
                    <Td>{row.jobTitle || '—'}</Td>
                    <Td>{row.user ? `${row.user.username} (${ROLE_LABELS[row.user.role] || row.user.role})` : '—'}</Td>
                    {seeSalary && <Td>{formatMoney(row.basicSalary)}</Td>}
                    <Td><Badge tone={row.isActive ? 'emerald' : 'slate'}>{row.isActive ? 'نشط' : 'موقوف'}</Badge></Td>
                    <Td><Button type="button" variant="secondary" onClick={() => openEmpEdit(row)}>تعديل</Button></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'attendance' && isStaff && (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <Card className="print:hidden">
            <CardHeader title="تسجيل يدوي" icon={Clock} />
            <form className="space-y-3" onSubmit={saveAttendance}>
              <div>
                <Label>الموظف</Label>
                <Select value={attForm.employeeId} onChange={(e) => setAttForm({ ...attForm, employeeId: e.target.value })}>
                  <option value="">اختر</option>
                  {activeEmployees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </Select>
              </div>
              <div>
                <Label>التاريخ</Label>
                <Input type="date" value={attForm.date} onChange={(e) => setAttForm({ ...attForm, date: e.target.value })} />
              </div>
              <div>
                <Label>حضور</Label>
                <Input type="datetime-local" value={attForm.checkIn} onChange={(e) => setAttForm({ ...attForm, checkIn: e.target.value })} />
              </div>
              <div>
                <Label>انصراف</Label>
                <Input type="datetime-local" value={attForm.checkOut} onChange={(e) => setAttForm({ ...attForm, checkOut: e.target.value })} />
              </div>
              <div>
                <Label>الحالة</Label>
                <Select value={attForm.status} onChange={(e) => setAttForm({ ...attForm, status: e.target.value })}>
                  {Object.entries(ATT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </div>
              <div>
                <Label>ملاحظات</Label>
                <Input value={attForm.notes} onChange={(e) => setAttForm({ ...attForm, notes: e.target.value })} />
              </div>
              <Button type="submit" disabled={busy} className="w-full">حفظ</Button>
            </form>
            <Button
              type="button"
              variant="secondary"
              className="mt-3 w-full"
              disabled={busy}
              onClick={() => run(() => api('/hr/attendance/recalculate-late', { method: 'POST' }), 'تم إعادة حساب التأخير').then((ok) => { if (ok) reloadTab(); })}
            >
              إعادة حساب التأخير
            </Button>
          </Card>
          <Card>
            {attendance.length === 0 ? <Empty text="لا سجلات حضور." /> : (
              <Table>
                <thead>
                  <tr>
                    <Th>الموظف</Th>
                    <Th>اليوم</Th>
                    <Th>حضور</Th>
                    <Th>انصراف</Th>
                    <Th>تأخير (د)</Th>
                    <Th>الحالة</Th>
                    <Th className="print:hidden">حذف</Th>
                  </tr>
                </thead>
                <tbody>
                  {attendance.map((row) => (
                    <tr key={row.id}>
                      <Td className="font-bold">{row.employee.name}</Td>
                      <Td>{formatDate(row.date)}</Td>
                      <Td>{row.checkIn ? formatTime(row.checkIn) : '—'}</Td>
                      <Td>{row.checkOut ? formatTime(row.checkOut) : '—'}</Td>
                      <Td>{row.lateMinutes || 0}</Td>
                      <Td>{ATT_STATUS[row.status] || row.status}</Td>
                      <Td className="print:hidden">
                        <Button
                          type="button"
                          variant="danger"
                          disabled={busy}
                          onClick={async () => {
                            if (!(await confirm({ title: 'حذف', message: 'حذف سجل الحضور؟', danger: true }))) return;
                            const ok = await run(() => api(`/hr/attendance/${row.id}`, { method: 'DELETE' }), 'تم الحذف');
                            if (ok) await reloadTab();
                          }}
                        >
                          حذف
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {tab === 'leaves' && isStaff && (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <Card className="print:hidden">
            <CardHeader title="إجازة جديدة" icon={CalendarDays} />
            <form className="space-y-3" onSubmit={saveLeave}>
              <div>
                <Label>الموظف</Label>
                <Select value={leaveForm.employeeId} onChange={(e) => setLeaveForm({ ...leaveForm, employeeId: e.target.value })}>
                  <option value="">اختر</option>
                  {activeEmployees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </Select>
              </div>
              <div>
                <Label>النوع</Label>
                <Select value={leaveForm.type} onChange={(e) => setLeaveForm({ ...leaveForm, type: e.target.value })}>
                  {Object.entries(LEAVE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>من</Label>
                  <Input type="date" value={leaveForm.fromDate} onChange={(e) => setLeaveForm({ ...leaveForm, fromDate: e.target.value })} />
                </div>
                <div>
                  <Label>إلى</Label>
                  <Input type="date" value={leaveForm.toDate} onChange={(e) => setLeaveForm({ ...leaveForm, toDate: e.target.value })} />
                </div>
              </div>
              {leaveForm.type === 'PERMISSION' && (
                <div>
                  <Label>ساعات</Label>
                  <NumberInput value={leaveForm.hours} onValueChange={(v) => setLeaveForm({ ...leaveForm, hours: v })} min={0} step={0.5} />
                </div>
              )}
              <div>
                <Label>ملاحظات</Label>
                <Input value={leaveForm.notes} onChange={(e) => setLeaveForm({ ...leaveForm, notes: e.target.value })} />
              </div>
              <Button type="submit" disabled={busy} className="w-full">تسجيل</Button>
            </form>
          </Card>
          <Card>
            {leaves.length === 0 ? <Empty text="لا إجازات." /> : (
              <Table>
                <thead>
                  <tr><Th>الموظف</Th><Th>النوع</Th><Th>من</Th><Th>إلى</Th><Th>ساعات</Th><Th className="print:hidden">حذف</Th></tr>
                </thead>
                <tbody>
                  {leaves.map((row) => (
                    <tr key={row.id}>
                      <Td className="font-bold">{row.employee.name}</Td>
                      <Td>{LEAVE_TYPES[row.type] || row.type}</Td>
                      <Td>{formatDate(row.fromDate)}</Td>
                      <Td>{formatDate(row.toDate)}</Td>
                      <Td>{row.hours || '—'}</Td>
                      <Td className="print:hidden">
                        <Button type="button" variant="danger" disabled={busy} onClick={async () => {
                          if (!(await confirm({ title: 'حذف', message: 'حذف الإجازة؟', danger: true }))) return;
                          const ok = await run(() => api(`/hr/leaves/${row.id}`, { method: 'DELETE' }), 'تم الحذف');
                          if (ok) await reloadTab();
                        }}>حذف</Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {tab === 'movements' && isStaff && (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <Card className="print:hidden">
            <CardHeader title="حركة مالية" icon={Wallet} />
            <form className="space-y-3" onSubmit={saveMovement}>
              <div>
                <Label>الموظف</Label>
                <Select value={movForm.employeeId} onChange={(e) => setMovForm({ ...movForm, employeeId: e.target.value })}>
                  <option value="">اختر</option>
                  {activeEmployees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </Select>
              </div>
              <div>
                <Label>النوع</Label>
                <Select value={movForm.kind} onChange={(e) => setMovForm({ ...movForm, kind: e.target.value as typeof movForm.kind })}>
                  {Object.entries(MOVEMENT_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </div>
              <div>
                <Label>المبلغ</Label>
                <NumberInput value={movForm.amount} onValueChange={(v) => setMovForm({ ...movForm, amount: v })} min={0} />
              </div>
              <div>
                <Label>التاريخ</Label>
                <Input type="date" value={movForm.movementDate} onChange={(e) => setMovForm({ ...movForm, movementDate: e.target.value })} />
              </div>
              <div>
                <Label>ملاحظات</Label>
                <Input value={movForm.notes} onChange={(e) => setMovForm({ ...movForm, notes: e.target.value })} />
              </div>
              <Button type="submit" disabled={busy} className="w-full">تسجيل</Button>
            </form>
          </Card>
          <Card>
            {movements.length === 0 ? <Empty text="لا حركات." /> : (
              <Table>
                <thead>
                  <tr><Th>الموظف</Th><Th>النوع</Th><Th>المبلغ</Th><Th>التاريخ</Th><Th>تسوية</Th><Th className="print:hidden">حذف</Th></tr>
                </thead>
                <tbody>
                  {movements.map((row) => (
                    <tr key={row.id}>
                      <Td className="font-bold">{row.employee.name}</Td>
                      <Td>{MOVEMENT_KIND[row.kind] || row.kind}</Td>
                      <Td>{formatMoney(row.amount)}</Td>
                      <Td>{formatDate(row.movementDate)}</Td>
                      <Td><Badge tone={row.settled ? 'emerald' : 'amber'}>{row.settled ? 'مُسوّى' : 'مفتوح'}</Badge></Td>
                      <Td className="print:hidden">
                        <Button type="button" variant="danger" disabled={busy} onClick={async () => {
                          if (!(await confirm({ title: 'حذف', message: 'حذف الحركة؟', danger: true }))) return;
                          const ok = await run(() => api(`/hr/movements/${row.id}`, { method: 'DELETE' }), 'تم الحذف');
                          if (ok) await reloadTab();
                        }}>حذف</Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {tab === 'payroll' && isStaff && (
        <div className="space-y-4">
          <Card className="print:hidden">
            <CardHeader title="حساب ومسودة المرتبات" icon={CircleDollarSign} />
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <Button type="button" onClick={calcPayroll} disabled={busy}>احسب المعاينة</Button>
              <Button type="button" variant="secondary" onClick={savePayrollDraft} disabled={busy || !payrollCalc?.lines.length}>حفظ مسودة</Button>
            </div>
            <div className="mb-3">
              <Label>ملاحظات المسودة</Label>
              <Input value={payrollDraftNotes} onChange={(e) => setPayrollDraftNotes(e.target.value)} />
            </div>
            {payrollCalc && (
              <PayrollPreviewTable payrollCalc={payrollCalc} seeSalary={seeSalary} />
            )}
            {payrollCalc?.skipped.length ? (
              <Card className="mt-3 border-amber-200 bg-amber-50">
                <div className="text-sm font-bold text-amber-900">موظفون تم تخطيهم</div>
                <ul className="mt-1 text-sm text-amber-800">
                  {payrollCalc.skipped.map((s) => <li key={s.employeeId}>{s.name}: {s.reason}</li>)}
                </ul>
              </Card>
            ) : null}
          </Card>

          <Card className="print:hidden">
            <CardHeader title="كشوف المرتبات" subtitle="مسودة وترحيل" />
            {payrollRuns.length === 0 ? <Empty text="لا كشوف مرتبات." /> : (
              <Table>
                <thead>
                  <tr>
                    <Th>الفترة</Th>
                    <Th>الحالة</Th>
                    <Th>الموظفين</Th>
                    <Th>الصافي</Th>
                    <Th>إجراء</Th>
                  </tr>
                </thead>
                <tbody>
                  {payrollRuns.map((run) => {
                    const totalNet = run.lines.reduce((s, l) => s + l.net, 0);
                    return (
                      <tr key={run.id}>
                        <Td>{formatDate(run.fromDate)} → {formatDate(run.toDate)}</Td>
                        <Td><Badge tone={run.status === 'POSTED' ? 'emerald' : 'amber'}>{run.status === 'POSTED' ? 'مرحّل' : 'مسودة'}</Badge></Td>
                        <Td>{run._count?.lines ?? run.lines.length}</Td>
                        <Td>{seeSalary ? formatMoney(totalNet) : '—'}</Td>
                        <Td>
                          <PayrollRunActions
                            run={run}
                            busy={busy}
                            methods={methods}
                            postMethodByRun={postMethodByRun}
                            setPostMethodByRun={setPostMethodByRun}
                            onPost={postPayroll}
                            onDelete={deletePayrollDraft}
                            onView={setSelectedRun}
                          />
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {tab === 'payments' && isStaff && (
        <Card>
          <CardHeader title="مدفوعات الرواتب" subtitle="كشوف معتمدة بانتظار الصرف أو مصروفة" icon={BadgeCheck} />
          {postedPayrolls.length === 0 ? <Empty text="لا كشوف معتمدة أو مصروفة." /> : (
            <Table>
              <thead>
                <tr><Th>الفترة</Th><Th>الحالة</Th><Th>تاريخ الاعتماد</Th><Th>الموظفين</Th><Th>الصافي</Th><Th>إجراء</Th></tr>
              </thead>
              <tbody>
                {postedPayrolls.map((run) => (
                  <tr key={run.id}>
                    <Td>{formatDate(run.fromDate)} → {formatDate(run.toDate)}</Td>
                    <Td>{run.status === 'PAID' ? 'مصروف' : 'مستحق'}</Td>
                    <Td>{run.postedAt ? formatDate(run.postedAt) : '—'}</Td>
                    <Td>{run.lines.length}</Td>
                    <Td>{seeSalary ? formatMoney(run.lines.reduce((s, l) => s + l.net, 0)) : '—'}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        <Button type="button" variant="secondary" onClick={() => setSelectedRun(run)}>عرض</Button>
                        {run.status === 'POSTED' && (
                          <>
                            <Select
                              className="max-w-[120px]"
                              value={postMethodByRun[run.id] || run.methodId || methods[0]?.id || ''}
                              onChange={(e) => setPostMethodByRun((m) => ({ ...m, [run.id]: e.target.value }))}
                            >
                              {methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </Select>
                            <Button type="button" onClick={() => payPayroll(run)} disabled={busy}>صرف</Button>
                          </>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'commissions' && isStaff && (
        <div className="space-y-4">
          {commission && commission.unlinkedSales.length > 0 && (
            <Card className="border-amber-200 bg-amber-50 print:hidden">
              <div className="text-sm font-bold text-amber-900">مبيعات لمستخدمين غير مربوطين بموظف</div>
              <Table>
                <thead><tr><Th>المستخدم</Th><Th>عدد الفواتير</Th><Th>إجمالي المبيعات</Th></tr></thead>
                <tbody>
                  {commission.unlinkedSales.map((row) => (
                    <tr key={row.userId}>
                      <Td>{row.fullName || row.username}</Td>
                      <Td>{row.count}</Td>
                      <Td>{formatMoney(row.salesTotal)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
          <Card>
            <CardHeader title="ملخص العمولات" subtitle={commission ? `${commission.from} → ${commission.to}` : ''} icon={Gift} />
            {!commission?.rows.length ? <Empty text="لا بيانات عمولات." /> : (
              <Table>
                <thead>
                  <tr>
                    <Th>الموظف</Th>
                    <Th>مرتبط</Th>
                    <Th>%</Th>
                    <Th>المبيعات</Th>
                    <Th>مستحق</Th>
                    <Th>مدفوع</Th>
                    <Th>متبقي</Th>
                  </tr>
                </thead>
                <tbody>
                  {commission.rows.map((row) => (
                    <tr key={row.employeeId}>
                      <Td className="font-bold">{row.name}</Td>
                      <Td><Badge tone={row.linked ? 'emerald' : 'rose'}>{row.linked ? 'نعم' : 'لا'}</Badge></Td>
                      <Td>{row.commissionPercent}%</Td>
                      <Td>{formatMoney(row.salesTotal)}</Td>
                      <Td>{formatMoney(row.accrued)}</Td>
                      <Td>{formatMoney(row.paid)}</Td>
                      <Td className="font-extrabold">{formatMoney(row.remaining)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {tab === 'settings' && isStaff && hrSettings && (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <Card>
            <CardHeader title="إعدادات الدوام" icon={Settings2} />
            <form className="space-y-4" onSubmit={saveSettings}>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>بداية الدوام</Label>
                  <Input type="time" value={hrSettings.workStart} onChange={(e) => setHrSettings({ ...hrSettings, workStart: e.target.value })} />
                </div>
                <div>
                  <Label>نهاية الدوام</Label>
                  <Input type="time" value={hrSettings.workEnd} onChange={(e) => setHrSettings({ ...hrSettings, workEnd: e.target.value })} />
                </div>
                <div>
                  <Label>فترة سماح (دقيقة)</Label>
                  <NumberInput value={hrSettings.graceMinutes} onValueChange={(v) => setHrSettings({ ...hrSettings, graceMinutes: num(v) })} min={0} />
                </div>
                <div>
                  <Label>أيام الشهر للراتب</Label>
                  <NumberInput value={hrSettings.monthWorkDays} onValueChange={(v) => setHrSettings({ ...hrSettings, monthWorkDays: num(v) })} min={1} />
                </div>
                <div>
                  <Label>خصم التأخير / دقيقة</Label>
                  <NumberInput value={hrSettings.lateDeductPerMinute} onValueChange={(v) => setHrSettings({ ...hrSettings, lateDeductPerMinute: num(v) })} min={0} step={0.01} />
                </div>
              </div>
              <div>
                <Label>عطلة أسبوعية</Label>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map((day) => (
                    <label key={day.v} className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-sm">
                      <input
                        type="checkbox"
                        checked={weekendSel.includes(day.v)}
                        onChange={(e) => {
                          setWeekendSel((cur) => (e.target.checked ? [...cur, day.v] : cur.filter((x) => x !== day.v)));
                        }}
                      />
                      {day.label}
                    </label>
                  ))}
                </div>
              </div>
              <Button type="submit" disabled={busy}>حفظ الإعدادات</Button>
            </form>
          </Card>

          <Card>
            <CardHeader title="الإجازات الرسمية" icon={CalendarDays} />
            <form
              className="mb-4 space-y-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!holidayForm.name.trim()) return toast.error('اسم العطلة مطلوب');
                const ok = await run(
                  () => api('/hr/holidays', { method: 'POST', body: JSON.stringify(holidayForm) }),
                  'تمت إضافة العطلة',
                );
                if (ok) {
                  setHolidayForm({ date: todayIso(), name: '', yearly: false });
                  await reloadTab();
                }
              }}
            >
              <div>
                <Label>التاريخ</Label>
                <Input type="date" value={holidayForm.date} onChange={(e) => setHolidayForm({ ...holidayForm, date: e.target.value })} />
              </div>
              <div>
                <Label>الاسم</Label>
                <Input value={holidayForm.name} onChange={(e) => setHolidayForm({ ...holidayForm, name: e.target.value })} />
              </div>
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={holidayForm.yearly} onChange={(e) => setHolidayForm({ ...holidayForm, yearly: e.target.checked })} />
                تتكرر سنوياً
              </label>
              <Button type="submit" disabled={busy} className="w-full">إضافة</Button>
            </form>
            {holidays.length === 0 ? <Empty text="لا عطلات رسمية." /> : (
              <Table>
                <thead><tr><Th>التاريخ</Th><Th>الاسم</Th><Th>سنوية</Th><Th></Th></tr></thead>
                <tbody>
                  {holidays.map((h) => (
                    <tr key={h.id}>
                      <Td>{formatDate(h.date)}</Td>
                      <Td>{h.name}</Td>
                      <Td>{h.yearly ? 'نعم' : 'لا'}</Td>
                      <Td>
                        <Button type="button" variant="danger" disabled={busy} onClick={async () => {
                          if (!(await confirm({ title: 'حذف', message: 'حذف العطلة؟', danger: true }))) return;
                          const ok = await run(() => api(`/hr/holidays/${h.id}`, { method: 'DELETE' }), 'تم الحذف');
                          if (ok) await reloadTab();
                        }}>حذف</Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      <Modal open={empModal} onClose={() => setEmpModal(false)} title={editingEmpId ? 'تعديل موظف' : 'موظف جديد'} wide>
        <form className="space-y-4" onSubmit={saveEmployee}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>الكود</Label>
              <Input value={empForm.code} onChange={(e) => setEmpForm({ ...empForm, code: e.target.value })} />
            </div>
            <div>
              <Label>الاسم</Label>
              <Input value={empForm.name} onChange={(e) => setEmpForm({ ...empForm, name: e.target.value })} />
            </div>
            <div>
              <Label>الهاتف</Label>
              <Input value={empForm.phone} onChange={(e) => setEmpForm({ ...empForm, phone: e.target.value })} />
            </div>
            <div>
              <Label>الرقم القومي</Label>
              <Input value={empForm.nationalId} onChange={(e) => setEmpForm({ ...empForm, nationalId: e.target.value })} />
            </div>
            <div>
              <Label>المسمى</Label>
              <Input value={empForm.jobTitle} onChange={(e) => setEmpForm({ ...empForm, jobTitle: e.target.value })} />
            </div>
            <div>
              <Label>القسم</Label>
              <Input value={empForm.department} onChange={(e) => setEmpForm({ ...empForm, department: e.target.value })} />
            </div>
            <div>
              <Label>تاريخ التعيين</Label>
              <Input type="date" value={empForm.hireDate} onChange={(e) => setEmpForm({ ...empForm, hireDate: e.target.value })} />
            </div>
            <div>
              <Label>حساب بنكي</Label>
              <Input value={empForm.bankAccount} onChange={(e) => setEmpForm({ ...empForm, bankAccount: e.target.value })} />
            </div>
            {seeSalary && (
              <>
                <div>
                  <Label>الراتب الأساسي</Label>
                  <NumberInput value={empForm.basicSalary} onValueChange={(v) => setEmpForm({ ...empForm, basicSalary: v })} min={0} />
                </div>
                <div>
                  <Label>نسبة العمولة %</Label>
                  <NumberInput value={empForm.commissionPercent} onValueChange={(v) => setEmpForm({ ...empForm, commissionPercent: v })} min={0} max={100} />
                </div>
              </>
            )}
            <div className="sm:col-span-2">
              <Label>ربط مستخدم موجود</Label>
              <Select value={empForm.userId} onChange={(e) => setEmpForm({ ...empForm, userId: e.target.value })}>
                <option value="">بدون ربط</option>
                {linkableUsers.map((u) => <option key={u.id} value={u.id}>{u.fullName} ({u.username})</option>)}
              </Select>
            </div>
            {editingEmpId && (
              <label className="flex items-center gap-2 text-sm font-semibold sm:col-span-2">
                <input type="checkbox" checked={empForm.isActive} onChange={(e) => setEmpForm({ ...empForm, isActive: e.target.checked })} />
                موظف نشط
              </label>
            )}
            <div className="sm:col-span-2">
              <Label>ملاحظات</Label>
              <Input value={empForm.notes} onChange={(e) => setEmpForm({ ...empForm, notes: e.target.value })} />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 p-3">
              <div className="mb-2 text-sm font-bold text-slate-700">
                {editingEmp?.userId ? 'تحديث حساب الدخول' : 'إنشاء حساب دخول (اختياري)'}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>اسم الدخول</Label>
                  <Input value={accountForm.username} disabled={!!editingEmp?.userId} onChange={(e) => setAccountForm({ ...accountForm, username: e.target.value })} />
                </div>
                <div>
                  <Label>{editingEmp?.userId ? 'كلمة سر جديدة (اختياري)' : 'كلمة السر'}</Label>
                  <Input type="password" value={accountForm.password} onChange={(e) => setAccountForm({ ...accountForm, password: e.target.value })} />
                </div>
                <div>
                  <Label>الاسم المعروض</Label>
                  <Input value={accountForm.fullName} onChange={(e) => setAccountForm({ ...accountForm, fullName: e.target.value })} />
                </div>
                <div>
                  <Label>الدور</Label>
                  <Select value={accountForm.role} onChange={(e) => setAccountForm({ ...accountForm, role: e.target.value })}>
                    {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </Select>
                </div>
                {editingEmp?.userId && (
                  <label className="flex items-center gap-2 text-sm font-semibold sm:col-span-2">
                    <input type="checkbox" checked={accountForm.isActive} onChange={(e) => setAccountForm({ ...accountForm, isActive: e.target.checked })} />
                    حساب نشط
                  </label>
                )}
              </div>
              <div className="mt-3">
                <Label>مخازن الحساب</Label>
                <WarehouseMultiSelect warehouses={warehouses} value={accountForm.warehouseIds} onChange={(ids) => setAccountForm({ ...accountForm, warehouseIds: ids })} />
              </div>
              {editingEmp?.userId && (
                <UserAccess
                  role={accountForm.role}
                  value={editingEmp.user?.permissions || null}
                  busy={busy}
                  onSave={saveEmployeeAccess}
                />
              )}
            </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setEmpModal(false)}>إلغاء</Button>
            <Button type="submit" disabled={busy}>حفظ</Button>
          </div>
        </form>
      </Modal>

      <Modal open={!!selectedRun} onClose={() => setSelectedRun(null)} title="تفاصيل كشف المرتبات" wide>
        {selectedRun && (
          <Table>
            <thead>
              <tr>
                <Th>الموظف</Th>
                {seeSalary && <><Th>المرتب</Th><Th>عمولة</Th><Th>الصافي</Th></>}
              </tr>
            </thead>
            <tbody>
              {selectedRun.lines.map((line) => (
                <tr key={line.id}>
                  <Td className="font-bold">{line.employee.name}</Td>
                  {seeSalary && (
                    <>
                      <Td>{formatMoney(line.salaryNet)}</Td>
                      <Td>{formatMoney(line.commissionDue)}</Td>
                      <Td className="font-extrabold">{formatMoney(line.net)}</Td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Modal>
    </div>
  );
}

function PayrollPreviewTable({ payrollCalc, seeSalary }: { payrollCalc: PayrollCalc; seeSalary: boolean }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>الموظف</Th>
          <Th>حضور</Th>
          <Th>غياب</Th>
          <Th>تأخير</Th>
          {seeSalary && <><Th>صافي المرتب</Th><Th>عمولة</Th><Th>الإجمالي</Th></>}
        </tr>
      </thead>
      <tbody>
        {payrollCalc.lines.map((line) => (
          <tr key={line.employeeId}>
            <Td className="font-bold">{line.name}</Td>
            <Td>{line.presentDays}</Td>
            <Td>{line.absentDays}</Td>
            <Td>{line.lateMinutes} د</Td>
            {seeSalary && (
              <>
                <Td>{formatMoney(line.salaryNet)}</Td>
                <Td>{formatMoney(line.commissionDue)}</Td>
                <Td className="font-extrabold">{formatMoney(line.net)}</Td>
              </>
            )}
          </tr>
        ))}
      </tbody>
      {seeSalary && (
        <tfoot>
          <tr>
            <td colSpan={4} className="px-3 py-2 font-bold">الإجمالي</td>
            <td colSpan={3} className="px-3 py-2 font-extrabold tabular-nums">{formatMoney(payrollCalc.totalNet)}</td>
          </tr>
        </tfoot>
      )}
    </Table>
  );
}

function PayrollRunActions({
  run,
  busy,
  methods,
  postMethodByRun,
  setPostMethodByRun,
  onPost,
  onDelete,
  onView,
}: {
  run: PayrollRun;
  busy: boolean;
  methods: { id: string; name: string }[];
  postMethodByRun: Record<string, string>;
  setPostMethodByRun: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onPost: (run: PayrollRun) => void;
  onDelete: (run: PayrollRun) => void;
  onView: (run: PayrollRun) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button type="button" variant="secondary" onClick={() => onView(run)}>عرض</Button>
      {run.status === 'DRAFT' && (
        <>
          <Select
            className="max-w-[120px]"
            value={postMethodByRun[run.id] || methods[0]?.id || ''}
            onChange={(e) => setPostMethodByRun((m) => ({ ...m, [run.id]: e.target.value }))}
          >
            <option value="">طريقة دفع لاحقًا</option>
            {methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          <Button type="button" onClick={() => onPost(run)} disabled={busy}>اعتماد</Button>
          <Button type="button" variant="danger" onClick={() => onDelete(run)} disabled={busy}>حذف</Button>
        </>
      )}
      {run.status === 'POSTED' && (
        <span className="text-xs font-semibold text-amber-700">مستحق — اصرف من المدفوعات</span>
      )}
      {run.status === 'PAID' && (
        <span className="text-xs font-semibold text-emerald-700">مصروف</span>
      )}
    </div>
  );
}