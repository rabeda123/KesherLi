import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth.js';
import { sendPush, type Ctx } from '../context.js';
import { many, one } from '../db/pool.js';
import { canCommunicate, isFamilyAdmin, requireConversationAccess } from '../lib/authz.js';
import { createHmac } from 'node:crypto';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/errors.js';
import { inQuietHours } from './conversations.js';

const RING_TIMEOUT_MS = 45_000;
const ACTIVE = `('ringing', 'accepted')`;

type CallRow = {
  id: string;
  conversation_id: string;
  family_id: string;
  caller_id: string;
  callee_id: string;
  caller_device_id: string | null;
  callee_device_id: string | null;
  kind: 'audio' | 'video';
  status: string;
  end_reason: string | null;
  created_at: Date;
  answered_at: Date | null;
  ended_at: Date | null;
};

const ringTimers = new Map<string, NodeJS.Timeout>();

/** How a call is shown to one of its participants (a child sees the name the parent chose). */
async function present(ctx: Ctx, call: CallRow, viewerId: string) {
  const peerId = viewerId === call.caller_id ? call.callee_id : call.caller_id;
  const peer = await one<{ display_name: string | null; avatar_color: string; contact_name: string | null }>(
    ctx.db,
    `SELECT u.display_name, u.avatar_color,
            (SELECT ct.display_name FROM contacts ct JOIN child_profiles cp ON cp.family_id = ct.family_id
              WHERE cp.user_id = $2 AND ct.user_id = u.id LIMIT 1) AS contact_name
       FROM users u WHERE u.id = $1`,
    [peerId, viewerId],
  );
  return {
    id: call.id,
    conversationId: call.conversation_id,
    kind: call.kind,
    status: call.status,
    endReason: call.end_reason,
    direction: viewerId === call.caller_id ? 'outgoing' : 'incoming',
    callerDeviceId: call.caller_device_id,
    calleeDeviceId: call.callee_device_id,
    peer: { id: peerId, displayName: peer?.contact_name ?? peer?.display_name ?? null, avatarColor: peer?.avatar_color ?? '#999' },
    createdAt: call.created_at,
    answeredAt: call.answered_at,
    endedAt: call.ended_at,
  };
}

async function publishCall(ctx: Ctx, call: CallRow, type: 'call.incoming' | 'call.updated', onlyTo?: string) {
  for (const uid of [call.caller_id, call.callee_id]) {
    if (!uid || (onlyTo && uid !== onlyTo)) continue;
    ctx.hub.publish([uid], { type, call: await present(ctx, call, uid) });
  }
}

/** Moves an active call to a final state and tells both sides (all their devices). */
export async function finishCall(ctx: Ctx, callId: string, status: 'declined' | 'missed' | 'cancelled' | 'ended', reason: string): Promise<CallRow | undefined> {
  const call = await one<CallRow>(
    ctx.db,
    `UPDATE calls SET status = $2, end_reason = $3, ended_at = now() WHERE id = $1 AND status IN ${ACTIVE} RETURNING *`,
    [callId, status, reason],
  );
  clearTimeout(ringTimers.get(callId));
  ringTimers.delete(callId);
  if (call) await publishCall(ctx, call, 'call.updated');
  return call;
}

/** Ends calls in a family whose participants are no longer allowed to call each other. */
export async function endRevokedCalls(ctx: Ctx, familyId: string): Promise<void> {
  const active = await many<CallRow>(ctx.db, `SELECT * FROM calls WHERE family_id = $1 AND status IN ${ACTIVE}`, [familyId]);
  for (const c of active) {
    if (!(await canCommunicate(ctx.db, c.caller_id, c.callee_id, 'call'))) await finishCall(ctx, c.id, 'ended', 'revoked');
  }
}

/** Short-lived TURN credentials (coturn REST API scheme) or the configured fixed ones. */
export function iceServers(ctx: Ctx, userId: string) {
  const { stunUrls, turn } = ctx.config.webrtc;
  const servers: Array<{ urls: string[]; username?: string; credential?: string }> = [];
  if (stunUrls.length) servers.push({ urls: stunUrls });
  if (turn) {
    if (turn.secret) {
      const username = `${Math.floor(Date.now() / 1000) + 6 * 3600}:${userId}`;
      const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
      servers.push({ urls: turn.urls, username, credential });
    } else {
      servers.push({ urls: turn.urls, username: turn.username, credential: turn.credential });
    }
  }
  return servers;
}

