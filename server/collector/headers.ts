/**
 * Allowlisted upstream response headers → structured metadata (quota windows, error class, trace
 * ids, routing, rate limits, data policy). Port of CPA Manager Plus `usage/response_headers.go`
 * (MIT). Object keys are built in the Go struct order so `response_metadata_json` matches CPAMP.
 *
 * Not ported: xAI `provider_usage` (derived from failure bodies) and merging an incoming
 * `response_metadata` object (CPA never sends one).
 */
import type {
  ResponseHeaderDataPolicyMetadata,
  ResponseHeaderErrorMetadata,
  ResponseHeaderMetadata,
  ResponseHeaderProviderMetadata,
  ResponseHeaderQuotaMetadata,
  ResponseHeaderQuotaWindow,
  ResponseHeaderRateLimitBucket,
  ResponseHeaderRateLimitMetadata,
  ResponseHeaderResponseMetadata,
  ResponseHeaderRoutingMetadata,
  ResponseHeaderTraceMetadata,
} from '../../shared/analytics-types.ts';
import { failSummaryFromBody, truncateUtf8Bytes } from './redact.ts';

export type { ResponseHeaderMetadata };

export interface ResponseHeaderDerived {
  metadataJson: string | null;
  quotaRecoverAtMs: number | null;
  quotaUsedPercent: number | null;
  quotaPlanType: string;
  errorKind: string;
  errorCode: string;
  traceId: string;
}

const MAX_VALUE_BYTES = 1024;

const ALLOWED = new Set([
  'x-codex-plan-type',
  'x-codex-active-limit',
  'x-codex-rate-limit-reached-type',
  'x-codex-credits-balance',
  'x-codex-credits-has-credits',
  'x-codex-credits-unlimited',
  'x-codex-primary-over-secondary-limit-percent',
  'x-codex-primary-used-percent',
  'x-codex-secondary-used-percent',
  'x-codex-primary-reset-at',
  'x-codex-secondary-reset-at',
  'x-codex-primary-reset-after-seconds',
  'x-codex-secondary-reset-after-seconds',
  'x-codex-primary-window-minutes',
  'x-codex-secondary-window-minutes',
  'retry-after',
  'x-should-retry',
  'x-openai-authorization-error',
  'x-openai-ide-error-code',
  'x-openai-ide-root-error-code',
  'x-ratelimit-bypass',
  'x-oai-request-id',
  'x-request-id',
  'x-oneapi-request-id',
  'cf-ray',
  'eagleid',
  'x-cloudaicompanion-trace-id',
  'x-client-request-id',
  'x-zeabur-request-id',
  'traceparent',
  'x-openai-proxy-wasm',
  'x-models-etag',
  'x-new-api-version',
  'server',
  'via',
  'cf-cache-status',
  'x-site-cache-status',
  'x-served-by',
  'x-mife-upstream-status',
  'content-type',
  'content-length',
  'content-disposition',
  'server-timing',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-data-retention',
  'x-zero-data-retention',
  'x-zero-retention',
]);

export function isResponseHeaderAllowed(key: string): boolean {
  if (
    key === 'set-cookie' ||
    (key.includes('token') && key !== 'x-ratelimit-limit-tokens' && key !== 'x-ratelimit-remaining-tokens') ||
    key.includes('secret') ||
    (key.includes('authorization') && key !== 'x-openai-authorization-error')
  ) {
    return false;
  }
  return ALLOWED.has(key);
}

type Headers = Map<string, string[]>;

function scalarHeaderValue(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number') return Number.isFinite(raw) ? (Number.isInteger(raw) ? raw.toFixed(0) : String(raw)) : '';
  if (typeof raw === 'boolean') return String(raw);
  return '';
}

function headerValues(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map(scalarHeaderValue).filter(Boolean);
  const text = scalarHeaderValue(raw);
  return text ? [text] : [];
}

/** Lower-cased allowlisted headers → values (keys visited in sorted order, like Go). */
export function normalizeResponseHeaders(raw: unknown): Headers {
  const headers: Headers = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return headers;
  for (const key of Object.keys(raw).sort()) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || !isResponseHeaderAllowed(normalized)) continue;
    const values = headerValues((raw as Record<string, unknown>)[key]);
    if (values.length === 0) continue;
    headers.set(normalized, [...(headers.get(normalized) ?? []), ...values]);
  }
  return headers;
}

