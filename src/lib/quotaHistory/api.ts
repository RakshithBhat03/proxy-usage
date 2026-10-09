import { LOCAL_TIME_ZONE, queryAnalytics } from '@/lib/api/analytics';
import { api } from '@/lib/api/client';
import { MINUTE_MS } from '@/lib/quota/parse';
import { credentialTarget, fromSnapshotItem, observationsFromEvent, type SnapshotItemRaw } from './sources';
import type { CycleBoundary, HistoryCredential, QuotaObservation, WindowUsage } from './types';

/* ---------- POST /v0/management/quota-snapshots/query (read-only) ---------- */

const MAX_SNAPSHOT_ACCOUNTS = 200;

export interface SnapshotHistory {
  observations: QuotaObservation[];
  cycles: CycleBoundary[];
}

/** The decoder rejects unknown fields; only the documented account keys are sent. */
export async function fetchSnapshotHistory(creds: HistoryCredential[], signal?: AbortSignal): Promise<Record<string, SnapshotHistory>> {
  const targets = creds.slice(0, MAX_SNAPSHOT_ACCOUNTS);
  if (targets.length === 0) return {};
  const rows = new Map(targets.map((cred, i) => [`r${i}`, cred]));
  const response = await api<{ items?: SnapshotItemRaw[] }>('/v0/management/quota-snapshots/query', {
    method: 'POST',
    body: {
      accounts: [...rows].map(([row_key, cred]) => {
        const { auth_file_snapshot, auth_provider_snapshot, auth_index, auth_label_snapshot, source, auth_account_id_snapshot } = credentialTarget(cred);
        const account: Record<string, string> = { auth_file_snapshot, auth_provider_snapshot, source };
        if (auth_index) account.auth_index = auth_index;
        if (auth_label_snapshot) account.auth_label_snapshot = auth_label_snapshot;
        if (auth_account_id_snapshot) account.auth_account_id_snapshot = auth_account_id_snapshot;
        return { row_key, provider: cred.provider, account };
      }),
      include_inactive: false,
    },
    signal,
  });
  const out: Record<string, SnapshotHistory> = {};
  for (const item of response?.items ?? []) {
    const cred = item.row_key ? rows.get(item.row_key) : undefined;
    if (cred) out[cred.key] = fromSnapshotItem(cred.provider, item);
  }
  return out;
}

/* ---------- quota headers on raw events (POST /monitoring/analytics, events_page) ---------- */

const EVENT_PAGE = 5000;
const MAX_PAGES = 8;
const OVERLAP_MS = 2 * MINUTE_MS;

interface HeaderCacheEntry {
  fromMs: number;
  toMs: number;
  observations: QuotaObservation[];
  truncatedBeforeMs: number | null;
}

/**
 * Events are ~2.5 KB each and only their quota headers matter, so readings are cached per
 * credential and later refreshes ask only for events newer than the last fetch.
 */
const headerCache = new Map<string, HeaderCacheEntry>();

export interface HeaderHistory {
  observations: QuotaObservation[];
  /** Set when paging stopped early: readings before this instant are missing. */
  truncatedBeforeMs: number | null;
}

async function fetchEventObservations(authIndex: string, fromMs: number, toMs: number, signal?: AbortSignal) {
  const observations: QuotaObservation[] = [];
  let before: { before_ms: number; before_id: number } | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await queryAnalytics(
      {
        from_ms: Math.floor(fromMs),
        to_ms: Math.ceil(toMs),
        time_zone: LOCAL_TIME_ZONE,
        filters: { auth_indices: [authIndex] },
        include: { events_page: { limit: EVENT_PAGE, ...(before ?? {}) } },
      },
      signal,
    );
    const events = res.events;
    for (const event of events?.items ?? []) observations.push(...observationsFromEvent(event));
    if (!events?.has_more || !events.next_before_ms) return { observations, truncatedBeforeMs: null };
    before = { before_ms: events.next_before_ms, before_id: events.next_before_id };
  }
  return { observations, truncatedBeforeMs: before?.before_ms ?? null };
}

