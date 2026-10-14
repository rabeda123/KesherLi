import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdult, requireChildUser } from '../auth.js';
import { afterPermissionChange, endCallsOf, familyAdminIds, notify, type Ctx } from '../context.js';
import { many, one, withTx } from '../db/pool.js';
import { logEvent } from '../lib/audit.js';
import { childFamilyId, requireConversationAccess } from '../lib/authz.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/errors.js';
import { verifyStepUp } from '../lib/otp.js';
import { normalizePhone } from '../lib/phone.js';

export async function meRoutes(app: FastifyInstance, ctx: Ctx) {
  app.addHook('preHandler', authenticate(ctx));

  app.get('/me', async (req) => {
    const user = await one(
      ctx.db,
      `SELECT id, kind, display_name AS "displayName", avatar_color AS "avatarColor", phone_e164 AS phone, created_at AS "createdAt"
         FROM users WHERE id = $1`,
      [req.user.id],
    );
    const families = await many(
      ctx.db,
      `SELECT f.id, f.name, m.role, f.is_demo AS "isDemo",
              (m.role = 'owner' OR m.can_manage_contacts) AS "canManageContacts",
              (m.role = 'owner' OR m.can_approve_requests) AS "canApproveRequests",
              (m.role = 'owner' OR m.can_change_settings) AS "canChangeSettings"
         FROM family_memberships m JOIN families f ON f.id = m.family_id
        WHERE m.user_id = $1 AND m.role IN ('owner','admin') ORDER BY m.role DESC, f.created_at`,
      [req.user.id],
    );
    const child =
      req.user.kind === 'child'
        ? await one(
            ctx.db,
            `SELECT cp.family_id AS "familyId", f.name AS "familyName", cp.allow_contact_requests AS "allowContactRequests",
                    cp.allow_profile_edit AS "allowProfileEdit", cp.read_receipts AS "readReceipts"
               FROM child_profiles cp JOIN families f ON f.id = cp.family_id WHERE cp.user_id = $1`,
            [req.user.id],
          )
        : null;
    const unread = await one<{ n: number }>(ctx.db, `SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [req.user.id]);
    return { user, families, child, unreadNotifications: unread?.n ?? 0, deviceId: req.user.deviceId };
  });

  app.patch('/me', async (req) => {
    const body = parse(z.object({ displayName: z.string().trim().min(1).max(60) }), req.body);
    if (req.user.kind === 'child') {
      const cp = await one<{ allow_profile_edit: boolean }>(ctx.db, `SELECT allow_profile_edit FROM child_profiles WHERE user_id = $1`, [req.user.id]);
      if (!cp?.allow_profile_edit) throw forbidden('profile_edit_disabled');
    }
    await ctx.db.query(`UPDATE users SET display_name = $2 WHERE id = $1`, [req.user.id, body.displayName]);
    return { ok: true };
  });

  /** The people the caller may talk to right now — the only "directory" in the app. */
  app.get('/me/reachable', async (req) => {
    if (req.user.kind === 'child') {
      const fid = await childFamilyId(ctx.db, req.user.id);
      const people = await many(
        ctx.db,
        `SELECT u.id, u.display_name AS "displayName", u.avatar_color AS "avatarColor", 'parent' AS relation
           FROM family_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.family_id = $1 AND m.role IN ('owner','admin') AND u.deleted_at IS NULL
         UNION ALL
         SELECT u.id, u.display_name, u.avatar_color, 'sibling'
           FROM child_profiles cp JOIN users u ON u.id = cp.user_id
          WHERE cp.family_id = $1 AND u.id <> $2 AND u.deleted_at IS NULL
         UNION ALL
         SELECT u.id, ct.display_name, u.avatar_color, 'contact'
           FROM contact_approvals ca JOIN contacts ct ON ct.id = ca.contact_id JOIN users u ON u.id = ct.user_id
          WHERE ca.child_user_id = $2 AND ca.status = 'approved' AND ca.can_message AND ct.family_id = $1
            AND u.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.family_id = ct.family_id AND b.phone_e164 = ct.phone_e164 AND b.lifted_at IS NULL)`,
        [fid, req.user.id],
      );
      return { people };
    }
    const people = await many<{ id: string }>(
      ctx.db,
      `SELECT u.id, u.display_name AS "displayName", u.avatar_color AS "avatarColor", 'child' AS relation, f.name AS "familyName"
         FROM family_memberships m JOIN child_profiles cp ON cp.family_id = m.family_id
         JOIN users u ON u.id = cp.user_id JOIN families f ON f.id = m.family_id
        WHERE m.user_id = $1 AND m.role IN ('owner','admin') AND u.deleted_at IS NULL
       UNION ALL
       SELECT u.id, u.display_name, u.avatar_color, 'coparent', f.name
         FROM family_memberships m JOIN family_memberships m2 ON m2.family_id = m.family_id AND m2.user_id <> m.user_id
         JOIN users u ON u.id = m2.user_id JOIN families f ON f.id = m.family_id
        WHERE m.user_id = $1 AND m.role IN ('owner','admin') AND m2.role IN ('owner','admin') AND u.deleted_at IS NULL
       UNION ALL
       SELECT u.id, u.display_name, u.avatar_color, 'contact_child', f.name
         FROM contacts ct JOIN contact_approvals ca ON ca.contact_id = ct.id JOIN users u ON u.id = ca.child_user_id
         JOIN families f ON f.id = ct.family_id
        WHERE ct.user_id = $1 AND ca.status = 'approved' AND ca.can_message AND u.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.family_id = ct.family_id AND b.phone_e164 = ct.phone_e164 AND b.lifted_at IS NULL)`,
      [req.user.id],
    );
    const seen = new Set<string>();
    return { people: people.filter((p) => !seen.has(p.id) && seen.add(p.id)) };
  });

  // ---- Devices ----------------------------------------------------------------

  app.get('/me/devices', async (req) => {
    const devices = await many(
      ctx.db,
      `SELECT id, name, platform, created_at AS "createdAt", last_seen_at AS "lastSeenAt", id = $2 AS current
         FROM devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_seen_at DESC`,
      [req.user.id, req.user.deviceId],
    );
    return { devices };
  });

  app.post('/me/devices/:did/revoke', async (req) => {
    requireAdult(req);
    const { did } = parse(z.object({ did: z.uuid() }), req.params);
    const res = await ctx.db.query(
      `UPDATE devices SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [did, req.user.id],
    );
    if (res.rowCount !== 1) throw notFound('device_not_found');
    ctx.hub.disconnect({ deviceId: did });
    await endCallsOf(ctx, { deviceId: did });
    await logEvent(ctx.db, { kind: 'device_revoked', actorId: req.user.id, targetId: did, ip: req.ip });
    return { ok: true };
  });

  app.put('/me/push-token', async (req) => {
    const body = parse(z.object({ token: z.string().max(200).nullable() }), req.body);
    await ctx.db.query(`UPDATE devices SET push_token = $2 WHERE id = $1`, [req.user.deviceId, body.token]);
    return { ok: true };
  });

  // ---- Notifications -------------------------------------------------------

  app.get('/me/notifications', async (req) => {
    const notifications = await many(
      ctx.db,
      `SELECT id, kind, payload, created_at AS "createdAt", read_at AS "readAt"
         FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id],
    );
    return { notifications };
  });

  app.post('/me/notifications/read', async (req) => {
    await ctx.db.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [req.user.id]);
    return { ok: true };
  });

  // ---- Child: requesting a new contact ------------------------------------------

  app.post('/me/contact-requests', async (req) => {
    requireChildUser(req);
    ctx.limiter.consume(`contact-request:${req.user.id}`, 10, 24 * 60 * 60_000);
    const body = parse(
      z.object({ displayName: z.string().trim().min(1).max(60), phone: z.string().max(30), note: z.string().trim().max(200).optional() }),
      req.body,
    );
    const phone = normalizePhone(body.phone);
    if (!phone) throw badRequest('invalid_phone');
    const cp = await one<{ family_id: string; allow_contact_requests: boolean }>(
      ctx.db,
      `SELECT family_id, allow_contact_requests FROM child_profiles WHERE user_id = $1`,
      [req.user.id],
    );
    if (!cp?.allow_contact_requests) throw forbidden('contact_requests_disabled');
    const fid = cp.family_id;
    const blocked = await one(ctx.db, `SELECT 1 FROM blocks WHERE family_id = $1 AND phone_e164 = $2 AND lifted_at IS NULL`, [fid, phone]);
    if (blocked) throw conflict('contact_blocked');

    const approvalId = await withTx(ctx.db, async (c) => {
      // A child's request never overwrites the name a parent gave a contact.
      const contact = await one<{ id: string }>(
        c,
        `INSERT INTO contacts (family_id, display_name, phone_e164, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (family_id, phone_e164) DO UPDATE SET family_id = EXCLUDED.family_id
         RETURNING id`,
        [fid, body.displayName, phone, req.user.id],
      );
      const existing = await one<{ id: string; status: string }>(
        c,
        `SELECT id, status FROM contact_approvals WHERE contact_id = $1 AND child_user_id = $2`,
        [contact!.id, req.user.id],
      );
      if (existing && ['approved', 'pending_verification', 'pending_parent_approval', 'blocked'].includes(existing.status)) {
        throw conflict(existing.status === 'approved' ? 'already_approved' : 'already_requested');
      }
      const row = await one<{ id: string }>(
        c,
        `INSERT INTO contact_approvals (contact_id, child_user_id, status, request_note, requested_by)
         VALUES ($1, $2, 'pending_parent_approval', $3, $2)
         ON CONFLICT (contact_id, child_user_id) DO UPDATE SET status = 'pending_parent_approval', request_note = $3,
           requested_by = $2, decided_by = NULL, decided_at = NULL, updated_at = now(),
           can_message = true, can_send_media = false, can_voice = false, can_call = false
         RETURNING id`,
        [contact!.id, req.user.id, body.note ?? null],
      );
      await logEvent(c, { kind: 'contact_requested', familyId: fid, actorId: req.user.id, targetId: row!.id, ip: req.ip, metadata: { name: body.displayName } });
      return row!.id;
    });
    await notify(
      ctx,
      await familyAdminIds(ctx.db, fid, 'can_approve_requests'),
      'contact_request',
      { familyId: fid, approvalId, childId: req.user.id, childName: req.user.displayName, contactName: body.displayName },
      { title: 'בקשה חדשה', body: `${req.user.displayName ?? 'הילד/ה'} מבקש/ת להוסיף את ${body.displayName}` },
    );
    return { id: approvalId, status: 'pending_parent_approval' };
  });

  app.get('/me/contact-requests', async (req) => {
    requireChildUser(req);
    const requests = await many(
      ctx.db,
      `SELECT ca.id, ct.display_name AS "displayName", ca.status, ca.updated_at AS "updatedAt"
         FROM contact_approvals ca JOIN contacts ct ON ct.id = ca.contact_id
        WHERE ca.child_user_id = $1 AND ca.requested_by = $1 AND ca.status IN ('pending_parent_approval','pending_verification','rejected')
        ORDER BY ca.updated_at DESC LIMIT 20`,
      [req.user.id],
    );
    return { requests };
  });

  // ---- Reports & help --------------------------------------------------------

  app.post('/reports', async (req) => {
    ctx.limiter.consume(`report:${req.user.id}`, 20, 60 * 60_000);
    const body = parse(
      z.object({
        reason: z.enum(['bullying', 'inappropriate', 'stranger', 'spam', 'help', 'other']),
        details: z.string().trim().max(1000).optional(),
        conversationId: z.uuid().optional(),
        messageId: z.uuid().optional(),
      }),
      req.body,
    );
    let familyId: string | undefined;
    if (body.conversationId) {
      const conv = await requireConversationAccess(ctx.db, req.user.id, body.conversationId);
      familyId = conv.family_id;
      if (body.messageId) {
        const m = await one(ctx.db, `SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2`, [body.messageId, conv.id]);
        if (!m) throw notFound('message_not_found');
      }
    } else if (body.messageId) {
      throw badRequest('invalid_input', 'messageId requires conversationId');
    } else if (req.user.kind === 'child') {
      familyId = await childFamilyId(ctx.db, req.user.id);
    }
    if (!familyId) throw badRequest('invalid_input', 'conversationId is required');
    const row = await one<{ id: string }>(
      ctx.db,
      `INSERT INTO reports (family_id, reporter_id, conversation_id, message_id, reason, details) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [familyId, req.user.id, body.conversationId ?? null, body.messageId ?? null, body.reason, body.details ?? null],
    );
    await logEvent(ctx.db, { kind: 'report_created', familyId, actorId: req.user.id, targetId: row!.id, ip: req.ip, metadata: { reason: body.reason } });
    const isHelp = body.reason === 'help';
    await notify(
      ctx,
      await familyAdminIds(ctx.db, familyId),
      isHelp ? 'help_request' : 'report',
      { familyId, reportId: row!.id, reporterName: req.user.displayName, reason: body.reason },
      { title: isHelp ? 'בקשת עזרה' : 'דיווח חדש', body: `${req.user.displayName ?? ''} ${isHelp ? 'מבקש/ת עזרה' : 'שלח/ה דיווח'}` },
    );
    return { id: row!.id };
  });

  // ---- Privacy: export and deletion -----------------------------------------------

  app.get('/me/export', async (req) => {
    requireAdult(req);
    const id = req.user.id;
    const [user, memberships, devices, consents, messages, notifications] = await Promise.all([
      one(ctx.db, `SELECT id, kind, display_name, phone_e164, created_at FROM users WHERE id = $1`, [id]),
      many(ctx.db, `SELECT family_id, role, created_at FROM family_memberships WHERE user_id = $1`, [id]),
      many(ctx.db, `SELECT name, platform, created_at, last_seen_at, revoked_at FROM devices WHERE user_id = $1`, [id]),
      many(ctx.db, `SELECT kind, version, created_at FROM consent_records WHERE user_id = $1`, [id]),
      many(ctx.db, `SELECT conversation_id, body, created_at FROM messages WHERE sender_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [id]),
      many(ctx.db, `SELECT kind, payload, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at`, [id]),
    ]);
    return { exportedAt: new Date().toISOString(), user, memberships, devices, consents, messages, notifications };
  });

  app.delete('/me', async (req) => {
    requireAdult(req);
    const body = parse(z.object({ challengeId: z.uuid().optional(), code: z.string().max(10).optional() }), req.body);
    const owner = await one(ctx.db, `SELECT 1 FROM family_memberships WHERE user_id = $1 AND role = 'owner'`, [req.user.id]);
    if (owner) throw conflict('owner_must_transfer_or_delete_family');
    await verifyStepUp(ctx, req.user.id, body.challengeId, body.code, req.ip);
    const families = await many<{ family_id: string }>(
      ctx.db,
      `SELECT family_id FROM family_memberships WHERE user_id = $1 UNION SELECT family_id FROM contacts WHERE user_id = $1`,
      [req.user.id],
    );
    await withTx(ctx.db, async (c) => {
      await c.query(`DELETE FROM family_memberships WHERE user_id = $1`, [req.user.id]);
      await c.query(
        `UPDATE contact_approvals SET status = 'pending_verification', updated_at = now()
          WHERE status = 'approved' AND contact_id IN (SELECT id FROM contacts WHERE user_id = $1)`,
        [req.user.id],
      );
      await c.query(`UPDATE contacts SET user_id = NULL WHERE user_id = $1`, [req.user.id]);
      await c.query(`UPDATE messages SET body = NULL, deleted_at = now() WHERE sender_id = $1`, [req.user.id]);
      await c.query(`UPDATE conversation_members SET left_at = now() WHERE user_id = $1 AND left_at IS NULL`, [req.user.id]);
      await c.query(`UPDATE devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [req.user.id]);
      await c.query(`DELETE FROM notifications WHERE user_id = $1`, [req.user.id]);
      await c.query(`UPDATE users SET deleted_at = now(), phone_e164 = NULL, display_name = NULL WHERE id = $1`, [req.user.id]);
      await logEvent(c, { kind: 'account_deleted', actorId: req.user.id, ip: req.ip });
    });
    ctx.hub.disconnect({ userId: req.user.id });
    await endCallsOf(ctx, { userId: req.user.id });
    for (const f of families) await afterPermissionChange(ctx, f.family_id);
    return { ok: true };
  });
}
