import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenance } from '../src/jobs.js';
import { inviteToken, newPhone, setupEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.close();
});

describe('child asks for a new contact', () => {
  it('goes request → parent approval → contact verification → chat', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'אורית', ['תום']);
    const kid = kids[0]!;
    const phone = newPhone();

    const req = await env.call('POST', '/me/contact-requests', kid.token, { displayName: 'יואב מהכיתה', phone: '0' + phone.slice(4), note: 'חבר מהכיתה' });
    expect(req.status).toBe(200);
    expect((await env.call('GET', '/me/notifications', parent.token)).body.notifications[0].kind).toBe('contact_request');
    expect((await env.call('POST', '/me/contact-requests', kid.token, { displayName: 'יואב', phone })).body.error.code).toBe('already_requested');

    const pending = await env.call('GET', `/families/${familyId}/requests`, parent.token);
    expect(pending.body.requests).toHaveLength(1);
    expect(pending.body.requests[0].note).toBe('חבר מהכיתה');

    // No invitation goes out before a parent approves the request.
    const early = await env.call('POST', `/contacts/${pending.body.requests[0].contactId}/invitation`, parent.token);
    expect(early.body.error.code).toBe('nothing_to_verify');

    const decision = await env.call('POST', `/approvals/${req.body.id}/decision`, parent.token, { decision: 'approve' });
    expect(decision.body.status).toBe('pending_verification');
    expect(env.sms.lastTo(phone)).toContain(decision.body.inviteLink);

    // Still not reachable until the contact proves the phone is theirs.
    const yoavParent = await env.adult(phone, 'אבא של יואב');
    expect((await env.call('POST', '/conversations/direct', kid.token, { userId: yoavParent.id })).status).toBe(404);

    const preview = await env.call('POST', '/invitations/preview', yoavParent.token, { token: inviteToken(decision.body.inviteLink) });
    expect(preview.body).toMatchObject({ kind: 'contact', children: ['תום'] });
    await env.call('POST', '/invitations/accept', yoavParent.token, { token: inviteToken(decision.body.inviteLink) });

    const conv = await env.dm(kid.token, yoavParent.id);
    expect((await env.send(kid.token, conv, 'אפשר לבוא אליכם?')).status).toBe(200);
    const audit = await env.call('GET', `/families/${familyId}/audit`, parent.token);
    expect(audit.body.events.map((e: any) => e.kind)).toEqual(
      expect.arrayContaining(['contact_requested', 'contact_approved', 'contact_verified', 'device_paired']),
    );
  });

  it('respects the parent turning requests off, and rejection', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'נטע', ['ליבי']);
    const kid = kids[0]!;
    const r = await env.call('POST', '/me/contact-requests', kid.token, { displayName: 'מישהו', phone: newPhone() });
    await env.call('POST', `/approvals/${r.body.id}/decision`, parent.token, { decision: 'reject' });
    const mine = await env.call('GET', '/me/contact-requests', kid.token);
    expect(mine.body.requests[0].status).toBe('rejected');

    await env.call('PATCH', `/families/${familyId}/children/${kid.id}`, parent.token, { allowContactRequests: false });
    expect((await env.call('POST', '/me/contact-requests', kid.token, { displayName: 'עוד', phone: newPhone() })).status).toBe(403);
  });

  it('approves a known contact for a second child without a new invitation', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'ערן', ['רוני', 'דפנה']);
    const phone = newPhone();
    const grandpa = await env.verifiedContact(parent.token, familyId, [kids[0]!.id], phone, 'סבא');
    const add = await env.call('POST', `/families/${familyId}/contacts`, parent.token, { displayName: 'סבא', phone, children: [{ childId: kids[1]!.id }] });
    expect(add.body).toMatchObject({ status: 'approved', inviteLink: null });
    expect((await env.call('POST', '/conversations/direct', grandpa.token, { userId: kids[1]!.id })).status).toBe(200);
  });
});

