import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { runMaintenance } from './jobs.js';

const config = loadConfig();
await migrate(config.databaseUrl);
const db = createPool(config.databaseUrl);
const { app, ctx } = await buildApp(config, db);

if (config.sms.provider === 'console') {
  app.log.warn('SMS_PROVIDER=console: codes and invitations are written to this log, not sent. Development only.');
}

const timer = setInterval(() => {
  runMaintenance(ctx).then(
    (r) => r.messagesDeleted && app.log.info(r, 'retention maintenance'),
    (err) => app.log.error({ err }, 'maintenance failed'),
  );
}, 15 * 60_000);
void runMaintenance(ctx).catch((err) => app.log.error({ err }, 'maintenance failed'));

const shutdown = async () => {
  clearInterval(timer);
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: config.host, port: config.port });
