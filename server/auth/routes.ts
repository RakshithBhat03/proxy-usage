/**
 * Auth-owned routes:
 *   GET  /api/status                          public: CPA host, reachability, version
 *   GET  /api/session                         authenticated: collector, DB, retention, pricing status
 *   GET  /v0/management/auth-files            forwarded to CPA with the caller's key
 *   GET  /v0/management/auth-files/download   forwarded to CPA with the caller's key
 *   POST /v0/management/api-call              forwarded to CPA with the caller's key
 * Every other /v0/* path is 404 (handled by the server's API namespace fallback).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.ts';
import { sendJson } from '../http/respond.ts';
import { withAuth } from '../http/withAuth.ts';
import type { CollectorStatus, SessionResponse, StatusResponse } from '../../shared/session-types.ts';
import { cpaHost, cpaRequest, knownCpaVersion } from './cpa.ts';
import { forwardToCpa } from './forward.ts';

/** How long the public reachability probe result is reused. */
export const STATUS_CACHE_MS = 15_000;
const PROBE_TIMEOUT_MS = 3000;
/** api-call bodies can carry large JSON payloads. */
export const API_CALL_BODY_LIMIT = 8 * 1024 * 1024;

function readAppVersion(rootDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function fallbackCollectorStatus(ctx: AppContext): CollectorStatus {
  return {
    mode: ctx.config.collectorMode,
    transport: 'none',
    state: 'disabled',
    disabled_reason: 'collector not started',
    connected_since_ms: null,
    last_event_at_ms: null,
    last_error: null,
    last_error_at_ms: null,
    next_retry_at_ms: null,
    counts: { received: 0, inserted: 0, duplicates: 0, dead_letters: 0, reconnects: 0 },
    usage_statistics_enabled: null,
    usage_statistics_auto_enabled: false,
    cpa_version: null,
  };
}

/**
 * Reachability probe: `GET {CPA_URL}/` without credentials. CPA's root route is outside the
 * management API, so it never counts toward CPA's failed-login ban.
 */
function createReachabilityProbe(ctx: AppContext): () => Promise<boolean> {
  let cached: { at: number; reachable: boolean } | null = null;
  let pending: Promise<boolean> | null = null;
  return () => {
    const t = Date.now();
    if (cached && t - cached.at < STATUS_CACHE_MS) return Promise.resolve(cached.reachable);
    if (pending) return pending;
    pending = cpaRequest(ctx.config, { method: 'GET', path: '/', headers: { Accept: 'application/json' }, timeoutMs: PROBE_TIMEOUT_MS })
      .then(
        (res) => {
          res.resume();
          return true;
        },
        () => false,
      )
      .then((reachable) => {
        cached = { at: Date.now(), reachable };
        pending = null;
        return reachable;
      });
    return pending;
  };
}

interface DbStatsRow {
  events: number;
  oldest: number | null;
  newest: number | null;
}

function dbStats(ctx: AppContext): SessionResponse['db'] {
  const row = ctx.db
    .prepare('SELECT count(*) AS events, min(timestamp_ms) AS oldest, max(timestamp_ms) AS newest FROM events')
    .get() as unknown as DbStatsRow;
  const pageCount = (ctx.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const pageSize = (ctx.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  return {
    events: Number(row.events),
    oldest_event_ms: row.oldest === null ? null : Number(row.oldest),
    newest_event_ms: row.newest === null ? null : Number(row.newest),
    size_bytes: Number(pageCount) * Number(pageSize),
  };
}

export function registerAuthRoutes(ctx: AppContext): void {
  const appVersion = readAppVersion(ctx.config.rootDir);
  const host = cpaHost(ctx.config.cpaUrl);
  const probe = createReachabilityProbe(ctx);

  ctx.router.get('/api/status', async ({ req, res }) => {
    const reachable = await probe();
    const body: StatusResponse = {
      app_version: appVersion,
      cpa: {
        host,
        reachable,
        version: knownCpaVersion(ctx.config.cpaUrl) ?? ctx.collector?.status().cpa_version ?? null,
      },
    };
    await sendJson(req, res, 200, body);
  });

  ctx.router.get(
    '/api/session',
    withAuth(ctx, async ({ req, res }) => {
      const stats = ctx.pricing?.stats();
      const body: SessionResponse = {
        ok: true,
        collector: ctx.collector?.status() ?? fallbackCollectorStatus(ctx),
        db: dbStats(ctx),
        retention_days: ctx.config.retentionDays,
        prices: { models: stats?.models ?? 0, last_sync_ms: stats?.last_sync_ms ?? stats?.last_sync_at_ms ?? null },
      };
      await sendJson(req, res, 200, body);
    }),
  );

  ctx.router.get(
    '/v0/management/auth-files',
    withAuth(ctx, (rc, auth) => forwardToCpa(ctx, rc, auth, { method: 'GET', path: '/v0/management/auth-files' })),
  );
  ctx.router.get(
    '/v0/management/auth-files/download',
    withAuth(ctx, (rc, auth) => forwardToCpa(ctx, rc, auth, { method: 'GET', path: '/v0/management/auth-files/download' })),
  );
  ctx.router.post(
    '/v0/management/api-call',
    withAuth(ctx, (rc, auth) =>
      forwardToCpa(ctx, rc, auth, { method: 'POST', path: '/v0/management/api-call', bodyLimitBytes: API_CALL_BODY_LIMIT }),
    ),
  );
}
