import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from './context.js';
import { one } from './db/pool.js';
import { randomToken, sha256 } from './lib/crypto.js';
import { forbidden, unauthorized } from './lib/errors.js';

export type AuthUser = { id: string; kind: 'adult' | 'child'; deviceId: string; displayName: string | null };

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
}

/** Creates a device session and returns the bearer token (shown to the client once, stored hashed). */
export async function createSession(
  ctx: Ctx,
  userId: string,
  device: { name?: string; platform?: string },
): Promise<{ token: string; deviceId: string }> {
  const token = randomToken('kl_');
  const row = await one<{ id: string }>(
    ctx.db,
    `INSERT INTO devices (user_id, name, platform, token_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, (device.name ?? 'מכשיר').slice(0, 60), (device.platform ?? 'unknown').slice(0, 20), sha256(token)],
  );
  return { token, deviceId: row!.id };
}

export async function userForToken(ctx: Ctx, token: string): Promise<AuthUser | null> {
  if (!token.startsWith('kl_') || token.length > 100) return null;
  const row = await one<{ device_id: string; user_id: string; kind: 'adult' | 'child'; display_name: string | null; stale: boolean }>(
    ctx.db,
    `SELECT d.id AS device_id, u.id AS user_id, u.kind, u.display_name,
            d.last_seen_at < now() - interval '5 minutes' AS stale
       FROM devices d JOIN users u ON u.id = d.user_id
      WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND u.deleted_at IS NULL`,
    [sha256(token)],
  );
  if (!row) return null;
  if (row.stale) await ctx.db.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [row.device_id]);
  return { id: row.user_id, kind: row.kind, deviceId: row.device_id, displayName: row.display_name };
}

export function authenticate(ctx: Ctx) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const user = token ? await userForToken(ctx, token) : null;
    if (!user) throw unauthorized();
    req.user = user;
  };
}

export function requireAdult(req: FastifyRequest): void {
  if (req.user.kind !== 'adult') throw forbidden('adults_only');
}

export function requireChildUser(req: FastifyRequest): void {
  if (req.user.kind !== 'child') throw forbidden('children_only');
}
