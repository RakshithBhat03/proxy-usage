/**
 * Usage collector: receives CLIProxyAPI usage records, normalizes them and batches them into
 * `events`. Semantics ported from CPA Manager Plus `collector/` (MIT).
 *
 * Transports (COLLECTOR_MODE):
 *  - `resp` / `auto`: RESP `AUTH` + `SUBSCRIBE usage` on CPA's HTTP port. Pub/sub is fan-out, so it
 *    coexists with other subscribers. PING every 30 s; no data for 75 s → reconnect. After every
 *    successful subscribe the HTTP queue is drained once (records published while disconnected).
 *  - `http` (or `auto` when SUBSCRIBE is unsupported): poll `GET /v0/management/usage-queue`
 *    (destructive pop). In `auto` the RESP upgrade is retried every 5 minutes.
 *
 * Before every (re)connect the collector reads CPA's config: version, `usage-statistics-enabled`
 * (turned on when AUTO_ENABLE_USAGE_STATISTICS) and the queue retention.
 *
 * Failures back off 1 → 30 s with jitter. A rejected key (RESP AUTH error / HTTP 401) backs off
 * 15 minutes and a 403 (CPA's IP ban or remote management disabled) 30 minutes, so the collector
 * can never trip CPA's 5-failure IP ban on its own.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { AppContext } from '../context.ts';
import { CpaClient, CpaHttpError } from '../cpa/client.ts';
import { RespAuthError, RespConnection, RespUnsupportedError } from '../cpa/resp.ts';
import type { Logger } from '../log.ts';
import { AuthSnapshotResolver } from './authSnapshots.ts';
import { NormalizeError, classifyControlPayload, normalizeRecord, type EventRowInsert } from './normalize.ts';
import { redactPayloadForStorage, sanitizeCredentialText, truncateChars } from './redact.ts';
import type { CollectorHandle, CollectorStatus } from './types.ts';
import { EventWriter } from './writer.ts';

export const USAGE_CHANNEL = 'usage';
export const DEAD_LETTER_CAP = 1000;

export interface CollectorTimings {
  pingIntervalMs: number;
  idleTimeoutMs: number;
  upgradeIntervalMs: number;
  authFailureDelayMs: number;
  forbiddenDelayMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  drainBatch: number;
  random: () => number;
}

export const DEFAULT_TIMINGS: CollectorTimings = {
  pingIntervalMs: 30_000,
  idleTimeoutMs: 75_000,
  upgradeIntervalMs: 5 * 60_000,
  authFailureDelayMs: 15 * 60_000,
  forbiddenDelayMs: 30 * 60_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  drainBatch: 500,
  random: Math.random,
};

function emptyStatus(mode: CollectorStatus['mode']): CollectorStatus {
  return {
    mode,
    transport: 'none',
    state: 'starting',
    disabled_reason: null,
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

function disabledHandle(mode: CollectorStatus['mode'], reason: string, log: Logger): CollectorHandle {
  const status = { ...emptyStatus(mode), state: 'disabled' as const, disabled_reason: reason };
  log.warn(`collector disabled: ${reason}`);
  return {
    status: () => structuredClone(status),
    stop: async () => {},
  };
}

/** Reads `usage-statistics-enabled` from a config object (top level, or v8 `observability.usage`). */
export function readUsageStatisticsFlag(config: Record<string, unknown> | null | undefined): boolean | null {
  if (!config || typeof config !== 'object') return null;
  const top = config['usage-statistics-enabled'];
  if (typeof top === 'boolean') return top;
  const obs = config.observability as Record<string, unknown> | undefined;
  if (obs && typeof obs === 'object') {
    const direct = obs['usage-statistics-enabled'];
    if (typeof direct === 'boolean') return direct;
    const usage = obs.usage as Record<string, unknown> | boolean | undefined;
    if (typeof usage === 'boolean') return usage;
    if (usage && typeof usage === 'object') {
      for (const key of ['enabled', 'usage-statistics-enabled', 'statistics-enabled']) {
        if (typeof usage[key] === 'boolean') return usage[key] as boolean;
      }
    }
  }
  return null;
}

function readRetentionSeconds(config: Record<string, unknown>): number | null {
  const candidates = [
    config['redis-usage-queue-retention-seconds'],
    (config.observability as Record<string, Record<string, unknown>> | undefined)?.usage?.['redis-usage-queue-retention-seconds'],
    (config.observability as Record<string, Record<string, unknown>> | undefined)?.usage?.['queue-retention-seconds'],
  ];
  for (const value of candidates) if (typeof value === 'number' && value > 0) return value;
  return null;
}