function first(headers: Headers, ...keys: string[]): string {
  for (const key of keys) {
    for (const value of headers.get(key) ?? []) {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return '';
}

export function normalizeHeaderValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return truncateUtf8Bytes(failSummaryFromBody(trimmed), MAX_VALUE_BYTES);
}

const FLOAT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

export function parseFloatHeader(value: string): number | null {
  const trimmed = value.replace(/%$/, '').trim();
  if (!trimmed || !FLOAT_RE.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIntHeader(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBoolHeader(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return null;
}

const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|z|[+-]\d{2}:\d{2})?$/;

/** RFC 3339 / RFC 1123 / "YYYY-MM-DD HH:MM:SS" (UTC) → epoch ms; null when not a time. */
function parseCommonTime(value: string): number | null {
  const m = RFC3339_RE.exec(value);
  if (m) {
    const [, y, mo, d, h, mi, s, frac, zone] = m;
    let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    if (frac) ms += Math.floor(Number(`0.${frac}`) * 1000);
    if (zone && zone !== 'Z' && zone !== 'z') {
      const sign = zone[0] === '-' ? -1 : 1;
      ms -= sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * 60_000;
    }
    return Number.isFinite(ms) ? ms : null;
  }
  // RFC 1123 ("Mon, 02 Jan 2006 15:04:05 GMT" / "-0700") and "2006-01-02 15:04:05 MST".
  if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} (?:[A-Z]{3,4}|[+-]\d{4})$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseHeaderTime(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;
  const common = parseCommonTime(trimmed);
  if (common !== null) return common;
  if (!FLOAT_RE.test(trimmed)) return null;
  const number = Number(trimmed);
  if (!Number.isFinite(number) || number <= 0) return null;
  if (number > 1_000_000_000_000) return Math.trunc(number);
  if (number > 1_000_000_000) return Math.trunc(number) * 1000;
  return null;
}

function parseRetryAfter(value: string, baseMs: number): { seconds: number; recoverAtMs: number } | null {
  const seconds = parseFloatHeader(value);
  if (seconds !== null && seconds >= 0) return { seconds, recoverAtMs: baseMs + Math.floor(seconds * 1000) };
  const at = parseHeaderTime(value);
  if (at !== null) return { seconds: Math.max(0, (at - baseMs) / 1000), recoverAtMs: at };
  return null;
}

/** Drops undefined / empty-string fields; returns undefined when nothing is left. */
function compact<T extends object>(value: T): T | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined || v === null || v === '' || (key.endsWith('_ms') && v === 0)) continue;
    out[key] = v;
  }
  return Object.keys(out).length ? (out as T) : undefined;
}

function parseQuotaWindow(headers: Headers, baseMs: number, used: string, resetAt: string, resetAfter: string, window: string) {
  const w: ResponseHeaderQuotaWindow = {};
  const usedPercent = parseFloatHeader(first(headers, used));
  w.used_percent = usedPercent ?? undefined;
  const after = parseFloatHeader(first(headers, resetAfter));
  let resetAtMs = 0;
  if (after !== null && baseMs > 0 && after > 0) resetAtMs = baseMs + Math.floor(after * 1000);
  const at = parseHeaderTime(first(headers, resetAt));
  if (at !== null) resetAtMs = at;
  const ordered: ResponseHeaderQuotaWindow = {
    used_percent: w.used_percent,
    reset_at_ms: resetAtMs || undefined,
    reset_after_seconds: after ?? undefined,
    window_minutes: parseFloatHeader(first(headers, window)) ?? undefined,
  };
  return compact(ordered);
}

const FIVE_HOUR = 'five_hour';
const WEEKLY = 'weekly';
const MONTHLY = 'monthly';
const UNKNOWN = 'unknown';

function windowKind(window: ResponseHeaderQuotaWindow | undefined): string {
  const minutes = window?.window_minutes;
  if (minutes === undefined || minutes <= 0) return UNKNOWN;
  if (Math.abs(minutes - 300) < 0.001) return FIVE_HOUR;
  if (Math.abs(minutes - 10_080) < 0.001) return WEEKLY;
  if (minutes >= 28 * 24 * 60 && minutes <= 31 * 24 * 60) return MONTHLY;
  return UNKNOWN;
}

interface Selection {
  source: string;
  kind: string;
  usedPercent: number;
  hasUsedPercent: boolean;
  resetAtMs: number;
}

