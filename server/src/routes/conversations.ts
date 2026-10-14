import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth.js';
import { sendPush, type Ctx } from '../context.js';
import type { Db } from '../db/pool.js';
import { many, one, withTx } from '../db/pool.js';
import { logEvent } from '../lib/audit.js';
import {
  canCommunicate,
  canJoinGroup,
  canSendInConversation,
  childFamilyId,
  isFamilyAdmin,
  requireConversationAccess,
  requireFamilyAdmin,
  type ConversationRow,
} from '../lib/authz.js';
import { badRequest, forbidden, notFound, parse } from '../lib/errors.js';

const MESSAGE_FIELDS = `m.id, m.conversation_id AS "conversationId", m.sender_id AS "senderId", m.client_id AS "clientId",
  m.kind, CASE WHEN m.deleted_at IS NULL THEN m.body END AS body, m.created_at AS "createdAt", m.deleted_at AS "deletedAt"`;

type MemberRow = {
  id: string;
  displayName: string | null;
  avatarColor: string;
  kind: 'adult' | 'child';
  leftAt: Date | null;
  lastDeliveredAt: Date | null;
  lastReadAt: Date | null;
};

/**
 * Children see contacts under the name their parent gave them
 * ("סבתא רחל"), not whatever the contact typed into their own profile.
 */
async function nameOverrides(db: Db, viewerId: string, viewerKind: string): Promise<Map<string, string>> {
  if (viewerKind !== 'child') return new Map();
  const rows = await many<{ user_id: string; display_name: string }>(
    db,
    `SELECT ct.user_id, ct.display_name FROM contacts ct JOIN child_profiles cp ON cp.family_id = ct.family_id
      WHERE cp.user_id = $1 AND ct.user_id IS NOT NULL`,
    [viewerId],
  );
  return new Map(rows.map((r) => [r.user_id, r.display_name]));
}

async function members(db: Db, conversationId: string, overrides: Map<string, string>): Promise<MemberRow[]> {
  const rows = await many<MemberRow>(
    db,
    `SELECT u.id, u.display_name AS "displayName", u.avatar_color AS "avatarColor", u.kind, cm.left_at AS "leftAt",
            cm.last_delivered_at AS "lastDeliveredAt",
            -- A child whose parent turned off read receipts never reveals read state.
            CASE WHEN cp.read_receipts = false THEN NULL ELSE cm.last_read_at END AS "lastReadAt"
       FROM conversation_members cm JOIN users u ON u.id = cm.user_id
       LEFT JOIN child_profiles cp ON cp.user_id = u.id
      WHERE cm.conversation_id = $1 ORDER BY cm.joined_at`,
    [conversationId],
  );
  return rows.map((r) => ({ ...r, displayName: overrides.get(r.id) ?? r.displayName }));
}

function minutesInZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

