import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Boxes,
  ClipboardList,
  FileBarChart,
  Landmark,
  LayoutDashboard,
  LineChart,
  Package,
  ScrollText,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Truck,
  Undo2,
  Users,
  Wallet,
  Warehouse,
} from 'lucide-react';

export type AppRole = 'ADMIN' | 'ACCOUNTANT' | 'WAREHOUSE' | 'SALES';

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  keywords: string;
  roles?: AppRole[];
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'مدير النظام',
  ACCOUNTANT: 'محاسب',
  WAREHOUSE: 'أمين مخزن',
  SALES: 'مبيعات',
};

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'نظرة عامة',
    items: [
      { to: '/', label: 'لوحة التحكم', icon: LayoutDashboard, end: true, keywords: 'dashboard رئيسية' },
    ],
  },
  {
    label: 'المخزون',
    items: [
      { to: '/warehouses', label: 'المخازن', icon: Warehouse, keywords: 'مخزن warehouse' },
      { to: '/products', label: 'الأصناف', icon: Package, keywords: 'صنف منتج product استيراد import' },
      { to: '/stock', label: 'المخزون', icon: Boxes, keywords: 'رصيد حركة stock' },
    ],
  },
  {
    label: 'الأطراف',
    items: [
      { to: '/suppliers', label: 'الموردين', icon: Truck, keywords: 'مورد supplier' },
      { to: '/customers', label: 'العملاء', icon: Users, keywords: 'عميل customer' },
    ],
  },
  {
    label: 'العمليات',
    items: [
      { to: '/sales', label: 'المبيعات', icon: ShoppingCart, keywords: 'فاتورة بيع sales' },
      { to: '/purchases', label: 'المشتريات', icon: ShoppingBag, keywords: 'فاتورة شراء purchase' },
      { to: '/returns', label: 'المرتجعات', icon: Undo2, keywords: 'مرتجع return' },
      { to: '/documents', label: 'عروض وأوامر', icon: ClipboardList, keywords: 'عرض سعر أمر' },
      { to: '/cash', label: 'الخزنة', icon: Wallet, keywords: 'نقدي خزنة cash' },
    ],
  },
  {
    label: 'المالية',
    items: [
      { to: '/finance', label: 'المالية', icon: Landmark, keywords: 'مصروف شيك وردية' },
      { to: '/reports', label: 'التقارير', icon: BarChart3, keywords: 'تقرير report' },
      { to: '/report-builder', label: 'منشئ التقارير', icon: FileBarChart, keywords: 'report builder حفظ تصدير' },
      { to: '/analytics', label: 'التحليلات', icon: LineChart, keywords: 'تحليل analytics نمو' },
      { to: '/insights', label: 'التنبيهات الذكية', icon: Sparkles, keywords: 'تنبيه صلاحية نقص' },
    ],
  },
  {
    label: 'النظام',
    items: [
      { to: '/audit', label: 'سجل العمليات', icon: ScrollText, keywords: 'audit سجل', roles: ['ADMIN'] },
      { to: '/settings', label: 'الإعدادات', icon: Settings, keywords: 'إعداد مستخدم نسخ' },
    ],
  },
];

export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

export function canAccess(role: string | undefined, roles?: AppRole[]) {
  if (!roles?.length) return true;
  if (role === 'ADMIN') return true;
  return !!role && roles.includes(role as AppRole);
}

export const QUICK_ACTIONS: { to: string; label: string; roles?: AppRole[] }[] = [
  { to: '/sales', label: 'فاتورة مبيعات', roles: ['ADMIN', 'SALES', 'ACCOUNTANT'] },
  { to: '/purchases', label: 'فاتورة مشتريات', roles: ['ADMIN', 'ACCOUNTANT', 'WAREHOUSE'] },
  { to: '/products', label: 'الأصناف' },
  { to: '/stock', label: 'المخزون' },
  { to: '/cash', label: 'حركة خزنة', roles: ['ADMIN', 'ACCOUNTANT'] },
  { to: '/reports', label: 'التقارير' },
  { to: '/report-builder', label: 'منشئ التقارير' },
];
