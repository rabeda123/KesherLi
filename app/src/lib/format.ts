import { LOCALE, t } from './i18n';

const time = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const dayMonth = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });
const weekday = new Intl.DateTimeFormat(LOCALE, { weekday: 'long' });
const full = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function formatTime(iso: string): string {
  return time.format(new Date(iso));
}

/** Short label for a conversation list: time today, "אתמול", weekday this week, otherwise date. */
export function formatListDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (days === 0) return time.format(d);
  if (days === 1) return t('yesterday');
  if (days < 7) return weekday.format(d);
  return dayMonth.format(d);
}

export function formatDayHeader(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (days === 0) return t('today');
  if (days === 1) return t('yesterday');
  return dayMonth.format(d);
}

export function formatDateTime(iso: string): string {
  return full.format(new Date(iso));
}

export function sameDay(a: string, b: string): boolean {
  return startOfDay(new Date(a)) === startOfDay(new Date(b));
}

/** "21:00" ⇄ minutes from midnight. */
export const minutesToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export function hhmmToMinutes(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * Local Israeli format for display. Wrapped in a left-to-right isolate so the
 * digits stay together inside right-to-left Hebrew text.
 */
export const displayPhone = (e164: string) =>
  '\u2066' + (e164.startsWith('+972') ? '0' + e164.slice(4, 6) + '-' + e164.slice(6, 9) + '-' + e164.slice(9) : e164) + '\u2069';

/** Extracts the token from a pasted invitation link (or a bare token). */
export function inviteTokenFrom(input: string): string | null {
  const m = /(?:invite\/)?([A-Za-z0-9_-]{30,})\s*$/.exec(input.trim());
  return m ? m[1]! : null;
}