function applyQuotaWindowSemantics(q: ResponseHeaderQuotaMetadata): void {
  const selections: Selection[] = [];
  for (const [source, window] of [
    ['primary', q.primary],
    ['secondary', q.secondary],
  ] as const) {
    if (!window) continue;
    selections.push({
      source,
      kind: windowKind(window),
      resetAtMs: window.reset_at_ms ?? 0,
      usedPercent: window.used_percent ?? 0,
      hasUsedPercent: window.used_percent !== undefined,
    });
  }
  const reachedType = (q.rate_limit_reached_type ?? '').trim();
  if (selections.length === 0) {
    if (q.used_percent !== undefined || (q.recover_at_ms ?? 0) > 0) {
      q.summary_window_kind ||= UNKNOWN;
      q.summary_window_source ||= 'aggregate';
    }
    if (reachedType) {
      q.reached_window_kind ||= UNKNOWN;
      q.reached_window_source ||= UNKNOWN;
    }
    return;
  }
  let summary: Selection | null = null;
  for (const s of selections) {
    if (!s.hasUsedPercent) continue;
    if (!summary || s.usedPercent > summary.usedPercent || (s.usedPercent === summary.usedPercent && s.resetAtMs > summary.resetAtMs)) {
      summary = s;
    }
  }
  if (summary) {
    q.used_percent = summary.usedPercent;
    q.recover_at_ms = summary.resetAtMs;
    q.summary_window_kind = summary.kind;
    q.summary_window_source = summary.source;
  } else if (q.used_percent !== undefined || (q.recover_at_ms ?? 0) > 0) {
    q.summary_window_kind ||= UNKNOWN;
    q.summary_window_source ||= 'aggregate';
  }

  let reached: Selection | null = null;
  const lowered = reachedType.toLowerCase();
  if (lowered === 'primary' || lowered === 'secondary') reached = selections.find((s) => s.source === lowered) ?? null;
  if (!reached) {
    for (const s of selections) {
      if (!s.hasUsedPercent || s.usedPercent < 100) continue;
      if (!reached || s.resetAtMs > reached.resetAtMs) reached = s;
    }
  }
  if (reached) {
    q.reached_window_kind = reached.kind;
    q.reached_window_source = reached.source;
    if ((q.recover_at_ms ?? 0) <= 0 && reached.resetAtMs > 0) q.recover_at_ms = reached.resetAtMs;
  } else if (reachedType) {
    q.reached_window_kind = UNKNOWN;
    q.reached_window_source = UNKNOWN;
  }
}

function parseQuota(headers: Headers, baseMs: number): ResponseHeaderQuotaMetadata | undefined {
  const q: ResponseHeaderQuotaMetadata = {
    plan_type: normalizeHeaderValue(first(headers, 'x-codex-plan-type')),
    active_limit: normalizeHeaderValue(first(headers, 'x-codex-active-limit')),
    rate_limit_reached_type: normalizeHeaderValue(first(headers, 'x-codex-rate-limit-reached-type')),
    summary_window_kind: '',
    summary_window_source: '',
    reached_window_kind: '',
    reached_window_source: '',
    credits_balance: normalizeHeaderValue(first(headers, 'x-codex-credits-balance')),
    credits_has_credits: parseBoolHeader(first(headers, 'x-codex-credits-has-credits')) ?? undefined,
    credits_unlimited: parseBoolHeader(first(headers, 'x-codex-credits-unlimited')) ?? undefined,
    primary_over_secondary_limit_percent: parseFloatHeader(first(headers, 'x-codex-primary-over-secondary-limit-percent')) ?? undefined,
    primary: parseQuotaWindow(
      headers,
      baseMs,
      'x-codex-primary-used-percent',
      'x-codex-primary-reset-at',
      'x-codex-primary-reset-after-seconds',
      'x-codex-primary-window-minutes',
    ),
    secondary: parseQuotaWindow(
      headers,
      baseMs,
      'x-codex-secondary-used-percent',
      'x-codex-secondary-reset-at',
      'x-codex-secondary-reset-after-seconds',
      'x-codex-secondary-window-minutes',
    ),
    recover_at_ms: 0,
    used_percent: undefined,
  };
  applyQuotaWindowSemantics(q);
  return compact(q);
}

