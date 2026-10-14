# Architecture and security model

## Overview

```
 Expo app (iOS / Android / Web) ──HTTPS REST──▶ Fastify API ──▶ PostgreSQL
            ▲                                        │
            └──────────── WebSocket (events) ◀───────┘
```

- **REST is the only way to read or change data.** Every route checks authorization in `server/src/lib/authz.ts` before touching the database.
- **The WebSocket only carries hints** ("a message arrived", "your contacts changed", "this conversation was removed", "your session was revoked"). The app reacts by re-fetching through REST, so a lost or spoofed event can never grant access.
- The app never hides data for security; hiding a button is UX only. Tests call the API directly to prove the server refuses.

## Identity

| Who | Signs in with | Notes |
|---|---|---|
| Adult (parent, co-parent, contact) | Phone + 6-digit SMS code | Codes are HMAC-hashed, expire in 5 min, 5 attempts, single use; 3 per number per 10 min, 10 per day, plus per-IP limits. Same response for known and unknown numbers. |
| Child | 8-character pairing code created by a parent | 15 min, single use, HMAC-hashed, per-IP limited. Children have no phone or password, so they cannot open an independent account or "recover" one without a parent. |

A successful sign-in creates a **device** row with a random 256-bit bearer token; only its SHA-256 is stored. Revoking a device (by its owner, or by a parent for a child's device) invalidates the token on the next request and closes its WebSocket immediately (`session.revoked`, close code 4001).

Sensitive actions — transferring ownership, deleting the family, removing a child, deleting an account — require a **step-up**: a fresh SMS code to the signed-in adult's own phone.

## Communication rules (`canCommunicate`)

Two users may talk only if one of these holds:

1. **Child ↔ adult**: the adult is an owner/admin of the child's family, **or** there is a `contact_approvals` row for *that specific child* with status `approved` and the needed capability (`can_message`, …), the contact has verified their phone by accepting the invitation, and the number is not blocked in the family.
2. **Child ↔ child**: siblings in the same family.
3. **Adult ↔ adult**: both administer the same family (co-parents).

There is no user search endpoint. The only directory is `GET /me/reachable`, computed from the same rules. Asking to open a conversation with someone you may not reach returns the same 404 as a non-existent id.

### Checked on every send

`POST /conversations/:id/messages` re-evaluates the rules for every message. If a parent blocks a contact while the contact is online, the very next send fails. Group conversations require every adult in the group to be allowed with every child in it.

### Reconciliation

After any change that can reduce access (removal, block, permission change, co-parent removal, account deletion), `afterPermissionChange` removes members who are no longer allowed from the family's conversations and notifies affected users in real time. Children keep their own history read-only; the adult who lost permission loses access to the conversation entirely.

### Contact lifecycle

```
parent adds contact ──▶ pending_verification ──(contact signs in with that phone + accepts invite)──▶ approved
child requests ──▶ pending_parent_approval ──approve──▶ pending_verification / approved (if already verified)
                                           └─reject──▶ rejected
any ──block──▶ blocked  (number blocked family-wide; cannot be re-requested or re-added until unblocked)
approved ──remove──▶ removed
```

Invitations are 256-bit single-use tokens, valid for 7 days, stored hashed, and **bound to the phone number**. A forwarded link is useless to anyone who cannot sign in with that number.

### Parents and privacy

Parents do **not** read their children's messages. The dashboard shows who the child talked with and when, never the content. Children can report a message or ask for help, which sends that report (including the reported message) to their parents. There is no location tracking and no covert monitoring.

## Data model

`server/src/db/migrations/001_init.sql` is the source of truth.

| Spec entity | Table | Notes |
|---|---|---|
| Users | `users` | `kind` adult/child; adults require a phone, children cannot have one |
| Families | `families` | |
| FamilyMemberships | `family_memberships` | roles owner/admin/child + per-admin permission flags; one owner per family; one family per child |
| ChildProfiles | `child_profiles` | request/profile/read-receipt settings, quiet hours |
| Devices | `devices` | sessions; hashed token, push token, revocation |
| Contacts | `contacts` | per family and phone; `user_id` set only after verification |
| ContactApprovals | `contact_approvals` | per child; status + capabilities |
| Invitations | `invitations` | contact and co-parent invitations |
| Conversations / ConversationMembers | `conversations`, `conversation_members` | direct conversations have a unique pair key |
| Messages | `messages` | `(sender_id, client_id)` unique for idempotent retries |
| MessageReceipts | `conversation_members.last_delivered_at / last_read_at` | per-member watermarks instead of per-message rows |
| Blocks | `blocks` | one active block per family + phone |
| Reports | `reports` | |
| Notifications | `notifications` | |
| SecurityEvents | `security_events` | the family activity log |
| ConsentRecords | `consent_records` | terms, privacy, parental consent with version |
| RetentionPolicies | `retention_policies` | hourly job deletes older messages |
| Calls | `calls` | caller/callee and their devices, kind, status, timestamps (migration 002) |
| MediaFiles | — | not created yet; planned for phase 2 (see ROADMAP) |
| (auth support) | `otp_challenges`, `pairing_codes` | |

## Calls (voice and video over the internet)

Calls use WebRTC: audio and video travel directly between the two devices over the internet (Wi-Fi or mobile data), encrypted by WebRTC's mandatory DTLS-SRTP. The server never carries media; it decides whether a call may happen and relays connection setup.

- `POST /calls` requires a direct conversation and `canCommunicate(…, 'call')` — for a contact, the parent's per-child `can_call` permission. Quiet hours block calls to a child except from the child's parents. One active call per person (`busy`).
- The callee's devices ring (`call.incoming`); the first device to answer becomes the call's device and the others stop ringing. Unanswered calls become `missed` after 45 s.
- Offer/answer/ICE messages go through `POST /calls/:id/signal`, accepted only from the two devices in the call and relayed only to the other one.
- Revoking `can_call`, removing or blocking the contact, disconnecting a device, or deleting the child or family **ends the active call immediately** on both sides (`call.updated`, `endReason: revoked | device_revoked`).
- `GET /calls/ice-servers` / the call responses return STUN and, when configured, TURN servers. With a coturn shared secret the server issues credentials valid for 6 hours per user.
- Group calls are not supported.

On the web the browser provides WebRTC; on phones `react-native-webrtc` (with its Expo config plugin) does, which requires a development/production build rather than Expo Go.

## Encryption

Messages are protected in transit by TLS (terminate HTTPS in front of the API) and at rest by the database/disk encryption of your hosting provider. **The app is not end-to-end encrypted** and must not be described as such. E2EE would conflict with parts of the product as designed (children reporting messages to parents, multi-device sync, account recovery by a parent) and needs a dedicated design — see ROADMAP.

## Real-time scaling

`RealtimeHub` and `RateLimiter` are in-process. For more than one API instance, move event fan-out to Postgres `LISTEN/NOTIFY` or Redis pub/sub and rate-limit counters to Redis. Both are behind small interfaces in `server/src/lib/`.
