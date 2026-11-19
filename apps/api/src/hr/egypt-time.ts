const TZ = 'Africa/Cairo';

export function ensureEgyptTz() {
  if (!process.env.TZ) process.env.TZ = TZ;
}

export function egyptDayKey(input: Date | string = new Date()) {
  const date = typeof input === 'string' ? new Date(input) : input;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function egyptDayStart(key: string) {
  return new Date(`${key}T00:00:00+02:00`);
}

export function egyptDayEnd(key: string) {
  return new Date(`${key}T23:59:59.999+02:00`);
}

export function egyptWeekday(input: Date | string) {
  const key = typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input) ? input : egyptDayKey(input);
  // 0=Sunday … 6=Saturday in Cairo
  const noon = new Date(`${key}T12:00:00+02:00`);
  const short = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(noon);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short);
}

export function parseTimeToMinutes(value: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value || '').trim());
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function egyptMinutesOf(input: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(input);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

export function eachDayKeys(from: string, to: string) {
  const keys: string[] = [];
  let cursor = egyptDayStart(from);
  const end = egyptDayStart(to);
  while (cursor.getTime() <= end.getTime()) {
    keys.push(egyptDayKey(cursor));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return keys;
}
