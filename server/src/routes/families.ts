import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdult } from '../auth.js';
import { afterPermissionChange, familyMemberIds, notify, type Ctx } from '../context.js';
import { many, one, withTx } from '../db/pool.js';
import { logEvent } from '../lib/audit.js';
import { requireChildInFamily, requireFamilyAdmin } from '../lib/authz.js';
import { pairingCode } from '../lib/crypto.js';
import { badRequest, conflict, notFound, parse } from '../lib/errors.js';
import { createInvitation, sendInvitationSms } from '../lib/invitations.js';
import { verifyStepUp } from '../lib/otp.js';
import { normalizePhone } from '../lib/phone.js';
import { pairingHash } from './auth.js';

export const TERMS_VERSION = '2026-10';

const Name = z.string().trim().min(1).max(60);
const FamilyParams = z.object({ fid: z.uuid() });
const ChildParams = z.object({ fid: z.uuid(), cid: z.uuid() });
const StepUp = { challengeId: z.uuid().optional(), code: z.string().max(10).optional() };
const AVATAR_COLORS = ['#4A90E2', '#2EC4B6', '#FF9F68', '#9B7BEA', '#F25F7A', '#3BB273', '#F2B134'];

export async function familyRoutes(app: FastifyInstance, ctx: Ctx) {
  app.addHook('preHandler', authenticate(ctx));

  app.post('/families', async (req) => {
    requireAdult(req);
    const body = parse(
      z.object({ name: Name, acceptTerms: z.literal(true), parentalConsent: z.literal(true), termsVersion: z.string().max(20) }),
      req.body,
    );
    if (body.termsVersion !== TERMS_VERSION) throw badRequest('terms_outdated');
    const owned = await one(ctx.db, `SELECT 1 FROM family_memberships WHERE user_id = $1 AND role = 'owner'`, [req.user.id]);
    if (owned) throw conflict('already_owner');
    const familyId = await withTx(ctx.db, async (c) => {
      const f = await one<{ id: string }>(c, `INSERT INTO families (name, created_by) VALUES ($1, $2) RETURNING id`, [body.name, req.user.id]);
      await c.query(`INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')`, [f!.id, req.user.id]);
      for (const kind of ['terms', 'privacy', 'parental_consent']) {
        await c.query(`INSERT INTO consent_records (user_id, family_id, kind, version, ip) VALUES ($1, $2, $3, $4, $5)`, [
          req.user.id,
          f!.id,
          kind,
          TERMS_VERSION,
          req.ip,
        ]);
      }
      await c.query(`INSERT INTO retention_policies (family_id, updated_by) VALUES ($1, $2)`, [f!.id, req.user.id]);
      await logEvent(c, { kind: 'family_created', familyId: f!.id, actorId: req.user.id, ip: req.ip });
      return f!.id;
    });
    return { id: familyId };
  });

  app.get('/families/:fid', async (req) => {
    const { fid } = parse(FamilyParams, req.params);
    const me = await requireFamilyAdmin(ctx.db, req.user.id, fid);
    const family = await one(ctx.db, `SELECT id, name, created_at AS "createdAt", is_demo AS "isDemo" FROM families WHERE id = $1`, [fid]);
    const admins = await many(
      ctx.db,
      `SELECT u.id, u.display_name AS "displayName", u.avatar_color AS "avatarColor", m.role,
              m.can_manage_contacts AS "canManageContacts", m.can_approve_requests AS "canApproveRequests",
              m.can_change_settings AS "canChangeSettings"
         FROM family_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.family_id = $1 AND m.role IN ('owner','admin') ORDER BY m.role DESC, m.created_at`,
      [fid],
    );
    const children = await many(
      ctx.db,
      `SELECT u.id, u.display_name AS "displayName", u.avatar_color AS "avatarColor"
         FROM child_profiles cp JOIN users u ON u.id = cp.user_id
        WHERE cp.family_id = $1 AND u.deleted_at IS NULL ORDER BY u.created_at`,
      [fid],
    );
    const pendingAdminInvites = await many(
      ctx.db,
      `SELECT id, phone_e164 AS phone, expires_at AS "expiresAt" FROM invitations
        WHERE family_id = $1 AND kind = 'admin' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
      [fid],
    );
    const retention = await one(ctx.db, `SELECT message_retention_days AS "messageRetentionDays" FROM retention_policies WHERE family_id = $1`, [fid]);
    return {
      family,
      me: {
        role: me.role,
        canManageContacts: me.role === 'owner' || me.can_manage_contacts,
        canApproveRequests: me.role === 'owner' || me.can_approve_requests,
        canChangeSettings: me.role === 'owner' || me.can_change_settings,
      },
      admins,
      children,
      pendingAdminInvites,
      retention: retention ?? { messageRetentionDays: null },
    };
  });

  app.patch('/families/:fid', async (req) => {
    const { fid } = parse(FamilyParams, req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid, 'change_settings');
    const body = parse(z.object({ name: Name }), req.body);
    await ctx.db.query(`UPDATE families SET name = $2 WHERE id = $1`, [fid, body.name]);
    await logEvent(ctx.db, { kind: 'family_updated', familyId: fid, actorId: req.user.id, ip: req.ip, metadata: { name: body.name } });
    ctx.hub.publish(await familyMemberIds(ctx.db, fid), { type: 'family.changed', familyId: fid });
    return { ok: true };
  });

  app.delete('/families/:fid', async (req) => {
    const { fid } = parse(FamilyParams, req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid, 'owner');
    const body = parse(z.object(StepUp), req.body);
    await verifyStepUp(ctx, req.user.id, body.challengeId, body.code, req.ip);
    const members = await familyMemberIds(ctx.db, fid);
    await withTx(ctx.db, async (c) => {
      // Child accounts exist only inside the family, so they are deleted with it.
      await c.query(`DELETE FROM users WHERE id IN (SELECT user_id FROM child_profiles WHERE family_id = $1)`, [fid]);
      await c.query(`DELETE FROM families WHERE id = $1`, [fid]);
      await logEvent(c, { kind: 'family_deleted', actorId: req.user.id, targetId: fid, ip: req.ip });
    });
    ctx.hub.publish(members, { type: 'family.changed', familyId: fid });
    return { ok: true };
  });

  app.get('/families/:fid/dashboard', async (req) => {
    const { fid } = parse(FamilyParams, req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid);
    const children = await many(
      ctx.db,
      `SELECT u.id, u.display_name AS "displayName", u.avatar_color AS "avatarColor",
              (SELECT count(*) FROM contact_approvals ca WHERE ca.child_user_id = u.id AND ca.status = 'approved') AS "approvedContacts",
              (SELECT count(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS "activeDevices",
              (SELECT max(d.last_seen_at) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS "lastSeenAt",
              cp.quiet_start_min IS NOT NULL AS "quietHoursOn",
              cp.allow_contact_requests AS "allowContactRequests"
         FROM child_profiles cp JOIN users u ON u.id = cp.user_id
        WHERE cp.family_id = $1 AND u.deleted_at IS NULL ORDER BY u.created_at`,
      [fid],
    );
    const counts = await one<{ pendingRequests: number; pendingVerification: number; openReports: number }>(
      ctx.db,
      `SELECT
         (SELECT count(*) FROM contact_approvals ca JOIN contacts ct ON ct.id = ca.contact_id
           WHERE ct.family_id = $1 AND ca.status = 'pending_parent_approval') AS "pendingRequests",
         (SELECT count(*) FROM contact_approvals ca JOIN contacts ct ON ct.id = ca.contact_id
           WHERE ct.family_id = $1 AND ca.status = 'pending_verification') AS "pendingVerification",
         (SELECT count(*) FROM reports WHERE family_id = $1 AND status = 'open') AS "openReports"`,
      [fid],
    );
    // Who talked with whom and when — never message content. Parents see the
    // shape of their child's communication without covert reading.
    const recentConversations = await many(
      ctx.db,
      `SELECT c.id, c.kind, c.title, c.last_message_at AS "lastMessageAt",
              child.id AS "childId", child.display_name AS "childName",
              (SELECT string_agg(coalesce(u.display_name, '—'), ', ')
                 FROM conversation_members cm JOIN users u ON u.id = cm.user_id
                WHERE cm.conversation_id = c.id AND cm.user_id <> child.id AND cm.left_at IS NULL) AS "withNames"
         FROM conversations c
         JOIN conversation_members ccm ON ccm.conversation_id = c.id
         JOIN users child ON child.id = ccm.user_id AND child.kind = 'child'
        WHERE c.family_id = $1 AND c.last_message_at IS NOT NULL
        ORDER BY c.last_message_at DESC LIMIT 10`,
      [fid],
    );
    const alerts = await many(
      ctx.db,
      `SELECT e.id, e.kind, e.created_at AS "createdAt", e.metadata, a.display_name AS "actorName"
         FROM security_events e LEFT JOIN users a ON a.id = e.actor_id
        WHERE e.family_id = $1 AND e.kind IN ('device_paired','device_revoked','contact_blocked','report_created','admin_joined','admin_removed','ownership_transferred')
          AND e.created_at > now() - interval '14 days'
        ORDER BY e.created_at DESC LIMIT 5`,
      [fid],
    );
    return { children, ...counts, recentConversations, alerts };
  });

  app.post('/families/:fid/children', async (req) => {
    const { fid } = parse(FamilyParams, req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid, 'change_settings');
    const body = parse(z.object({ displayName: Name, birthYear: z.number().int().min(2000).max(2100).optional() }), req.body);
    const count = await one<{ n: number }>(ctx.db, `SELECT count(*) AS n FROM child_profiles WHERE family_id = $1`, [fid]);
    if ((count?.n ?? 0) >= 12) throw conflict('too_many_children');
    const id = await withTx(ctx.db, async (c) => {
      const color = AVATAR_COLORS[(count?.n ?? 0) % AVATAR_COLORS.length];
      const u = await one<{ id: string }>(c, `INSERT INTO users (kind, display_name, avatar_color) VALUES ('child', $1, $2) RETURNING id`, [
        body.displayName,
        color,
      ]);
      await c.query(`INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'child')`, [fid, u!.id]);
      await c.query(`INSERT INTO child_profiles (user_id, family_id, birth_year) VALUES ($1, $2, $3)`, [u!.id, fid, body.birthYear ?? null]);
      await logEvent(c, { kind: 'child_added', familyId: fid, actorId: req.user.id, targetId: u!.id, ip: req.ip });
      return u!.id;
    });
    ctx.hub.publish(await familyMemberIds(ctx.db, fid), { type: 'family.changed', familyId: fid });
    return { id };
  });

  app.get('/families/:fid/children/:cid', async (req) => {
    const { fid, cid } = parse(ChildParams, req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid);
    await requireChildInFamily(ctx.db, fid, cid);
    const child = await one(
      ctx.db,
      `SELECT u.id, u.display_name AS "displayName", u.avatar_color AS "avatarColor", cp.birth_year AS "birthYear",
              cp.allow_contact_requests AS "allowContactRequests", cp.allow_profile_edit AS "allowProfileEdit",
              cp.read_receipts AS "readReceipts", cp.quiet_start_min AS "quietStartMin", cp.quiet_end_min AS "quietEndMin",
              cp.time_zone AS "timeZone"
         FROM users u JOIN child_profiles cp ON cp.user_id = u.id WHERE u.id = $1`,
      [cid],
    );
    const contacts = await many(
      ctx.db,
      `SELECT ca.id AS "approvalId", ct.id AS "contactId", ct.display_name AS "displayName", ct.phone_e164 AS phone,
              ct.user_id IS NOT NULL AS verified, ca.status, ca.can_message AS "canMessage",
              ca.can_send_media AS "canSendMedia", ca.can_voice AS "canVoice", ca.can_call AS "canCall",
              ca.updated_at AS "updatedAt"
         FROM contact_approvals ca JOIN contacts ct ON ct.id = ca.contact_id
        WHERE ca.child_user_id = $1 AND ca.status <> 'removed'
        ORDER BY ca.status = 'approved' DESC, ct.display_name`,
      [cid],
    );
    const devices = await many(
      ctx.db,
      `SELECT id, name, platform, created_at AS "createdAt", last_seen_at AS "lastSeenAt"
         FROM devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_seen_at DESC`,
      [cid],
    );
    return { child, contacts, devices };
  });

  app.patch('/families/:fid/children/:cid', async (req) => {
    const { fid, cid } = parse(ChildParams, req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid, 'change_settings');
    await requireChildInFamily(ctx.db, fid, cid);
    const Minutes = z.number().int().min(0).max(1439).nullable();
    const body = parse(
      z
        .object({
          displayName: Name.optional(),
          birthYear: z.number().int().min(2000).max(2100).nullable().optional(),
          allowContactRequests: z.boolean().optional(),
          allowProfileEdit: z.boolean().optional(),
          readReceipts: z.boolean().optional(),
          quietStartMin: Minutes.optional(),
          quietEndMin: Minutes.optional(),
        })
        .refine((b) => (b.quietStartMin === null) === (b.quietEndMin === null), 'quiet hours need both start and end'),
      req.body,
    );
    await withTx(ctx.db, async (c) => {
      if (body.displayName) await c.query(`UPDATE users SET display_name = $2 WHERE id = $1`, [cid, body.displayName]);
      const cols: Record<string, unknown> = {
        birth_year: body.birthYear,
        allow_contact_requests: body.allowContactRequests,
        allow_profile_edit: body.allowProfileEdit,
        read_receipts: body.readReceipts,
        quiet_start_min: body.quietStartMin,
        quiet_end_min: body.quietEndMin,
      };
      const set = Object.entries(cols).filter(([, v]) => v !== undefined);
      if (set.length) {
        await c.query(
          `UPDATE child_profiles SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE user_id = $1`,
          [cid, ...set.map(([, v]) => v)],
        );
      }
      await logEvent(c, { kind: 'child_settings_changed', familyId: fid, actorId: req.user.id, targetId: cid, ip: req.ip, metadata: body });
    });
    ctx.hub.publish([cid, ...(await familyMemberIds(ctx.db, fid))], { type: 'family.changed', familyId: fid });
    return { ok: true };
  });

  app.delete('/families/:fid/children/:cid', async (req) => {
    const { fid, cid } = parse(ChildParams, req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid, 'owner');
    await requireChildInFamily(ctx.db, fid, cid);
    const body = parse(z.object(StepUp), req.body);
    await verifyStepUp(ctx, req.user.id, body.challengeId, body.code, req.ip);
    ctx.hub.disconnect({ userId: cid });
    await withTx(ctx.db, async (c) => {
      await c.query(`DELETE FROM users WHERE id = $1`, [cid]);
      await logEvent(c, { kind: 'child_removed', familyId: fid, actorId: req.user.id, targetId: cid, ip: req.ip });
    });
    await afterPermissionChange(ctx, fid);
    return { ok: true };
  });

  app.post('/families/:fid/children/:cid/pairing-code', async (req) => {
    const { fid, cid } = parse(ChildParams, req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid, 'change_settings');
    await requireChildInFamily(ctx.db, fid, cid);
    // Only one open code per child at a time.
    await ctx.db.query(`UPDATE pairing_codes SET consumed_at = now() WHERE child_user_id = $1 AND consumed_at IS NULL`, [cid]);
    const code = pairingCode();
    const row = await one<{ expires_at: Date }>(
      ctx.db,
      `INSERT INTO pairing_codes (child_user_id, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, now() + interval '15 minutes') RETURNING expires_at`,
      [cid, pairingHash(ctx, code), req.user.id],
    );
    await logEvent(ctx.db, { kind: 'pairing_code_created', familyId: fid, actorId: req.user.id, targetId: cid, ip: req.ip });
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: row!.expires_at };
  });

  app.post('/families/:fid/children/:cid/devices/:did/revoke', async (req) => {
    const { fid, cid, did } = parse(ChildParams.extend({ did: z.uuid() }), req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid, 'change_settings');
    await requireChildInFamily(ctx.db, fid, cid);
    const res = await ctx.db.query(
      `UPDATE devices SET revoked_at = now(), revoked_by = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [did, cid, req.user.id],
    );
    if (res.rowCount !== 1) throw notFound('device_not_found');
    ctx.hub.disconnect({ deviceId: did });
    await logEvent(ctx.db, { kind: 'device_revoked', familyId: fid, actorId: req.user.id, targetId: did, ip: req.ip, metadata: { childId: cid } });
    return { ok: true };
  });

  app.get('/families/:fid/audit', async (req) => {
    const { fid } = parse(FamilyParams, req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid);
    const q = parse(z.object({ before: z.coerce.number().int().optional() }), req.query);
    const events = await many(
      ctx.db,
      `SELECT e.id, e.kind, e.created_at AS "createdAt", e.metadata, e.target_id AS "targetId",
              a.display_name AS "actorName", a.kind AS "actorKind"
         FROM security_events e LEFT JOIN users a ON a.id = e.actor_id
        WHERE e.family_id = $1 AND ($2::bigint IS NULL OR e.id < $2)
        ORDER BY e.id DESC LIMIT 50`,
      [fid, q.before ?? null],
    );
    return { events };
  });

  // ---- Co-parents ---------------------------------------------------------

  const Perms = z.object({ canManageContacts: z.boolean(), canApproveRequests: z.boolean(), canChangeSettings: z.boolean() });

  app.post('/families/:fid/admins/invite', async (req) => {
    const { fid } = parse(FamilyParams, req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid, 'owner');
    const body = parse(z.object({ phone: z.string().max(30), permissions: Perms }), req.body);
    const phone = normalizePhone(body.phone);
    if (!phone) throw badRequest('invalid_phone');
    const existing = await one(
      ctx.db,
      `SELECT 1 FROM family_memberships m JOIN users u ON u.id = m.user_id WHERE m.family_id = $1 AND u.phone_e164 = $2`,
      [fid, phone],
    );
    if (existing) throw conflict('already_admin');
    const fam = await one<{ name: string }>(ctx.db, `SELECT name FROM families WHERE id = $1`, [fid]);
    const inv = await createInvitation(ctx, ctx.db, { familyId: fid, kind: 'admin', phone, createdBy: req.user.id, adminPerms: body.permissions });
    await logEvent(ctx.db, { kind: 'admin_invited', familyId: fid, actorId: req.user.id, targetId: inv.id, ip: req.ip });
    await sendInvitationSms(ctx, phone, fam!.name, inv.link);
    return { link: inv.link, expiresAt: inv.expiresAt };
  });

  app.patch('/families/:fid/admins/:uid', async (req) => {
    const { fid, uid } = parse(FamilyParams.extend({ uid: z.uuid() }), req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid, 'owner');
    const body = parse(Perms, req.body);
    const res = await ctx.db.query(
      `UPDATE family_memberships SET can_manage_contacts = $3, can_approve_requests = $4, can_change_settings = $5
        WHERE family_id = $1 AND user_id = $2 AND role = 'admin'`,
      [fid, uid, body.canManageContacts, body.canApproveRequests, body.canChangeSettings],
    );
    if (res.rowCount !== 1) throw notFound('admin_not_found');
    await logEvent(ctx.db, { kind: 'admin_updated', familyId: fid, actorId: req.user.id, targetId: uid, ip: req.ip, metadata: body });
    ctx.hub.publish([uid], { type: 'family.changed', familyId: fid });
    return { ok: true };
  });

  // The owner removes a co-parent, or a co-parent leaves on their own.
  app.delete('/families/:fid/admins/:uid', async (req) => {
    const { fid, uid } = parse(FamilyParams.extend({ uid: z.uuid() }), req.params);
    if (uid === req.user.id) await requireFamilyAdmin(ctx.db, req.user.id, fid);
    else await requireFamilyAdmin(ctx.db, req.user.id, fid, 'owner');
    const res = await ctx.db.query(`DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2 AND role = 'admin'`, [fid, uid]);
    if (res.rowCount !== 1) throw notFound('admin_not_found');
    await logEvent(ctx.db, { kind: 'admin_removed', familyId: fid, actorId: req.user.id, targetId: uid, ip: req.ip });
    await afterPermissionChange(ctx, fid, [uid]);
    ctx.hub.publish([uid], { type: 'family.changed', familyId: fid });
    return { ok: true };
  });

  app.post('/families/:fid/transfer-ownership', async (req) => {
    const { fid } = parse(FamilyParams, req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid, 'owner');
    const body = parse(z.object({ userId: z.uuid(), ...StepUp }), req.body);
    await verifyStepUp(ctx, req.user.id, body.challengeId, body.code, req.ip);
    await withTx(ctx.db, async (c) => {
      const target = await one(c, `SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2 AND role = 'admin'`, [fid, body.userId]);
      if (!target) throw notFound('admin_not_found');
      await c.query(`UPDATE family_memberships SET role = 'admin' WHERE family_id = $1 AND user_id = $2`, [fid, req.user.id]);
      await c.query(
        `UPDATE family_memberships SET role = 'owner', can_manage_contacts = true, can_approve_requests = true, can_change_settings = true
          WHERE family_id = $1 AND user_id = $2`,
        [fid, body.userId],
      );
      await logEvent(c, { kind: 'ownership_transferred', familyId: fid, actorId: req.user.id, targetId: body.userId, ip: req.ip });
    });
    await notify(ctx, [body.userId], 'ownership_transferred', { familyId: fid });
    ctx.hub.publish(await familyMemberIds(ctx.db, fid), { type: 'family.changed', familyId: fid });
    return { ok: true };
  });

  app.put('/families/:fid/retention', async (req) => {
    const { fid } = parse(FamilyParams, req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid, 'change_settings');
    const body = parse(z.object({ messageRetentionDays: z.number().int().min(7).max(3650).nullable() }), req.body);
    await ctx.db.query(
      `INSERT INTO retention_policies (family_id, message_retention_days, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (family_id) DO UPDATE SET message_retention_days = $2, updated_by = $3, updated_at = now()`,
      [fid, body.messageRetentionDays, req.user.id],
    );
    await logEvent(ctx.db, { kind: 'retention_changed', familyId: fid, actorId: req.user.id, ip: req.ip, metadata: body });
    return { ok: true };
  });

  // ---- Reports --------------------------------------------------------------

  app.get('/families/:fid/reports', async (req) => {
    const { fid } = parse(FamilyParams, req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid);
    const reports = await many(
      ctx.db,
      `SELECT r.id, r.reason, r.details, r.status, r.created_at AS "createdAt", r.conversation_id AS "conversationId",
              u.display_name AS "reporterName", u.kind AS "reporterKind",
              (SELECT m.body FROM messages m WHERE m.id = r.message_id) AS "messageBody",
              (SELECT su.display_name FROM messages m JOIN users su ON su.id = m.sender_id WHERE m.id = r.message_id) AS "messageSender"
         FROM reports r JOIN users u ON u.id = r.reporter_id
        WHERE r.family_id = $1 ORDER BY r.status = 'open' DESC, r.created_at DESC LIMIT 100`,
      [fid],
    );
    return { reports };
  });

  app.post('/families/:fid/reports/:rid/resolve', async (req) => {
    const { fid, rid } = parse(FamilyParams.extend({ rid: z.uuid() }), req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid);
    const res = await ctx.db.query(
      `UPDATE reports SET status = 'resolved', resolved_at = now(), resolved_by = $3 WHERE id = $1 AND family_id = $2 AND status = 'open'`,
      [rid, fid, req.user.id],
    );
    if (res.rowCount !== 1) throw notFound('report_not_found');
    await logEvent(ctx.db, { kind: 'report_resolved', familyId: fid, actorId: req.user.id, targetId: rid, ip: req.ip });
    return { ok: true };
  });

}
