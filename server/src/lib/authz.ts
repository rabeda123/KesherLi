import type { Db } from '../db/pool.js';
import { many, one } from '../db/pool.js';
import { forbidden, notFound } from './errors.js';

/**
 * All authorization decisions live here. Routes call these helpers before
 * every read or write; nothing relies on the app hiding buttons.
 */

export type AdminPerm = 'manage_contacts' | 'approve_requests' | 'change_settings' | 'owner';

export type AdminMembership = {
  family_id: string;
  role: 'owner' | 'admin';
  can_manage_contacts: boolean;
  can_approve_requests: boolean;
  can_change_settings: boolean;
};

/**
 * Returns the caller's admin membership in the family, or throws 404 so that
 * non-members cannot tell whether the family exists.
 */
export async function requireFamilyAdmin(db: Db, userId: string, familyId: string, perm?: AdminPerm): Promise<AdminMembership> {
  const m = await one<AdminMembership>(
    db,
    `SELECT family_id, role, can_manage_contacts, can_approve_requests, can_change_settings
       FROM family_memberships
      WHERE family_id = $1 AND user_id = $2 AND role IN ('owner', 'admin')`,
    [familyId, userId],
  );
  if (!m) throw notFound('family_not_found');
  if (!perm || m.role === 'owner') return m;
  if (perm === 'owner') throw forbidden('owner_only');
  const allowed =
    (perm === 'manage_contacts' && m.can_manage_contacts) ||
    (perm === 'approve_requests' && m.can_approve_requests) ||
    (perm === 'change_settings' && m.can_change_settings);
  if (!allowed) throw forbidden('missing_permission', perm);
  return m;
}

export async function isFamilyAdmin(db: Db, userId: string, familyId: string): Promise<boolean> {
  const r = await one(
    db,
    `SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2 AND role IN ('owner','admin')`,
    [familyId, userId],
  );
  return !!r;
}

/** Ensures childId is a child of familyId (404 otherwise). */
export async function requireChildInFamily(db: Db, familyId: string, childId: string): Promise<void> {
  const r = await one(db, `SELECT 1 FROM child_profiles WHERE user_id = $1 AND family_id = $2`, [childId, familyId]);
  if (!r) throw notFound('child_not_found');
}

export async function childFamilyId(db: Db, childId: string): Promise<string | undefined> {
  const r = await one<{ family_id: string }>(db, `SELECT family_id FROM child_profiles WHERE user_id = $1`, [childId]);
  return r?.family_id;
}

export type Capability = 'message' | 'media' | 'voice' | 'call';
const CAPABILITY_COLUMN: Record<Capability, string> = {
  message: 'can_message',
  media: 'can_send_media',
  voice: 'can_voice',
  call: 'can_call',
};

type PartyRow = { id: string; kind: 'adult' | 'child'; deleted_at: Date | null; child_family: string | null };

/**
 * Whether users a and b may communicate (in either direction):
 *  - two children: only siblings in the same family;
 *  - a child and an adult: the adult is an admin of the child's family, or
 *    an approved, verified, unblocked contact of that specific child with the
 *    requested capability;
 *  - two adults: both administer the same family (co-parents).
 */
export async function canCommunicate(db: Db, a: string, b: string, cap: Capability = 'message'): Promise<boolean> {
  if (a === b) return false;
  const parties = await many<PartyRow>(
    db,
    `SELECT u.id, u.kind, u.deleted_at, cp.family_id AS child_family
       FROM users u LEFT JOIN child_profiles cp ON cp.user_id = u.id
      WHERE u.id = ANY($1::uuid[])`,
    [[a, b]],
  );
  if (parties.length !== 2 || parties.some((p) => p.deleted_at)) return false;
  const [p, q] = parties as [PartyRow, PartyRow];

  if (p.kind === 'child' && q.kind === 'child') {
    return !!p.child_family && p.child_family === q.child_family;
  }
  if (p.kind === 'adult' && q.kind === 'adult') {
    const r = await one(
      db,
      `SELECT 1 FROM family_memberships m1
         JOIN family_memberships m2 ON m2.family_id = m1.family_id
        WHERE m1.user_id = $1 AND m2.user_id = $2
          AND m1.role IN ('owner','admin') AND m2.role IN ('owner','admin')
        LIMIT 1`,
      [p.id, q.id],
    );
    return !!r;
  }

  const child = p.kind === 'child' ? p : q;
  const adult = p.kind === 'child' ? q : p;
  if (!child.child_family) return false;
  if (await isFamilyAdmin(db, adult.id, child.child_family)) return true;

  const col = CAPABILITY_COLUMN[cap];
  const r = await one(
    db,
    `SELECT 1
       FROM contact_approvals ca
       JOIN contacts ct ON ct.id = ca.contact_id
      WHERE ct.family_id = $1 AND ct.user_id = $2 AND ca.child_user_id = $3
        AND ca.status = 'approved' AND ca.${col}
        AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE b.family_id = ct.family_id AND b.phone_e164 = ct.phone_e164
                           AND b.lifted_at IS NULL)`,
    [child.child_family, adult.id, child.id],
  );
  return !!r;
}

