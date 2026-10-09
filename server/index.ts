/**
 * CPA Usage server.
 *
 *   node --env-file-if-exists=.env --disable-warning=ExperimentalWarning server/index.ts [--dev]
 *
 * `.env` is also loaded in-process (never overriding set variables), so `npm run dev` can use
 * `node --watch-path` without `--env-file` (see `loadDotEnv`).
 *
 * Startup: config → db → pricing → collector → retention → analytics pool → routes → http.
 * SIGTERM / SIGINT shut down in reverse: stop accepting requests, stop the collector (flushing its
 * buffer), close workers, then checkpoint the WAL and close the database.
 */
import { createAuthVerifier } from './auth/verify.ts';
import { createAnalyticsPool } from './analytics/pool.ts';
import { startCollector } from './collector/index.ts';
import { ConfigError, loadConfig, loadDotEnv, redactedConfig, type Config } from './config.ts';
import type { AppContext } from './context.ts';
import { closeDatabase, openDatabase } from './db/open.ts';
import { SCHEMA_VERSION } from './db/migrations.ts';
import { startRetention } from './db/retention.ts';
import { Router } from './http/router.ts';
import { startHttp, type HttpHandle } from './http/server.ts';
import { createLogger } from './log.ts';
import { startPricing } from './pricing/index.ts';
import { registerRoutes } from './routes.ts';

const SHUTDOWN_TIMEOUT_MS = 12_000;

async function main(): Promise<void> {
  let config: Config;
  try {
    loadDotEnv();
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`config error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const log = createLogger(config.logLevel);
  log.info('starting CPA Usage', { node: process.version, ...redactedConfig(config) });

  const db = openDatabase(config.dbPath);
  log.info('database ready', { path: config.dbPath, schema: SCHEMA_VERSION });

  const ctx: AppContext = {
    config,
    log,
    db,
    router: new Router(),
    startedAtMs: Date.now(),
    requireAuth: createAuthVerifier({ config, log: log.child('auth') }),
  };

  let http: HttpHandle | null = null;
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      log.warn(`received ${signal} again, exiting immediately`);
      process.exit(1);
    }
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);
    const force = setTimeout(() => {
      log.error('shutdown timed out, exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    const step = async (name: string, fn: () => unknown) => {
      try {
        await fn();
      } catch (err) {
        log.error(`shutdown: ${name} failed`, { error: err });
      }
    };
    await step('http', () => http?.close(8000));
    await step('collector', () => ctx.collector?.stop());
    await step('analytics', () => ctx.analytics?.close());
    await step('pricing', () => ctx.pricing?.stop());
    await step('retention', () => ctx.retention?.stop());
    await step('database', () => closeDatabase(db));
    clearTimeout(force);
    log.info('bye');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  ctx.pricing = await startPricing(ctx);
  ctx.collector = startCollector(ctx);
  ctx.retention = startRetention(ctx);
  ctx.analytics = createAnalyticsPool(ctx);

  registerRoutes(ctx);
  log.debug('routes', { routes: ctx.router.list() });
  http = await startHttp(ctx);
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
