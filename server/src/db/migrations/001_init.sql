-- Kesharli initial schema.
-- Every row that belongs to a family carries family_id so that queries can be
-- scoped and audited per family. Authorization is enforced in the API layer
-- (src/lib/authz.ts); the database adds integrity constraints on top.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('adult', 'child')),
  display_name  text CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 60),
  -- Adults sign in with a verified phone number. Children have no phone:
  -- they sign in with a one-time pairing code issued by a parent.
  phone_e164    text UNIQUE,
  avatar_color  text NOT NULL DEFAULT '#4A90E2',
  is_demo       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT adult_has_phone CHECK (kind = 'child' OR phone_e164 IS NOT NULL OR deleted_at IS NOT NULL),
  CONSTRAINT child_has_no_phone CHECK (kind = 'adult' OR phone_e164 IS NULL)
);

CREATE TABLE families (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  created_by  uuid NOT NULL REFERENCES users(id),
  is_demo     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE family_memberships (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id             uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                  text NOT NULL CHECK (role IN ('owner', 'admin', 'child')),
  can_manage_contacts   boolean NOT NULL DEFAULT true,
  can_approve_requests  boolean NOT NULL DEFAULT true,
  can_change_settings   boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, user_id)
);
-- A child belongs to exactly one family; a family has exactly one owner.
CREATE UNIQUE INDEX one_family_per_child ON family_memberships (user_id) WHERE role = 'child';
CREATE UNIQUE INDEX one_owner_per_family ON family_memberships (family_id) WHERE role = 'owner';
CREATE INDEX family_memberships_user ON family_memberships (user_id);

CREATE TABLE child_profiles (
  user_id                 uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  family_id               uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  birth_year              int CHECK (birth_year IS NULL OR birth_year BETWEEN 2000 AND 2100),
  allow_contact_requests  boolean NOT NULL DEFAULT true,
  allow_profile_edit      boolean NOT NULL DEFAULT false,
  read_receipts           boolean NOT NULL DEFAULT true,
  -- Quiet hours, minutes from midnight in the family's local time zone.
  quiet_start_min         int CHECK (quiet_start_min BETWEEN 0 AND 1439),
  quiet_end_min           int CHECK (quiet_end_min BETWEEN 0 AND 1439),
  time_zone               text NOT NULL DEFAULT 'Asia/Jerusalem',
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX child_profiles_family ON child_profiles (family_id);

-- A device is a signed-in session. Revoking it invalidates the token at once.
CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL DEFAULT 'מכשיר',
  platform      text NOT NULL DEFAULT 'unknown',
  token_hash    bytea NOT NULL UNIQUE,
  push_token    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX devices_user ON devices (user_id) WHERE revoked_at IS NULL;

CREATE TABLE otp_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164   text NOT NULL,
  code_hash    bytea NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenges_phone ON otp_challenges (phone_e164, created_at DESC);

CREATE TABLE pairing_codes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash      bytea NOT NULL UNIQUE,
  created_by     uuid NOT NULL REFERENCES users(id),
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- A contact is a person (identified by phone) that a family knows about.
-- user_id is filled only after that person proved ownership of the phone
-- and accepted the family's invitation.
CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  display_name  text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  phone_e164    text NOT NULL,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, phone_e164)
);
CREATE INDEX contacts_user ON contacts (user_id);

-- Per-child permission for a contact. Approval for one child never implies
-- approval for a sibling: each child has its own row.
CREATE TABLE contact_approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id       uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  child_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status           text NOT NULL CHECK (status IN (
                     'pending_verification', 'pending_parent_approval',
                     'approved', 'rejected', 'blocked', 'removed')),
  can_message      boolean NOT NULL DEFAULT true,
  can_send_media   boolean NOT NULL DEFAULT false,
  can_voice        boolean NOT NULL DEFAULT false,
  can_call         boolean NOT NULL DEFAULT false,
  request_note     text CHECK (request_note IS NULL OR char_length(request_note) <= 200),
  requested_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, child_user_id)
);
CREATE INDEX contact_approvals_child ON contact_approvals (child_user_id, status);

CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('contact', 'admin')),
  contact_id   uuid REFERENCES contacts(id) ON DELETE CASCADE,
  phone_e164   text NOT NULL,
  -- For admin invitations: the permissions the new co-parent will receive.
  admin_perms  jsonb,
  token_hash   bytea NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   timestamptz,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_invite_has_contact CHECK (kind <> 'contact' OR contact_id IS NOT NULL)
);
CREATE INDEX invitations_family ON invitations (family_id);

-- Blocks are recorded per family and phone so that a blocked person cannot be
-- re-added (by a child request, for example) until a parent lifts the block.
CREATE TABLE blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  phone_e164  text NOT NULL,
  reason      text CHECK (reason IS NULL OR char_length(reason) <= 200),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  lifted_at   timestamptz,
  lifted_by   uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX one_active_block ON blocks (family_id, phone_e164) WHERE lifted_at IS NULL;

CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id        uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('direct', 'group')),
  title            text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 60),
  -- For direct conversations: the two member ids sorted, so a pair has one conversation.
  direct_key       text UNIQUE,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_message_at  timestamptz,
  CONSTRAINT direct_has_key CHECK ((kind = 'direct') = (direct_key IS NOT NULL))
);
CREATE INDEX conversations_family ON conversations (family_id);

-- Delivery/read state is kept as per-member watermarks (last_delivered_at,
-- last_read_at); this replaces a per-message receipts table and is enough
-- for "sent / delivered / read" ticks and unread counters.
CREATE TABLE conversation_members (
  conversation_id    uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at          timestamptz NOT NULL DEFAULT now(),
  left_at            timestamptz,
  last_delivered_at  timestamptz,
  last_read_at       timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user ON conversation_members (user_id) WHERE left_at IS NULL;

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Idempotency key generated on the device, so retries after a lost
  -- connection never create duplicates.
  client_id        uuid NOT NULL,
  kind             text NOT NULL DEFAULT 'text' CHECK (kind IN ('text')),
  body             text CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 4000),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at       timestamptz,
  UNIQUE (sender_id, client_id)
);
CREATE INDEX messages_conversation_time ON messages (conversation_id, created_at DESC);

CREATE TABLE reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id        uuid REFERENCES families(id) ON DELETE CASCADE,
  reporter_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id       uuid REFERENCES messages(id) ON DELETE SET NULL,
  reason           text NOT NULL CHECK (reason IN ('bullying', 'inappropriate', 'stranger', 'spam', 'help', 'other')),
  details          text CHECK (details IS NULL OR char_length(details) <= 1000),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  resolved_by      uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX reports_family ON reports (family_id, status);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);

CREATE TABLE security_events (
  id          bigserial PRIMARY KEY,
  family_id   uuid REFERENCES families(id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  kind        text NOT NULL,
  target_id   uuid,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_family ON security_events (family_id, created_at DESC);
CREATE INDEX security_events_actor ON security_events (actor_id, created_at DESC);

CREATE TABLE consent_records (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid REFERENCES families(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('terms', 'privacy', 'parental_consent')),
  version     text NOT NULL,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE retention_policies (
  family_id               uuid PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE,
  -- NULL keeps messages until a member deletes them or the family is deleted.
  message_retention_days  int CHECK (message_retention_days IS NULL OR message_retention_days BETWEEN 7 AND 3650),
  updated_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
