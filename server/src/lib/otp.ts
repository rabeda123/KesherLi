import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.js';
import { one } from '../db/pool.js';
import { logEvent } from './audit.js';
import { hmac, numericCode, safeEqual } from './crypto.js';
import { badRequest, tooMany } from './errors.js';

const OTP_TTL_MIN = 5;
const MAX_ATTEMPTS = 5;
const MAX_PER_PHONE_PER_10_MIN = 3;
const MAX_PER_PHONE_PER_DAY = 10;

const codeHash = (ctx: Ctx, challengeId: string, code: string) => hmac(ctx.config.appSecret, `otp:${challengeId}:${code}`);

/** Sends a one-time code by SMS. Returns the challenge id (and, in dev mode only, the code). */
export async function startOtp(ctx: Ctx, phone: string, ip: string): Promise<{ challengeId: string; devCode?: string }> {
  ctx.limiter.consume(`otp-ip:${ip}`, 10, 10 * 60_000);
  const counts = await one<{ recent: number; day: number }>(
    ctx.db,
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '10 minutes') AS recent,
            count(*) AS day
       FROM otp_challenges WHERE phone_e164 = $1 AND created_at > now() - interval '1 day'`,
    [phone],
  );
  if ((counts?.recent ?? 0) >= MAX_PER_PHONE_PER_10_MIN || (counts?.day ?? 0) >= MAX_PER_PHONE_PER_DAY) throw tooMany();

  const code = numericCode(6);
  const id = randomUUID();
  await ctx.db.query(
    `INSERT INTO otp_challenges (id, phone_e164, code_hash, expires_at, ip)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4), $5)`,
    [id, phone, codeHash(ctx, id, code), OTP_TTL_MIN, ip],
  );
  await ctx.sms.send(phone, `קוד האימות שלך בקשרלי: ${code}. אין למסור את הקוד לאף אחד.`);
  return { challengeId: id, devCode: ctx.config.devExposeOtp ? code : undefined };
}

/**
 * Verifies a code and returns the phone it was sent to. Each challenge
 * allows a few attempts and can be used once; failures give one generic error.
 */
export async function verifyOtp(ctx: Ctx, challengeId: string, code: string, ip: string): Promise<string> {
  ctx.limiter.consume(`otp-verify-ip:${ip}`, 30, 10 * 60_000);
  const ch = await one<{ id: string; phone_e164: string; code_hash: Buffer; attempts: number; usable: boolean }>(
    ctx.db,
    `UPDATE otp_challenges SET attempts = attempts + 1
      WHERE id = $1 AND consumed_at IS NULL
      RETURNING id, phone_e164, code_hash, attempts, (expires_at > now() AND attempts <= $2) AS usable`,
    [challengeId, MAX_ATTEMPTS],
  );
  if (!ch || !ch.usable) {
    if (ch && ch.attempts === MAX_ATTEMPTS + 1) {
      await logEvent(ctx.db, { kind: 'otp_locked', metadata: { challengeId }, ip });
    }
    throw badRequest('invalid_code');
  }
  if (!/^\d{6}$/.test(code) || !safeEqual(codeHash(ctx, ch.id, code), ch.code_hash)) throw badRequest('invalid_code');
  const consumed = await ctx.db.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`, [ch.id]);
  if (consumed.rowCount !== 1) throw badRequest('invalid_code');
  return ch.phone_e164;
}

/**
 * Step-up check for sensitive actions (ownership transfer, deleting a family
 * or account): the caller must prove control of their own phone again.
 */
export async function verifyStepUp(ctx: Ctx, userId: string, challengeId: string | undefined, code: string | undefined, ip: string): Promise<void> {
  if (!challengeId || !code) throw badRequest('step_up_required');
  const phone = await verifyOtp(ctx, challengeId, code, ip);
  const u = await one(ctx.db, `SELECT 1 FROM users WHERE id = $1 AND phone_e164 = $2`, [userId, phone]);
  if (!u) throw badRequest('invalid_code');
}