describe('family groups', () => {
  it('creates a group of permitted people and removes a contact who loses permission', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'שושנה', ['אביגיל', 'נדב']);
    const grandma = await env.verifiedContact(parent.token, familyId, kids.map((k) => k.id), newPhone(), 'סבתא');
    const g = await env.call('POST', `/families/${familyId}/groups`, parent.token, { title: 'המשפחה', memberIds: [...kids.map((k) => k.id), grandma.id] });
    expect(g.status).toBe(200);
    expect((await env.send(grandma.token, g.body.id, 'שבת שלום!')).status).toBe(200);
    expect((await env.send(kids[1]!.token, g.body.id, 'שבת שלום סבתא')).status).toBe(200);

    // Grandma loses permission for one grandchild → she can no longer be in a group with him.
    const detail = await env.call('GET', `/families/${familyId}/children/${kids[1]!.id}`, parent.token);
    await env.call('POST', `/approvals/${detail.body.contacts[0].approvalId}/remove`, parent.token);
    expect((await env.send(grandma.token, g.body.id, 'מה?')).status).toBe(404);
    const conv = await env.call('GET', `/conversations/${g.body.id}`, kids[0]!.token);
    expect(conv.body.members.find((m: any) => m.id === grandma.id).leftAt).not.toBeNull();
    expect(conv.body.canSend).toBe(true);
  });
});

describe('co-parents', () => {
  it('lets an invited co-parent manage the family, and removal takes their access', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'יעלי', ['שקד']);
    const coPhone = newPhone();
    const inv = await env.call('POST', `/families/${familyId}/admins/invite`, parent.token, {
      phone: coPhone,
      permissions: { canManageContacts: true, canApproveRequests: true, canChangeSettings: true },
    });
    const co = await env.adult(coPhone, 'אבא');
    await env.call('POST', '/invitations/accept', co.token, { token: inviteToken(inv.body.link) });
    const conv = await env.dm(co.token, kids[0]!.id);
    expect((await env.send(co.token, conv, 'אני בדרך')).status).toBe(200);

    await env.call('DELETE', `/families/${familyId}/admins/${co.id}`, parent.token);
    expect((await env.call('GET', `/families/${familyId}`, co.token)).status).toBe(404);
    expect((await env.send(co.token, conv, 'עוד משהו')).status).toBe(404);
  });
});

describe('dashboard, reports and help', () => {
  it('shows who talked with whom, never the content', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'הילה', ['אורי']);
    const friend = await env.verifiedContact(parent.token, familyId, [kids[0]!.id], newPhone(), 'אמא של דן');
    const conv = await env.dm(kids[0]!.token, friend.id);
    await env.send(kids[0]!.token, conv, 'תוכן פרטי');
    const dash = await env.call('GET', `/families/${familyId}/dashboard`, parent.token);
    expect(dash.body.children[0]).toMatchObject({ approvedContacts: 1, activeDevices: 1 });
    expect(dash.body.recentConversations[0].withNames).toContain('אמא של דן');
    expect(JSON.stringify(dash.body)).not.toContain('תוכן פרטי');
    // And parents are not members of the conversation.
    expect((await env.call('GET', `/conversations/${conv}/messages`, parent.token)).status).toBe(404);
  });

  it('routes a child report and a help request to the parents', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'אלה', ['מיה']);
    const c = await env.verifiedContact(parent.token, familyId, [kids[0]!.id], newPhone(), 'שכנה');
    const conv = await env.dm(c.token, kids[0]!.id);
    const m = await env.send(c.token, conv, 'הודעה לא נעימה');
    expect((await env.call('POST', '/reports', kids[0]!.token, { reason: 'bullying', conversationId: conv, messageId: m.body.message.id })).status).toBe(200);
    expect((await env.call('POST', '/reports', kids[0]!.token, { reason: 'help', details: 'אני צריכה עזרה' })).status).toBe(200);
    const reports = await env.call('GET', `/families/${familyId}/reports`, parent.token);
    expect(reports.body.reports).toHaveLength(2);
    expect(reports.body.reports.find((r: any) => r.reason === 'bullying').messageBody).toBe('הודעה לא נעימה');
    // A stranger cannot file a report on a conversation they are not in.
    const stranger = await env.adult(newPhone(), 'זר');
    expect((await env.call('POST', '/reports', stranger.token, { reason: 'spam', conversationId: conv })).status).toBe(404);
  });
});

