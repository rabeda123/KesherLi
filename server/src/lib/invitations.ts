import type { Ctx } from '../context.js';
import type { Db } from '../db/pool.js';
import { one } from '../db/pool.js';
import { randomToken, sha256 } from './crypto.js';

const INVITE_TTL_DAYS = 7;

export type AdminPerms = { canManageContacts: boolean; canApproveRequests: boolean; canChangeSettings: boolean };

/**
 * Creates a single-use invitation link, replacing any open one for the same
 * person. Holding the link is not enough to use it: whoever accepts must be
 * signed in with the exact phone number the invitation was issued for.
 */
export async function createInvitation(
  ctx: Ctx,
  db: Db,
  inv: { familyId: string; kind: 'contact' | 'admin'; contactId?: string; phone: string; createdBy: string; adminPerms?: AdminPerms },
): Promise<{ id: string; link: string; expiresAt: Date }> {
  await db.query(
    `UPDATE invitations SET revoked_at = now()
      WHERE family_id = $1 AND kind = $2 AND phone_e164 = $3 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [inv.familyId, inv.kind, inv.phone],
  );
  const token = randomToken();
  const row = await one<{ id: string; expires_at: Date }>(
    db,
    `INSERT INTO invitations (family_id, kind, contact_id, phone_e164, token_hash, expires_at, created_by, admin_perms)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7, $8)
     RETURNING id, expires_at`,
    [
      inv.familyId,
      inv.kind,
      inv.contactId ?? null,
      inv.phone,
      sha256(token),
      INVITE_TTL_DAYS,
      inv.createdBy,
      inv.adminPerms ? JSON.stringify(inv.adminPerms) : null,
    ],
  );
  return { id: row!.id, link: `${ctx.config.publicAppUrl}/invite/${token}`, expiresAt: row!.expires_at };
}

export async function sendInvitationSms(ctx: Ctx, phone: string, familyName: string, link: string): Promise<void> {
  try {
    await ctx.sms.send(phone, `הוזמנת להצטרף לקשרלי על ידי משפחת ${familyName}. להצטרפות: ${link}`);
  } catch (err) {
    // The parent also gets the link to share directly, so a failed SMS is not fatal.
    ctx.log.error({ err }, 'failed to send invitation sms');
  }
}
