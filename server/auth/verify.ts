/**
 * Management key verification.
 *
 * A request presents CLIProxyAPI's management key (`Authorization: Bearer` or `X-Management-Key`).
 * CPA bans an IP for 30 minutes after 5 failed management logins, and this server shares one IP
 * with everything else talking to CPA (the collector included), so wrong keys must almost never
 * reach CPA. Check order:
 *
 *   1. empty key                          → 401, no CPA call
 *   2. positive cache (sha256, 5 min)     → ok
 *   3. negative cache (sha256, 10 min)    → 401, no CPA call
 *   4. constant-time compare with CPA_MANAGEMENT_KEY → ok, no CPA call
 *   5. per-client-IP limiter (5 CPA verifications / 10 min) → 429 `login_rate_limited`
 *   6. global failure budget (≤3 CPA rejections / 30 min, below CPA's ban threshold) → 429
 *   7. `GET /v0/management/config` with the key (5 s timeout)
 *        200 → ok (cached); 401 → 401 (cached, budget spent); 403 → 503 `cpa_forbidden`;
 *        network/timeout → 502 `cpa_unreachable`; anything else → 502 `cpa_error`.
 *
 * The client IP is the socket peer; X-Forwarded-For is never trusted.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Config } from '../config.ts';
import type { Logger } from '../log.ts';
import { CpaNetworkError, cpaErrorMessage, cpaRequest, noteCpaVersion, readCpaBody } from './cpa.ts';
import type { AuthResult, RequireAuth } from './types.ts';

export const OK_TTL_MS = 5 * 60_000;
export const BAD_TTL_MS = 10 * 60_000;
export const IP_WINDOW_MS = 10 * 60_000;
export const IP_MAX_ATTEMPTS = 5;
export const BUDGET_WINDOW_MS = 30 * 60_000;
export const BUDGET_MAX_FAILURES = 3;
export const VERIFY_TIMEOUT_MS = 5000;
const MAX_CACHE_ENTRIES = 1000;
const MAX_TRACKED_IPS = 10_000;

/** The management key a request presents: `Authorization: Bearer <key>` or `X-Management-Key`. */
export function extractManagementKey(req: IncomingMessage): string {
  const authorization = req.headers.authorization;
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  const header = req.headers['x-management-key'];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.trim() ?? '';
}

