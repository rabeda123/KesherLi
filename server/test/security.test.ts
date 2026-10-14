/**
 * The mandatory scenarios from the product spec (section 13), run against
 * the real API and a real Postgres database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inviteToken, newPhone, openSocket, setupEnv, waitFor, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.close();
});

describe('1. a child cannot message a contact that is not approved', () => {
  it('blocks a contact that was added but has not verified their phone', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'דנה', ['נועה']);
    const phone = newPhone();
    const add = await env.call('POST', `/families/${familyId}/contacts`, parent.token, {
      displayName: 'סבא',
      phone,
      children: [{ childId: kids[0]!.id }],
    });
    expect(add.body.status).toBe('pending_verification');
    // The person registers but has not accepted the invitation yet.
    const grandpa = await env.adult(phone, 'סבא');
    expect((await env.call('POST', '/conversations/direct', kids[0]!.token, { userId: grandpa.id })).status).toBe(404);
    expect((await env.call('POST', '/conversations/direct', grandpa.token, { userId: kids[0]!.id })).status).toBe(404);
    const reachable = await env.call('GET', '/me/reachable', kids[0]!.token);
    expect(reachable.body.people.map((p: any) => p.id)).not.toContain(grandpa.id);
  });

  it('blocks sending once the approval is removed, even in an existing conversation', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'רון', ['איתי']);
    const aunt = await env.verifiedContact(parent.token, familyId, [kids[0]!.id], newPhone(), 'דודה');
    const conv = await env.dm(kids[0]!.token, aunt.id);
    expect((await env.send(kids[0]!.token, conv, 'היי')).status).toBe(200);

    const detail = await env.call('GET', `/families/${familyId}/children/${kids[0]!.id}`, parent.token);
    const approvalId = detail.body.contacts[0].approvalId;
    expect((await env.call('POST', `/approvals/${approvalId}/remove`, parent.token)).status).toBe(200);

    expect((await env.send(kids[0]!.token, conv, 'עדיין כאן?')).status).toBe(403);
    expect((await env.send(aunt.token, conv, 'כן')).status).toBe(404);
  });

  it('only sends text with the message capability', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'גל', ['עומר']);
    const coach = await env.verifiedContact(parent.token, familyId, [kids[0]!.id], newPhone(), 'מאמן');
    const conv = await env.dm(kids[0]!.token, coach.id);
    const detail = await env.call('GET', `/families/${familyId}/children/${kids[0]!.id}`, parent.token);
    await env.call('PATCH', `/approvals/${detail.body.contacts[0].approvalId}`, parent.token, { canMessage: false });
    expect((await env.send(kids[0]!.token, conv, 'שלום')).status).toBe(403);
  });
});

describe('2. strangers cannot discover children', () => {
  it('offers no user search and treats unknown and forbidden ids alike', async () => {
    const { kids } = await env.family(newPhone(), 'מיכל', ['יעל']);
    const stranger = await env.adult(newPhone(), 'זר');
    for (const url of ['/users?q=יעל', '/users/search?q=יעל', `/users/${kids[0]!.id}`]) {
      expect((await env.call('GET', url, stranger.token)).status).toBe(404);
    }
    const forbidden = await env.call('POST', '/conversations/direct', stranger.token, { userId: kids[0]!.id });
    const missing = await env.call('POST', '/conversations/direct', stranger.token, { userId: crypto.randomUUID() });
    expect(forbidden.status).toBe(404);
    expect(forbidden.body).toEqual(missing.body);
    expect((await env.call('GET', '/me/reachable', stranger.token)).body.people).toEqual([]);
  });

  it('answers OTP requests identically for registered and unknown numbers', async () => {
    const known = newPhone();
    await env.adult(known, 'רשום');
    const a = await env.call('POST', '/auth/otp/request', undefined, { phone: known });
    const b = await env.call('POST', '/auth/otp/request', undefined, { phone: newPhone() });
    expect(a.status).toBe(200);
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
  });
});

describe('3. changing a conversation id does not grant access', () => {
  it('returns 404 for conversations the caller is not in', async () => {
    const a = await env.family(newPhone(), 'אורי', ['שירה', 'בן']);
    const conv = await env.dm(a.kids[0]!.token, a.kids[1]!.id);
    await env.send(a.kids[0]!.token, conv, 'סוד בין אחים');

    const other = await env.family(newPhone(), 'זיו', ['תמר']);
    for (const token of [other.parent.token, other.kids[0]!.token, a.parent.token]) {
      expect((await env.call('GET', `/conversations/${conv}`, token)).status).toBe(404);
      expect((await env.call('GET', `/conversations/${conv}/messages`, token)).status).toBe(404);
      expect((await env.send(token, conv, 'פריצה')).status).toBe(404);
      expect((await env.call('POST', `/conversations/${conv}/read`, token, { messageId: crypto.randomUUID() })).status).toBe(404);
    }
    const search = await env.call('GET', '/search?q=סוד', other.kids[0]!.token);
    expect(search.body.results).toEqual([]);
  });

  it('rejects reusing a client id to slip a message into another conversation', async () => {
    const { parent, kids } = await env.family(newPhone(), 'שקד', ['ליה', 'רז']);
    const c1 = await env.dm(kids[0]!.token, kids[1]!.id);
    const c2 = await env.dm(kids[0]!.token, parent.id);
    const clientId = crypto.randomUUID();
    expect((await env.send(kids[0]!.token, c1, 'אחת', clientId)).status).toBe(200);
    expect((await env.send(kids[0]!.token, c2, 'שתיים', clientId)).status).toBe(400);
  });
});

describe('4. approval for one child is not approval for a sibling', () => {
  it('keeps approvals per child', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'עדי', ['אלה', 'יונתן']);
    const [ella, yonatan] = kids as [(typeof kids)[0], (typeof kids)[0]];
    const friendMom = await env.verifiedContact(parent.token, familyId, [ella.id], newPhone(), 'אמא של מאיה');
    expect((await env.call('POST', '/conversations/direct', friendMom.token, { userId: ella.id })).status).toBe(200);
    expect((await env.call('POST', '/conversations/direct', friendMom.token, { userId: yonatan.id })).status).toBe(404);
    expect((await env.call('POST', '/conversations/direct', yonatan.token, { userId: friendMom.id })).status).toBe(404);

    // A family group cannot be used to bring her together with the sibling.
    const group = await env.call('POST', `/families/${familyId}/groups`, parent.token, {
      title: 'קבוצה',
      memberIds: [ella.id, yonatan.id, friendMom.id],
    });
    expect(group.status).toBe(403);
  });
});

describe('5. blocking a contact cuts communication', () => {
  it('stops messages both ways, hides the conversation and prevents re-requesting', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'הדס', ['נגה']);
    const phone = newPhone();
    const x = await env.verifiedContact(parent.token, familyId, [kids[0]!.id], phone, 'שכן');
    const conv = await env.dm(x.token, kids[0]!.id);
    expect((await env.send(x.token, conv, 'שלום')).status).toBe(200);

    expect((await env.call('POST', `/contacts/${x.contactId}/block`, parent.token, { reason: 'לא מתאים' })).status).toBe(200);

    expect((await env.send(x.token, conv, 'שוב שלום')).status).toBe(404);
    expect((await env.send(kids[0]!.token, conv, 'היי')).status).toBe(403);
    expect((await env.call('GET', `/conversations/${conv}/messages`, x.token)).status).toBe(404);
    expect((await env.call('GET', '/conversations', x.token)).body.conversations).toEqual([]);
    expect((await env.call('POST', '/conversations/direct', x.token, { userId: kids[0]!.id })).status).toBe(404);

    // The child keeps their own history but cannot reach the person.
    expect((await env.call('GET', `/conversations/${conv}/messages`, kids[0]!.token)).body.messages).toHaveLength(1);
    const request = await env.call('POST', '/me/contact-requests', kids[0]!.token, { displayName: 'שכן', phone });
    expect(request.status).toBe(409);
    // A parent cannot accidentally re-add a blocked number either.
    const readd = await env.call('POST', `/families/${familyId}/contacts`, parent.token, {
      displayName: 'שכן',
      phone,
      children: [{ childId: kids[0]!.id }],
    });
    expect(readd.status).toBe(409);
  });
});

describe('6. a parent without permission cannot change sensitive settings', () => {
  it('enforces co-parent permissions and owner-only actions on the server', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'שרון', ['אור']);
    const coPhone = newPhone();
    const inv = await env.call('POST', `/families/${familyId}/admins/invite`, parent.token, {
      phone: coPhone,
      permissions: { canManageContacts: false, canApproveRequests: true, canChangeSettings: false },
    });
    const co = await env.adult(coPhone, 'אבא');
    expect((await env.call('POST', '/invitations/accept', co.token, { token: inviteToken(inv.body.link) })).status).toBe(200);

    const child = `/families/${familyId}/children/${kids[0]!.id}`;
    expect((await env.call('PATCH', child, co.token, { allowContactRequests: false })).status).toBe(403);
    expect((await env.call('POST', `${child}/pairing-code`, co.token)).status).toBe(403);
    expect(
      (await env.call('POST', `/families/${familyId}/contacts`, co.token, { displayName: 'x', phone: newPhone(), children: [{ childId: kids[0]!.id }] }))
        .status,
    ).toBe(403);
    expect((await env.call('POST', `/families/${familyId}/admins/invite`, co.token, { phone: newPhone(), permissions: { canManageContacts: true, canApproveRequests: true, canChangeSettings: true } })).status).toBe(403);
    expect((await env.call('POST', `/families/${familyId}/transfer-ownership`, co.token, { userId: co.id })).status).toBe(403);
    expect((await env.call('PATCH', `/families/${familyId}/admins/${co.id}`, co.token, { canManageContacts: true, canApproveRequests: true, canChangeSettings: true })).status).toBe(403);
    // Allowed: read the dashboard.
    expect((await env.call('GET', `/families/${familyId}/dashboard`, co.token)).status).toBe(200);
  });

  it('gives a child no access to parent endpoints', async () => {
    const { familyId, kids } = await env.family(newPhone(), 'טל', ['רום']);
    const kid = kids[0]!;
    expect((await env.call('GET', `/families/${familyId}`, kid.token)).status).toBe(404);
    expect((await env.call('PATCH', `/families/${familyId}/children/${kid.id}`, kid.token, { allowContactRequests: true })).status).toBe(404);
    expect((await env.call('POST', `/families/${familyId}/children/${kid.id}/pairing-code`, kid.token)).status).toBe(404);
    expect((await env.call('PATCH', '/me', kid.token, { displayName: 'שם חדש' })).status).toBe(403);
    expect((await env.call('POST', '/families', kid.token, { name: 'x', acceptTerms: true, parentalConsent: true, termsVersion: '2026-10' })).status).toBe(403);
  });

  it('requires a fresh phone code to transfer ownership', async () => {
    const { parent, familyId } = await env.family(newPhone(), 'נועם', []);
    const coPhone = newPhone();
    const inv = await env.call('POST', `/families/${familyId}/admins/invite`, parent.token, {
      phone: coPhone,
      permissions: { canManageContacts: true, canApproveRequests: true, canChangeSettings: true },
    });
    const co = await env.adult(coPhone, 'שותף');
    await env.call('POST', '/invitations/accept', co.token, { token: inviteToken(inv.body.link) });
    expect((await env.call('POST', `/families/${familyId}/transfer-ownership`, parent.token, { userId: co.id })).body.error.code).toBe('step_up_required');
    const step = await env.call('POST', '/auth/step-up', parent.token);
    const code = /(\d{6})/.exec(env.sms.lastTo(parent.phone))![1];
    const ok = await env.call('POST', `/families/${familyId}/transfer-ownership`, parent.token, { userId: co.id, challengeId: step.body.challengeId, code });
    expect(ok.status).toBe(200);
    expect((await env.call('GET', `/families/${familyId}`, co.token)).body.me.role).toBe('owner');
  });
});

describe('7. no access to another family', () => {
  it('returns 404 for every family-scoped resource of another family', async () => {
    const a = await env.family(newPhone(), 'אביב', ['שחר']);
    const contact = await env.verifiedContact(a.parent.token, a.familyId, [a.kids[0]!.id], newPhone(), 'סבתא');
    const detail = await env.call('GET', `/families/${a.familyId}/children/${a.kids[0]!.id}`, a.parent.token);
    const approvalId = detail.body.contacts[0].approvalId;

    const b = await env.family(newPhone(), 'ברק', ['דור']);
    const t = b.parent.token;
    const urls: Array<[string, string, unknown?]> = [
      ['GET', `/families/${a.familyId}`],
      ['GET', `/families/${a.familyId}/dashboard`],
      ['GET', `/families/${a.familyId}/contacts`],
      ['GET', `/families/${a.familyId}/requests`],
      ['GET', `/families/${a.familyId}/audit`],
      ['GET', `/families/${a.familyId}/reports`],
      ['GET', `/families/${a.familyId}/children/${a.kids[0]!.id}`],
      ['POST', `/families/${a.familyId}/children/${a.kids[0]!.id}/pairing-code`],
      ['PATCH', `/approvals/${approvalId}`, { canCall: true }],
      ['POST', `/approvals/${approvalId}/remove`],
      ['POST', `/contacts/${contact.contactId}/block`, {}],
      ['POST', `/contacts/${contact.contactId}/invitation`],
    ];
    for (const [method, url, body] of urls) {
      const r = await env.call(method, url, t, body);
      expect(r.status, `${method} ${url}`).toBe(404);
    }
    // Using one's own family id with another family's child does not work either.
    expect((await env.call('GET', `/families/${b.familyId}/children/${a.kids[0]!.id}`, t)).status).toBe(404);
    expect(
      (await env.call('POST', `/families/${b.familyId}/contacts`, t, { displayName: 'x', phone: newPhone(), children: [{ childId: a.kids[0]!.id }] })).status,
    ).toBe(404);
  });
});

describe('8. media files are never public', () => {
  // Media upload is not part of the MVP; there is deliberately no static file
  // route. When media lands it must use short-lived signed URLs (see docs/ROADMAP.md).
  it('exposes no static or upload routes', async () => {
    for (const url of ['/media/x.jpg', '/uploads/x.jpg', '/files/x', '/static/x']) {
      expect((await env.call('GET', url)).status).toBe(404);
    }
  });
});

describe('9. nobody can impersonate a parent or contact', () => {
  it('binds invitation links to the invited phone number', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'עינב', ['מעיין']);
    const add = await env.call('POST', `/families/${familyId}/contacts`, parent.token, {
      displayName: 'סבתא',
      phone: newPhone(),
      children: [{ childId: kids[0]!.id }],
    });
    const thief = await env.adult(newPhone(), 'מתחזה');
    const token = inviteToken(add.body.inviteLink);
    expect((await env.call('POST', '/invitations/preview', thief.token, { token })).status).toBe(403);
    expect((await env.call('POST', '/invitations/accept', thief.token, { token })).status).toBe(403);
    expect((await env.call('POST', '/conversations/direct', thief.token, { userId: kids[0]!.id })).status).toBe(404);
  });

  it('makes invitations single use', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'יובל', ['אגם']);
    const phone = newPhone();
    const add = await env.call('POST', `/families/${familyId}/contacts`, parent.token, { displayName: 'דוד', phone, children: [{ childId: kids[0]!.id }] });
    const uncle = await env.adult(phone, 'דוד');
    const token = inviteToken(add.body.inviteLink);
    expect((await env.call('POST', '/invitations/accept', uncle.token, { token })).status).toBe(200);
    expect((await env.call('POST', '/invitations/accept', uncle.token, { token })).status).toBe(404);
  });

  it('locks a code after repeated wrong guesses', async () => {
    const phone = newPhone();
    const { challengeId, code } = await env.otp(phone);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      expect((await env.call('POST', '/auth/otp/verify', undefined, { challengeId, code: wrong })).status).toBe(400);
    }
    // Even the right code no longer works.
    expect((await env.call('POST', '/auth/otp/verify', undefined, { challengeId, code })).status).toBe(400);
  });

  it('limits how many codes can be requested for one number', async () => {
    const phone = newPhone();
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await env.call('POST', '/auth/otp/request', undefined, { phone })).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('rejects forged and revoked tokens', async () => {
    expect((await env.call('GET', '/me', 'kl_forged')).status).toBe(401);
    const a = await env.adult(newPhone(), 'משתמש');
    await env.call('POST', '/auth/logout', a.token);
    expect((await env.call('GET', '/me', a.token)).status).toBe(401);
  });
});

describe('10. revocation reaches devices that are already connected', () => {
  it('pushes the removal to the contact live and refuses their next send', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'רותם', ['הילה']);
    const contact = await env.verifiedContact(parent.token, familyId, [kids[0]!.id], newPhone(), 'מורה');
    const conv = await env.dm(contact.token, kids[0]!.id);
    const sock = await openSocket(env, contact.token);

    await env.call('POST', `/contacts/${contact.contactId}/block`, parent.token, {});
    await waitFor(() => sock.events.some((e) => e.type === 'conversation.removed' && e.conversationId === conv));
    expect((await env.send(contact.token, conv, 'עוד הודעה')).status).toBe(404);
    sock.ws.close();
  });

  it('disconnects a child device the parent revokes, and its token stops working', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'שגיא', ['אופיר']);
    const kid = kids[0]!;
    const sock = await openSocket(env, kid.token);
    const detail = await env.call('GET', `/families/${familyId}/children/${kid.id}`, parent.token);
    const deviceId = detail.body.devices[0].id;
    await env.call('POST', `/families/${familyId}/children/${kid.id}/devices/${deviceId}/revoke`, parent.token);
    expect(await sock.closed).toBe(4001);
    expect(sock.events.some((e) => e.type === 'session.revoked')).toBe(true);
    expect((await env.call('GET', '/me', kid.token)).status).toBe(401);
  });
});

describe('11. messages are stored and synced', () => {
  it('deduplicates retries, syncs after a cursor, and tracks unread and read state', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'ליאור', ['עלמה']);
    const grandma = await env.verifiedContact(parent.token, familyId, [kids[0]!.id], newPhone(), 'סבתא');
    const kid = kids[0]!;
    const conv = await env.dm(kid.token, grandma.id);

    const clientId = crypto.randomUUID();
    const first = await env.send(kid.token, conv, 'בוקר טוב סבתא', clientId);
    const retry = await env.send(kid.token, conv, 'בוקר טוב סבתא', clientId);
    expect(retry.body.duplicate).toBe(true);
    expect(retry.body.message.id).toBe(first.body.message.id);

    // Grandma was offline; she catches up from her last known message.
    const m2 = await env.send(kid.token, conv, 'מה שלומך?');
    const m3 = await env.send(kid.token, conv, '❤️');
    const list = await env.call('GET', '/conversations', grandma.token);
    expect(list.body.conversations[0].unread).toBe(3);
    expect(list.body.conversations[0].members.find((m: any) => m.id === kid.id).displayName).toBe('עלמה');
    const sync = await env.call('GET', `/conversations/${conv}/messages?after=${first.body.message.id}`, grandma.token);
    expect(sync.body.messages.map((m: any) => m.id)).toEqual([m2.body.message.id, m3.body.message.id]);

    await env.call('POST', `/conversations/${conv}/read`, grandma.token, { messageId: m3.body.message.id });
    expect((await env.call('GET', '/conversations', grandma.token)).body.conversations[0].unread).toBe(0);
    const detail = await env.call('GET', `/conversations/${conv}`, kid.token);
    const g = detail.body.members.find((m: any) => m.id === grandma.id);
    expect(new Date(g.lastReadAt) >= new Date(m3.body.message.createdAt)).toBe(true);

    // The child sees grandma under the name the parent gave her.
    expect(detail.body.members.find((m: any) => m.id === grandma.id).displayName).toBe('סבתא');
  });

  it('delivers new messages live to the other member', async () => {
    const { kids } = await env.family(newPhone(), 'אסף', ['גיא', 'מאיה']);
    const conv = await env.dm(kids[0]!.token, kids[1]!.id);
    const sock = await openSocket(env, kids[1]!.token);
    await env.send(kids[0]!.token, conv, 'ארוחת ערב!');
    await waitFor(() => sock.events.some((e) => e.type === 'message.new' && e.message.body === 'ארוחת ערב!'));
    sock.ws.close();
  });

  it('hides read state when a parent turned off read receipts', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'אלון', ['דניאל']);
    const kid = kids[0]!;
    await env.call('PATCH', `/families/${familyId}/children/${kid.id}`, parent.token, { readReceipts: false });
    const conv = await env.dm(parent.token, kid.id);
    const m = await env.send(parent.token, conv, 'לסדר את החדר');
    await env.call('POST', `/conversations/${conv}/read`, kid.token, { messageId: m.body.message.id });
    const detail = await env.call('GET', `/conversations/${conv}`, parent.token);
    expect(detail.body.members.find((x: any) => x.id === kid.id).lastReadAt).toBeNull();
  });
});

describe('12. account recovery cannot bypass parental control', () => {
  it('only lets a parent connect a new device, with a single-use code', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'מור', ['ים']);
    const code = await env.call('POST', `/families/${familyId}/children/${kids[0]!.id}/pairing-code`, parent.token);
    expect((await env.call('POST', '/auth/pair', undefined, { code: code.body.code })).status).toBe(200);
    expect((await env.call('POST', '/auth/pair', undefined, { code: code.body.code })).status).toBe(400);
    expect((await env.call('POST', '/auth/pair', undefined, { code: 'ABCD-EFGH' })).status).toBe(400);
  });

  it('keeps the same restrictions on a re-paired device', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'אדם', ['שני']);
    const kid = kids[0]!;
    const stranger = await env.adult(newPhone(), 'זר');
    const newToken = await env.pairChild(parent.token, familyId, kid.id);
    expect((await env.call('POST', '/conversations/direct', newToken, { userId: stranger.id })).status).toBe(404);
    expect((await env.call('GET', '/me', newToken)).body.user.id).toBe(kid.id);
  });

  it('gives a child no phone login that could create an independent account', async () => {
    const { kids } = await env.family(newPhone(), 'רוני', ['עדן']);
    const me = await env.call('GET', '/me', kids[0]!.token);
    expect(me.body.user.phone).toBeNull();
    expect((await env.call('POST', '/auth/step-up', kids[0]!.token)).status).toBe(403);
  });
});
