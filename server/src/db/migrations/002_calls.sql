-- Voice and video calls over the internet (WebRTC). The server records each
-- call and relays connection setup between the two devices; audio and video
-- flow directly between them (or through a TURN relay when configured).
CREATE TABLE calls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  family_id           uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  caller_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  callee_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  caller_device_id    uuid REFERENCES devices(id) ON DELETE SET NULL,
  -- The callee device that answered; signaling for the callee goes only there.
  callee_device_id    uuid REFERENCES devices(id) ON DELETE SET NULL,
  kind                text NOT NULL CHECK (kind IN ('audio', 'video')),
  status              text NOT NULL CHECK (status IN ('ringing', 'accepted', 'declined', 'missed', 'cancelled', 'ended', 'busy')),
  end_reason          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  answered_at         timestamptz,
  ended_at            timestamptz
);
CREATE INDEX calls_active ON calls (status) WHERE status IN ('ringing', 'accepted');
CREATE INDEX calls_conversation ON calls (conversation_id, created_at DESC);
CREATE INDEX calls_family ON calls (family_id, created_at DESC);
