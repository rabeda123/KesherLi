import type { FastifyInstance } from 'fastify';
import { userForToken } from '../auth.js';
import type { Ctx } from '../context.js';

/**
 * Real-time channel. The token is sent as the first message rather than in
 * the URL so it does not end up in proxy or access logs. The socket only
 * carries notifications; all data is read and written through the REST API.
 */
export async function wsRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/ws', { websocket: true }, (socket, req) => {
    let unregister: (() => void) | null = null;
    const authTimeout = setTimeout(() => socket.close(4000, 'auth timeout'), 5000);

    socket.on('message', async (raw) => {
      if (unregister) return; // Clients do not send anything after auth.
      clearTimeout(authTimeout);
      let token = '';
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === 'auth' && typeof msg.token === 'string') token = msg.token;
      } catch {
        /* fall through */
      }
      const user = token ? await userForToken(ctx, token) : null;
      if (!user) {
        socket.close(4001, 'unauthenticated');
        return;
      }
      unregister = ctx.hub.add({ socket, userId: user.id, deviceId: user.deviceId });
      socket.send(JSON.stringify({ type: 'ready', userId: user.id }));
    });

    const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 30_000);
    socket.on('close', () => {
      clearTimeout(authTimeout);
      clearInterval(ping);
      unregister?.();
    });
    socket.on('error', (err) => req.log.debug({ err }, 'ws error'));
  });
}
