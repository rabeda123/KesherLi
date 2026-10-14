import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** High-entropy opaque token (sessions, invitation links). Only its hash is stored. */
export function randomToken(prefix = ''): string {
  return prefix + randomBytes(32).toString('base64url');
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Keyed hash for low-entropy codes (OTP, pairing) so a database leak does not reveal them. */
export function hmac(secret: string, value: string): Buffer {
  return createHmac('sha256', secret).update(value).digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function numericCode(digits = 6): string {
  return String(randomInt(0, 10 ** digits)).padStart(digits, '0');
}

// No 0/O, 1/I/L: easy to read aloud and type on a child's device.
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function pairingCode(length = 8): string {
  let out = '';
  for (let i = 0; i < length; i++) out += PAIRING_ALPHABET[randomInt(0, PAIRING_ALPHABET.length)];
  return out;
}

export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
