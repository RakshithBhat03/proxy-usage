/**
 * Contract for `GET /api/system` (authenticated): everything the Status page shows. Snake_case on
 * purpose: serialized as-is.
 */
import type { CollectorStatus } from './session-types.ts';

/** Non-secret CLIProxyAPI settings (from its management config). Null fields were not reported. */
export interface CpaRuntimeConfig {
  /** `round-robin`, `fill-first` ...; null = CPA default (round-robin). */
  routing_strategy: string | null;
  request_retry: number | null;
  max_retry_interval_s: number | null;
  /** An upstream `proxy-url` is set (the URL itself is never sent: it can hold credentials). */
  proxy_configured: boolean;
  /** Number of client API keys (count only). */
  api_keys: number | null;
  usage_queue_retention_s: number | null;
  flags: {
    usage_statistics: boolean | null;
    request_log: boolean | null;
    logging_to_file: boolean | null;
    debug: boolean | null;
    ws_auth: boolean | null;
    tls: boolean | null;
    plugins: boolean | null;
    cooling_disabled: boolean | null;
  };
}

export interface CpaSystemStatus {
  /** host[:port] of CPA_URL. */
  host: string;
  reachable: boolean;
  /** Round trip of the unauthenticated `GET /` probe, null when unreachable. */
  latency_ms: number | null;
  /** From `X-CPA-VERSION` / `X-CPA-COMMIT` / `X-CPA-BUILD-DATE` on management responses. */
  version: string | null;
  commit: string | null;
  build_date: string | null;
  /** Newest release tag CLIProxyAPI reports (`/v0/management/latest-version`), e.g. `v8.0.24`. */
  latest_version: string | null;
  latest_checked_at_ms: number | null;
  latest_error: string | null;
  /** True/false once both versions are known and comparable; null otherwise. */
  update_available: boolean | null;
  /** GitHub release page for `latest_version` (or the releases list when unknown). */
  release_url: string;
  runtime: CpaRuntimeConfig | null;
  runtime_error: string | null;
  /** Files in CLIProxyAPI's request error log directory; null when unknown. */
  error_log_files: number | null;
}

export interface AppSystemStatus {
  version: string;
  node_version: string;
  platform: string;
  arch: string;
  mode: 'production' | 'dev';
  started_at_ms: number;
  memory: { rss_bytes: number; heap_used_bytes: number };
  analytics_workers: number;
  log_level: string;
}

export interface DbSystemStatus {
  events: number;
  oldest_event_ms: number | null;
  newest_event_ms: number | null;
  /** Requests recorded in the last hour / 24 hours (by request time). */
  events_last_hour: number;
  events_last_day: number;
  size_bytes: number;
  wal_bytes: number;
  dead_letters: number;
  schema_version: number;
}

export interface RetentionSystemStatus {
  /** 0 = keep forever. */
  retention_days: number;
  last_run_at_ms: number | null;
  last_deleted_events: number;
  last_error: string | null;
  next_run_at_ms: number | null;
}

export interface PricingSystemStatus {
  models: number;
  synced_models: number;
  manual_models: number;
  last_sync_at_ms: number | null;
  last_sync_error: string | null;
  unpriced_events: number | null;
  /** Hours between automatic syncs; 0 = off. */
  sync_interval_hours: number;
}

export interface SystemResponse {
  checked_at_ms: number;
  cpa: CpaSystemStatus;
  app: AppSystemStatus;
  collector: CollectorStatus;
  db: DbSystemStatus;
  retention: RetentionSystemStatus | null;
  pricing: PricingSystemStatus | null;
}
