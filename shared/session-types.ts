/**
 * Contracts for the server's status endpoints, shared by the server and the UI.
 * Snake_case on purpose: these are serialized as-is.
 */

export type CollectorMode = 'auto' | 'resp' | 'http' | 'off';

/** How events currently arrive from CLIProxyAPI. */
export type CollectorTransport = 'resp' | 'http' | 'none';

/**
 * Collector lifecycle state.
 *  - `disabled`: COLLECTOR_MODE=off or no CPA_MANAGEMENT_KEY.
 *  - `starting`: first connection attempt in progress.
 *  - `running`: subscribed (RESP) or polling (HTTP) successfully.
 *  - `backoff`: waiting before a reconnect after an error (see `next_retry_at_ms`).
 *  - `auth_failed`: CLIProxyAPI rejected the key; long backoff to avoid its IP ban.
 *  - `stopped`: shut down.
 */
export type CollectorState = 'disabled' | 'starting' | 'running' | 'backoff' | 'auth_failed' | 'stopped';

export interface CollectorStatus {
  mode: CollectorMode;
  transport: CollectorTransport;
  state: CollectorState;
  /** Why the collector is disabled, when `state === 'disabled'`. */
  disabled_reason: string | null;
  /** When the current transport connected (ms), null when not connected. */
  connected_since_ms: number | null;
  /** Arrival time of the newest event received (ms). */
  last_event_at_ms: number | null;
  last_error: string | null;
  last_error_at_ms: number | null;
  next_retry_at_ms: number | null;
  counts: {
    /** Records received from CLIProxyAPI since start. */
    received: number;
    /** Rows actually inserted (new event_hash). */
    inserted: number;
    /** Records ignored as duplicates (existing event_hash). */
    duplicates: number;
    /** Records that failed to normalize and went to dead_letters. */
    dead_letters: number;
    /** Transport (re)connects since start. */
    reconnects: number;
  };
  /** CLIProxyAPI `usage-statistics-enabled`; null when unknown (not yet read / unreachable). */
  usage_statistics_enabled: boolean | null;
  /** True when this process turned `usage-statistics-enabled` on. */
  usage_statistics_auto_enabled: boolean;
  /** CLIProxyAPI version, when known. */
  cpa_version: string | null;
}

/** `GET /api/status` (public): just enough for the sign-in screen. */
export interface StatusResponse {
  app_version: string;
  cpa: {
    /** host[:port] of CPA_URL, no scheme or path. */
    host: string;
    reachable: boolean;
    version: string | null;
  };
}

/** `GET /api/session` (authenticated): validates a key and reports server health. */
export interface SessionResponse {
  ok: true;
  collector: CollectorStatus;
  db: {
    events: number;
    oldest_event_ms: number | null;
    newest_event_ms: number | null;
    size_bytes: number;
  };
  /** 0 = keep forever. */
  retention_days: number;
  prices: {
    models: number;
    last_sync_ms: number | null;
  };
}

/** Error body for every non-2xx JSON response. */
export interface ApiErrorBody {
  error: string;
  code: string;
  retry_after_s?: number;
}
