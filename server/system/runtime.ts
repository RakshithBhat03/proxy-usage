/**
 * CLIProxyAPI runtime settings for the Status page, read with the caller's verified key:
 * `GET /v0/management/config` (reduced to non-secret fields here; the raw body holds keys and is
 * never logged or returned) and `GET /v0/management/request-error-logs` (file count only).
 * Cached for a minute and shared between concurrent requests.
 */
import type { AppContext } from '../context.ts';
import { cpaErrorMessage, cpaRequest, noteCpaVersion, readCpaBody } from '../auth/cpa.ts';
import type { AuthVerifierControls } from '../auth/verify.ts';
import type { CpaRuntimeConfig } from '../../shared/system-types.ts';

export const RUNTIME_TTL_MS = 60_000;
const RUNTIME_MIN_INTERVAL_MS = 5000;
const TIMEOUT_MS = 5000;
const CONFIG_BODY_LIMIT = 4 * 1024 * 1024;

export interface RuntimeRead {
  at: number;
  config: CpaRuntimeConfig | null;
  error: string | null;
  error_log_files: number | null;
}

/** First value found at any of the dotted paths (flat v0 names first, then the v8 nested layout). */
function pick(data: Record<string, unknown>, ...paths: string[]): unknown {
  for (const path of paths) {
    let node: unknown = data;
    for (const part of path.split('.')) {
      node = node && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, unknown>)[part] : undefined;
    }
    if (node !== undefined && node !== null) return node;
  }
  return undefined;
}

const bool = (value: unknown) => (typeof value === 'boolean' ? value : null);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The non-secret settings a status page shows. Never copies keys, URLs or tokens. */
export function runtimeFromConfig(data: Record<string, unknown>): CpaRuntimeConfig {
  const strategy = pick(data, 'routing.strategy', 'routing-strategy');
  const proxy = pick(data, 'proxy-url');
  const apiKeys = pick(data, 'api-keys', 'auth.api-keys');
  return {
    routing_strategy: typeof strategy === 'string' && strategy.trim() ? strategy.trim().slice(0, 40) : null,
    request_retry: num(pick(data, 'request-retry')),
    max_retry_interval_s: num(pick(data, 'max-retry-interval')),
    proxy_configured: typeof proxy === 'string' && proxy.trim() !== '',
    api_keys: Array.isArray(apiKeys) ? apiKeys.length : null,
    usage_queue_retention_s: num(
      pick(data, 'redis-usage-queue-retention-seconds', 'observability.usage.redis-usage-queue-retention-seconds'),
    ),
    flags: {
      usage_statistics: bool(pick(data, 'usage-statistics-enabled', 'observability.usage.usage-statistics-enabled')),
      request_log: bool(pick(data, 'request-log', 'observability.request-log')),
      logging_to_file: bool(pick(data, 'logging-to-file', 'observability.logging-to-file')),
      debug: bool(pick(data, 'debug')),
      ws_auth: bool(pick(data, 'ws-auth')),
      tls: bool(pick(data, 'tls.enable')),
      plugins: bool(pick(data, 'plugins.enabled')),
      cooling_disabled: bool(pick(data, 'disable-cooling')),
    },
  };
}

export function createRuntimeReader(ctx: AppContext) {
  let last: RuntimeRead | null = null;
  let pending: Promise<RuntimeRead> | null = null;

  const get = async (key: string, path: string, limit?: number) => {
    const res = await cpaRequest(ctx.config, {
      method: 'GET',
      path,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      timeoutMs: TIMEOUT_MS,
    });
    noteCpaVersion(ctx.config.cpaUrl, res.headers);
    const body = await readCpaBody(res, limit);
    const status = res.statusCode ?? 0;
    if (status === 401) (ctx.requireAuth as Partial<AuthVerifierControls>).invalidate?.(key);
    return { status, body };
  };

  const read = async (key: string): Promise<RuntimeRead> => {
    const at = Date.now();
    let config: CpaRuntimeConfig | null = null;
    let error: string | null = null;
    try {
      const res = await get(key, '/v0/management/config', CONFIG_BODY_LIMIT);
      if (res.status === 401) return { at, config: null, error: 'CLIProxyAPI rejected the management key', error_log_files: null };
      if (res.status >= 200 && res.status < 300) config = runtimeFromConfig(JSON.parse(res.body) as Record<string, unknown>);
      else error = cpaErrorMessage(res.body) || `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof SyntaxError ? 'unreadable config response' : (err as Error).message;
    }

    let errorLogFiles: number | null = null;
    if (config) {
      try {
        const res = await get(key, '/v0/management/request-error-logs');
        if (res.status >= 200 && res.status < 300) {
          const files = (JSON.parse(res.body) as { files?: unknown })?.files;
          if (Array.isArray(files)) errorLogFiles = files.length;
        }
      } catch {
        // Optional; older versions have no error-log listing.
      }
    }
    return { at, config, error, error_log_files: errorLogFiles };
  };

  return (key: string, refresh: boolean): Promise<RuntimeRead> => {
    const age = last ? Date.now() - last.at : Infinity;
    if (last && (age < RUNTIME_MIN_INTERVAL_MS || (!refresh && age < RUNTIME_TTL_MS))) return Promise.resolve(last);
    pending ??= read(key).then((result) => {
      last = result;
      pending = null;
      return result;
    });
    return pending;
  };
}
