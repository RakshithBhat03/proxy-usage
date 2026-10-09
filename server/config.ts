/**
 * Environment configuration. Every setting is parsed and validated once at startup; invalid values
 * abort the process with a readable message instead of failing later at runtime.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CollectorMode } from '../shared/session-types.ts';
export type { CollectorMode };
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  /** Repository / image root (the directory holding package.json, dist/ and server/). */
  rootDir: string;
  /** Built SPA served in production. */
  distDir: string;
  /** `--dev`: serve the UI through Vite middleware with HMR instead of `dist/`. */
  dev: boolean;

  port: number;
  host: string;
  /** Extra Host header names from ALLOWED_HOSTS (`*` disables the check). */
  allowedHosts: string[];
  /** Browser-side HMR port when the dev server sits behind a TLS proxy (e.g. 443). */
  hmrClientPort: number | undefined;

  /** CLIProxyAPI base URL without a trailing slash, e.g. `http://127.0.0.1:8317`. */
  cpaUrl: string;
  /** Management key the collector uses; '' when unset (collector then stays disabled). */
  cpaManagementKey: string;
  /** Skip TLS certificate verification for an https CPA_URL. */
  cpaTlsInsecure: boolean;

  /** Absolute data directory; the SQLite file lives at `dbPath`. */
  dataDir: string;
  dbPath: string;
  /** Days of event history to keep; 0 keeps everything. */
  retentionDays: number;

  collectorMode: CollectorMode;
  collectorPollMs: number;
  collectorBatch: number;
  autoEnableUsageStatistics: boolean;

  priceSyncIntervalHours: number;
  analyticsWorkers: number;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function str(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer (got "${raw}")`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${name} must be between ${min} and ${max} (got ${value})`);
  return value;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false (got "${raw}")`);
}

function oneOf<T extends string>(env: Env, name: string, fallback: T, allowed: readonly T[]): T {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(', ')} (got "${raw}")`);
  }
  return raw as T;
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseCpaUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`CPA_URL must be an absolute http(s) URL (got "${raw}")`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`CPA_URL must use http or https (got "${url.protocol}")`);
  }
  if (url.username || url.password) throw new ConfigError('CPA_URL must not contain credentials');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/**
 * Loads `<root>/.env` into process.env without overriding variables that are already set (same
 * semantics as `--env-file-if-exists`). Done in-process because `node --watch-path` combined with
 * `--env-file` makes Node watch the whole repo root, so every Vite cache write restarted `npm run dev`.
 */
export function loadDotEnv(file = path.join(ROOT_DIR, '.env')): boolean {
  try {
    process.loadEnvFile(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new ConfigError(`cannot read ${path.basename(file)}: ${(err as Error).message}`);
  }
}

export function loadConfig(env: Env = process.env, argv: readonly string[] = process.argv): Config {
  const dataDir = path.resolve(ROOT_DIR, str(env, 'DATA_DIR', './data'));
  const hmrRaw = env.HMR_CLIENT_PORT?.trim();
  return {
    rootDir: ROOT_DIR,
    distDir: path.join(ROOT_DIR, 'dist'),
    dev: argv.includes('--dev'),

    port: int(env, 'PORT', 18320, 1, 65535),
    host: str(env, 'HOST', '0.0.0.0'),
    allowedHosts: csv(env.ALLOWED_HOSTS),
    hmrClientPort: hmrRaw ? int(env, 'HMR_CLIENT_PORT', 0, 1, 65535) : undefined,

    cpaUrl: parseCpaUrl(str(env, 'CPA_URL', 'http://127.0.0.1:8317')),
    cpaManagementKey: env.CPA_MANAGEMENT_KEY?.trim() ?? '',
    cpaTlsInsecure: bool(env, 'CPA_TLS_INSECURE', false),

    dataDir,
    dbPath: path.join(dataDir, 'usage.sqlite'),
    retentionDays: int(env, 'RETENTION_DAYS', 0, 0, 36500),

    collectorMode: oneOf(env, 'COLLECTOR_MODE', 'auto', ['auto', 'resp', 'http', 'off'] as const),
    collectorPollMs: int(env, 'COLLECTOR_POLL_MS', 1000, 100, 600_000),
    collectorBatch: int(env, 'COLLECTOR_BATCH', 500, 1, 10_000),
    autoEnableUsageStatistics: bool(env, 'AUTO_ENABLE_USAGE_STATISTICS', true),

    priceSyncIntervalHours: int(env, 'PRICE_SYNC_INTERVAL_HOURS', 24, 0, 24 * 365),
    analyticsWorkers: int(env, 'ANALYTICS_WORKERS', 2, 1, 16),
    logLevel: oneOf(env, 'LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error'] as const),
  };
}

/** The config with secrets masked, for the startup log. */
export function redactedConfig(config: Config): Record<string, unknown> {
  return {
    mode: config.dev ? 'dev' : 'production',
    listen: `${config.host}:${config.port}`,
    cpaUrl: config.cpaUrl,
    cpaManagementKey: config.cpaManagementKey ? 'set' : 'unset',
    cpaTlsInsecure: config.cpaTlsInsecure,
    allowedHosts: config.allowedHosts,
    dbPath: config.dbPath,
    retentionDays: config.retentionDays,
    collectorMode: config.collectorMode,
    collectorPollMs: config.collectorPollMs,
    collectorBatch: config.collectorBatch,
    autoEnableUsageStatistics: config.autoEnableUsageStatistics,
    priceSyncIntervalHours: config.priceSyncIntervalHours,
    analyticsWorkers: config.analyticsWorkers,
    logLevel: config.logLevel,
    hmrClientPort: config.hmrClientPort,
  };
}