/** Constant-time string comparison (hashes first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

function keyHash(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** The socket peer address (IPv4-mapped IPv6 normalized). Proxy headers are ignored on purpose. */
export function clientIp(req: IncomingMessage): string {
  const address = req.socket.remoteAddress ?? 'unknown';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

/** Map of key → expiry with a size bound (oldest insertion evicted first). */
class TtlSet {
  readonly #entries = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #max: number;
  constructor(ttlMs: number, max: number) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }
  has(key: string, now: number): boolean {
    const expires = this.#entries.get(key);
    if (expires === undefined) return false;
    if (expires <= now) {
      this.#entries.delete(key);
      return false;
    }
    return true;
  }
  add(key: string, now: number): void {
    this.#entries.delete(key);
    if (this.#entries.size >= this.#max) {
      for (const [k, expires] of this.#entries) if (expires <= now) this.#entries.delete(k);
      while (this.#entries.size >= this.#max) {
        const oldest = this.#entries.keys().next().value;
        if (oldest === undefined) break;
        this.#entries.delete(oldest);
      }
    }
    this.#entries.set(key, now + this.#ttlMs);
  }
  delete(key: string): void {
    this.#entries.delete(key);
  }
  get size(): number {
    return this.#entries.size;
  }
}

/** Extra controls on the verifier (used by the CPA forwarder and tests). */
export interface AuthVerifierControls {
  /**
   * CPA rejected `key` on a forwarded call although it was accepted earlier: forget the positive
   * cache entry, remember it as bad and charge the failure budget (CPA counted the failure).
   */
  invalidate(key: string): void;
  /** Counters for tests and diagnostics. */
  stats(): { cpaCalls: number; okCached: number; badCached: number; budgetUsed: number };
}

export type AuthVerifier = RequireAuth & AuthVerifierControls;

export interface AuthVerifierDeps {
  config: Config;
  log: Logger;
  /** Clock override for tests. */
  now?: () => number;
}

export function createAuthVerifier(deps: AuthVerifierDeps): AuthVerifier {
  const { config, log } = deps;
  const now = deps.now ?? Date.now;
  const okCache = new TtlSet(OK_TTL_MS, MAX_CACHE_ENTRIES);
  const badCache = new TtlSet(BAD_TTL_MS, MAX_CACHE_ENTRIES);
  const ipAttempts = new Map<string, number[]>();
  /** Times of CPA rejections (401) inside the budget window. */
  let failures: number[] = [];
  /** Verifications in flight; reserved against the budget so concurrent wrong keys can't overshoot it. */
  let inflightCount = 0;
  const inflight = new Map<string, Promise<AuthResult>>();
  let cpaCalls = 0;

  const pruneFailures = (t: number) => {
    failures = failures.filter((at) => at > t - BUDGET_WINDOW_MS);
  };

  const recordFailure = (t: number) => {
    failures.push(t);
    pruneFailures(t);
  };

  /** Returns seconds to wait when the IP is over its limit, else records the attempt. */
  const takeIpAttempt = (ip: string, t: number): number | null => {
    const recent = (ipAttempts.get(ip) ?? []).filter((at) => at > t - IP_WINDOW_MS);
    if (recent.length >= IP_MAX_ATTEMPTS) {
      ipAttempts.set(ip, recent);
      return Math.max(1, Math.ceil((recent[0] + IP_WINDOW_MS - t) / 1000));
    }
    recent.push(t);
    ipAttempts.delete(ip);
    if (ipAttempts.size >= MAX_TRACKED_IPS) {
      for (const [k, times] of ipAttempts) if (times.every((at) => at <= t - IP_WINDOW_MS)) ipAttempts.delete(k);
      while (ipAttempts.size >= MAX_TRACKED_IPS) {
        const oldest = ipAttempts.keys().next().value;
        if (oldest === undefined) break;
        ipAttempts.delete(oldest);
      }
    }
    ipAttempts.set(ip, recent);
    return null;
  };

  const refundIpAttempt = (ip: string) => {
    const times = ipAttempts.get(ip);
    if (times && times.length > 0) times.pop();
  };

  const rateLimited = (retryAfterS: number, error: string): AuthResult => ({
    ok: false,
    status: 429,
    code: 'login_rate_limited',
    error,
    retryAfterS,
  });

  const verifyWithCpa = async (key: string, hash: string): Promise<AuthResult> => {
    cpaCalls++;
    let res: IncomingMessage;
    try {
      res = await cpaRequest(config, {
        method: 'GET',
        path: '/v0/management/config',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        timeoutMs: VERIFY_TIMEOUT_MS,
      });
    } catch (err) {
      const message = err instanceof CpaNetworkError ? err.message : 'cannot reach CLIProxyAPI';
      log.warn('key verification: CLIProxyAPI unreachable', { error: message });
      return { ok: false, status: 502, code: 'cpa_unreachable', error: message };
    }
    noteCpaVersion(config.cpaUrl, res.headers);
    const status = res.statusCode ?? 0;
    const body = await readCpaBody(res);
    const t = now();
    if (status === 200) {
      okCache.add(hash, t);
      badCache.delete(hash);
      return { ok: true, key };
    }
    if (status === 401) {
      badCache.add(hash, t);
      recordFailure(t);
      log.warn('key verification: CLIProxyAPI rejected a management key', {
        budget_used: failures.length,
        budget_max: BUDGET_MAX_FAILURES,
      });
      return { ok: false, status: 401, code: 'invalid_management_key', error: 'invalid management key' };
    }
    if (status === 403) {
      const reason = cpaErrorMessage(body) || 'forbidden';
      log.warn('key verification: CLIProxyAPI refused management access', { reason });
      return {
        ok: false,
        status: 503,
        code: 'cpa_forbidden',
        error:
          `CLIProxyAPI refused management access: ${reason}. CLIProxyAPI only allows management from ` +
          'loopback unless remote-management.allow-remote is true or MANAGEMENT_PASSWORD is set, and this ' +
          'server is not loopback when it runs in Docker. If CLIProxyAPI banned this IP after failed ' +
          'attempts, wait 30 minutes.',
      };
    }
    log.warn('key verification: unexpected CLIProxyAPI response', { status });
    return { ok: false, status: 502, code: 'cpa_error', error: `CLIProxyAPI answered HTTP ${status}` };
  };

  const verifier = async (req: IncomingMessage): Promise<AuthResult> => {
    const key = extractManagementKey(req);
    if (!key) return { ok: false, status: 401, code: 'missing_management_key', error: 'management key required' };
    const t = now();
    const hash = keyHash(key);
    if (okCache.has(hash, t)) return { ok: true, key };
    if (badCache.has(hash, t)) return { ok: false, status: 401, code: 'invalid_management_key', error: 'invalid management key' };
    if (config.cpaManagementKey && safeEqual(key, config.cpaManagementKey)) return { ok: true, key };

    // Same key already being verified: share the result instead of a second CPA call.
    const pending = inflight.get(hash);
    if (pending) return pending;

    const ip = clientIp(req);
    const ipWait = takeIpAttempt(ip, t);
    if (ipWait !== null) return rateLimited(ipWait, 'too many sign-in attempts from this address; try again later');

    pruneFailures(t);
    if (failures.length + inflightCount >= BUDGET_MAX_FAILURES) {
      refundIpAttempt(ip);
      const retry = failures.length > 0 ? Math.ceil((failures[0] + BUDGET_WINDOW_MS - t) / 1000) : 5;
      log.warn('key verification: failure budget exhausted, not asking CLIProxyAPI');
      return rateLimited(
        Math.max(1, retry),
        'too many failed sign-ins; waiting so CLIProxyAPI does not ban this server — try again later',
      );
    }

    inflightCount++;
    const promise = verifyWithCpa(key, hash).finally(() => {
      inflightCount--;
      inflight.delete(hash);
    });
    inflight.set(hash, promise);
    const result = await promise;
    if (result.ok) refundIpAttempt(ip);
    return result;
  };

  return Object.assign(verifier, {
    invalidate(key: string) {
      const t = now();
      const hash = keyHash(key);
      okCache.delete(hash);
      badCache.add(hash, t);
      recordFailure(t);
      log.warn('CLIProxyAPI rejected a previously accepted management key; signed out');
    },
    stats() {
      pruneFailures(now());
      return { cpaCalls, okCached: okCache.size, badCached: badCache.size, budgetUsed: failures.length };
    },
  });
}
