import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Warehouse,
  Package,
  Boxes,
  Truck,
  Users,
  Wallet,
  ShoppingCart,
  ShoppingBag,
  Undo2,
  ClipboardList,
  Landmark,
  BarChart3,
  Settings,
  LogOut,
} from 'lucide-react';
import { useAuth } from '../lib/auth';

const nav = [
  { to: '/', label: 'لوحة التحكم', icon: LayoutDashboard, end: true },
  { to: '/warehouses', label: 'المخازن', icon: Warehouse },
  { to: '/products', label: 'الأصناف', icon: Package },
  { to: '/stock', label: 'المخزون', icon: Boxes },
  { to: '/suppliers', label: 'الموردين', icon: Truck },
  { to: '/customers', label: 'العملاء', icon: Users },
  { to: '/cash', label: 'الخزنة', icon: Wallet },
  { to: '/sales', label: 'المبيعات', icon: ShoppingCart },
  { to: '/purchases', label: 'المشتريات', icon: ShoppingBag },
  { to: '/returns', label: 'المرتجعات', icon: Undo2 },
  { to: '/documents', label: 'عروض وأوامر', icon: ClipboardList },
  { to: '/finance', label: 'المالية', icon: Landmark },
  { to: '/reports', label: 'التقارير', icon: BarChart3 },
  { to: '/settings', label: 'الإعدادات', icon: Settings },
];

export function AppLayout() {
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-full">
      <aside className="no-print sticky top-0 flex h-screen w-72 shrink-0 flex-col bg-gradient-to-b from-brand-800 via-brand-700 to-brand-900 text-white shadow-xl shadow-brand-900/30">
        <div className="border-b border-white/10 px-4 py-4">
          <div className="flex items-center gap-3">
            <img
              src="/ak-tech-logo.png"
              alt="AK Tech"
              className="h-14 w-14 rounded-xl bg-white object-contain p-1 shadow-md"
            />
            <div className="min-w-0">
              <div className="text-base font-extrabold leading-tight tracking-tight">
                نظام AK Tech
              </div>
              <div className="mt-0.5 text-[11px] leading-snug text-brand-200">
                لإدارة المخازن
              </div>
            </div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                  isActive
                    ? 'bg-white text-brand-800 shadow-sm'
                    : 'text-brand-100 hover:bg-white/10 hover:text-white'
                }`
              }
            >
              <item.icon size={18} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 p-4">
          <div className="mb-3 text-sm">
            <div className="font-semibold text-white">{user?.fullName}</div>
            <div className="text-xs text-brand-300">{user?.role}</div>
          </div>
          <button
            onClick={logout}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-rose-200 hover:bg-rose-500/20 hover:text-white"
          >
            <LogOut size={16} />
            تسجيل الخروج
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-7xl p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
