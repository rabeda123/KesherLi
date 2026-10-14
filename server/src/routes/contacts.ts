import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdult } from '../auth.js';
import { afterPermissionChange, familyAdminIds, notify, type Ctx } from '../context.js';
import type { Db } from '../db/pool.js';
import { many, one, withTx } from '../db/pool.js';
import { logEvent } from '../lib/audit.js';
import { requireChildInFamily, requireFamilyAdmin, type AdminPerm } from '../lib/authz.js';
import { sha256 } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/errors.js';
import { createInvitation, sendInvitationSms, type AdminPerms } from '../lib/invitations.js';
import { maskPhone, normalizePhone } from '../lib/phone.js';

export const PermissionsSchema = z.object({
  canMessage: z.boolean().default(true),
  canSendMedia: z.boolean().default(false),
  canVoice: z.boolean().default(false),
  canCall: z.boolean().default(false),
});
type Permissions = z.infer<typeof PermissionsSchema>;

type ContactRow = { id: string; family_id: string; display_name: string; phone_e164: string; user_id: string | null };
type ApprovalRow = { id: string; status: string; child_user_id: string; contact_id: string } & { contact: ContactRow };

async function activeBlock(db: Db, familyId: string, phone: string): Promise<boolean> {
  return !!(await one(db, `SELECT 1 FROM blocks WHERE family_id = $1 AND phone_e164 = $2 AND lifted_at IS NULL`, [familyId, phone]));
}

/** Loads a contact and checks the caller administers its family with the given permission. */
async function contactForAdmin(ctx: Ctx, userId: string, contactId: string, perm: AdminPerm): Promise<ContactRow> {
  const c = await one<ContactRow>(ctx.db, `SELECT id, family_id, display_name, phone_e164, user_id FROM contacts WHERE id = $1`, [contactId]);
  if (!c) throw notFound('contact_not_found');
  await requireFamilyAdmin(ctx.db, userId, c.family_id, perm);
  return c;
}

async function approvalForAdmin(ctx: Ctx, userId: string, approvalId: string, perm: AdminPerm): Promise<ApprovalRow> {
  const a = await one<{ id: string; status: string; child_user_id: string; contact_id: string }>(
    ctx.db,
    `SELECT id, status, child_user_id, contact_id FROM contact_approvals WHERE id = $1`,
    [approvalId],
  );
  if (!a) throw notFound('approval_not_found');
  const contact = await contactForAdmin(ctx, userId, a.contact_id, perm);
  return { ...a, contact };
}

async function ensureInvitation(ctx: Ctx, db: Db, contact: ContactRow, createdBy: string) {
  const fam = await one<{ name: string }>(db, `SELECT name FROM families WHERE id = $1`, [contact.family_id]);
  const inv = await createInvitation(ctx, db, {
    familyId: contact.family_id,
    kind: 'contact',
    contactId: contact.id,
    phone: contact.phone_e164,
    createdBy,
  });
  return { ...inv, familyName: fam!.name };
}