describe('privacy operations', () => {
  it('applies a retention policy', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'רז', ['עמית']);
    const conv = await env.dm(parent.token, kids[0]!.id);
    const m = await env.send(parent.token, conv, 'ישן');
    await env.pool.query(`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = $1`, [m.body.message.id]);
    await env.send(parent.token, conv, 'חדש');
    expect((await env.call('PUT', `/families/${familyId}/retention`, parent.token, { messageRetentionDays: 30 })).status).toBe(200);
    await runMaintenance(env.ctx);
    const msgs = await env.call('GET', `/conversations/${conv}/messages`, kids[0]!.token);
    expect(msgs.body.messages.map((x: any) => x.body)).toEqual(['חדש']);
  });

  it('deletes a contact account and its access after a fresh code', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'מאיר', ['נוי']);
    const c = await env.verifiedContact(parent.token, familyId, [kids[0]!.id], newPhone(), 'דוד');
    const exp = await env.call('GET', '/me/export', c.token);
    expect(exp.body.user.display_name).toBe('דוד');
    expect((await env.call('DELETE', '/me', c.token, {})).body.error.code).toBe('step_up_required');
    const step = await env.call('POST', '/auth/step-up', c.token);
    const code = /(\d{6})/.exec(env.sms.lastTo(c.phone))![1];
    expect((await env.call('DELETE', '/me', c.token, { challengeId: step.body.challengeId, code })).status).toBe(200);
    expect((await env.call('GET', '/me', c.token)).status).toBe(401);
    const detail = await env.call('GET', `/families/${familyId}/children/${kids[0]!.id}`, parent.token);
    expect(detail.body.contacts[0]).toMatchObject({ status: 'pending_verification', verified: false });
  });

  it('removes a child who started conversations, then deletes the whole family', async () => {
    const { parent, familyId, kids } = await env.family(newPhone(), 'שלומית', ['אריאל', 'הדר']);
    const grandpa = await env.verifiedContact(parent.token, familyId, kids.map((k) => k.id), newPhone(), 'סבא');
    // Each child creates a conversation, a contact request and a report.
    for (const k of kids) {
      const conv = await env.dm(k.token, grandpa.id);
      await env.send(k.token, conv, 'שלום סבא');
      await env.call('POST', '/me/contact-requests', k.token, { displayName: 'חבר', phone: newPhone() });
      await env.call('POST', '/reports', k.token, { reason: 'help' });
    }
    const stepUp = async () => {
      const s = await env.call('POST', '/auth/step-up', parent.token);
      return { challengeId: s.body.challengeId, code: /(\d{6})/.exec(env.sms.lastTo(parent.phone))![1] };
    };
    const del = await env.call('DELETE', `/families/${familyId}/children/${kids[0]!.id}`, parent.token, await stepUp());
    expect(del.status).toBe(200);
    expect((await env.call('GET', '/me', kids[0]!.token)).status).toBe(401);

    const delFamily = await env.call('DELETE', `/families/${familyId}`, parent.token, await stepUp());
    expect(delFamily.status).toBe(200);
    expect((await env.call('GET', '/me', kids[1]!.token)).status).toBe(401);
    expect((await env.call('GET', '/conversations', grandpa.token)).body.conversations).toEqual([]);
    expect((await env.call('GET', '/me', parent.token)).body.families).toEqual([]);
  });

  it('records consent when a family is created', async () => {
    const { familyId } = await env.family(newPhone(), 'עוז', []);
    const rows = await env.pool.query(`SELECT kind FROM consent_records WHERE family_id = $1 ORDER BY kind`, [familyId]);
    expect(rows.rows.map((r) => r.kind)).toEqual(['parental_consent', 'privacy', 'terms']);
  });
});
