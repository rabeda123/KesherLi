import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from './config.js';
import type { Ctx } from './context.js';
import { AppError } from './lib/errors.js';
import { createPushSender, type PushSender } from './lib/push.js';
import { RateLimiter } from './lib/rateLimit.js';
import { RealtimeHub } from './lib/realtime.js';
import { createSmsSender, type SmsSender } from './lib/sms.js';
import { authRoutes } from './routes/auth.js';
import { contactRoutes } from './routes/contacts.js';
import { conversationRoutes } from './routes/conversations.js';
import { familyRoutes } from './routes/families.js';
import { meRoutes } from './routes/me.js';
import { wsRoutes } from './routes/ws.js';

export type AppOverrides = { sms?: SmsSender; push?: PushSender; logger?: boolean };

export async function buildApp(config: Config, db: pg.Pool, overrides: AppOverrides = {}): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const app = Fastify({
    logger:
      overrides.logger === false
        ? false
        : {
            level: config.env === 'production' ? 'info' : 'debug',
            // Never log credentials.
            redact: ['req.headers.authorization', 'req.headers.cookie'],
          },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
  });

  const ctx: Ctx = {
    config,
    db,
    hub: new RealtimeHub(),
    sms: overrides.sms ?? createSmsSender(config, app.log),
    push: overrides.push ?? createPushSender(config, app.log),
    limiter: new RateLimiter(),
    log: app.log,
  };

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: config.corsOrigins, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] });
  if (config.globalRateLimitPerMin > 0) {
    await app.register(rateLimit, { max: config.globalRateLimitPerMin, timeWindow: '1 minute' });
  }
  await app.register(websocket, { options: { maxPayload: 4096 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: status === 429 ? 'rate_limited' : 'bad_request', message: (err as Error).message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal error' } });
  });

  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { ok: true, sms: ctx.sms.name, push: ctx.push.enabled };
  });

  for (const routes of [authRoutes, meRoutes, familyRoutes, contactRoutes, conversationRoutes, wsRoutes]) {
    await app.register(async (scope) => routes(scope, ctx));
  }

  return { app, ctx };
}
