import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, createSession, requireAdult } from '../auth.js';
import { familyAdminIds, notify, type Ctx } from '../context.js';
import { one } from '../db/pool.js';
import { logEvent } from '../lib/audit.js';
import { hmac, normalizePairingCode } from '../lib/crypto.js';
import { badRequest, parse } from '../lib/errors.js';
import { startOtp, verifyOtp } from '../lib/otp.js';
import { normalizePhone } from '../lib/phone.js';

const Device = z.object({ name: z.string().max(60).optional(), platform: z.string().max(20).optional() }).optional();

export const pairingHash = (ctx: Ctx, code: string) => hmac(ctx.config.appSecret, `pair:${code}`);

export async function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = authenticate(ctx);

  app.post('/auth/otp/request', async (req) => {
    const body = parse(z.object({ phone: z.string().max(30) }), req.body);
    const phone = normalizePhone(body.phone);
    if (!phone) throw badRequest('invalid_phone');
    // Same response whether or not an account exists, so this cannot be used
    // to find out who is registered.
    return startOtp(ctx, phone, req.ip);
  });

  app.post('/auth/otp/verify', async (req) => {
    const body = parse(z.object({ challengeId: z.uuid(), code: z.string().max(10), device: Device }), req.body);
    const phone = await verifyOtp(ctx, body.challengeId, body.code.trim(), req.ip);
    let user = await one<{ id: string; display_name: string | null }>(
      ctx.db,
      `SELECT id, display_name FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL`,
      [phone],
    );
    const isNew = !user;
    if (!user) {
      user = await one(ctx.db, `INSERT INTO users (kind, phone_e164) VALUES ('adult', $1) RETURNING id, display_name`, [phone]);
    }
    const session = await createSession(ctx, user!.id, body.device ?? {});
    await logEvent(ctx.db, { kind: 'login', actorId: user!.id, targetId: session.deviceId, ip: req.ip, metadata: { method: 'otp' } });
    return { token: session.token, isNew, needsProfile: !user!.display_name };
  });

  // A child's device is connected with a one-time code that a parent created.
  app.post('/auth/pair', async (req) => {
    ctx.limiter.consume(`pair-ip:${req.ip}`, 10, 15 * 60_000);
    const body = parse(z.object({ code: z.string().max(20), device: Device }), req.body);
    const code = normalizePairingCode(body.code);
    if (code.length !== 8) throw badRequest('invalid_code');
    const row = await one<{ child_user_id: string; family_id: string; display_name: string }>(
      ctx.db,
      `UPDATE pairing_codes pc SET consumed_at = now()
         FROM child_profiles cp, users u
        WHERE pc.code_hash = $1 AND pc.consumed_at IS NULL AND pc.expires_at > now()
          AND cp.user_id = pc.child_user_id AND u.id = pc.child_user_id AND u.deleted_at IS NULL
        RETURNING pc.child_user_id, cp.family_id, u.display_name`,
      [pairingHash(ctx, code)],
    );
    if (!row) throw badRequest('invalid_code');
    const session = await createSession(ctx, row.child_user_id, body.device ?? {});
    await logEvent(ctx.db, {
      kind: 'device_paired',
      familyId: row.family_id,
      actorId: row.child_user_id,
      targetId: session.deviceId,
      ip: req.ip,
      metadata: { device: body.device?.name ?? null },
    });
    await notify(
      ctx,
      await familyAdminIds(ctx.db, row.family_id),
      'device_paired',
      { childId: row.child_user_id, childName: row.display_name, device: body.device?.name ?? null },
      { title: 'קשרלי', body: `מכשיר חדש חובר לחשבון של ${row.display_name}` },
    );
    return { token: session.token };
  });

  app.post('/auth/logout', { preHandler: auth }, async (req) => {
    await ctx.db.query(`UPDATE devices SET revoked_at = now(), revoked_by = $2 WHERE id = $1`, [req.user.deviceId, req.user.id]);
    await logEvent(ctx.db, { kind: 'logout', actorId: req.user.id, targetId: req.user.deviceId, ip: req.ip });
    ctx.hub.disconnect({ deviceId: req.user.deviceId });
    return { ok: true };
  });

  // Sends a fresh code to the signed-in adult's own phone for a sensitive action.
  app.post('/auth/step-up', { preHandler: auth }, async (req) => {
    requireAdult(req);
    const u = await one<{ phone_e164: string }>(ctx.db, `SELECT phone_e164 FROM users WHERE id = $1`, [req.user.id]);
    return startOtp(ctx, u!.phone_e164, req.ip);
  });
}