export function inQuietHours(start: number | null, end: number | null, timeZone: string, now = new Date()): boolean {
  if (start === null || end === null || start === end) return false;
  const t = minutesInZone(now, timeZone);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

export async function conversationRoutes(app: FastifyInstance, ctx: Ctx) {
  app.addHook('preHandler', authenticate(ctx));

  async function activeMemberIds(conversationId: string): Promise<string[]> {
    const rows = await many<{ user_id: string }>(
      ctx.db,
      `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL`,
      [conversationId],
    );
    return rows.map((r) => r.user_id);
  }

  app.get('/conversations', async (req) => {
    const rows = await many<
      ConversationRow & { unread: number; last: unknown; lastReadAt: Date | null }
    >(
      ctx.db,
      `SELECT c.*, me.last_read_at AS "lastReadAt",
              (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> $1 AND m.deleted_at IS NULL
                 AND (me.last_read_at IS NULL OR m.created_at > me.last_read_at)) AS unread,
              (SELECT row_to_json(x) FROM (SELECT ${MESSAGE_FIELDS} FROM messages m WHERE m.conversation_id = c.id
                 ORDER BY m.created_at DESC, m.id DESC LIMIT 1) x) AS last
         FROM conversation_members me JOIN conversations c ON c.id = me.conversation_id
        WHERE me.user_id = $1 AND me.left_at IS NULL
        ORDER BY coalesce(c.last_message_at, c.created_at) DESC`,
      [req.user.id],
    );
    const overrides = await nameOverrides(ctx.db, req.user.id, req.user.kind);
    const out = [];
    for (const c of rows) {
      const canSend = await canSendInConversation(ctx.db, req.user.id, c);
      // An adult outside the family who lost permission does not see the conversation at all.
      if (!canSend && c.kind === 'direct' && req.user.kind === 'adult' && !(await isFamilyAdmin(ctx.db, req.user.id, c.family_id))) continue;
      out.push({
        id: c.id,
        kind: c.kind,
        title: c.title,
        familyId: c.family_id,
        lastMessageAt: c.last_message_at,
        unread: c.unread,
        lastMessage: c.last,
        canSend,
        members: await members(ctx.db, c.id, overrides),
      });
    }
    return { conversations: out };
  });

  app.post('/conversations/direct', async (req) => {
    const body = parse(z.object({ userId: z.uuid() }), req.body);
    // Same answer for "does not exist" and "not allowed": no discovery of users.
    if (!(await canCommunicate(ctx.db, req.user.id, body.userId))) throw notFound('user_not_found');
    const other = await one<{ kind: string }>(ctx.db, `SELECT kind FROM users WHERE id = $1`, [body.userId]);
    let familyId: string | undefined;
    if (req.user.kind === 'child') familyId = await childFamilyId(ctx.db, req.user.id);
    else if (other!.kind === 'child') familyId = await childFamilyId(ctx.db, body.userId);
    else {
      const shared = await one<{ family_id: string }>(
        ctx.db,
        `SELECT m1.family_id FROM family_memberships m1 JOIN family_memberships m2 ON m2.family_id = m1.family_id
          WHERE m1.user_id = $1 AND m2.user_id = $2 AND m1.role IN ('owner','admin') AND m2.role IN ('owner','admin') LIMIT 1`,
        [req.user.id, body.userId],
      );
      familyId = shared?.family_id;
    }
    if (!familyId) throw notFound('user_not_found');
    const key = [req.user.id, body.userId].sort().join(':');
    const id = await withTx(ctx.db, async (c) => {
      await c.query(
        `INSERT INTO conversations (family_id, kind, direct_key, created_by) VALUES ($1, 'direct', $2, $3) ON CONFLICT (direct_key) DO NOTHING`,
        [familyId, key, req.user.id],
      );
      const conv = await one<{ id: string }>(c, `SELECT id FROM conversations WHERE direct_key = $1`, [key]);
      for (const uid of [req.user.id, body.userId]) {
        await c.query(
          `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)
           ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL`,
          [conv!.id, uid],
        );
      }
      return conv!.id;
    });
    ctx.hub.publish([req.user.id, body.userId], { type: 'conversations.changed' });
    return { id };
  });

  app.post('/families/:fid/groups', async (req) => {
    const { fid } = parse(z.object({ fid: z.uuid() }), req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid, 'manage_contacts');
    const body = parse(z.object({ title: z.string().trim().min(1).max(60), memberIds: z.array(z.uuid()).min(1).max(30) }), req.body);
    const all = [...new Set([req.user.id, ...body.memberIds])];
    for (const uid of all) {
      if (!(await canJoinGroup(ctx.db, fid, uid, all))) throw forbidden('member_not_allowed', uid);
    }
    const id = await withTx(ctx.db, async (c) => {
      const conv = await one<{ id: string }>(
        c,
        `INSERT INTO conversations (family_id, kind, title, created_by) VALUES ($1, 'group', $2, $3) RETURNING id`,
        [fid, body.title, req.user.id],
      );
      for (const uid of all) await c.query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)`, [conv!.id, uid]);
      await logEvent(c, { kind: 'group_created', familyId: fid, actorId: req.user.id, targetId: conv!.id, ip: req.ip, metadata: { title: body.title } });
      return conv!.id;
    });
    ctx.hub.publish(all, { type: 'conversations.changed' });
    return { id };
  });

  app.post('/conversations/:id/members', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.object({ userId: z.uuid() }), req.body);
    const conv = await requireConversationAccess(ctx.db, req.user.id, id);
    if (conv.kind !== 'group') throw badRequest('not_a_group');
    await requireFamilyAdmin(ctx.db, req.user.id, conv.family_id, 'manage_contacts');
    const current = await activeMemberIds(id);
    if (!(await canJoinGroup(ctx.db, conv.family_id, body.userId, [...current, body.userId]))) throw forbidden('member_not_allowed');
    await ctx.db.query(
      `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL`,
      [id, body.userId],
    );
    await logEvent(ctx.db, { kind: 'group_member_added', familyId: conv.family_id, actorId: req.user.id, targetId: body.userId, ip: req.ip, metadata: { conversationId: id } });
    ctx.hub.publish([...current, body.userId], { type: 'conversations.changed' });
    return { ok: true };
  });

  app.delete('/conversations/:id/members/:uid', async (req) => {
    const { id, uid } = parse(z.object({ id: z.uuid(), uid: z.uuid() }), req.params);
    const conv = await requireConversationAccess(ctx.db, req.user.id, id);
    if (conv.kind !== 'group') throw badRequest('not_a_group');
    if (uid !== req.user.id) await requireFamilyAdmin(ctx.db, req.user.id, conv.family_id, 'manage_contacts');
    const current = await activeMemberIds(id);
    await ctx.db.query(`UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`, [id, uid]);
    await logEvent(ctx.db, { kind: 'group_member_removed', familyId: conv.family_id, actorId: req.user.id, targetId: uid, ip: req.ip, metadata: { conversationId: id } });
    ctx.hub.publish([uid], { type: 'conversation.removed', conversationId: id });
    ctx.hub.publish(current, { type: 'conversations.changed' });
    return { ok: true };
  });

  app.get('/conversations/:id', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const conv = await requireConversationAccess(ctx.db, req.user.id, id);
    const overrides = await nameOverrides(ctx.db, req.user.id, req.user.kind);
    return {
      id: conv.id,
      kind: conv.kind,
      title: conv.title,
      familyId: conv.family_id,
      canSend: await canSendInConversation(ctx.db, req.user.id, conv),
      // Calls are one-to-one and need the parent's "calls" permission for this pair.
      canCall: conv.kind === 'direct' && (await canSendInConversation(ctx.db, req.user.id, conv, 'call')),
      isAdmin: await isFamilyAdmin(ctx.db, req.user.id, conv.family_id),
      members: await members(ctx.db, id, overrides),
    };
  });

  app.get('/conversations/:id/messages', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const q = parse(
      z.object({ before: z.uuid().optional(), after: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      req.query,
    );
    await requireConversationAccess(ctx.db, req.user.id, id);
    let messages: Array<{ createdAt: Date }>;
    if (q.after) {
      messages = await many(
        ctx.db,
        `SELECT ${MESSAGE_FIELDS} FROM messages m, (SELECT created_at, id FROM messages WHERE id = $2 AND conversation_id = $1) cur
          WHERE m.conversation_id = $1 AND (m.created_at, m.id) > (cur.created_at, cur.id)
          ORDER BY m.created_at, m.id LIMIT $3`,
        [id, q.after, q.limit],
      );
    } else {
      messages = (
        await many<{ createdAt: Date }>(
          ctx.db,
          `SELECT ${MESSAGE_FIELDS} FROM messages m
            WHERE m.conversation_id = $1
              AND ($2::uuid IS NULL OR (m.created_at, m.id) < (SELECT created_at, id FROM messages WHERE id = $2 AND conversation_id = $1))
            ORDER BY m.created_at DESC, m.id DESC LIMIT $3`,
          [id, q.before ?? null, q.limit],
        )
      ).reverse();
    }
    // Fetching messages marks them delivered to this user.
    const updated = await one<{ last_delivered_at: Date; last_read_at: Date | null; changed: boolean }>(
      ctx.db,
      `UPDATE conversation_members cm SET last_delivered_at = greatest(cm.last_delivered_at, sub.newest)
         FROM (SELECT max(created_at) AS newest FROM messages WHERE conversation_id = $1) sub
        WHERE cm.conversation_id = $1 AND cm.user_id = $2 AND sub.newest IS NOT NULL
          AND (cm.last_delivered_at IS NULL OR cm.last_delivered_at < sub.newest)
        RETURNING cm.last_delivered_at, cm.last_read_at, true AS changed`,
      [id, req.user.id],
    );
    if (updated) await publishReceipt(id, req.user.id, updated.last_delivered_at, updated.last_read_at);
    return { messages, hasMore: !q.after && messages.length === q.limit };
  });

  async function publishReceipt(conversationId: string, userId: string, delivered: Date | null, read: Date | null) {
    const rr = await one<{ read_receipts: boolean }>(ctx.db, `SELECT read_receipts FROM child_profiles WHERE user_id = $1`, [userId]);
    ctx.hub.publish((await activeMemberIds(conversationId)).filter((u) => u !== userId), {
      type: 'conversation.receipt',
      conversationId,
      userId,
      lastDeliveredAt: delivered?.toISOString() ?? null,
      lastReadAt: rr?.read_receipts === false ? null : (read?.toISOString() ?? null),
    });
  }

  app.post('/conversations/:id/messages', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.object({ clientId: z.uuid(), body: z.string().max(4000) }), req.body);
    const text = body.body.trim();
    if (!text) throw badRequest('empty_message');
    ctx.limiter.consume(`msg:${req.user.id}`, 60, 60_000);
    const conv = await requireConversationAccess(ctx.db, req.user.id, id);
    // Checked on every send: a permission revoked while the sender was online
    // stops the very next message.
    if (!(await canSendInConversation(ctx.db, req.user.id, conv))) throw forbidden('not_allowed_to_send');

    let message = await one<{ createdAt: Date; id: string; conversationId: string }>(
      ctx.db,
      `INSERT INTO messages (conversation_id, sender_id, client_id, body) VALUES ($1, $2, $3, $4)
       ON CONFLICT (sender_id, client_id) DO NOTHING
       RETURNING id, conversation_id AS "conversationId", sender_id AS "senderId", client_id AS "clientId", kind, body,
                 created_at AS "createdAt", deleted_at AS "deletedAt"`,
      [id, req.user.id, body.clientId, text],
    );
    if (!message) {
      // A retry of a message that already arrived: return the original.
      message = await one(ctx.db, `SELECT ${MESSAGE_FIELDS} FROM messages m WHERE m.sender_id = $1 AND m.client_id = $2`, [
        req.user.id,
        body.clientId,
      ]);
      if (!message || message.conversationId !== id) throw badRequest('client_id_reused');
      return { message, duplicate: true };
    }
    await ctx.db.query(
      `UPDATE conversations SET last_message_at = $2 WHERE id = $1 AND (last_message_at IS NULL OR last_message_at < $2)`,
      [id, message.createdAt],
    );
    await ctx.db.query(
      `UPDATE conversation_members SET last_read_at = greatest(last_read_at, $3), last_delivered_at = greatest(last_delivered_at, $3)
        WHERE conversation_id = $1 AND user_id = $2`,
      [id, req.user.id, message.createdAt],
    );
    const recipients = (await activeMemberIds(id)).filter((u) => u !== req.user.id);
    ctx.hub.publish([req.user.id, ...recipients], { type: 'message.new', conversationId: id, message });
    void pushNewMessage(recipients, req.user.displayName, conv).catch((err) => ctx.log.error({ err }, 'push failed'));
    return { message, duplicate: false };
  });

  async function pushNewMessage(recipients: string[], senderName: string | null, conv: ConversationRow) {
    if (!ctx.push.enabled) return;
    const quiet = await many<{ user_id: string; quiet_start_min: number | null; quiet_end_min: number | null; time_zone: string }>(
      ctx.db,
      `SELECT user_id, quiet_start_min, quiet_end_min, time_zone FROM child_profiles WHERE user_id = ANY($1::uuid[])`,
      [recipients],
    );
    const muted = new Set(quiet.filter((q) => inQuietHours(q.quiet_start_min, q.quiet_end_min, q.time_zone)).map((q) => q.user_id));
    // Push carries no message text; the content is fetched through the API.
    await sendPush(
      ctx,
      recipients.filter((r) => !muted.has(r)),
      conv.title ?? senderName ?? 'קשרלי',
      'הודעה חדשה',
      { conversationId: conv.id },
    );
  }

  app.post('/conversations/:id/read', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.object({ messageId: z.uuid() }), req.body);
    await requireConversationAccess(ctx.db, req.user.id, id);
    const updated = await one<{ last_delivered_at: Date; last_read_at: Date }>(
      ctx.db,
      `UPDATE conversation_members cm
          SET last_read_at = greatest(cm.last_read_at, m.created_at), last_delivered_at = greatest(cm.last_delivered_at, m.created_at)
         FROM messages m
        WHERE m.id = $3 AND m.conversation_id = $1 AND cm.conversation_id = $1 AND cm.user_id = $2
        RETURNING cm.last_delivered_at, cm.last_read_at`,
      [id, req.user.id, body.messageId],
    );
    if (!updated) throw notFound('message_not_found');
    await publishReceipt(id, req.user.id, updated.last_delivered_at, updated.last_read_at);
    return { ok: true };
  });

  app.delete('/conversations/:id/messages/:mid', async (req) => {
    const { id, mid } = parse(z.object({ id: z.uuid(), mid: z.uuid() }), req.params);
    await requireConversationAccess(ctx.db, req.user.id, id);
    // Senders may delete their own messages within 24 hours.
    const res = await ctx.db.query(
      `UPDATE messages SET deleted_at = now(), body = NULL
        WHERE id = $1 AND conversation_id = $2 AND sender_id = $3 AND deleted_at IS NULL AND created_at > now() - interval '24 hours'`,
      [mid, id, req.user.id],
    );
    if (res.rowCount !== 1) throw notFound('message_not_found');
    ctx.hub.publish(await activeMemberIds(id), { type: 'message.deleted', conversationId: id, messageId: mid });
    return { ok: true };
  });

  app.get('/search', async (req) => {
    const q = parse(z.object({ q: z.string().trim().min(2).max(100) }), req.query);
    ctx.limiter.consume(`search:${req.user.id}`, 30, 60_000);
    const pattern = '%' + q.q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const results = await many(
      ctx.db,
      `SELECT ${MESSAGE_FIELDS} FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.left_at IS NULL
        WHERE m.deleted_at IS NULL AND m.body ILIKE $2
        ORDER BY m.created_at DESC LIMIT 30`,
      [req.user.id, pattern],
    );
    return { results };
  });
}
