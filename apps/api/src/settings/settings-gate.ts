import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

const HEADER = 'x-settings-token';
const TTL_MS = 30 * 60 * 1000;

function secret() {
  return process.env.JWT_SECRET || 'm5azen-dev-secret';
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function settingsPasswordMatches(password: string) {
  const expected = process.env.SETTINGS_PASSWORD || '';
  if (!expected || !password) return false;
  return safeEqual(password, expected);
}

export function signSettingsToken() {
  const exp = Date.now() + TTL_MS;
  const body = Buffer.from(JSON.stringify({ purpose: 'settings', exp })).toString('base64url');
  const sig = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySettingsToken(token?: string) {
  if (!token || !token.includes('.')) return false;
  const [body, sig] = token.split('.');
  const expected = createHmac('sha256', secret()).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as { purpose?: string; exp?: number };
    return payload.purpose === 'settings' && typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

@Injectable()
export class SettingsGateGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const token = req.headers[HEADER];
    if (!verifySettingsToken(token)) {
      throw new ForbiddenException('أدخل كلمة سر الإعدادات');
    }
    return true;
  }
}
