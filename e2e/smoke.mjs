/**
 * Browser smoke test of the main flows against a running dev stack:
 * the API with seeded demo data (DEV_EXPOSE_OTP=true) and the Expo web app.
 *
 *   node smoke.mjs <child pairing code for נועה from `npm run seed`>
 *
 * Screenshots are written to ./shots. Set CHROMIUM_PATH to use a specific browser binary.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const SHOTS = new URL('./shots', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const APP = process.env.APP_URL ?? 'http://localhost:8081';
const [childCode] = process.argv.slice(2);
if (!childCode) {
  console.error('usage: node smoke.mjs <pairing code>');
  process.exit(1);
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errors = [];
async function ctx(name) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'he-IL' });
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errors.push(`[${name}] console: ${m.text()} @ ${m.location().url}`));
  return p;
}
const shot = (p, n) => p.screenshot({ path: `${SHOTS}/${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(p, phone, tag) {
  await p.goto(APP + '/');
  await p.getByText('כניסה עם מספר טלפון').waitFor();
  if (tag) await shot(p, tag + '-welcome');
  await p.getByText('כניסה עם מספר טלפון').click();
  await p.getByPlaceholder('050-123-4567').fill(phone);
  await p.getByText('שליחת קוד').click();
  const notice = p.getByText(/מצב פיתוח — הקוד/);
  await notice.waitFor();
  if (tag) await shot(p, tag + '-code');
  const code = (await notice.textContent()).match(/(\d{6})/)[1];
  await p.getByPlaceholder('••••••').fill(code);
  await p.getByText('אימות', { exact: true }).click();
}

// Parent
const parent = await ctx('parent');
await login(parent, '050-000-0001', '01');
await parent.getByText('לוח בקרה').or(parent.getByText('משפחת כהן (הדגמה)')).first().waitFor();
await wait(800);
await shot(parent, '02-dashboard');
await parent.screenshot({ path: `${SHOTS}/02-dashboard-full.png`, fullPage: true });
await parent.getByText('נועה', { exact: true }).first().click();
await parent.getByText('אנשי הקשר של נועה').waitFor();
await wait(500);
await shot(parent, '03-child');
await parent.screenshot({ path: `${SHOTS}/03-child-full.png`, fullPage: true });
await parent.goBack();
await parent.getByText('בקשות ממתינות').first().click();
await parent.getByText(/מבקש\/ת להוסיף את/).waitFor();
await wait(400);
await shot(parent, '04-requests');
await parent.goto(APP + '/family/add-contact');
await parent.getByPlaceholder('סבתא רחל').fill('דודה שירה');
await parent.getByPlaceholder('050-123-4567').fill('050-000-0020');
await parent.getByText('נועה', { exact: true }).click();
await shot(parent, '05-add-contact');
await parent.getByText('הוספת איש קשר', { exact: true }).last().click();
await parent.getByText('איש הקשר נוסף').waitFor();
await wait(300);
await shot(parent, '06-invite-link');
const inviteLink = (await parent.getByText(/\/invite\//).textContent()).trim();

// Child pairs with the seeded code and chats with grandma
const child = await ctx('child');
await child.goto(APP + '/');
await child.getByText('אני ילד/ה — יש לי קוד חיבור').click();
await child.getByPlaceholder('XXXX-XXXX').fill(childCode);
await shot(child, '07-pair');
await child.getByText('חיבור', { exact: true }).click();
await child.getByText('סבתא רחל').first().waitFor();
await wait(500);
await shot(child, '08-child-chats');
await child.getByText('סבתא רחל').first().click();
await child.getByPlaceholder('הודעה').waitFor();
await wait(500);
await child.getByPlaceholder('הודעה').fill('כן! נבוא בשבת 🥰');
await child.keyboard.press('Enter');
await child.getByText('כן! נבוא בשבת 🥰').last().waitFor();
await wait(800);
await shot(child, '09-child-chat');

// Grandma signs in, sees the message live, replies
const grandma = await ctx('grandma');
await login(grandma, '050-000-0010');
await grandma.getByText('נועה').first().waitFor();
await wait(500);
await shot(grandma, '10-grandma-chats');
await grandma.getByText('נועה').first().click();
await grandma.getByText('כן! נבוא בשבת 🥰').last().waitFor();
await grandma.getByPlaceholder('הודעה').fill('מחכה לכם ❤️');
await grandma.keyboard.press('Enter');
await child.getByText('מחכה לכם ❤️').last().waitFor({ timeout: 5000 });
await wait(600);
await shot(child, '11-child-live-reply');
await shot(grandma, '12-grandma-chat');

// Grandma video-calls Noa over the internet; both sides must actually connect.
await grandma.getByLabel('שיחת וידאו').click();
await grandma.getByText('מצלצל…').waitFor();
await child.getByText('שיחת וידאו נכנסת…').waitFor({ timeout: 8000 });
await shot(child, '20-call-incoming');
await child.getByLabel('מענה').click();
// The timer only appears once the WebRTC connection is up.
const connected = (p) => p.getByText(/^🎥 \d+:\d\d$/).waitFor({ timeout: 15000 });
await Promise.all([connected(child), connected(grandma)]);
await wait(2500);
await shot(child, '21-call-connected-child');
await shot(grandma, '22-call-connected-grandma');
const hasRemoteVideo = await child.evaluate(() => [...document.querySelectorAll('video')].some((v) => v.srcObject && v.videoWidth > 0 && !v.muted));
if (!hasRemoteVideo) throw new Error('remote video is not playing on the child side');
await grandma.getByLabel('ניתוק').click();
await child.getByText('השיחה הסתיימה').waitFor({ timeout: 8000 });
await shot(child, '23-call-ended');
await wait(2500);

// Child people tab + request screen
await child.goto(APP + '/people');
await child.getByText('לבקש מההורים להוסיף מישהו').waitFor();
await wait(300);
await shot(child, '13-child-people');

// Parent blocks uncle Dani: child's conversation with him becomes read-only immediately
await parent.goto(APP + '/family/contacts');
await parent.getByText('דוד דני').waitFor();
parent.on('dialog', (d) => d.accept());
const card = parent.locator('div', { hasText: 'דוד דני' }).filter({ hasText: 'חסימה' }).last();
await card.getByText('חסימה', { exact: true }).click();
await parent.getByText('ביטול חסימה').waitFor();
await wait(300);
await shot(parent, '14-blocked');
await child.goto(APP + '/chats');
await child.getByText('דוד דני').first().click();
await child.getByText(/אי אפשר לשלוח הודעות/).waitFor();
await wait(300);
await shot(child, '15-child-blocked-chat');

// The invited aunt opens her link, signs in with her own number, sets her name and accepts
const aunt = await ctx('aunt');
await aunt.goto(inviteLink);
await aunt.getByText('כניסה עם מספר טלפון').click();
await aunt.getByPlaceholder('050-123-4567').fill('050-000-0020');
await aunt.getByText('שליחת קוד').click();
const n2 = aunt.getByText(/מצב פיתוח — הקוד/);
await n2.waitFor();
await aunt.getByPlaceholder('••••••').fill((await n2.textContent()).match(/(\d{6})/)[1]);
await aunt.getByText('אימות', { exact: true }).click();
await aunt.getByPlaceholder('שם פרטי').fill('שירה');
await aunt.getByText('המשך', { exact: true }).click();
await aunt.getByText('אישור והצטרפות').last().waitFor();
await wait(300);
await shot(aunt, '17-invite-preview');
await aunt.getByText('אישור והצטרפות').last().click();
await aunt.getByText('הצטרפת בהצלחה').last().waitFor();
await aunt.goto(APP + '/people');
await aunt.getByText('נועה').first().click();
await aunt.getByPlaceholder('הודעה').fill('היי נועה, זאת דודה שירה 😊');
await aunt.keyboard.press('Enter');
await child.goto(APP + '/chats');
await child.getByText('דודה שירה').first().waitFor({ timeout: 8000 });
await wait(400);
await shot(child, '18-child-new-contact');

// A different person cannot use the aunt's link (bound to her number)
const thief = await ctx('thief');
await login(thief, '050-000-0030');
await thief.getByPlaceholder('שם פרטי').fill('זר');
await thief.getByText('המשך', { exact: true }).click();
await thief.goto(inviteLink);
await thief.getByText(/לא תקפה|מספר טלפון אחר/).last().waitFor();
await shot(thief, '19-invite-wrong-phone');

// Dark mode
const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const dp = await dark.newPage();
await dp.goto(APP + '/');
await dp.getByText('כניסה עם מספר טלפון').waitFor();
await wait(300);
await dp.screenshot({ path: `${SHOTS}/16-dark-welcome.png` });

await browser.close();
// The stranger's attempt to use an already-accepted invitation is expected to 404.
const unexpected = errors.filter((e) => !(e.startsWith('[thief]') && e.includes('/invitations/preview')));
if (unexpected.length) {
  console.error('Unexpected browser errors:\n' + unexpected.join('\n'));
  process.exit(1);
}
console.log(`OK — screenshots in ${SHOTS}`);
