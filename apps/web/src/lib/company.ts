import { api, getApiBase } from './api';
import { COLOR_CHOICES, ORIGINAL_COLOR, readAppearance } from './appearance';

export type CompanyProfile = {
  companyName: string;
  taxNumber: string;
  commercialRegister: string;
  companyAddress: string;
  companyPhone: string;
  hasLogo: boolean;
  logoVersion: string;
};

const INVOICE_COLOR_KEY = 'm5azen.invoice.color';
let cachedProfile: CompanyProfile | null = null;
let profilePromise: Promise<CompanyProfile> | null = null;

export const INVOICE_COLOR_CHOICES = COLOR_CHOICES;

export function companyLogoUrl(version?: string | null) {
  const token = localStorage.getItem('m5azen_token') || '';
  const stamp = version ? `&v=${encodeURIComponent(version)}` : `&t=${Date.now()}`;
  return `${getApiBase()}/api/settings/logo?token=${encodeURIComponent(token)}${stamp}`;
}

export async function loadCompanyProfile(force = false): Promise<CompanyProfile> {
  if (!force && cachedProfile) return cachedProfile;
  if (!force && profilePromise) return profilePromise;
  profilePromise = api<CompanyProfile>('/settings/company-profile')
    .then((profile) => {
      cachedProfile = profile;
      return profile;
    })
    .catch(() => {
      const fallback: CompanyProfile = {
        companyName: 'نظام AK Tech لإدارة المخازن',
        taxNumber: '',
        commercialRegister: '',
        companyAddress: '',
        companyPhone: '',
        hasLogo: false,
        logoVersion: '',
      };
      cachedProfile = fallback;
      return fallback;
    })
    .finally(() => {
      profilePromise = null;
    });
  return profilePromise;
}

export function readInvoiceColor() {
  try {
    const saved = localStorage.getItem(INVOICE_COLOR_KEY);
    if (saved && /^#[0-9a-fA-F]{6}$/.test(saved)) return saved.toLowerCase();
  } catch {
    /* ignore */
  }
  return readAppearance().color || ORIGINAL_COLOR;
}

export function saveInvoiceColor(color: string) {
  const next = color.toLowerCase();
  try {
    localStorage.setItem(INVOICE_COLOR_KEY, next);
  } catch {
    /* preference stays for this visit */
  }
  return next;
}

export function mixHex(base: string, target: string, amount: number) {
  const parse = (hex: string) => {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const from = parse(base);
  const to = parse(target);
  const channel = (i: number) => Math.round(Math.max(0, Math.min(255, from[i] + (to[i] - from[i]) * amount)));
  return `#${[channel(0), channel(1), channel(2)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}