type FailureKind = 'auth' | 'forbidden' | 'transient';

function classifyFailure(err: unknown): FailureKind {
  if (err instanceof RespAuthError) return /\bban|too many/i.test(err.message) ? 'forbidden' : 'auth';
  if (err instanceof CpaHttpError) {
    if (err.status === 401) return 'auth';
    if (err.status === 403) return 'forbidden';
  }
  return 'transient';
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return truncateChars(sanitizeCredentialText(message).replace(/\s+/g, ' '), 300);
}

class DeadLetters {
  private insert: StatementSync | null = null;
  private trim: StatementSync | null = null;
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  add(source: string, payload: string, error: string): void {
    this.insert ??= this.db.prepare('INSERT INTO dead_letters (source, payload, error, created_at_ms) VALUES (?, ?, ?, ?)');
    this.trim ??= this.db.prepare('DELETE FROM dead_letters WHERE id <= (SELECT max(id) FROM dead_letters) - ?');
    this.insert.run(source, redactPayloadForStorage(payload), truncateChars(sanitizeCredentialText(error), 500), Date.now());
    this.trim.run(DEAD_LETTER_CAP);
  }
}

class Stopped extends Error {}

export function startCollector(ctx: AppContext, overrides: Partial<CollectorTimings> = {}): CollectorHandle {
  const timings: CollectorTimings = { ...DEFAULT_TIMINGS, ...overrides };
  const { config, db } = ctx;
  const log = ctx.log.child('collector');
  const mode = config.collectorMode;
  if (mode === 'off') return disabledHandle(mode, 'COLLECTOR_MODE=off', log);
  if (!config.cpaManagementKey) return disabledHandle(mode, 'CPA_MANAGEMENT_KEY is not set', log);

  const status = emptyStatus(mode);
  const client = new CpaClient({ baseUrl: config.cpaUrl, managementKey: config.cpaManagementKey, tlsInsecure: config.cpaTlsInsecure });
  const snapshots = new AuthSnapshotResolver({ db, client, log: log.child('auth-files') });
  const deadLetters = new DeadLetters(db);
  const writer = new EventWriter({
    db,
    log,
    pricing: () => ctx.pricing,
    onFlushed: (result, rows) => {
      status.counts.inserted += result.inserted;
      status.counts.duplicates += result.duplicates;
      for (const row of rows) if (row.auth_index && !row.auth_file_snapshot) snapshots.markDirty(row.auth_index);
    },
  });

  const abort = new AbortController();
  let stopped = false;
  let connection: RespConnection | null = null;
  let pipeline: Promise<void> = Promise.resolve();
  let retentionSeconds: number | null = null;
  let snapshotsPrimed = false;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (stopped) return resolve();
      const done = () => {
        clearTimeout(timer);
        abort.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      abort.signal.addEventListener('abort', done, { once: true });
    });

  const checkStopped = () => {
    if (stopped) throw new Stopped();
  };

  /** Normalizes, enriches and queues records; processing is serialized. */
  const processItems = (items: string[], source: 'resp' | 'http'): Promise<void> => {
    const job = pipeline.then(async () => {
      const rows: EventRowInsert[] = [];
      const now = Date.now();
      for (const item of items) {
        const payload = item.trim();
        if (!payload) continue;
        const control = classifyControlPayload(payload);
        if (control === 'refresh') {
          snapshots.clear();
          continue;
        }
        if (control) continue;
        status.counts.received++;
        status.last_event_at_ms = now;
        try {
          rows.push(normalizeRecord(payload, now));
        } catch (err) {
          status.counts.dead_letters++;
          const message = err instanceof NormalizeError ? err.message : `normalize failed: ${(err as Error).message}`;
          try {
            deadLetters.add(source, payload, message);
          } catch (dlErr) {
            log.error('dead letter write failed', { error: dlErr as Error });
          }
          log.warn('usage record rejected', { error: message });
        }
      }
      if (rows.length === 0) return;
      try {
        await snapshots.enrich(rows);
      } catch (err) {
        log.warn('auth snapshot enrichment failed', { error: err as Error });
      }
      writer.enqueue(rows);
    });
    pipeline = job.catch((err: unknown) => log.error('usage processing failed', { error: err as Error }));
    return pipeline;
  };

  const markError = (err: unknown, retryInMs: number, state: CollectorStatus['state']) => {
    status.state = state;
    status.transport = 'none';
    status.connected_since_ms = null;
    status.last_error = errorMessage(err);
    status.last_error_at_ms = Date.now();
    status.next_retry_at_ms = Date.now() + retryInMs;
  };

  const markConnected = (transport: 'resp' | 'http') => {
    status.state = 'running';
    status.transport = transport;
    status.connected_since_ms = Date.now();
    status.next_retry_at_ms = null;
    status.counts.reconnects++;
  };

  async function preflight(): Promise<void> {
    const { data, version } = await client.getConfig(abort.signal);
    checkStopped();
    status.cpa_version = version ?? client.lastVersion ?? status.cpa_version;
    let enabled = readUsageStatisticsFlag(data);
    if (enabled === null) {
      try {
        enabled = await client.getUsageStatisticsEnabled(abort.signal);
      } catch (err) {
        if (classifyFailure(err) !== 'transient') throw err;
        log.debug('usage-statistics-enabled endpoint unavailable', { error: errorMessage(err) });
      }
    }
    status.usage_statistics_enabled = enabled;
    if (enabled === false) {
      if (config.autoEnableUsageStatistics) {
        await client.setUsageStatisticsEnabled(true, abort.signal);
        status.usage_statistics_enabled = true;
        status.usage_statistics_auto_enabled = true;
        log.warn('usage-statistics-enabled was off on CLIProxyAPI; turned it on (AUTO_ENABLE_USAGE_STATISTICS=false opts out)');
      } else {
        log.warn('usage-statistics-enabled is off on CLIProxyAPI: it publishes no usage records until it is turned on');
      }
    }
    const retention = readRetentionSeconds(data);
    if (retention !== retentionSeconds) {
      retentionSeconds = retention;
      if (retention !== null) log.info('CLIProxyAPI usage queue retention', { seconds: retention });
    }
    if (!snapshotsPrimed) {
      snapshotsPrimed = true;
      // Labels for the credential list and a backfill of rows stored without them.
      void snapshots.refresh(true);
    }
  }

  /** Drains the HTTP queue once (records queued while we were not subscribed). */
  async function drainQueue(): Promise<void> {
    let drained = 0;
    for (let round = 0; round < 1000 && !stopped; round++) {
      const items = await client.popUsageQueue(timings.drainBatch, abort.signal);
      if (items === null) {
        log.debug('CLIProxyAPI has no HTTP usage queue; skipping drain');
        return;
      }
      if (items.length > 0) {
        drained += items.length;
        await processItems(items, 'http');
      }
      if (items.length < timings.drainBatch) break;
    }
    if (drained > 0) log.info('drained queued usage records', { count: drained });
  }

  /** One RESP session. Resolves 'unsupported' when CPA has no SUBSCRIBE; throws when it drops. */
  async function runResp(): Promise<'unsupported' | 'stopped'> {
    const conn = await RespConnection.connect({ url: config.cpaUrl, tlsInsecure: config.cpaTlsInsecure });
    connection = conn;
    try {
      checkStopped();
      await conn.auth(config.cpaManagementKey);
      checkStopped();
      await conn.subscribe(USAGE_CHANNEL);
    } catch (err) {
      conn.close();
      connection = null;
      if (err instanceof RespUnsupportedError) return 'unsupported';
      throw err;
    }
    conn.onMessage = ({ channel, payload }) => {
      if (channel === USAGE_CHANNEL) void processItems([payload], 'resp');
    };
    markConnected('resp');
    log.info('subscribed (resp)', { channel: USAGE_CHANNEL, cpa_version: status.cpa_version });

    drainQueue().catch((err: unknown) => {
      if (stopped) return;
      log.warn('usage queue drain failed', { error: errorMessage(err) });
    });

    const ping = setInterval(() => conn.ping(), timings.pingIntervalMs);
    const idle = setInterval(() => {
      if (Date.now() - conn.lastDataAt > timings.idleTimeoutMs) {
        conn.close(new Error(`no data from CLIProxyAPI for ${Math.round(timings.idleTimeoutMs / 1000)} s`));
      }
    }, Math.min(5_000, timings.idleTimeoutMs));
    const reason = await conn.closed();
    clearInterval(ping);
    clearInterval(idle);
    connection = null;
    status.connected_since_ms = null;
    status.transport = 'none';
    if (stopped) return 'stopped';
    throw reason ?? new Error('RESP connection closed');
  }

  /** HTTP polling. Resolves 'upgrade' when it is time to retry RESP (auto mode). */
  async function runHttp(upgradeable: boolean): Promise<'upgrade' | 'stopped'> {
    const upgradeAt = Date.now() + timings.upgradeIntervalMs;
    let connected = false;
    let warned = false;
    while (!stopped) {
      const items = await client.popUsageQueue(config.collectorBatch, abort.signal);
      if (items === null) throw new Error('CLIProxyAPI has no usage queue endpoint (GET /v0/management/usage-queue → 404)');
      if (!connected) {
        connected = true;
        markConnected('http');
        log.info('polling usage queue (http)', { interval_ms: config.collectorPollMs, batch: config.collectorBatch });
      }
      if (!warned && retentionSeconds !== null && config.collectorPollMs / 1000 > retentionSeconds) {
        warned = true;
        log.warn('COLLECTOR_POLL_MS exceeds CLIProxyAPI queue retention; records may expire before they are polled', {
          poll_ms: config.collectorPollMs,
          retention_seconds: retentionSeconds,
        });
      }
      if (items.length > 0) await processItems(items, 'http');
      if (upgradeable && Date.now() >= upgradeAt) return 'upgrade';
      if (items.length < config.collectorBatch) await sleep(config.collectorPollMs);
    }
    return 'stopped';
  }

  async function loop(): Promise<void> {
    let attempt = 0;
    const backoff = () => {
      const base = Math.min(timings.backoffMaxMs, timings.backoffBaseMs * 2 ** attempt);
      attempt++;
      return Math.round(base * (0.8 + 0.4 * timings.random()));
    };
    while (!stopped) {
      let connectedThisRound = false;
      try {
        await preflight();
        if (mode === 'http') {
          await runHttp(false);
        } else {
          const countBefore = status.counts.reconnects;
          let outcome: 'unsupported' | 'stopped';
          try {
            outcome = await runResp();
          } finally {
            connectedThisRound = status.counts.reconnects > countBefore;
          }
          if (outcome === 'unsupported') {
            if (mode === 'resp') throw new Error('CLIProxyAPI does not support RESP SUBSCRIBE (COLLECTOR_MODE=resp)');
            log.warn('RESP SUBSCRIBE unsupported; falling back to HTTP polling', {
              retry_resp_in_s: Math.round(timings.upgradeIntervalMs / 1000),
            });
            const result = await runHttp(true);
            attempt = 0;
            if (result === 'upgrade') log.info('retrying RESP SUBSCRIBE');
          }
        }
      } catch (err) {
        if (stopped || err instanceof Stopped) break;
        if (connectedThisRound) attempt = 0;
        const kind = classifyFailure(err);
        if (kind === 'auth') {
          const delay = timings.authFailureDelayMs;
          markError(err, delay, 'auth_failed');
          log.error('CLIProxyAPI rejected the management key; retrying later to avoid its IP ban', {
            error: status.last_error,
            retry_in_s: Math.round(delay / 1000),
          });
          await sleep(delay);
          continue;
        }
        if (kind === 'forbidden') {
          const delay = timings.forbiddenDelayMs + Math.round(timings.random() * Math.min(60_000, timings.forbiddenDelayMs * 0.05));
          markError(err, delay, 'backoff');
          log.error('CLIProxyAPI refused access (403: IP ban or remote management disabled); waiting it out', {
            error: status.last_error,
            retry_in_s: Math.round(delay / 1000),
          });
          await sleep(delay);
          continue;
        }
        const delay = backoff();
        markError(err, delay, 'backoff');
        log.warn('collector connection failed; retrying', { error: status.last_error, retry_in_ms: delay });
        await sleep(delay);
      }
    }
  }

  log.info('collector starting', { mode, cpa: config.cpaUrl });
  const running = loop().catch((err: unknown) => {
    log.error('collector loop crashed', { error: err as Error });
    status.state = 'backoff';
    status.last_error = errorMessage(err);
    status.last_error_at_ms = Date.now();
  });

  return {
    status: () => structuredClone(status),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      abort.abort();
      connection?.close(new Error('collector stopped'));
      await running;
      await pipeline;
      const result = writer.stop();
      client.close();
      status.state = 'stopped';
      status.transport = 'none';
      status.connected_since_ms = null;
      status.next_retry_at_ms = null;
      log.info('collector stopped', { flushed: result.inserted + result.duplicates, ...writer.totals });
    },
  };
}

export type { CollectorHandle };
