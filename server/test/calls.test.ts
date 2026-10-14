import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newPhone, openSocket, setupEnv, waitFor, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.close();
});

/** A family with one child and a verified contact whose "calls" permission is set as given. */
async function setup(canCall: boolean) {
  const { parent, familyId, kids } = await env.family(newPhone(), 'דנה', ['נועה']);
  const kid = kids[0]!;
  const grandma = await env.verifiedContact(parent.token, familyId, [kid.id], newPhone(), 'סבתא');
  const detail = await env.call('GET', `/families/${familyId}/children/${kid.id}`, parent.token);
  const approvalId = detail.body.contacts[0].approvalId;
  await env.call('PATCH', `/approvals/${approvalId}`, parent.token, { canCall });
  const conv = await env.dm(grandma.token, kid.id);
  return { parent, familyId, kid, grandma, conv, approvalId };
}

describe('calls', () => {
  it('needs the parent to allow calls for that contact and child', async () => {
    const { kid, grandma, conv } = await setup(false);
    expect((await env.call('GET', `/conversations/${conv}`, kid.token)).body.canCall).toBe(false);
    const r = await env.call('POST', '/calls', grandma.token, { conversationId: conv, kind: 'video' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('calls_not_allowed');
    expect((await env.call('POST', '/calls', kid.token, { conversationId: conv, kind: 'audio' })).status).toBe(403);
  });

  it('rings, connects and relays WebRTC signals only between the two call devices', async () => {
    const { kid, grandma, conv } = await setup(true);
    expect((await env.call('GET', `/conversations/${conv}`, kid.token)).body.canCall).toBe(true);
    const kidSock = await openSocket(env, kid.token);
    const gmaSock = await openSocket(env, grandma.token);

    const start = await env.call('POST', '/calls', grandma.token, { conversationId: conv, kind: 'video' });
    expect(start.status).toBe(200);
    expect(start.body.iceServers[0].urls[0]).toMatch(/^stun:/);
    const callId = start.body.call.id;
    await waitFor(() => kidSock.events.some((e) => e.type === 'call.incoming' && e.call.id === callId));
    const incoming = kidSock.events.find((e) => e.type === 'call.incoming').call;
    expect(incoming).toMatchObject({ direction: 'incoming', kind: 'video', peer: { displayName: 'סבתא' } });

    // Signals are refused before the call is answered.
    expect((await env.call('POST', `/calls/${callId}/signal`, grandma.token, { type: 'offer', sdp: 'v=0' })).status).toBe(409);
    expect((await env.call('POST', `/calls/${callId}/accept`, kid.token)).status).toBe(200);
    await waitFor(() => gmaSock.events.some((e) => e.type === 'call.updated' && e.call.status === 'accepted'));

    await env.call('POST', `/calls/${callId}/signal`, grandma.token, { type: 'offer', sdp: 'v=0 offer' });
    await waitFor(() => kidSock.events.some((e) => e.type === 'call.signal' && e.signal.sdp === 'v=0 offer'));
    await env.call('POST', `/calls/${callId}/signal`, kid.token, { type: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
    await waitFor(() => gmaSock.events.some((e) => e.type === 'call.signal' && e.signal.type === 'ice'));

    // An outsider cannot see, signal or end the call.
    const stranger = await env.adult(newPhone(), 'זר');
    expect((await env.call('GET', `/calls/${callId}`, stranger.token)).status).toBe(404);
    expect((await env.call('POST', `/calls/${callId}/signal`, stranger.token, { type: 'offer', sdp: 'x' })).status).toBe(404);
    expect((await env.call('POST', `/calls/${callId}/end`, stranger.token)).status).toBe(404);

    expect((await env.call('POST', `/calls/${callId}/end`, kid.token)).status).toBe(200);
    await waitFor(() => gmaSock.events.some((e) => e.type === 'call.updated' && e.call.status === 'ended'));
    kidSock.ws.close();
    gmaSock.ws.close();
  });

  it('ends a call in progress the moment the parent turns calls off', async () => {
    const { parent, kid, grandma, conv, approvalId } = await setup(true);
    const gmaSock = await openSocket(env, grandma.token);
    const start = await env.call('POST', '/calls', grandma.token, { conversationId: conv, kind: 'audio' });
    await env.call('POST', `/calls/${start.body.call.id}/accept`, kid.token);
    await env.call('PATCH', `/approvals/${approvalId}`, parent.token, { canCall: false });
    await waitFor(() => gmaSock.events.some((e) => e.type === 'call.updated' && e.call.status === 'ended' && e.call.endReason === 'revoked'));
    expect((await env.call('POST', `/calls/${start.body.call.id}/signal`, grandma.token, { type: 'ice', candidate: null })).status).toBe(409);
    gmaSock.ws.close();
  });

  it('ends the call when the parent disconnects the child device', async () => {
    const { parent, familyId, kid, grandma, conv } = await setup(true);
    const gmaSock = await openSocket(env, grandma.token);
    const start = await env.call('POST', '/calls', grandma.token, { conversationId: conv, kind: 'video' });
    await env.call('POST', `/calls/${start.body.call.id}/accept`, kid.token);
    const detail = await env.call('GET', `/families/${familyId}/children/${kid.id}`, parent.token);
    await env.call('POST', `/families/${familyId}/children/${kid.id}/devices/${detail.body.devices[0].id}/revoke`, parent.token);
    await waitFor(() => gmaSock.events.some((e) => e.type === 'call.updated' && e.call.endReason === 'device_revoked'));
    gmaSock.ws.close();
  });

  it('respects quiet hours for contacts but not for parents', async () => {
    const { parent, familyId, kid, grandma, conv } = await setup(true);
    // Quiet hours that cover the whole day.
    await env.call('PATCH', `/families/${familyId}/children/${kid.id}`, parent.token, { quietStartMin: 0, quietEndMin: 1439 });
    const r = await env.call('POST', '/calls', grandma.token, { conversationId: conv, kind: 'audio' });
    expect(r.body.error.code).toBe('quiet_hours');
    const parentConv = await env.dm(parent.token, kid.id);
    const p = await env.call('POST', '/calls', parent.token, { conversationId: parentConv, kind: 'audio' });
    expect(p.status).toBe(200);
    // A second call while one is ringing is refused as busy.
    expect((await env.call('POST', '/calls', parent.token, { conversationId: parentConv, kind: 'audio' })).body.error.code).toBe('busy');
    await env.call('POST', `/calls/${p.body.call.id}/end`, parent.token);
  });

  it('only allows the answering device to signal', async () => {
    const { parent, familyId, kid, grandma, conv } = await setup(true);
    const secondTablet = await env.pairChild(parent.token, familyId, kid.id);
    const start = await env.call('POST', '/calls', grandma.token, { conversationId: conv, kind: 'audio' });
    await env.call('POST', `/calls/${start.body.call.id}/accept`, kid.token);
    const r = await env.call('POST', `/calls/${start.body.call.id}/signal`, secondTablet, { type: 'answer', sdp: 'x' });
    expect(r.status).toBe(403);
    await env.call('POST', `/calls/${start.body.call.id}/end`, grandma.token);
  });

  it('issues short-lived TURN credentials when a shared secret is configured', async () => {
    const { iceServers } = await import('../src/routes/calls.js');
    const ctx = { ...env.ctx, config: { ...env.ctx.config, webrtc: { stunUrls: [], turn: { urls: ['turn:turn.example.com:3478'], secret: 's3cret' } } } };
    const [turn] = iceServers(ctx, 'user-1');
    expect(turn!.urls).toEqual(['turn:turn.example.com:3478']);
    expect(turn!.username).toMatch(/^\d+:user-1$/);
    expect(turn!.credential).toBeTruthy();
  });
});
