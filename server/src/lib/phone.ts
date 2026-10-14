/**
 * Normalizes a phone number to E.164. Local Israeli numbers (05X-XXXXXXX)
 * are accepted for convenience; anything else must include a country code.
 * Returns null when the input is not a plausible phone number.
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/[^\d]/g, '');
  let e164: string;
  if (trimmed.startsWith('+')) e164 = '+' + digits;
  else if (trimmed.startsWith('00')) e164 = '+' + digits.slice(2);
  else if (digits.startsWith('0') && digits.length === 10) e164 = '+972' + digits.slice(1);
  else if (digits.startsWith('972')) e164 = '+' + digits;
  else return null;
  if (e164.startsWith('+9720')) e164 = '+972' + e164.slice(5);
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

/** "+972501234567" -> "+972•••••4567", for logs and UI where the full number is not needed. */
export function maskPhone(e164: string): string {
  return e164.slice(0, 4) + '•'.repeat(Math.max(0, e164.length - 8)) + e164.slice(-4);
}
