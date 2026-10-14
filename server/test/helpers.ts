import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Ctx } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import type { SmsSender } from '../src/lib/sms.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/kesharli_test';

/** Captures outgoing SMS so tests can read codes and invitation links like a real recipient would. */
export class CapturedSms implements SmsSender {
  readonly name = 'captured';
  sent: Array<{ to: string; text: string }> = [];
  async send(to: string, text: string) {
    this.sent.push({ to, text });
  }
  lastTo(to: string): string {
    const m = [...this.sent].reverse().find((s) => s.to === to);
    if (!m) throw new Error(`no sms to ${to}`);
    return m.text;
  }
}

let ipSeq = 1;

export type Res = { status: number; body: any };

export class TestEnv {
  constructor(
    public app: FastifyInstance,
    public ctx: Ctx,
    public pool: pg.Pool,
    public sms: CapturedSms,
  ) {}

  async call(method: string, url: string, token?: string, payload?: unknown): Promise<Res> {
    const res = await this.app.inject({
      method: method as any,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      // Each request comes from its own address so per-IP limits model many
      // real users rather than one test runner.
      remoteAddress: `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`,
      ...(payload !== undefined ? { payload: payload as any } : {}),
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  async otp(phone: string): Promise<{ challengeId: string; code: string }> {
    const r = await this.call('POST', '/auth/otp/request', undefined, { phone });
    if (r.status !== 200) throw new Error(`otp request failed: ${JSON.stringify(r.body)}`);
    const code = /(\d{6})/.exec(this.sms.lastTo(phone))![1]!;
    return { challengeId: r.body.challengeId, code };
  }

  /** Signs in (or registers) an adult through the real OTP flow. */
  async adult(phone: string, name: string): Promise<{ token: string; id: string; phone: string }> {
    const { challengeId, code } = await this.otp(phone);
    const r = await this.call('POST', '/auth/otp/verify', undefined, { challengeId, code, device: { name: 'test', platform: 'test' } });
    if (r.status !== 200) throw new Error(`otp verify failed: ${JSON.stringify(r.body)}`);
    const token = r.body.token as string;
    if (r.body.needsProfile) await this.call('PATCH', '/me', token, { displayName: name });
    const me = await this.call('GET', '/me', token);
    return { token, id: me.body.user.id, phone };
  }

  /** A parent with a family and the given children, each child signed in on a device. */
  async family(phone: string, name: string, children: string[]) {
    const parent = await this.adult(phone, name);
    const f = await this.call('POST', '/families', parent.token, {
      name: `משפחת ${name}`,
      acceptTerms: true,
      parentalConsent: true,
      termsVersion: '2026-10',
    });
    if (f.status !== 200) throw new Error(`family failed: ${JSON.stringify(f.body)}`);
    const familyId = f.body.id as string;
    const kids: Array<{ id: string; token: string; name: string }> = [];
    for (const childName of children) {
      const c = await this.call('POST', `/families/${familyId}/children`, parent.token, { displayName: childName });
      kids.push({ id: c.body.id, token: await this.pairChild(parent.token, familyId, c.body.id), name: childName });
    }
    return { parent, familyId, kids };
  }

  async pairChild(parentToken: string, familyId: string, childId: string): Promise<string> {
    const code = await this.call('POST', `/families/${familyId}/children/${childId}/pairing-code`, parentToken);
    const r = await this.call('POST', '/auth/pair', undefined, { code: code.body.code, device: { name: 'טאבלט', platform: 'test' } });
    if (r.status !== 200) throw new Error(`pair failed: ${JSON.stringify(r.body)}`);
    return r.body.token;
  }

  /** Parent adds a contact; the contact signs in with their phone and accepts the invitation. */
  async verifiedContact(parentToken: string, familyId: string, childIds: string[], phone: string, name: string) {
    const add = await this.call('POST', `/families/${familyId}/contacts`, parentToken, {
      displayName: name,
      phone,
      children: childIds.map((childId) => ({ childId, canMessage: true })),
    });
    if (add.status !== 200) throw new Error(`add contact failed: ${JSON.stringify(add.body)}`);
    const contact = await this.adult(phone, name);
    if (add.body.inviteLink) {
      const accept = await this.call('POST', '/invitations/accept', contact.token, { token: inviteToken(add.body.inviteLink) });
      if (accept.status !== 200) throw new Error(`accept failed: ${JSON.stringify(accept.body)}`);
    }
    return { ...contact, contactId: add.body.contactId as string };
  }

  async dm(token: string, userId: string): Promise<string> {
    const r = await this.call('POST', '/conversations/direct', token, { userId });
    if (r.status !== 200) throw new Error(`dm failed: ${JSON.stringify(r.body)}`);
    return r.body.id;
  }

  send(token: string, conversationId: string, body: string, clientId = crypto.randomUUID()) {
    return this.call('POST', `/conversations/${conversationId}/messages`, token, { clientId, body });
  }

  async close() {
    await this.app.close();
    await this.pool.end();
  }
}

export const inviteToken = (link: string) => link.split('/invite/')[1]!;

let phoneSeq = 0;
/** A fresh Israeli mobile number, so per-phone rate limits never interfere between tests. */
export const newPhone = () => `+97250${String(1_000_000 + phoneSeq++).slice(-7)}`;

export async function setupEnv(): Promise<TestEnv> {
  const admin = new pg.Client({ connectionString: TEST_DB });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  await migrate(TEST_DB, () => {});
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB,
    APP_SECRET: 'test-secret-test-secret-test-secret-123',
    GLOBAL_RATE_LIMIT_PER_MIN: '0',
  });
  const pool = new pg.Pool({ connectionString: TEST_DB });
  const sms = new CapturedSms();
  const { app, ctx } = await buildApp(config, pool, { sms, logger: false });
  await app.ready();
  return new TestEnv(app, ctx, pool, sms);
}

/** Opens an authenticated WebSocket and collects the events it receives. */
export async function openSocket(env: TestEnv, token: string): Promise<{ events: any[]; ws: WebSocket; closed: Promise<number> }> {
  if (!env.app.server.listening) await env.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = env.app.server.address() as { port: number };
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  const events: any[] = [];
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (data) => {
      const e = JSON.parse(String(data));
      if (e.type === 'ready') resolve();
      else events.push(e);
    });
    ws.on('error', reject);
  });
  return { events, ws, closed };
}

export async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}
