/**
 * Status page route:
 *   GET /api/system[?refresh=1]   authenticated: CLIProxyAPI build, update check and runtime
 *                                 settings, collector, database, retention, price book and process health
 *
 * The update check asks CLIProxyAPI itself (`GET /v0/management/latest-version`, which reads the
 * newest GitHub release) with the caller's already-verified key. CPA calls GitHub for every check,
 * so the answer is cached for 30 minutes; `?refresh=1` forces a new check at most every 30 seconds.
 */
import { statSync } from 'node:fs';
import type { AppContext } from '../context.ts';
import { SCHEMA_VERSION } from '../db/migrations.ts';
import { sendJson } from '../http/respond.ts';
import { withAuth } from '../http/withAuth.ts';
import { fallbackCollectorStatus, readAppVersion } from '../auth/routes.ts';
import { cpaErrorMessage, cpaHost, cpaRequest, knownCpaBuild, noteCpaVersion, readCpaBody } from '../auth/cpa.ts';
import type { AuthVerifierControls } from '../auth/verify.ts';
import { createRuntimeReader } from './runtime.ts';
import { compareVersions, versionTag } from '../../shared/version.ts';
import type { CpaSystemStatus, DbSystemStatus, SystemResponse } from '../../shared/system-types.ts';

export const LATEST_TTL_MS = 30 * 60_000;
export const LATEST_MIN_INTERVAL_MS = 30_000;
const LATEST_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 3000;
const RELEASES_URL = 'https://github.com/router-for-me/CLIProxyAPI/releases';
const HOUR_MS = 3_600_000;

interface LatestCheck {
  at: number;
  version: string | null;
  error: string | null;
}

/** `{"latest-version":"v8.0.24"}` (and the spellings other versions may use). */
export function latestFromBody(body: string): string | null {
  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    for (const key of ['latest-version', 'latest_version', 'latestVersion', 'version']) {
      const value = data?.[key];
      if (typeof value === 'string' && value.trim() && value.length <= 64) return value.trim();
    }
  } catch {
    // Not JSON.
  }
  return null;
}

function createLatestChecker(ctx: AppContext) {
  const log = ctx.log.child('system');
  let last: LatestCheck | null = null;
  let pending: Promise<LatestCheck> | null = null;

  const check = async (key: string): Promise<LatestCheck> => {
    const at = Date.now();
    try {
      const res = await cpaRequest(ctx.config, {
        method: 'GET',
        path: '/v0/management/latest-version',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        timeoutMs: LATEST_TIMEOUT_MS,
      });
      noteCpaVersion(ctx.config.cpaUrl, res.headers);
      const body = await readCpaBody(res);
      const status = res.statusCode ?? 0;
      if (status === 401) {
        (ctx.requireAuth as Partial<AuthVerifierControls>).invalidate?.(key);
        return { at, version: null, error: 'CLIProxyAPI rejected the management key' };
      }
      if (status === 404) return { at, version: null, error: 'this CLIProxyAPI version has no update check' };
      if (status < 200 || status >= 300) return { at, version: null, error: cpaErrorMessage(body) || `HTTP ${status}` };
      const version = latestFromBody(body);
      return { at, version, error: version ? null : 'unexpected latest-version response' };
    } catch (err) {
      log.debug('latest-version check failed', { error: err });
      return { at, version: null, error: (err as Error).message };
    }
  };

  return (key: string, refresh: boolean): Promise<LatestCheck> => {
    const now = Date.now();
    const age = last ? now - last.at : Infinity;
    if (last && (age < LATEST_MIN_INTERVAL_MS || (!refresh && age < LATEST_TTL_MS && !last.error))) {
      return Promise.resolve(last);
    }
    pending ??= check(key).then((result) => {
      // Keep the last good answer when a later check fails.
      last = result.version || !last?.version ? result : { ...last, at: result.at, error: result.error };
      pending = null;
      return last;
    });
    return pending;
  };
}