export async function callRoutes(app: FastifyInstance, ctx: Ctx) {
  app.addHook('preHandler', authenticate(ctx));

  async function participantCall(callId: string, userId: string): Promise<CallRow> {
    const call = await one<CallRow>(ctx.db, `SELECT * FROM calls WHERE id = $1 AND (caller_id = $2 OR callee_id = $2)`, [callId, userId]);
    if (!call) throw notFound('call_not_found');
    return call;
  }

  app.get('/calls/ice-servers', async (req) => ({ iceServers: iceServers(ctx, req.user.id) }));

  app.post('/calls', async (req) => {
    const body = parse(z.object({ conversationId: z.uuid(), kind: z.enum(['audio', 'video']) }), req.body);
    ctx.limiter.consume(`call:${req.user.id}`, 10, 60_000);
    const conv = await requireConversationAccess(ctx.db, req.user.id, body.conversationId);
    if (conv.kind !== 'direct') throw badRequest('group_calls_unsupported');
    const other = await one<{ user_id: string; left_at: Date | null }>(
      ctx.db,
      `SELECT user_id, left_at FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2`,
      [conv.id, req.user.id],
    );
    // The parent's "calls" permission for this contact and this child is checked here, every time.
    if (!other || other.left_at || !(await canCommunicate(ctx.db, req.user.id, other.user_id, 'call'))) throw forbidden('calls_not_allowed');

    // Quiet hours also hold back calls to a child, except from the child's own parents.
    const quiet = await one<{ quiet_start_min: number | null; quiet_end_min: number | null; time_zone: string; family_id: string }>(
      ctx.db,
      `SELECT quiet_start_min, quiet_end_min, time_zone, family_id FROM child_profiles WHERE user_id = $1`,
      [other.user_id],
    );
    if (quiet && inQuietHours(quiet.quiet_start_min, quiet.quiet_end_min, quiet.time_zone) && !(await isFamilyAdmin(ctx.db, req.user.id, quiet.family_id))) {
      throw forbidden('quiet_hours');
    }

    const busy = await one(ctx.db, `SELECT 1 FROM calls WHERE status IN ${ACTIVE} AND (caller_id = ANY($1::uuid[]) OR callee_id = ANY($1::uuid[]))`, [
      [req.user.id, other.user_id],
    ]);
    if (busy) throw conflict('busy');

    const call = (await one<CallRow>(
      ctx.db,
      `INSERT INTO calls (conversation_id, family_id, caller_id, callee_id, caller_device_id, kind, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ringing') RETURNING *`,
      [conv.id, conv.family_id, req.user.id, other.user_id, req.user.deviceId, body.kind],
    ))!;
    ringTimers.set(
      call.id,
      setTimeout(() => void finishCall(ctx, call.id, 'missed', 'no_answer').catch((err) => ctx.log.error({ err }, 'ring timeout')), RING_TIMEOUT_MS).unref(),
    );
    await publishCall(ctx, call, 'call.incoming', other.user_id);
    void sendPush(ctx, [other.user_id], req.user.displayName ?? 'קשרלי', body.kind === 'video' ? 'שיחת וידאו נכנסת' : 'שיחה נכנסת', {
      callId: call.id,
    }).catch(() => {});
    return { call: await present(ctx, call, req.user.id), iceServers: iceServers(ctx, req.user.id) };
  });

  app.get('/calls/:id', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    return { call: await present(ctx, await participantCall(id, req.user.id), req.user.id) };
  });

  app.post('/calls/:id/accept', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const call = await participantCall(id, req.user.id);
    if (call.callee_id !== req.user.id) throw forbidden();
    // Permission may have been revoked while it was ringing.
    if (!(await canCommunicate(ctx.db, call.caller_id, call.callee_id, 'call'))) {
      await finishCall(ctx, id, 'ended', 'revoked');
      throw forbidden('calls_not_allowed');
    }
    const updated = await one<CallRow>(
      ctx.db,
      `UPDATE calls SET status = 'accepted', answered_at = now(), callee_device_id = $2 WHERE id = $1 AND status = 'ringing' RETURNING *`,
      [id, req.user.deviceId],
    );
    if (!updated) throw conflict('call_not_ringing');
    clearTimeout(ringTimers.get(id));
    ringTimers.delete(id);
    await publishCall(ctx, updated, 'call.updated');
    return { call: await present(ctx, updated, req.user.id), iceServers: iceServers(ctx, req.user.id) };
  });

  app.post('/calls/:id/decline', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const call = await participantCall(id, req.user.id);
    if (call.callee_id !== req.user.id || call.status !== 'ringing') throw conflict('call_not_ringing');
    await finishCall(ctx, id, 'declined', 'declined');
    return { ok: true };
  });

  app.post('/calls/:id/end', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const call = await participantCall(id, req.user.id);
    const status = call.status === 'ringing' ? (call.caller_id === req.user.id ? 'cancelled' : 'declined') : 'ended';
    await finishCall(ctx, id, status, 'hangup');
    return { ok: true };
  });

  // Relays WebRTC setup (offer/answer/ICE candidates) to the other device in the call.
  app.post('/calls/:id/signal', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(
      z.object({
        type: z.enum(['offer', 'answer', 'ice']),
        sdp: z.string().max(20_000).optional(),
        candidate: z.object({ candidate: z.string().max(1000), sdpMid: z.string().max(64).nullish(), sdpMLineIndex: z.number().int().nullish() }).nullish(),
      }),
      req.body,
    );
    ctx.limiter.consume(`signal:${req.user.deviceId}`, 300, 60_000);
    const call = await participantCall(id, req.user.id);
    if (call.status !== 'accepted') throw conflict('call_not_active');
    // Only the two devices in the call may signal, not the user's other devices.
    const isCaller = call.caller_id === req.user.id && call.caller_device_id === req.user.deviceId;
    const isCallee = call.callee_id === req.user.id && call.callee_device_id === req.user.deviceId;
    if (!isCaller && !isCallee) throw forbidden('not_call_device');
    const [toUser, toDevice] = isCaller ? [call.callee_id, call.callee_device_id] : [call.caller_id, call.caller_device_id];
    if (toDevice) ctx.hub.publishToDevice(toUser, toDevice, { type: 'call.signal', callId: id, signal: body });
    return { ok: true };
  });
}

/** Clears calls left behind by a restart: stale ringing becomes missed, very long calls end. */
export async function sweepCalls(ctx: Ctx): Promise<void> {
  await ctx.db.query(
    `UPDATE calls SET status = 'missed', end_reason = 'no_answer', ended_at = now()
      WHERE status = 'ringing' AND created_at < now() - interval '2 minutes'`,
  );
  await ctx.db.query(
    `UPDATE calls SET status = 'ended', end_reason = 'timeout', ended_at = now()
      WHERE status = 'accepted' AND answered_at < now() - interval '6 hours'`,
  );
}
