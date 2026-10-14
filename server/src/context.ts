import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { Config } from './config.js';
import { many, type Db } from './db/pool.js';
import { reconcileFamilyConversations } from './lib/authz.js';
import { endRevokedCalls, finishCall } from './routes/calls.js';
import type { PushSender } from './lib/push.js';
import type { RateLimiter } from './lib/rateLimit.js';
import type { RealtimeHub } from './lib/realtime.js';
import type { SmsSender } from './lib/sms.js';

export type Ctx = {
  config: Config;
  db: pg.Pool;
  hub: RealtimeHub;
  sms: SmsSender;
  push: PushSender;
  limiter: RateLimiter;
  log: FastifyBaseLogger;
};

export async function familyAdminIds(
  db: Db,
  familyId: string,
  perm?: 'can_manage_contacts' | 'can_approve_requests' | 'can_change_settings',
): Promise<string[]> {
  const rows = await many<{ user_id: string }>(
    db,
    `SELECT user_id FROM family_memberships
      WHERE family_id = $1 AND (role = 'owner' OR (role = 'admin' ${perm ? `AND ${perm}` : ''}))`,
    [familyId],
  );
  return rows.map((r) => r.user_id);
}

export async function familyMemberIds(db: Db, familyId: string): Promise<string[]> {
  const rows = await many<{ user_id: string }>(db, `SELECT user_id FROM family_memberships WHERE family_id = $1`, [familyId]);
  return rows.map((r) => r.user_id);
}

/** Stores an in-app notification, pushes it live, and sends a push notification when configured. */
export async function notify(
  ctx: Ctx,
  userIds: string[],
  kind: string,
  payload: Record<string, unknown>,
  push?: { title: string; body: string },
): Promise<void> {
  for (const userId of new Set(userIds)) {
    const rows = await many(
      ctx.db,
      `INSERT INTO notifications (user_id, kind, payload) VALUES ($1, $2, $3)
       RETURNING id, kind, payload, created_at AS "createdAt", read_at AS "readAt"`,
      [userId, kind, JSON.stringify(payload)],
    );
    ctx.hub.publish([userId], { type: 'notification.new', notification: rows[0] });
  }
  if (push) await sendPush(ctx, userIds, push.title, push.body, { kind, ...payload });
}

export async function sendPush(
  ctx: Ctx,
  userIds: string[],
  title: string,
  body: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!ctx.push.enabled || userIds.length === 0) return;
  const devices = await many<{ push_token: string }>(
    ctx.db,
    `SELECT push_token FROM devices WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL AND push_token IS NOT NULL`,
    [userIds],
  );
  await ctx.push.send(devices.map((d) => ({ to: d.push_token, title, body, data })));
}

/**
 * Call after any change that can reduce who may talk to whom in a family.
 * Removes members that lost permission and tells every affected user to refresh.
 */
export async function afterPermissionChange(ctx: Ctx, familyId: string, alsoNotify: string[] = []): Promise<void> {
  const removed = await reconcileFamilyConversations(ctx.db, familyId);
  await endRevokedCalls(ctx, familyId);
  for (const r of removed) ctx.hub.publish([r.userId], { type: 'conversation.removed', conversationId: r.conversationId });
  const members = await familyMemberIds(ctx.db, familyId);
  ctx.hub.publish([...members, ...alsoNotify, ...removed.map((r) => r.userId)], { type: 'contacts.changed' });
  ctx.hub.publish([...members, ...alsoNotify, ...removed.map((r) => r.userId)], { type: 'conversations.changed' });
}

/** Ends any call running on a device (or on any of a user's devices) that was just signed out or revoked. */
export async function endCallsOf(ctx: Ctx, target: { deviceId?: string; userId?: string }): Promise<void> {
  const calls = await many<{ id: string }>(
    ctx.db,
    `SELECT id FROM calls WHERE status IN ('ringing', 'accepted')
        AND ($1::uuid IN (caller_device_id, callee_device_id) OR $2::uuid IN (caller_id, callee_id))`,
    [target.deviceId ?? null, target.userId ?? null],
  );
  for (const c of calls) await finishCall(ctx, c.id, 'ended', 'device_revoked');
}
