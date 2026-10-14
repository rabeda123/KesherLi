# Deployment

## What you need

| Item | Why | Where it goes |
|---|---|---|
| PostgreSQL 16 (managed: Neon, Supabase, RDS, Cloud SQL…) | data | `DATABASE_URL` |
| A host for a Node.js 22 container (Fly.io, Render, Railway, Cloud Run, ECS…) | API + WebSocket | `server/Dockerfile` |
| A domain with HTTPS | TLS for API and invite links | load balancer / platform |
| **SMS provider account** (Twilio is implemented) | sign-in codes and invitations | `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |
| A random secret, 32+ chars | HMAC for one-time codes | `APP_SECRET` (`openssl rand -base64 48`) |
| Expo / EAS account + Apple Developer + Google Play accounts | building and publishing the apps | `eas.json`, store consoles |
| Push credentials (APNs key, FCM) configured in EAS | push notifications | `PUSH_PROVIDER=expo`, optional `EXPO_ACCESS_TOKEN` |
| **TURN relay** (recommended: self-hosted coturn, or Twilio / Metered / Cloudflare TURN) | calls on networks that block direct connections | `TURN_URLS` + `TURN_SECRET`, or `TURN_USERNAME`/`TURN_CREDENTIAL` |

Without an SMS provider the server **refuses to start in production** — there is no silent fallback.

## Environments

Use three separate databases and secrets: development (local, `SMS_PROVIDER=console`, `DEV_EXPOSE_OTP=true` allowed), staging and production (`NODE_ENV=production`). Never copy production data to other environments. Demo data (`npm run seed`) refuses to run in production.

## API server

```bash
cd server
docker build -t kesharli-api .
docker run -p 4000:4000 \
  -e NODE_ENV=production \
  -e DATABASE_URL=postgres://… \
  -e APP_SECRET=… \
  -e CORS_ORIGINS=https://app.example.com \
  -e PUBLIC_APP_URL=https://app.example.com \
  -e SMS_PROVIDER=twilio -e TWILIO_ACCOUNT_SID=… -e TWILIO_AUTH_TOKEN=… -e TWILIO_FROM=… \
  -e TRUST_PROXY=true \
  kesharli-api
```

- Migrations run automatically at start (serialized with an advisory lock).
- Health check: `GET /health`.
- The WebSocket lives at `/ws` on the same port; the load balancer must allow WebSocket upgrades and idle connections ≥ 60 s.
- Set `TRUST_PROXY=true` behind a proxy so per-IP rate limits see real client addresses.
- Run **one instance** until real-time fan-out moves to Redis or LISTEN/NOTIFY (see ARCHITECTURE).
- Back up the database daily with point-in-time recovery.

## Web app

```bash
cd app
EXPO_PUBLIC_API_URL=https://api.example.com npx expo export --platform web
```

Serve `app/dist` from any static host with a fallback of all paths to `index.html` (invite links are `/invite/<token>`). Note: on the web the session token is kept in `localStorage`; for a production web client prefer an httpOnly cookie (see ROADMAP).

## Mobile apps

```bash
cd app
npx eas-cli@latest init          # creates the EAS project id
npx eas-cli@latest build --platform all
npx eas-cli@latest submit
```

Set `EXPO_PUBLIC_API_URL` for each build profile in `eas.json` (created by `eas build:configure`). For invite links to open the app directly, configure iOS Associated Domains and Android App Links for your `PUBLIC_APP_URL` domain; until then the `kesharli://` scheme and the "I got an invite link" field on the welcome screen work.
