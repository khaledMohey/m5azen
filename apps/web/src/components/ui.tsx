import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2 no-print">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
}) {
  const styles = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm shadow-brand-600/20',
    secondary: 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50',
    danger: 'bg-rose-600 text-white hover:bg-rose-700',
    ghost: 'text-slate-600 hover:bg-slate-100',
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition disabled:opacity-50 ${styles[variant]} ${className}`}
      {...props}
    />
  );
}

export function Input({ className = '', type, onWheel, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type={type}
      className={`w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-brand-500/30 focus:ring-2 ${
        type === 'number' ? 'no-spinner' : ''
      } ${className}`}
      onWheel={(e) => {
        if (type === 'number') {
          (e.target as HTMLInputElement).blur();
        }
        onWheel?.(e);
      }}
      {...props}
    />
  );
}

/** رقم بدون أسهم/سكرول — القيمة الفارغة تظهر خانة فاضية */
export function NumberInput({
  value,
  onValueChange,
  className = '',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: number | '';
  onValueChange: (value: number | '') => void;
}) {
  return (
    <Input
      type="number"
      inputMode="decimal"
      className={className}
      value={value === '' ? '' : value}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') onValueChange('');
        else onValueChange(Number(raw));
      }}
      {...props}
    />
  );
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-brand-500/30 focus:ring-2 ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="mb-1.5 block text-sm font-medium text-slate-700">{children}</label>;
}

export function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    DRAFT: 'مسودة',
    CONFIRMED: 'مؤكدة',
    PARTIAL: 'جزئي',
    PAID: 'مدفوعة',
    CANCELLED: 'ملغاة',
  };
  return (
    <span className={`status-${status} inline-flex rounded-lg px-2.5 py-1 text-xs font-bold`}>
      {labels[status] || status}
    </span>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="min-w-full text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <th className={`bg-slate-50 px-3 py-2.5 text-right font-semibold text-slate-600 ${className}`}>
      {children}
    </th>
  );
}

export function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <td className={`border-t border-slate-100 px-3 py-2.5 ${className}`}>{children}</td>;
}

export function Empty({ text = 'لا توجد بيانات' }: { text?: string }) {
  return <div className="py-10 text-center text-sm text-muted">{text}</div>;
}

export function SearchBox({
  value,
  onChange,
  onSearch,
  placeholder = 'بحث...',
  className = 'w-56',
}: {
  value: string;
  onChange: (v: string) => void;
  onSearch?: () => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Input
      className={className}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && onSearch?.()}
    />
  );
}

export function PrintHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="print-header mb-6 hidden border-b-2 border-brand-700 pb-4 print:flex print:items-center print:justify-between">
      <div className="flex items-center gap-3">
        <img src="/ak-tech-logo.png" alt="AK Tech" className="h-16 w-16 object-contain" />
        <div>
          <div className="text-xl font-extrabold text-brand-800">نظام AK Tech لإدارة المخازن</div>
          <div className="text-sm text-brand-600">{title}</div>
          {subtitle && <div className="text-xs text-slate-500">{subtitle}</div>}
        </div>
      </div>
      <div className="text-left text-xs text-slate-500">
        {new Date().toLocaleString('ar-EG')}
      </div>
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4" onClick={onClose}>
      <div
        className={`print-sheet max-h-[90vh] w-full overflow-y-auto rounded-2xl bg-white p-5 shadow-xl ${wide ? 'max-w-4xl' : 'max-w-lg'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between no-print">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-muted hover:bg-slate-100">
            إغلاق
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