function classifyHeaderError(e: ResponseHeaderErrorMetadata): [string, string] {
  for (const code of [e.ide_root_error_code, e.ide_error_code, e.authorization_error]) {
    const normalized = (code ?? '').trim().toLowerCase();
    if (['token_revoked', 'token_invalidated', 'account_deactivated', '401'].includes(normalized)) return ['auth', normalized];
    if (normalized === 'identity_edge_internal_error') return ['identity', normalized];
  }
  if (e.rate_limit_bypass) return ['rate_limit', e.rate_limit_bypass];
  if (e.retry_after_seconds !== undefined) return ['rate_limit', 'retry_after'];
  return ['', ''];
}

function parseErrors(headers: Headers, baseMs: number): ResponseHeaderErrorMetadata | undefined {
  const e: ResponseHeaderErrorMetadata = {
    kind: '',
    code: '',
    authorization_error: normalizeHeaderValue(first(headers, 'x-openai-authorization-error')),
    ide_error_code: normalizeHeaderValue(first(headers, 'x-openai-ide-error-code')),
    ide_root_error_code: normalizeHeaderValue(first(headers, 'x-openai-ide-root-error-code')),
    should_retry: parseBoolHeader(first(headers, 'x-should-retry')) ?? undefined,
    retry_after_seconds: undefined,
    retry_after_recover_at_ms: undefined,
    rate_limit_bypass: normalizeHeaderValue(first(headers, 'x-ratelimit-bypass')),
  };
  const retryAfter = first(headers, 'retry-after');
  if (retryAfter) {
    const parsed = parseRetryAfter(retryAfter, baseMs);
    if (parsed) {
      e.retry_after_seconds = parsed.seconds;
      e.retry_after_recover_at_ms = parsed.recoverAtMs;
    }
  }
  [e.kind, e.code] = classifyHeaderError(e);
  return compact(e);
}

const TRACEPARENT_RE = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

function normalizeTraceparent(value: string): string {
  const normalized = normalizeHeaderValue(value).toLowerCase();
  if (!TRACEPARENT_RE.test(normalized)) return '';
  const parts = normalized.split('-');
  if (parts[0] === 'ff' || parts[1] === '0'.repeat(32) || parts[2] === '0'.repeat(16)) return '';
  return normalized;
}

function parseTrace(headers: Headers): ResponseHeaderTraceMetadata | undefined {
  const t: ResponseHeaderTraceMetadata = {
    primary_trace_id: '',
    openai_request_id: normalizeHeaderValue(first(headers, 'x-oai-request-id')),
    request_id: normalizeHeaderValue(first(headers, 'x-request-id')),
    oneapi_request_id: normalizeHeaderValue(first(headers, 'x-oneapi-request-id')),
    cf_ray: normalizeHeaderValue(first(headers, 'cf-ray')),
    eagle_id: normalizeHeaderValue(first(headers, 'eagleid')),
    cloud_ai_companion_trace_id: normalizeHeaderValue(first(headers, 'x-cloudaicompanion-trace-id')),
    client_request_id: normalizeHeaderValue(first(headers, 'x-client-request-id')),
    zeabur_request_id: normalizeHeaderValue(first(headers, 'x-zeabur-request-id')),
    traceparent: normalizeTraceparent(first(headers, 'traceparent')),
  };
  const fromTraceparent = t.traceparent ? t.traceparent.split('-')[1] : '';
  t.primary_trace_id =
    [
      t.openai_request_id,
      t.request_id,
      t.oneapi_request_id,
      t.cloud_ai_companion_trace_id,
      t.cf_ray,
      t.eagle_id,
      t.client_request_id,
      t.zeabur_request_id,
      fromTraceparent,
    ].find((v) => v && v.trim()) ?? '';
  return compact(t);
}

function parseRouting(headers: Headers): ResponseHeaderRoutingMetadata | undefined {
  return compact<ResponseHeaderRoutingMetadata>({
    openai_proxy_wasm: normalizeHeaderValue(first(headers, 'x-openai-proxy-wasm')),
    models_etag: normalizeHeaderValue(first(headers, 'x-models-etag')),
    new_api_version: normalizeHeaderValue(first(headers, 'x-new-api-version')),
    server: normalizeHeaderValue(first(headers, 'server')),
    via: normalizeHeaderValue(first(headers, 'via')),
    cf_cache_status: normalizeHeaderValue(first(headers, 'cf-cache-status')),
    site_cache_status: normalizeHeaderValue(first(headers, 'x-site-cache-status')),
    served_by: normalizeHeaderValue(first(headers, 'x-served-by')),
    mife_upstream_status: normalizeHeaderValue(first(headers, 'x-mife-upstream-status')),
  });
}