/** Unauthenticated `GET /` (outside the management API, never counts toward CPA's login ban). */
async function probeCpa(ctx: AppContext): Promise<{ reachable: boolean; latencyMs: number | null }> {
  const started = performance.now();
  try {
    const res = await cpaRequest(ctx.config, { method: 'GET', path: '/', headers: { Accept: 'application/json' }, timeoutMs: PROBE_TIMEOUT_MS });
    res.resume();
    return { reachable: true, latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { reachable: false, latencyMs: null };
  }
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function dbStatus(ctx: AppContext, now: number): DbSystemStatus {
  const { db } = ctx;
  const row = db
    .prepare(
      `SELECT count(*) AS events, min(timestamp_ms) AS oldest, max(timestamp_ms) AS newest,
              count(*) FILTER (WHERE timestamp_ms >= ?) AS last_day,
              count(*) FILTER (WHERE timestamp_ms >= ?) AS last_hour
         FROM events`,
    )
    .get(now - 24 * HOUR_MS, now - HOUR_MS) as Record<string, number | null>;
  const deadLetters = db.prepare('SELECT count(*) AS n FROM dead_letters').get() as { n: number };
  const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  return {
    events: Number(row.events),
    oldest_event_ms: row.oldest === null ? null : Number(row.oldest),
    newest_event_ms: row.newest === null ? null : Number(row.newest),
    events_last_hour: Number(row.last_hour),
    events_last_day: Number(row.last_day),
    size_bytes: Number(pageCount) * Number(pageSize),
    wal_bytes: ctx.config.dbPath === ':memory:' ? 0 : fileSize(`${ctx.config.dbPath}-wal`),
    dead_letters: Number(deadLetters.n),
    schema_version: SCHEMA_VERSION,
  };
}

export function registerSystemRoutes(ctx: AppContext): void {
  const appVersion = readAppVersion(ctx.config.rootDir);
  const host = cpaHost(ctx.config.cpaUrl);
  const latest = createLatestChecker(ctx);
  const runtime = createRuntimeReader(ctx);

  ctx.router.get(
    '/api/system',
    withAuth(ctx, async ({ req, res, url }, auth) => {
      const refresh = url.searchParams.get('refresh') === '1';
      const [probe, check, settings] = await Promise.all([probeCpa(ctx), latest(auth.key, refresh), runtime(auth.key, refresh)]);
      const now = Date.now();
      const collector = ctx.collector?.status() ?? null;
      const build = knownCpaBuild(ctx.config.cpaUrl);
      const version = build?.version ?? collector?.cpa_version ?? null;
      const order = compareVersions(version, check.version);
      const cpa: CpaSystemStatus = {
        host,
        reachable: probe.reachable,
        latency_ms: probe.latencyMs,
        version,
        commit: build?.commit ?? null,
        build_date: build?.buildDate ?? null,
        latest_version: check.version,
        latest_checked_at_ms: check.at,
        latest_error: check.error,
        update_available: order === null ? null : order < 0,
        release_url: check.version ? `${RELEASES_URL}/tag/${versionTag(check.version)}` : RELEASES_URL,
        runtime: settings.config,
        runtime_error: settings.error,
        error_log_files: settings.error_log_files,
      };
      const memory = process.memoryUsage();
      const stats = ctx.pricing?.stats();
      const retention = ctx.retention?.status();
      const body: SystemResponse = {
        checked_at_ms: now,
        cpa,
        app: {
          version: appVersion,
          node_version: process.version,
          platform: process.platform,
          arch: process.arch,
          mode: ctx.config.dev ? 'dev' : 'production',
          started_at_ms: ctx.startedAtMs,
          memory: { rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed },
          analytics_workers: ctx.analytics?.size ?? 0,
          log_level: ctx.config.logLevel,
        },
        collector: collector ?? fallbackCollectorStatus(ctx),
        db: dbStatus(ctx, now),
        retention: retention ? { ...retention } : null,
        pricing: stats
          ? {
              models: stats.models,
              synced_models: stats.synced_models,
              manual_models: stats.manual_models,
              last_sync_at_ms: stats.last_sync_at_ms ?? stats.last_sync_ms,
              last_sync_error: stats.last_sync_error,
              unpriced_events: stats.unpriced_events,
              sync_interval_hours: ctx.config.priceSyncIntervalHours,
            }
          : null,
      };
      await sendJson(req, res, 200, body);
    }),
  );
}