export async function contactRoutes(app: FastifyInstance, ctx: Ctx) {
  app.addHook('preHandler', authenticate(ctx));

  app.get('/families/:fid/contacts', async (req) => {
    const { fid } = parse(z.object({ fid: z.uuid() }), req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid);
    const contacts = await many<Record<string, unknown> & { id: string }>(
      ctx.db,
      `SELECT ct.id, ct.display_name AS "displayName", ct.phone_e164 AS phone, ct.user_id IS NOT NULL AS verified,
              ct.created_at AS "createdAt",
              EXISTS (SELECT 1 FROM blocks b WHERE b.family_id = ct.family_id AND b.phone_e164 = ct.phone_e164 AND b.lifted_at IS NULL) AS blocked,
              (SELECT max(expires_at) FROM invitations i WHERE i.contact_id = ct.id AND i.accepted_at IS NULL
                  AND i.revoked_at IS NULL AND i.expires_at > now()) AS "inviteExpiresAt"
         FROM contacts ct WHERE ct.family_id = $1 ORDER BY ct.display_name`,
      [fid],
    );
    const approvals = await many<{ contactId: string }>(
      ctx.db,
      `SELECT ca.id, ca.contact_id AS "contactId", ca.child_user_id AS "childId", u.display_name AS "childName", ca.status,
              ca.can_message AS "canMessage", ca.can_send_media AS "canSendMedia", ca.can_voice AS "canVoice", ca.can_call AS "canCall",
              ca.request_note AS "requestNote", ca.updated_at AS "updatedAt"
         FROM contact_approvals ca JOIN contacts ct ON ct.id = ca.contact_id JOIN users u ON u.id = ca.child_user_id
        WHERE ct.family_id = $1 ORDER BY u.created_at`,
      [fid],
    );
    return { contacts: contacts.map((c) => ({ ...c, approvals: approvals.filter((a) => a.contactId === c.id) })) };
  });

  // Parent adds (or extends) a contact manually. No address book is read.
  app.post('/families/:fid/contacts', async (req) => {
    requireAdult(req);
    const { fid } = parse(z.object({ fid: z.uuid() }), req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid, 'manage_contacts');
    const body = parse(
      z.object({
        displayName: z.string().trim().min(1).max(60),
        phone: z.string().max(30),
        children: z.array(PermissionsSchema.extend({ childId: z.uuid() })).min(1).max(12),
      }),
      req.body,
    );
    const phone = normalizePhone(body.phone);
    if (!phone) throw badRequest('invalid_phone');
    for (const ch of body.children) await requireChildInFamily(ctx.db, fid, ch.childId);
    if (await activeBlock(ctx.db, fid, phone)) throw conflict('contact_blocked');
    const self = await one(ctx.db, `SELECT 1 FROM users WHERE id = $1 AND phone_e164 = $2`, [req.user.id, phone]);
    if (self) throw badRequest('cannot_add_self');

    const result = await withTx(ctx.db, async (c) => {
      const contact = (await one<ContactRow>(
        c,
        `INSERT INTO contacts (family_id, display_name, phone_e164, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (family_id, phone_e164) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id, family_id, display_name, phone_e164, user_id`,
        [fid, body.displayName, phone, req.user.id],
      ))!;
      // A person who already accepted this family's invitation is verified;
      // anyone else must first prove they own the phone number.
      const status = contact.user_id ? 'approved' : 'pending_verification';
      for (const ch of body.children) {
        await c.query(
          `INSERT INTO contact_approvals (contact_id, child_user_id, status, can_message, can_send_media, can_voice, can_call, decided_by, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           ON CONFLICT (contact_id, child_user_id) DO UPDATE SET
             status = EXCLUDED.status, can_message = EXCLUDED.can_message, can_send_media = EXCLUDED.can_send_media,
             can_voice = EXCLUDED.can_voice, can_call = EXCLUDED.can_call, decided_by = EXCLUDED.decided_by,
             decided_at = now(), updated_at = now()`,
          [contact.id, ch.childId, status, ch.canMessage, ch.canSendMedia, ch.canVoice, ch.canCall, req.user.id],
        );
      }
      await logEvent(c, {
        kind: 'contact_added',
        familyId: fid,
        actorId: req.user.id,
        targetId: contact.id,
        ip: req.ip,
        metadata: { name: body.displayName, phone: maskPhone(phone), children: body.children.map((x) => x.childId) },
      });
      const invite = contact.user_id ? null : await ensureInvitation(ctx, c, contact, req.user.id);
      return { contact, invite };
    });

    if (result.invite) {
      await sendInvitationSms(ctx, phone, result.invite.familyName, result.invite.link);
      await logEvent(ctx.db, { kind: 'contact_invite_created', familyId: fid, actorId: req.user.id, targetId: result.contact.id, ip: req.ip });
    } else {
      await afterPermissionChange(ctx, fid, [result.contact.user_id!]);
    }
    return {
      contactId: result.contact.id,
      status: result.invite ? 'pending_verification' : 'approved',
      inviteLink: result.invite?.link ?? null,
      inviteExpiresAt: result.invite?.expiresAt ?? null,
    };
  });

  app.get('/families/:fid/requests', async (req) => {
    const { fid } = parse(z.object({ fid: z.uuid() }), req.params);
    await requireFamilyAdmin(ctx.db, req.user.id, fid);
    const requests = await many(
      ctx.db,
      `SELECT ca.id, ca.child_user_id AS "childId", u.display_name AS "childName", ct.id AS "contactId",
              ct.display_name AS "contactName", ct.phone_e164 AS phone, ca.request_note AS note, ca.created_at AS "createdAt",
              ca.updated_at AS "updatedAt"
         FROM contact_approvals ca JOIN contacts ct ON ct.id = ca.contact_id JOIN users u ON u.id = ca.child_user_id
        WHERE ct.family_id = $1 AND ca.status = 'pending_parent_approval'
        ORDER BY ca.updated_at`,
      [fid],
    );
    return { requests };
  });

  app.post('/approvals/:aid/decision', async (req) => {
    const { aid } = parse(z.object({ aid: z.uuid() }), req.params);
    const body = parse(z.object({ decision: z.enum(['approve', 'reject']), permissions: PermissionsSchema.optional() }), req.body);
    const a = await approvalForAdmin(ctx, req.user.id, aid, 'approve_requests');
    if (a.status !== 'pending_parent_approval') throw conflict('not_pending');
    const fid = a.contact.family_id;
    if (body.decision === 'reject') {
      await ctx.db.query(
        `UPDATE contact_approvals SET status = 'rejected', decided_by = $2, decided_at = now(), updated_at = now() WHERE id = $1`,
        [aid, req.user.id],
      );
      await logEvent(ctx.db, { kind: 'contact_rejected', familyId: fid, actorId: req.user.id, targetId: aid, ip: req.ip });
      ctx.hub.publish([a.child_user_id], { type: 'contacts.changed' });
      return { status: 'rejected', inviteLink: null };
    }
    if (await activeBlock(ctx.db, fid, a.contact.phone_e164)) throw conflict('contact_blocked');
    const p: Permissions = body.permissions ?? PermissionsSchema.parse({});
    const status = a.contact.user_id ? 'approved' : 'pending_verification';
    const invite = await withTx(ctx.db, async (c) => {
      await c.query(
        `UPDATE contact_approvals SET status = $2, can_message = $3, can_send_media = $4, can_voice = $5, can_call = $6,
                decided_by = $7, decided_at = now(), updated_at = now() WHERE id = $1`,
        [aid, status, p.canMessage, p.canSendMedia, p.canVoice, p.canCall, req.user.id],
      );
      await logEvent(c, { kind: 'contact_approved', familyId: fid, actorId: req.user.id, targetId: aid, ip: req.ip });
      return a.contact.user_id ? null : ensureInvitation(ctx, c, a.contact, req.user.id);
    });
    if (invite) await sendInvitationSms(ctx, a.contact.phone_e164, invite.familyName, invite.link);
    await afterPermissionChange(ctx, fid, a.contact.user_id ? [a.contact.user_id] : []);
    return { status, inviteLink: invite?.link ?? null };
  });

  app.patch('/approvals/:aid', async (req) => {
    const { aid } = parse(z.object({ aid: z.uuid() }), req.params);
    const body = parse(PermissionsSchema.partial(), req.body);
    const a = await approvalForAdmin(ctx, req.user.id, aid, 'manage_contacts');
    await ctx.db.query(
      `UPDATE contact_approvals SET can_message = coalesce($2, can_message), can_send_media = coalesce($3, can_send_media),
              can_voice = coalesce($4, can_voice), can_call = coalesce($5, can_call), updated_at = now()
        WHERE id = $1`,
      [aid, body.canMessage ?? null, body.canSendMedia ?? null, body.canVoice ?? null, body.canCall ?? null],
    );
    await logEvent(ctx.db, { kind: 'contact_permissions_changed', familyId: a.contact.family_id, actorId: req.user.id, targetId: aid, ip: req.ip, metadata: body });
    await afterPermissionChange(ctx, a.contact.family_id, a.contact.user_id ? [a.contact.user_id] : []);
    return { ok: true };
  });

  app.post('/approvals/:aid/remove', async (req) => {
    const { aid } = parse(z.object({ aid: z.uuid() }), req.params);
    const a = await approvalForAdmin(ctx, req.user.id, aid, 'manage_contacts');
    if (a.status === 'blocked') throw conflict('contact_blocked');
    await ctx.db.query(`UPDATE contact_approvals SET status = 'removed', decided_by = $2, decided_at = now(), updated_at = now() WHERE id = $1`, [
      aid,
      req.user.id,
    ]);
    await logEvent(ctx.db, { kind: 'contact_removed', familyId: a.contact.family_id, actorId: req.user.id, targetId: aid, ip: req.ip });
    await afterPermissionChange(ctx, a.contact.family_id, a.contact.user_id ? [a.contact.user_id] : []);
    return { ok: true };
  });

  app.post('/contacts/:ctid/block', async (req) => {
    const { ctid } = parse(z.object({ ctid: z.uuid() }), req.params);
    const body = parse(z.object({ reason: z.string().max(200).optional() }), req.body);
    const contact = await contactForAdmin(ctx, req.user.id, ctid, 'manage_contacts');
    await withTx(ctx.db, async (c) => {
      await c.query(
        `INSERT INTO blocks (family_id, phone_e164, reason, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [contact.family_id, contact.phone_e164, body.reason ?? null, req.user.id],
      );
      await c.query(
        `UPDATE contact_approvals SET status = 'blocked', decided_by = $2, decided_at = now(), updated_at = now() WHERE contact_id = $1`,
        [ctid, req.user.id],
      );
      await c.query(`UPDATE invitations SET revoked_at = now() WHERE contact_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [ctid]);
      await logEvent(c, { kind: 'contact_blocked', familyId: contact.family_id, actorId: req.user.id, targetId: ctid, ip: req.ip, metadata: { name: contact.display_name } });
    });
    await afterPermissionChange(ctx, contact.family_id, contact.user_id ? [contact.user_id] : []);
    return { ok: true };
  });

  app.post('/contacts/:ctid/unblock', async (req) => {
    const { ctid } = parse(z.object({ ctid: z.uuid() }), req.params);
    const contact = await contactForAdmin(ctx, req.user.id, ctid, 'manage_contacts');
    await withTx(ctx.db, async (c) => {
      await c.query(`UPDATE blocks SET lifted_at = now(), lifted_by = $3 WHERE family_id = $1 AND phone_e164 = $2 AND lifted_at IS NULL`, [
        contact.family_id,
        contact.phone_e164,
        req.user.id,
      ]);
      // Unblocking does not restore access: the parent re-approves explicitly.
      await c.query(`UPDATE contact_approvals SET status = 'removed', updated_at = now() WHERE contact_id = $1 AND status = 'blocked'`, [ctid]);
      await logEvent(c, { kind: 'contact_unblocked', familyId: contact.family_id, actorId: req.user.id, targetId: ctid, ip: req.ip });
    });
    return { ok: true };
  });

  app.post('/contacts/:ctid/invitation', async (req) => {
    const { ctid } = parse(z.object({ ctid: z.uuid() }), req.params);
    const contact = await contactForAdmin(ctx, req.user.id, ctid, 'manage_contacts');
    if (contact.user_id) throw conflict('already_verified');
    if (await activeBlock(ctx.db, contact.family_id, contact.phone_e164)) throw conflict('contact_blocked');
    const inv = await ensureInvitation(ctx, ctx.db, contact, req.user.id);
    await sendInvitationSms(ctx, contact.phone_e164, inv.familyName, inv.link);
    await logEvent(ctx.db, { kind: 'contact_invite_created', familyId: contact.family_id, actorId: req.user.id, targetId: ctid, ip: req.ip });
    return { inviteLink: inv.link, inviteExpiresAt: inv.expiresAt };
  });

  // ---- Invitation acceptance (by the invited adult) ----------------------

  type InvitationRow = {
    id: string;
    family_id: string;
    kind: 'contact' | 'admin';
    contact_id: string | null;
    phone_e164: string;
    admin_perms: AdminPerms | null;
    family_name: string;
    inviter_name: string | null;
  };

  async function loadInvitation(token: string, userId: string, ip: string): Promise<InvitationRow> {
    ctx.limiter.consume(`invite:${userId}`, 20, 15 * 60_000);
    ctx.limiter.consume(`invite-ip:${ip}`, 60, 15 * 60_000);
    const inv = await one<InvitationRow>(
      ctx.db,
      `SELECT i.id, i.family_id, i.kind, i.contact_id, i.phone_e164, i.admin_perms, f.name AS family_name, u.display_name AS inviter_name
         FROM invitations i JOIN families f ON f.id = i.family_id JOIN users u ON u.id = i.created_by
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
      [sha256(token)],
    );
    if (!inv) throw notFound('invitation_invalid');
    const me = await one<{ phone_e164: string | null }>(ctx.db, `SELECT phone_e164 FROM users WHERE id = $1`, [userId]);
    // The invitation is bound to a phone number; a forwarded link is useless
    // to anyone who cannot sign in with that number.
    if (!me?.phone_e164 || me.phone_e164 !== inv.phone_e164) throw forbidden('invitation_phone_mismatch');
    if (inv.kind === 'contact' && (await activeBlock(ctx.db, inv.family_id, inv.phone_e164))) throw notFound('invitation_invalid');
    return inv;
  }

  const TokenBody = z.object({ token: z.string().min(20).max(100) });

  app.post('/invitations/preview', async (req) => {
    requireAdult(req);
    const { token } = parse(TokenBody, req.body);
    const inv = await loadInvitation(token, req.user.id, req.ip);
    const children =
      inv.kind === 'contact'
        ? await many<{ name: string }>(
            ctx.db,
            `SELECT u.display_name AS name FROM contact_approvals ca JOIN users u ON u.id = ca.child_user_id
              WHERE ca.contact_id = $1 AND ca.status = 'pending_verification' ORDER BY u.created_at`,
            [inv.contact_id],
          )
        : [];
    return { kind: inv.kind, familyName: inv.family_name, inviterName: inv.inviter_name, children: children.map((c) => c.name) };
  });

  app.post('/invitations/accept', async (req) => {
    requireAdult(req);
    const { token } = parse(TokenBody, req.body);
    const inv = await loadInvitation(token, req.user.id, req.ip);
    await withTx(ctx.db, async (c) => {
      const res = await c.query(`UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1 AND accepted_at IS NULL`, [
        inv.id,
        req.user.id,
      ]);
      if (res.rowCount !== 1) throw notFound('invitation_invalid');
      if (inv.kind === 'contact') {
        await c.query(`UPDATE contacts SET user_id = $2 WHERE id = $1`, [inv.contact_id, req.user.id]);
        await c.query(
          `UPDATE contact_approvals SET status = 'approved', updated_at = now() WHERE contact_id = $1 AND status = 'pending_verification'`,
          [inv.contact_id],
        );
        await logEvent(c, { kind: 'contact_verified', familyId: inv.family_id, actorId: req.user.id, targetId: inv.contact_id, ip: req.ip });
      } else {
        const p = inv.admin_perms ?? { canManageContacts: true, canApproveRequests: true, canChangeSettings: false };
        const isChildMember = await one(c, `SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2`, [inv.family_id, req.user.id]);
        if (isChildMember) throw conflict('already_admin');
        await c.query(
          `INSERT INTO family_memberships (family_id, user_id, role, can_manage_contacts, can_approve_requests, can_change_settings)
           VALUES ($1, $2, 'admin', $3, $4, $5)`,
          [inv.family_id, req.user.id, p.canManageContacts, p.canApproveRequests, p.canChangeSettings],
        );
        await logEvent(c, { kind: 'admin_joined', familyId: inv.family_id, actorId: req.user.id, ip: req.ip });
      }
    });
    const me = await one<{ display_name: string | null }>(ctx.db, `SELECT display_name FROM users WHERE id = $1`, [req.user.id]);
    await notify(
      ctx,
      await familyAdminIds(ctx.db, inv.family_id),
      inv.kind === 'contact' ? 'contact_verified' : 'admin_joined',
      { familyId: inv.family_id, name: me?.display_name ?? null },
      { title: 'קשרלי', body: `${me?.display_name ?? 'איש קשר'} הצטרף/ה לקשרלי` },
    );
    await afterPermissionChange(ctx, inv.family_id, [req.user.id]);
    return { ok: true, kind: inv.kind, familyId: inv.family_id };
  });
}
