/**
 * Demo data for local development. Every user and family it creates is
 * flagged is_demo, uses numbers in the +972-50-000-00xx range, and the
 * script refuses to run in production.
 */
import { loadConfig } from '../config.js';
import { hmac, pairingCode } from '../lib/crypto.js';
import { migrate } from './migrate.js';
import { createPool, one, withTx } from './pool.js';

const config = loadConfig();
if (config.env === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}
await migrate(config.databaseUrl);
const pool = createPool(config.databaseUrl);

const PARENT = '+972500000001';
const COPARENT = '+972500000002';
const GRANDMA = '+972500000010';
const UNCLE = '+972500000011';
const COACH = '+972500000012';

const existing = await one(pool, `SELECT 1 FROM users WHERE phone_e164 = $1`, [PARENT]);
if (existing) {
  console.log('Demo data already present. To reset: npm run seed -- --reset');
  if (!process.argv.includes('--reset')) {
    await printCodes();
    await pool.end();
    process.exit(0);
  }
  await pool.query(`DELETE FROM users WHERE id IN (SELECT user_id FROM child_profiles cp JOIN families f ON f.id = cp.family_id WHERE f.is_demo)`);
  await pool.query(`DELETE FROM families WHERE is_demo`);
  await pool.query(`DELETE FROM users WHERE is_demo`);
}

