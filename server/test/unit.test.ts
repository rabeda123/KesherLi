import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { normalizePairingCode } from '../src/lib/crypto.js';
import { maskPhone, normalizePhone } from '../src/lib/phone.js';
import { inQuietHours } from '../src/routes/conversations.js';

describe('normalizePhone', () => {
  it.each([
    ['050-123-4567', '+972501234567'],
    ['+972 50 123 4567', '+972501234567'],
    ['+972050-1234567', '+972501234567'],
    ['00972501234567', '+972501234567'],
    ['972501234567', '+972501234567'],
    ['+1 (415) 555-0100', '+14155550100'],
  ])('%s → %s', (input, out) => expect(normalizePhone(input)).toBe(out));

  it.each(['', 'abc', '12345', '+0123456789'])('rejects %s', (input) => expect(normalizePhone(input)).toBeNull());

  it('masks', () => expect(maskPhone('+972501234567')).toBe('+972•••••4567'));
});

describe('pairing codes', () => {
  it('ignores case, spaces and dashes', () => expect(normalizePairingCode(' abcd-ef 2h ')).toBe('ABCDEF2H'));
});

describe('quiet hours', () => {
  const at = (hhmm: string) => new Date(`2026-01-15T${hhmm}:00+02:00`); // Israel winter time
  it('handles ranges that cross midnight', () => {
    expect(inQuietHours(21 * 60, 7 * 60, 'Asia/Jerusalem', at('22:30'))).toBe(true);
    expect(inQuietHours(21 * 60, 7 * 60, 'Asia/Jerusalem', at('06:59'))).toBe(true);
    expect(inQuietHours(21 * 60, 7 * 60, 'Asia/Jerusalem', at('12:00'))).toBe(false);
  });
  it('handles same-day ranges and off', () => {
    expect(inQuietHours(8 * 60, 14 * 60, 'Asia/Jerusalem', at('09:00'))).toBe(true);
    expect(inQuietHours(null, null, 'Asia/Jerusalem', at('09:00'))).toBe(false);
  });
});

describe('config', () => {
  const base = { DATABASE_URL: 'postgres://x', APP_SECRET: 'x'.repeat(32) };
  it('refuses the console SMS provider in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/not allowed in production/);
  });
  it('refuses exposing codes in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b', TWILIO_FROM: 'c', DEV_EXPOSE_OTP: 'true' }),
    ).toThrow(/DEV_EXPOSE_OTP/);
  });
  it('requires a long secret', () => {
    expect(() => loadConfig({ ...base, APP_SECRET: 'short' })).toThrow(/APP_SECRET/);
  });
});
