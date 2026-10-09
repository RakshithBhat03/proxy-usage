import type { EventRow } from '@/lib/api/analytics';
import type { AuthFile } from '@/lib/api/authFiles';
import { authIndexOf } from '@/lib/api/authFiles';
import { normalizeProvider } from '@/lib/providers';

/** `fail_status_code` is set on successes too (200); fall back when it is missing. */
export function statusCodeOf(event: Pick<EventRow, 'failed' | 'fail_status_code'>): number {
  if (typeof event.fail_status_code === 'number' && event.fail_status_code > 0) return event.fail_status_code;
  return event.failed ? 0 : 200;
}

export type StatusTone = 'ok' | 'fail' | 'rate' | 'cancel';

export function statusTone(event: Pick<EventRow, 'failed' | 'fail_status_code' | 'fail_summary' | 'header_error_kind'>): StatusTone {
  if (!event.failed) return 'ok';
  const code = statusCodeOf(event);
  if (code === 429 || event.header_error_kind === 'rate_limit') return 'rate';
  if (code === 499 || /context canceled/i.test(event.fail_summary ?? '')) return 'cancel';
  return 'fail';
}

export type FailureClass =
  | 'rate_limit'
  | 'auth'
  | 'client_cancel'
  | 'timeout'
  | 'overloaded'
  | 'upstream_5xx'
  | 'bad_request'
  | 'other';

export const FAILURE_CLASS_LABELS: Record<FailureClass, { label: string; hint: string }> = {
  rate_limit: { label: 'Rate limited', hint: '429 or retry-after / rate-limit headers' },
  auth: { label: 'Auth', hint: '401 / 403, revoked or invalid tokens' },
  client_cancel: { label: 'Client cancelled', hint: '499 · the client gave up (context canceled)' },
  timeout: { label: 'Timeout', hint: '408 / 504' },
  overloaded: { label: 'Overloaded', hint: '503 / 529 upstream overloaded' },
  upstream_5xx: { label: 'Upstream 5xx', hint: 'Transport errors (EOF, dial failures) and 5xx bodies' },
  bad_request: { label: 'Bad request', hint: 'Other 4xx' },
  other: { label: 'Other', hint: 'No status code' },
};

/** Buckets a failed request by status code and error kind (semantics follow CPA Manager Plus, MIT). */
export function classifyFailure(
  event: Pick<EventRow, 'fail_status_code' | 'fail_summary' | 'header_error_kind' | 'failed'>,
): FailureClass {
  const s = event.fail_status_code ?? 0;
  if (event.header_error_kind === 'rate_limit' || s === 429) return 'rate_limit';
  if (event.header_error_kind === 'auth' || s === 401 || s === 403) return 'auth';
  if (s === 499 || /context canceled/i.test(event.fail_summary ?? '')) return 'client_cancel';
  if (s === 408 || s === 504) return 'timeout';
  if (s === 529 || s === 503) return 'overloaded';
  if (s >= 500) return 'upstream_5xx';
  if (s >= 400) return 'bad_request';
  return 'other';
}

export function normalizeServiceTier(tier: string | undefined): string {
  const v = (tier ?? '').trim().toLowerCase();
  if (['', 'auto', 'default', 'standard', 'standard_only'].includes(v)) return 'normal';
  if (v === 'priority' || v === 'fast') return 'fast';
  return v;
}

export function eventProvider(event: Pick<EventRow, 'auth_provider_snapshot' | 'executor_type'>): string {
  const snapshot = normalizeProvider(event.auth_provider_snapshot);
  if (snapshot) return snapshot;
  const executor = (event.executor_type ?? '').replace(/Executor$/, '');
  return normalizeProvider(executor);
}

/** Uncached prompt tokens: `input_tokens` already includes every cache bucket. */
export function freshInputTokens(e: Pick<EventRow, 'input_tokens' | 'cached_tokens' | 'cache_read_tokens' | 'cache_creation_tokens'>) {
  return Math.max((e.input_tokens ?? 0) - (e.cached_tokens ?? 0) - (e.cache_read_tokens ?? 0) - (e.cache_creation_tokens ?? 0), 0);
}

