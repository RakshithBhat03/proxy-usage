import { api } from '@/lib/api/client';
import { resolveCodexAccountId } from './files';
import { asRecord, normalizeNumberValue, normalizeStringValue } from './parse';
import { settleStaleWindow } from './signals';
import { CLAUDE_WINDOW_LABELS } from './providers/claude';
import type { AccountQuota, QuotaEntry, QuotaProvider, QuotaWindow } from './types';

/**
 * Manager Server quota snapshots (`POST /v0/management/quota-snapshots/query`): cached windows
 * other writers recorded, served from the Manager DB without touching any provider. Read-only here.
 */

interface SnapshotWindow {
  provider_window_id?: string;
  window_kind?: string;
  used_percent?: number | null;
  remaining_percent?: number | null;
  cycle_end_ms?: number | null;
  duration_seconds?: number | null;
  observed_at_ms?: number | null;
  stale?: boolean;
  availability?: string;
  current_cycle?: { scheduled_end_ms?: number | null } | null;
}

interface SnapshotItem {
  row_key?: string;
  provider?: string;
  windows?: SnapshotWindow[];
}

export interface SnapshotResponse {
  generated_at_ms?: number;
  items?: SnapshotItem[];
}

const MAX_ACCOUNTS = 200;

/** The decoder rejects unknown fields, so only documented keys are sent. */
export function snapshotQueryAccountFor(entry: QuotaEntry, rowKey: string) {
  const account: Record<string, string> = {
    auth_file_snapshot: entry.name,
    auth_provider_snapshot: entry.provider,
    source: entry.name,
  };
  if (entry.authIndex) account.auth_index = entry.authIndex;
  if (entry.email) account.auth_label_snapshot = entry.email;
  if (entry.provider === 'codex') {
    const accountId = resolveCodexAccountId(entry.file);
    if (accountId) account.auth_account_id_snapshot = accountId;
  }
  return { row_key: rowKey, provider: entry.provider, account };
}

/** Returns snapshot-derived quota keyed by entry key; failures resolve to an empty map. */
export async function querySnapshots(entries: QuotaEntry[], signal?: AbortSignal): Promise<Record<string, AccountQuota>> {
  const targets = entries.filter((entry) => entry.provider === 'claude' || entry.provider === 'codex').slice(0, MAX_ACCOUNTS);
  if (targets.length === 0) return {};
  const rows = new Map(targets.map((entry, index) => [`row-${index + 1}`, entry]));
  const response = await api<SnapshotResponse>('/v0/management/quota-snapshots/query', {
    method: 'POST',
    body: { accounts: [...rows].map(([rowKey, entry]) => snapshotQueryAccountFor(entry, rowKey)), include_inactive: false },
    signal,
  });
  const now = Date.now();
  const out: Record<string, AccountQuota> = {};
  for (const item of response?.items ?? []) {
    const entry = item.row_key ? rows.get(item.row_key) : undefined;
    if (!entry) continue;
    const quota = quotaFromSnapshot(entry.provider, item, now);
    if (quota) out[entry.key] = quota;
  }
  return out;
}

const SNAPSHOT_ID_MAP: Record<string, string> = {
  'weekly-scoped-fable': 'seven-day-fable',
};

const CODEX_LABELS: Record<string, string> = { 'five-hour': '5-hour limit', weekly: 'Weekly limit', monthly: 'Monthly limit' };

const humanize = (id: string) => id.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function quotaFromSnapshot(provider: QuotaProvider, item: SnapshotItem, now: number): AccountQuota | null {
  const windows: QuotaWindow[] = [];
  for (const raw of item.windows ?? []) {
    if (raw.stale === true || (raw.availability && raw.availability !== 'active')) continue;
    const rawId = normalizeStringValue(raw.provider_window_id);
    if (!rawId) continue;
    let id = SNAPSHOT_ID_MAP[rawId] ?? rawId;
    if (provider === 'claude' && id === 'weekly') id = 'seven-day';
    const used = normalizeNumberValue(raw.used_percent);
    const remaining = normalizeNumberValue(raw.remaining_percent);
    const duration = normalizeNumberValue(raw.duration_seconds);
    const resetAtMs = normalizeNumberValue(asRecord(raw.current_cycle).scheduled_end_ms) ?? normalizeNumberValue(raw.cycle_end_ms);
    windows.push(
      settleStaleWindow(
        {
          id,
          label: (provider === 'claude' ? CLAUDE_WINDOW_LABELS[id] : CODEX_LABELS[id]) ?? humanize(id),
          usedPercent: used ?? (remaining !== null ? 100 - remaining : null),
          remainingPercent: remaining ?? (used !== null ? Math.max(0, 100 - used) : null),
          resetAtMs,
          periodHours: duration ? duration / 3600 : null,
          kind: 'quota',
          observedAtMs: normalizeNumberValue(raw.observed_at_ms),
        },
        now,
      ),
    );
  }
  if (windows.length === 0) return null;
  return { windows, plan: null, source: 'snapshot', observedAtMs: Math.max(...windows.map((w) => w.observedAtMs ?? 0)) || null };
}