await withTx(pool, async (c) => {
  const adult = async (phone: string, name: string, color: string) =>
    (await one<{ id: string }>(c, `INSERT INTO users (kind, phone_e164, display_name, avatar_color, is_demo) VALUES ('adult', $1, $2, $3, true) RETURNING id`, [
      phone,
      name,
      color,
    ]))!.id;
  const parent = await adult(PARENT, 'מיכל', '#2EC4B6');
  const coparent = await adult(COPARENT, 'יואב', '#4A90E2');
  const grandma = await adult(GRANDMA, 'רחל', '#FF9F68');
  const uncle = await adult(UNCLE, 'דני', '#9B7BEA');

  const fam = (await one<{ id: string }>(c, `INSERT INTO families (name, created_by, is_demo) VALUES ('משפחת כהן (הדגמה)', $1, true) RETURNING id`, [parent]))!.id;
  await c.query(`INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')`, [fam, parent]);
  await c.query(`INSERT INTO family_memberships (family_id, user_id, role, can_change_settings) VALUES ($1, $2, 'admin', false)`, [fam, coparent]);
  await c.query(`INSERT INTO retention_policies (family_id) VALUES ($1)`, [fam]);
  for (const kind of ['terms', 'privacy', 'parental_consent']) {
    await c.query(`INSERT INTO consent_records (user_id, family_id, kind, version) VALUES ($1, $2, $3, 'demo')`, [parent, fam, kind]);
  }

  const child = async (name: string, color: string, year: number) => {
    const id = (await one<{ id: string }>(c, `INSERT INTO users (kind, display_name, avatar_color, is_demo) VALUES ('child', $1, $2, true) RETURNING id`, [
      name,
      color,
    ]))!.id;
    await c.query(`INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'child')`, [fam, id]);
    await c.query(`INSERT INTO child_profiles (user_id, family_id, birth_year, quiet_start_min, quiet_end_min) VALUES ($1, $2, $3, 1260, 420)`, [id, fam, year]);
    return id;
  };
  const noa = await child('נועה', '#F25F7A', 2016);
  const itay = await child('איתי', '#3BB273', 2018);

  const contact = async (name: string, phone: string, userId: string | null, approvals: Array<[string, string]>) => {
    const id = (await one<{ id: string }>(c, `INSERT INTO contacts (family_id, display_name, phone_e164, user_id, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
      fam,
      name,
      phone,
      userId,
      parent,
    ]))!.id;
    for (const [childId, status] of approvals) {
      await c.query(
        `INSERT INTO contact_approvals (contact_id, child_user_id, status, requested_by, decided_by, decided_at, request_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          childId,
          status,
          status === 'pending_parent_approval' ? childId : parent,
          status === 'pending_parent_approval' ? null : parent,
          status === 'pending_parent_approval' ? null : new Date(),
          status === 'pending_parent_approval' ? 'המאמן של הקבוצה' : null,
        ],
      );
    }
  };
  await contact('סבתא רחל', GRANDMA, grandma, [
    [noa, 'approved'],
    [itay, 'approved'],
  ]);
  await contact('דוד דני', UNCLE, uncle, [[noa, 'approved']]);
  await contact('המאמן אבי', COACH, null, [[itay, 'pending_parent_approval']]);

  const dm = async (a: string, b: string, msgs: Array<[string, string, number]>) => {
    const conv = (await one<{ id: string }>(c, `INSERT INTO conversations (family_id, kind, direct_key, created_by) VALUES ($1, 'direct', $2, $3) RETURNING id`, [
      fam,
      [a, b].sort().join(':'),
      a,
    ]))!.id;
    for (const u of [a, b]) await c.query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)`, [conv, u]);
    let last: Date | null = null;
    for (const [sender, body, minutesAgo] of msgs) {
      const r = await one<{ created_at: Date }>(
        c,
        `INSERT INTO messages (conversation_id, sender_id, client_id, body, created_at) VALUES ($1, $2, gen_random_uuid(), $3, now() - make_interval(mins => $4)) RETURNING created_at`,
        [conv, sender, body, minutesAgo],
      );
      last = r!.created_at;
    }
    await c.query(`UPDATE conversations SET last_message_at = $2 WHERE id = $1`, [conv, last]);
    await c.query(`UPDATE conversation_members SET last_read_at = $2, last_delivered_at = $2 WHERE conversation_id = $1 AND user_id = $3`, [conv, last, a]);
  };
  await dm(noa, grandma, [
    [grandma, 'בוקר טוב נועה! איך היה בבית הספר? 🌞', 180],
    [noa, 'היה כיף! קיבלתי 100 במבחן 😄', 170],
    [grandma, 'כל הכבוד!! אני גאה בך ❤️', 160],
    [grandma, 'באים אלינו בשבת?', 20],
  ]);
  await dm(itay, parent, [
    [parent, 'איתי, אני אוספת אותך ב-4', 90],
    [itay, 'אוקיי אמא 👍', 85],
  ]);
  await dm(noa, uncle, [[uncle, 'מזל טוב על המבחן! 🎉', 300]]);
  await c.query(
    `INSERT INTO security_events (family_id, actor_id, kind, metadata) VALUES ($1, $2, 'family_created', '{}'), ($1, $2, 'contact_added', '{"name":"סבתא רחל"}')`,
    [fam, parent],
  );
});

console.log('Demo data created.');
await printCodes();
await pool.end();

async function printCodes() {
  const kids = await pool.query<{ id: string; display_name: string }>(
    `SELECT u.id, u.display_name FROM users u JOIN child_profiles cp ON cp.user_id = u.id JOIN families f ON f.id = cp.family_id WHERE f.is_demo ORDER BY u.created_at`,
  );
  const parent = await one<{ id: string }>(pool, `SELECT id FROM users WHERE phone_e164 = $1`, [PARENT]);
  console.log('\nSign in as:');
  console.log('  Parent (owner)   050-000-0001');
  console.log('  Co-parent        050-000-0002');
  console.log('  Grandma (contact) 050-000-0010');
  console.log('  With SMS_PROVIDER=console the code is printed in the server log (or shown in the app when DEV_EXPOSE_OTP=true).');
  console.log('\nChild pairing codes (valid 15 minutes, single use):');
  for (const k of kids.rows) {
    await pool.query(`UPDATE pairing_codes SET consumed_at = now() WHERE child_user_id = $1 AND consumed_at IS NULL`, [k.id]);
    const code = pairingCode();
    await pool.query(
      `INSERT INTO pairing_codes (child_user_id, code_hash, created_by, expires_at) VALUES ($1, $2, $3, now() + interval '15 minutes')`,
      [k.id, hmac(config.appSecret, `pair:${code}`), parent!.id],
    );
    console.log(`  ${k.display_name}: ${code.slice(0, 4)}-${code.slice(4)}`);
  }
}