export async function fetchHeaderHistory(cred: HistoryCredential, fromMs: number, signal?: AbortSignal): Promise<HeaderHistory> {
  if (!cred.authIndex) return { observations: [], truncatedBeforeMs: null };
  const now = Date.now();
  const cached = headerCache.get(cred.authIndex);
  let entry: HeaderCacheEntry;
  if (cached && cached.fromMs <= fromMs && now - cached.toMs < 6 * 60 * MINUTE_MS) {
    const delta = await fetchEventObservations(cred.authIndex, cached.toMs - OVERLAP_MS, now, signal);
    const seen = new Set(cached.observations.map((o) => `${o.windowId}|${o.observedAtMs}`));
    const merged = [...cached.observations, ...delta.observations.filter((o) => !seen.has(`${o.windowId}|${o.observedAtMs}`))];
    entry = { fromMs: cached.fromMs, toMs: now, observations: merged, truncatedBeforeMs: cached.truncatedBeforeMs };
  } else {
    const full = await fetchEventObservations(cred.authIndex, fromMs, now, signal);
    entry = { fromMs, toMs: now, ...full };
  }
  headerCache.set(cred.authIndex, entry);
  return { observations: entry.observations.filter((o) => o.observedAtMs >= fromMs), truncatedBeforeMs: entry.truncatedBeforeMs };
}

/* ---------- POST /v0/management/monitoring/account-window-usage (read-only) ---------- */

export interface UsageTarget {
  key: string;
  cred: HistoryCredential;
  windowId: string;
  period: 'current' | 'previous';
  fromMs: number;
  /** null = open window, measured up to "now" at fetch time. */
  toMs: number | null;
  /** Models this window meters; omitted = every model on the credential. */
  models?: string[];
}

const MAX_WINDOWS_PER_CALL = 400;

interface WindowUsageItem {
  request_key?: string;
  matched?: boolean;
  total_requests?: number;
  success_calls?: number;
  failure_calls?: number;
  total_tokens?: number;
  total_cost?: number;
  success_rate?: number | null;
  last_seen_ms?: number | null;
  scope_match_status?: string;
}

export async function fetchWindowUsage(targets: UsageTarget[], signal?: AbortSignal): Promise<Record<string, WindowUsage>> {
  const now = Date.now();
  const valid = targets
    .map((t) => ({ ...t, to: Math.floor(t.toMs ?? now) }))
    .filter((t) => Math.floor(t.fromMs) < t.to);
  const out: Record<string, WindowUsage> = {};
  for (let i = 0; i < valid.length; i += MAX_WINDOWS_PER_CALL) {
    const chunk = valid.slice(i, i + MAX_WINDOWS_PER_CALL);
    const res = await api<{ items?: WindowUsageItem[] }>('/v0/management/monitoring/account-window-usage', {
      method: 'POST',
      body: {
        windows: chunk.map((t) => ({
          request_key: t.key,
          row_key: t.cred.key,
          provider_window_id: t.windowId,
          ...(t.models ? { model_scope: { kind: 'models', models: t.models, complete: true } } : {}),
          period: t.period,
          from_ms: Math.floor(t.fromMs),
          to_ms: t.to,
          ...credentialTarget(t.cred),
        })),
      },
      signal,
    });
    for (const item of res?.items ?? []) {
      if (!item.request_key) continue;
      out[item.request_key] = {
        matched: item.matched === true,
        requests: item.total_requests ?? 0,
        successCalls: item.success_calls ?? 0,
        failureCalls: item.failure_calls ?? 0,
        tokens: item.total_tokens ?? 0,
        cost: item.total_cost ?? 0,
        successRate: item.success_rate ?? null,
        lastSeenMs: item.last_seen_ms ?? null,
        complete: (item.scope_match_status ?? 'complete') === 'complete',
      };
    }
  }
  return out;
}