export function cacheReadTokens(e: Pick<EventRow, 'cached_tokens' | 'cache_read_tokens'>) {
  return Math.max(e.cached_tokens ?? 0, 0) + Math.max(e.cache_read_tokens ?? 0, 0);
}

export function cacheHitRate(e: Pick<EventRow, 'input_tokens' | 'cached_tokens' | 'cache_read_tokens'>) {
  return e.input_tokens > 0 ? Math.min(1, cacheReadTokens(e) / e.input_tokens) : 0;
}

/** Nearest-rank percentile over positive values (matches the server's p95). */
export function percentile(values: number[], p: number): number | null {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.ceil((sorted.length * p) / 100);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/*
 * IPv6: either ≥4 full groups or a `::` compression. Clock times ("14:08:19") have only three
 * groups and no `::`, so timestamps inside error bodies survive.
 */
const H = '[0-9a-fA-F]{1,4}';
const IPV6 = new RegExp(
  `(?<![\\w:.])(?:(?:${H}:){3,7}${H}|(?:${H}:){1,6}:(?:${H}(?::${H})*)?|::(?:${H}(?::${H})*)?)(?:%\\w+)?(?![\\w:])`,
  'g',
);

/** Upstream error bodies can carry raw IPs (`read tcp [2001:…]:443`); hide them for screenshots. */
export function maskIps(text: string): string {
  return text
    .replace(IPV6, '•••:•••')
    .replace(IPV4, (match) => (match === '127.0.0.1' ? match : match.replace(/\.\d{1,3}\.\d{1,3}$/, '.•••.•••')));
}

export type AuthIndexMap = Map<string, AuthFile>;

export function buildAuthMap(files: AuthFile[] | undefined): AuthIndexMap {
  const map: AuthIndexMap = new Map();
  for (const file of files ?? []) {
    const index = authIndexOf(file);
    if (index) map.set(index, file);
  }
  return map;
}

interface CredentialLike {
  auth_index?: string;
  account_snapshot?: string;
  auth_label_snapshot?: string;
  auth_file_snapshot?: string;
  source?: string;
}

/** Live auth-file label first, then request-time snapshots. Callers still mask the result. */
export function credentialLabel(row: CredentialLike, auth: AuthIndexMap): string {
  const file = row.auth_index ? auth.get(row.auth_index) : undefined;
  const fileLabel =
    (typeof file?.label === 'string' && file.label) ||
    (typeof file?.email === 'string' && file.email) ||
    (typeof file?.account === 'string' && file.account) ||
    file?.name;
  return (
    fileLabel ||
    row.auth_label_snapshot ||
    row.account_snapshot ||
    row.auth_file_snapshot ||
    row.source ||
    row.auth_index ||
    '-'
  );
}

export function eventKey(event: EventRow): string {
  return (
    event.event_hash ||
    `${event.timestamp_ms}:${event.model}:${event.source_hash}:${event.api_key_hash}:${event.auth_index}:${event.endpoint}`
  );
}

/** Newest-first merge, deduped by event key. Returns the merged list and the rows that were new. */
export function mergeNewest(current: EventRow[], incoming: EventRow[]): { rows: EventRow[]; added: EventRow[] } {
  const seen = new Set(current.map(eventKey));
  const added: EventRow[] = [];
  for (const row of incoming) {
    const key = eventKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(row);
  }
  if (added.length === 0) return { rows: current, added };
  const rows = [...added, ...current].sort((a, b) => b.timestamp_ms - a.timestamp_ms);
  return { rows, added };
}

export function appendOlder(current: EventRow[], incoming: EventRow[]): EventRow[] {
  const seen = new Set(current.map(eventKey));
  const extra = incoming.filter((row) => !seen.has(eventKey(row)));
  return extra.length === 0 ? current : [...current, ...extra];
}
