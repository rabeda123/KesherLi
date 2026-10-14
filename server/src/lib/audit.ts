import type { Db } from '../db/pool.js';

/** Security and administrative events. Shown to parents as the family's activity log. */
export type SecurityEventKind =
  | 'login'
  | 'logout'
  | 'otp_locked'
  | 'device_paired'
  | 'device_revoked'
  | 'family_created'
  | 'family_updated'
  | 'family_deleted'
  | 'child_added'
  | 'child_updated'
  | 'child_removed'
  | 'child_settings_changed'
  | 'pairing_code_created'
  | 'contact_added'
  | 'contact_invite_created'
  | 'contact_verified'
  | 'contact_requested'
  | 'contact_approved'
  | 'contact_rejected'
  | 'contact_permissions_changed'
  | 'contact_removed'
  | 'contact_blocked'
  | 'contact_unblocked'
  | 'admin_invited'
  | 'admin_joined'
  | 'admin_updated'
  | 'admin_removed'
  | 'ownership_transferred'
  | 'group_created'
  | 'group_member_added'
  | 'group_member_removed'
  | 'report_created'
  | 'report_resolved'
  | 'retention_changed'
  | 'account_deleted';

export async function logEvent(
  db: Db,
  e: {
    kind: SecurityEventKind;
    actorId?: string | null;
    familyId?: string | null;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
    ip?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO security_events (family_id, actor_id, kind, target_id, metadata, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.familyId ?? null, e.actorId ?? null, e.kind, e.targetId ?? null, JSON.stringify(e.metadata ?? {}), e.ip ?? null],
  );
}