export type ConversationRow = {
  id: string;
  family_id: string;
  kind: 'direct' | 'group';
  title: string | null;
  created_by: string;
  created_at: Date;
  last_message_at: Date | null;
};

/**
 * Loads a conversation the caller is an active member of. A conversation the
 * caller is not in is reported as not found, whatever its id. For direct
 * conversations an adult outside the family must also still be permitted, so
 * a revoked contact loses access even before reconciliation runs.
 */
export async function requireConversationAccess(db: Db, userId: string, conversationId: string): Promise<ConversationRow> {
  const conv = await one<ConversationRow & { kind_user: string }>(
    db,
    `SELECT c.*, u.kind AS kind_user
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2 AND cm.left_at IS NULL
       JOIN users u ON u.id = $2
      WHERE c.id = $1`,
    [conversationId, userId],
  );
  if (!conv) throw notFound('conversation_not_found');
  if (conv.kind === 'direct' && conv.kind_user === 'adult' && !(await isFamilyAdmin(db, userId, conv.family_id))) {
    const other = await one<{ user_id: string }>(
      db,
      `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2`,
      [conversationId, userId],
    );
    if (!other || !(await canCommunicate(db, userId, other.user_id))) throw notFound('conversation_not_found');
  }
  return conv;
}

/** Re-checked on every send, so a permission revoked mid-session takes effect immediately. */
export async function canSendInConversation(db: Db, userId: string, conv: ConversationRow, cap: Capability = 'message'): Promise<boolean> {
  const members = await many<{ user_id: string; kind: string; left_at: Date | null }>(
    db,
    `SELECT cm.user_id, u.kind, cm.left_at FROM conversation_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id = $1 AND cm.user_id <> $2`,
    [conv.id, userId],
  );
  const me = await one<{ kind: string }>(db, `SELECT kind FROM users WHERE id = $1`, [userId]);
  if (!me) return false;

  if (conv.kind === 'direct') {
    const other = members[0];
    if (!other || other.left_at) return false;
    return canCommunicate(db, userId, other.user_id, cap);
  }
  for (const m of members) {
    if (m.left_at) continue;
    if (me.kind === 'child' || m.kind === 'child') {
      if (!(await canCommunicate(db, userId, m.user_id, cap))) return false;
    }
  }
  return true;
}

/** Whether `candidate` may be in a group of the family together with `memberIds`. */
export async function canJoinGroup(db: Db, familyId: string, candidate: string, memberIds: string[]): Promise<boolean> {
  const u = await one<{ kind: string; deleted_at: Date | null; child_family: string | null }>(
    db,
    `SELECT u.kind, u.deleted_at, cp.family_id AS child_family FROM users u
       LEFT JOIN child_profiles cp ON cp.user_id = u.id WHERE u.id = $1`,
    [candidate],
  );
  if (!u || u.deleted_at) return false;
  if (u.kind === 'child' && u.child_family !== familyId) return false;
  if (u.kind === 'adult') {
    // Adults in a family group are admins of the family or verified contacts of it.
    const linked = await one(
      db,
      `SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2 AND role IN ('owner','admin')
       UNION ALL
       SELECT 1 FROM contacts WHERE family_id = $1 AND user_id = $2`,
      [familyId, candidate],
    );
    if (!linked) return false;
  }
  const others = await many<{ id: string; kind: string }>(db, `SELECT id, kind FROM users WHERE id = ANY($1::uuid[])`, [
    memberIds.filter((id) => id !== candidate),
  ]);
  for (const o of others) {
    if (u.kind === 'child' || o.kind === 'child') {
      if (!(await canCommunicate(db, candidate, o.id))) return false;
    }
  }
  return true;
}

/**
 * After any permission change in a family, removes members who are no longer
 * allowed to be in the family's conversations. Returns the removals so the
 * caller can notify the affected users in real time.
 */
export async function reconcileFamilyConversations(db: Db, familyId: string): Promise<Array<{ conversationId: string; userId: string }>> {
  const rows = await many<{ conversation_id: string; kind: string; user_id: string; user_kind: string }>(
    db,
    `SELECT c.id AS conversation_id, c.kind, cm.user_id, u.kind AS user_kind
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.left_at IS NULL
       JOIN users u ON u.id = cm.user_id
      WHERE c.family_id = $1`,
    [familyId],
  );
  const byConv = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byConv.get(r.conversation_id) ?? [];
    list.push(r);
    byConv.set(r.conversation_id, list);
  }
  const removed: Array<{ conversationId: string; userId: string }> = [];
  for (const [conversationId, members] of byConv) {
    const isDirect = members[0]!.kind === 'direct';
    for (const m of members) {
      // Children keep their own history; it is the adult who lost
      // permission that leaves the conversation.
      if (m.user_kind === 'child' || (await isFamilyAdmin(db, m.user_id, familyId))) continue;
      const mustReach = members.filter((o) => o.user_id !== m.user_id && (isDirect || o.user_kind === 'child'));
      let ok = true;
      for (const o of mustReach) {
        if (!(await canCommunicate(db, m.user_id, o.user_id))) {
          ok = false;
          break;
        }
      }
      if (!ok) {
        await db.query(
          `UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [conversationId, m.user_id],
        );
        removed.push({ conversationId, userId: m.user_id });
      }
    }
  }
  return removed;
}