function parseResponseShape(headers: Headers): ResponseHeaderResponseMetadata | undefined {
  return compact<ResponseHeaderResponseMetadata>({
    content_type: normalizeHeaderValue(first(headers, 'content-type')),
    content_length: parseIntHeader(first(headers, 'content-length')) ?? undefined,
    content_disposition: normalizeHeaderValue(first(headers, 'content-disposition')),
    server_timing: normalizeHeaderValue(first(headers, 'server-timing')),
  });
}

function parseProviders(headers: Headers): ResponseHeaderProviderMetadata | undefined {
  return compact<ResponseHeaderProviderMetadata>({
    antigravity_trace_id: normalizeHeaderValue(first(headers, 'x-cloudaicompanion-trace-id')),
    antigravity_server_timing: normalizeHeaderValue(first(headers, 'server-timing')),
    mife_upstream_status: normalizeHeaderValue(first(headers, 'x-mife-upstream-status')),
    oneapi_request_id: normalizeHeaderValue(first(headers, 'x-oneapi-request-id')),
    cloudflare_ray: normalizeHeaderValue(first(headers, 'cf-ray')),
    cloudflare_cache_status: normalizeHeaderValue(first(headers, 'cf-cache-status')),
  });
}

function parseBucket(headers: Headers, limitKey: string, remainingKey: string): ResponseHeaderRateLimitBucket | undefined {
  const limit = parseIntHeader(first(headers, limitKey));
  const remaining = parseIntHeader(first(headers, remainingKey));
  return compact<ResponseHeaderRateLimitBucket>({
    limit: limit !== null && limit >= 0 ? limit : undefined,
    remaining: remaining !== null && remaining >= 0 ? remaining : undefined,
  });
}

function parseRateLimit(headers: Headers): ResponseHeaderRateLimitMetadata | undefined {
  return compact<ResponseHeaderRateLimitMetadata>({
    requests: parseBucket(headers, 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests'),
    tokens: parseBucket(headers, 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens'),
  });
}

function parseDataPolicy(headers: Headers): ResponseHeaderDataPolicyMetadata | undefined {
  let zero: boolean | undefined;
  for (const key of ['x-zero-data-retention', 'x-zero-retention']) {
    const value = parseBoolHeader(first(headers, key));
    if (value !== null) {
      zero = value;
      break;
    }
  }
  return compact<ResponseHeaderDataPolicyMetadata>({
    retention_mode: normalizeHeaderValue(first(headers, 'x-data-retention')).toLowerCase(),
    zero_retention: zero,
  });
}

/** Parses a raw `response_headers` object (values may be strings or arrays); undefined when empty. */
export function parseResponseHeaderMetadata(raw: unknown, baseMs: number): ResponseHeaderMetadata | undefined {
  const headers = normalizeResponseHeaders(raw);
  if (headers.size === 0) return undefined;
  return compact<ResponseHeaderMetadata>({
    quota: parseQuota(headers, baseMs),
    errors: parseErrors(headers, baseMs),
    trace: parseTrace(headers),
    routing: parseRouting(headers),
    response: parseResponseShape(headers),
    providers: parseProviders(headers),
    rate_limit: parseRateLimit(headers),
    data_policy: parseDataPolicy(headers),
  });
}

/** The denormalized `header_*` columns plus the JSON blob. */
export function deriveResponseHeaderColumns(metadata: ResponseHeaderMetadata | undefined): ResponseHeaderDerived {
  if (!metadata) {
    return { metadataJson: null, quotaRecoverAtMs: null, quotaUsedPercent: null, quotaPlanType: '', errorKind: '', errorCode: '', traceId: '' };
  }
  return {
    metadataJson: JSON.stringify(metadata),
    quotaRecoverAtMs: metadata.quota?.recover_at_ms || null,
    quotaUsedPercent: metadata.quota?.used_percent ?? null,
    quotaPlanType: metadata.quota?.plan_type ?? '',
    errorKind: metadata.errors?.kind ?? '',
    errorCode: metadata.errors?.code ?? '',
    traceId: metadata.trace?.primary_trace_id ?? '',
  };
}
