import { useEffect, useState, type ReactNode } from 'react';
import { Check, Palette, Printer } from 'lucide-react';
import { formatDate, formatMoney } from '../lib/api';
import {
  companyLogoUrl,
  INVOICE_COLOR_CHOICES,
  loadCompanyProfile,
  mixHex,
  readInvoiceColor,
  saveInvoiceColor,
  type CompanyProfile,
} from '../lib/company';
import { Button, StatusBadge } from './ui';

export type InvoicePrintLine = {
  name: string;
  sku?: string;
  quantity: number;
  unitPrice: number;
  total: number;
  meta?: string;
  profit?: number | null;
  unitProfit?: number | null;
};

export type InvoicePrintProps = {
  kind: 'sale' | 'purchase';
  number: string;
  status: string;
  date: string;
  partyLabel: string;
  partyName: string;
  warehouseName: string;
  lines: InvoicePrintLine[];
  subtotal: number;
  discount?: number;
  tax?: number;
  total: number;
  paidAmount: number;
  remaining: number;
  notes?: string | null;
  showProfit?: boolean;
  profit?: number | null;
  footer?: ReactNode;
  actions?: ReactNode;
};

function ColorPicker({ color, onChange }: { color: string; onChange: (hex: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
        onClick={() => setOpen((value) => !value)}
      >
        <Palette size={14} />
        لون الفاتورة
        <span className="h-4 w-4 rounded-md border border-black/10" style={{ background: color }} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-2 w-72 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl">
          <div className="mb-2 text-xs font-bold text-muted">اختار لون الطباعة</div>
          <div className="grid grid-cols-8 gap-1.5">
            {INVOICE_COLOR_CHOICES.map((hex) => {
              const selected = color === hex;
              return (
                <button
                  key={hex}
                  type="button"
                  aria-label={hex}
                  className={`relative aspect-square rounded-lg border border-black/10 ${selected ? 'ring-2 ring-slate-900 ring-offset-1' : ''}`}
                  style={{ background: hex }}
                  onClick={() => {
                    onChange(hex);
                    setOpen(false);
                  }}
                >
                  {selected && (
                    <span className="absolute inset-0 grid place-items-center text-white drop-shadow">
                      <Check size={12} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <label className="text-xs font-semibold text-muted">مخصص</label>
            <input
              type="color"
              value={color}
              onChange={(event) => onChange(event.target.value)}
              className="h-8 w-14 cursor-pointer rounded border border-slate-200 bg-white p-0.5"
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function InvoicePrint(props: InvoicePrintProps) {
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [color, setColor] = useState(readInvoiceColor);

  useEffect(() => {
    loadCompanyProfile().then(setProfile);
  }, []);

  function applyColor(hex: string) {
    setColor(saveInvoiceColor(hex));
  }

  const accent = color;
  const accentSoft = mixHex(accent, '#ffffff', 0.88);
  const accentDeep = mixHex(accent, '#000000', 0.28);
  const kindLabel = props.kind === 'sale' ? 'فاتورة بيع' : 'فاتورة شراء';
  const logoSrc = profile?.hasLogo ? companyLogoUrl(profile.logoVersion) : '/ak-tech-logo.png';

  return (
    <div>
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ColorPicker color={color} onChange={applyColor} />
          <Button variant="secondary" onClick={() => window.print()}>
            <Printer size={14} /> طباعة / PDF
          </Button>
        </div>
        {props.actions}
      </div>

      <div
        className="invoice-sheet overflow-hidden rounded-2xl border bg-white shadow-sm print:rounded-none print:border-0 print:shadow-none"
        style={{
          borderColor: mixHex(accent, '#ffffff', 0.65),
          ['--invoice-accent' as string]: accent,
          ['--invoice-accent-soft' as string]: accentSoft,
          ['--invoice-accent-deep' as string]: accentDeep,
        }}
      >
        <div
          className="relative px-5 py-5 text-white print:px-0 print:py-4"
          style={{ background: `linear-gradient(135deg, ${accentDeep} 0%, ${accent} 55%, ${mixHex(accent, '#ffffff', 0.18)} 100%)` }}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl bg-white p-1.5 shadow-lg shadow-black/10">
                <img src={logoSrc} alt={profile?.companyName || 'Logo'} className="h-full w-full object-contain" />
              </div>
              <div className="min-w-0">
                <div className="text-xl font-extrabold leading-tight">{profile?.companyName || '—'}</div>
                {profile?.companyAddress && <div className="mt-1 text-sm text-white/85">{profile.companyAddress}</div>}
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/80">
                  {profile?.companyPhone && <span>هاتف: {profile.companyPhone}</span>}
                  {profile?.taxNumber && <span>ضريبي: {profile.taxNumber}</span>}
                  {profile?.commercialRegister && <span>س.ت: {profile.commercialRegister}</span>}
                </div>
              </div>
            </div>
            <div className="rounded-2xl bg-white/15 px-4 py-3 text-left backdrop-blur-sm">
              <div className="text-[11px] font-bold uppercase tracking-wide text-white/75">{kindLabel}</div>
              <div className="text-2xl font-extrabold">{props.number}</div>
              <div className="mt-1 text-xs text-white/85">{formatDate(props.date)}</div>
              <div className="mt-2 inline-flex rounded-lg bg-white/90 px-2 py-0.5">
                <StatusBadge status={props.status} />
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-3 border-b px-5 py-4 text-sm print:px-0 sm:grid-cols-3" style={{ borderColor: accentSoft, background: accentSoft }}>
          <div>
            <div className="text-[11px] font-bold" style={{ color: accentDeep }}>{props.partyLabel}</div>
            <div className="mt-0.5 text-base font-extrabold text-slate-900">{props.partyName}</div>
          </div>
          <div>
            <div className="text-[11px] font-bold" style={{ color: accentDeep }}>المخزن</div>
            <div className="mt-0.5 font-bold text-slate-800">{props.warehouseName}</div>
          </div>
          <div>
            <div className="text-[11px] font-bold" style={{ color: accentDeep }}>تاريخ الفاتورة</div>
            <div className="mt-0.5 font-bold text-slate-800">{formatDate(props.date)}</div>
          </div>
        </div>

        <div className="px-5 py-4 print:px-0">
          <table className="invoice-table w-full border-collapse text-sm">
            <thead>
              <tr style={{ background: accent, color: '#fff' }}>
                <th className="px-3 py-2.5 text-right font-bold">#</th>
                <th className="px-3 py-2.5 text-right font-bold">الصنف</th>
                <th className="px-3 py-2.5 text-right font-bold">كمية</th>
                <th className="px-3 py-2.5 text-right font-bold">{props.kind === 'sale' ? 'السعر' : 'التكلفة'}</th>
                <th className="px-3 py-2.5 text-right font-bold">الإجمالي</th>
                {props.showProfit && <th className="px-3 py-2.5 text-right font-bold">ربح الوحدة</th>}
                {props.showProfit && <th className="px-3 py-2.5 text-right font-bold">ربح الصنف</th>}
              </tr>
            </thead>
            <tbody>
              {props.lines.map((line, index) => (
                <tr key={`${line.name}-${index}`} className={index % 2 ? 'bg-slate-50/80' : 'bg-white'}>
                  <td className="border-b border-slate-100 px-3 py-2 text-slate-500">{index + 1}</td>
                  <td className="border-b border-slate-100 px-3 py-2">
                    <div className="font-bold text-slate-900">{line.name}</div>
                    {(line.sku || line.meta) && (
                      <div className="text-[11px] text-slate-500">
                        {[line.sku, line.meta].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="border-b border-slate-100 px-3 py-2 font-semibold">{line.quantity}</td>
                  <td className="border-b border-slate-100 px-3 py-2">{formatMoney(line.unitPrice)}</td>
                  <td className="border-b border-slate-100 px-3 py-2 font-bold">{formatMoney(line.total)}</td>
                  {props.showProfit && (
                    <td className={`border-b border-slate-100 px-3 py-2 ${(line.unitProfit || 0) >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                      {formatMoney(line.unitProfit || 0)}
                    </td>
                  )}
                  {props.showProfit && (
                    <td className={`border-b border-slate-100 px-3 py-2 font-semibold ${(line.profit || 0) >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                      {formatMoney(line.profit || 0)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:justify-between">
            <div className="max-w-sm text-sm text-slate-600">
              {props.notes ? (
                <>
                  <div className="text-xs font-bold text-slate-500">ملاحظات</div>
                  <div className="mt-1 whitespace-pre-wrap">{props.notes}</div>
                </>
              ) : (
                <div className="text-xs text-slate-400">شكراً لتعاملكم معنا</div>
              )}
            </div>
            <div
              className="min-w-[14rem] space-y-1.5 rounded-2xl border px-4 py-3 text-sm"
              style={{ borderColor: mixHex(accent, '#ffffff', 0.55), background: accentSoft }}
            >
              <div className="flex justify-between gap-6"><span>المجموع</span><span className="font-semibold">{formatMoney(props.subtotal)}</span></div>
              {(props.discount || 0) > 0 && (
                <div className="flex justify-between gap-6 text-amber-800"><span>الخصم</span><span className="font-semibold">{formatMoney(props.discount || 0)}</span></div>
              )}
              {(props.tax || 0) > 0 && (
                <div className="flex justify-between gap-6"><span>الضريبة</span><span className="font-semibold">{formatMoney(props.tax || 0)}</span></div>
              )}
              <div className="flex justify-between gap-6 border-t border-black/10 pt-2 text-base font-extrabold" style={{ color: accentDeep }}>
                <span>الإجمالي</span>
                <span>{formatMoney(props.total)}</span>
              </div>
              <div className="flex justify-between gap-6"><span>المدفوع</span><span className="font-semibold">{formatMoney(props.paidAmount)}</span></div>
              <div className="flex justify-between gap-6 font-bold">
                <span>المتبقي</span>
                <span>{formatMoney(props.remaining)}</span>
              </div>
              {props.showProfit && props.profit != null && (
                <div className={`flex justify-between gap-6 border-t border-black/10 pt-2 font-extrabold ${(props.profit || 0) >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                  <span>ربح الفاتورة</span>
                  <span>{formatMoney(props.profit || 0)}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div
          className="flex items-center justify-between gap-3 border-t px-5 py-3 text-[11px] print:px-0"
          style={{ borderColor: accentSoft, color: accentDeep, background: mixHex(accent, '#ffffff', 0.94) }}
        >
          <span>{profile?.companyName}</span>
          <span>{new Date().toLocaleString('ar-EG')}</span>
        </div>
      </div>

      {props.footer && <div className="mt-4">{props.footer}</div>}
    </div>
  );
}
