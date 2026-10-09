import type { EventRow, ResponseHeaderQuotaWindow } from '@/lib/api/analytics';
import { authIndexOfFile, isDisabledAuthFile, resolveAuthProvider, resolveCodexAccountId } from '@/lib/quota/files';
import { readStoredLive } from '@/lib/quota/live';
import { asRecord, HOUR_MS, isRecord, MINUTE_MS, normalizeNumberValue, normalizeStringValue, parseIsoToMs, parseUnixToMs } from '@/lib/quota/parse';
import { CLAUDE_WINDOW_LABELS } from '@/lib/quota/providers/claude';
import type { AuthFile } from '@/lib/api/authFiles';
import type { CycleBoundary, HistoryCredential, QuotaObservation, WindowKind } from './types';

export const FIVE_HOUR_MS = 5 * HOUR_MS;
export const WEEK_MS = 7 * 24 * HOUR_MS;

/* ---------- window identity ---------- */

const GENERIC_LABELS: Record<string, string> = {
  'five-hour': '5-hour limit',
  weekly: 'Weekly limit',
  monthly: 'Monthly limit',
  daily: 'Daily limit',
};

const humanize = (id: string) => id.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function windowLabel(provider: string, windowId: string, fallback?: string): string {
  if (provider === 'claude' && CLAUDE_WINDOW_LABELS[windowId]) return CLAUDE_WINDOW_LABELS[windowId];
  return GENERIC_LABELS[windowId] ?? fallback ?? humanize(windowId);
}

export function windowKindOf(windowId: string, durationMs: number | null): WindowKind {
  if (durationMs !== null) {
    if (Math.abs(durationMs - FIVE_HOUR_MS) < MINUTE_MS) return 'five-hour';
    if (Math.abs(durationMs - WEEK_MS) < HOUR_MS) return 'weekly';
    return 'other';
  }
  if (/five-hour|5h/.test(windowId)) return 'five-hour';
  if (/weekly|seven-day|7d/.test(windowId)) return 'weekly';
  return 'other';
}

/** Header `window_minutes` -> the same ids the Quota page uses. */
function windowIdFromMinutes(minutes: number): string {
  if (minutes === 300) return 'five-hour';
  if (minutes === 10080) return 'weekly';
  if (minutes >= 28 * 1440 && minutes <= 31 * 1440) return 'monthly';
  if (minutes === 1440) return 'daily';
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** Snapshot ids differ from the Quota page ids in a few places (see quota.md §7). */
function normalizeSnapshotWindowId(provider: string, rawId: string): string {
  if (rawId === 'weekly-scoped-fable') return 'seven-day-fable';
  if (provider === 'claude' && rawId === 'weekly') return 'seven-day';
  return rawId;
}

/* ---------- credentials ---------- */

export function historyCredentials(files: readonly AuthFile[]): HistoryCredential[] {
  const list: HistoryCredential[] = [];
  for (const file of files) {
    if (!file.name) continue;
    list.push({
      key: file.name,
      name: file.name,
      provider: resolveAuthProvider(file),
      email: normalizeStringValue(file.email) ?? normalizeStringValue(file.label),
      authIndex: authIndexOfFile(file),
      disabled: isDisabledAuthFile(file),
      file,
    });
  }
  return list;
}

/**
 * Identity fields the Manager uses to find a credential's events (same set CPAMP sends,
 * accountHistoryRows.ts:51-92). Codex needs the member email and ChatGPT account id, otherwise
 * the account rollups do not match.
 */
export function credentialTarget(cred: HistoryCredential) {
  const target: Record<string, string> = {
    auth_file_snapshot: cred.name,
    auth_provider_snapshot: cred.provider,
    source: cred.name,
  };
  if (cred.authIndex) target.auth_index = cred.authIndex;
  const account = normalizeStringValue(cred.file.account) ?? normalizeStringValue(cred.file.email);
  const label = normalizeStringValue(cred.file.label) ?? normalizeStringValue(cred.file.note);
  if (cred.provider === 'codex') {
    const member = account && /^[^@\s]+@[^@\s]+$/.test(account) ? account.toLowerCase() : null;
    if (member) target.account_snapshot = member;
    const accountId = resolveCodexAccountId(cred.file);
    if (accountId) target.auth_account_id_snapshot = accountId;
  } else if (account) {
    target.account_snapshot = account;
  }
  if (label) target.auth_label_snapshot = label;
  return target;
}

/* ---------- passive signals on the auth file ---------- */

const CLAUDE_HEADER = /^anthropic-ratelimit-unified-(5h|7d|7d_[a-z0-9]+)-(utilization|reset)$/;

function claudeFamilyId(family: string): { id: string; durationMs: number } {
  if (family === '5h') return { id: 'five-hour', durationMs: FIVE_HOUR_MS };
  if (family === '7d') return { id: 'seven-day', durationMs: WEEK_MS };
  const scope = family.slice(3);
  return { id: scope === 'oi' ? 'seven-day-fable' : `seven-day-${scope}`, durationMs: WEEK_MS };
}

/**
 * CPA keeps the rate-limit headers of the last response per credential (`quota.signals`) and per
 * model (`model_quotas[model].signals`). Each set is a dated reading, and older per-model sets often
 * describe the previous window, so they are history too, not just "current".
 */
export function observationsFromSignals(cred: HistoryCredential): QuotaObservation[] {
  const sets: Array<{ observedAtMs: number; headers: Map<string, string> }> = [];
  const push = (raw: unknown) => {
    const record = asRecord(raw);
    const signals = asRecord(record.signals);
    const observedAtMs = parseIsoToMs(record.observed_at);
    if (observedAtMs === null || Object.keys(signals).length === 0) return;
    const headers = new Map<string, string>();
    for (const [key, value] of Object.entries(signals)) {
      const text = normalizeStringValue(Array.isArray(value) ? value[0] : value);
      if (text !== null) headers.set(key.toLowerCase(), text);
    }
    sets.push({ observedAtMs, headers });
  };
  push(cred.file.quota);
  if (isRecord(cred.file.model_quotas)) Object.values(cred.file.model_quotas).forEach(push);

  const out: QuotaObservation[] = [];
  for (const set of sets) {
    const claude = new Map<string, { utilization: number | null; reset: number | null }>();
    for (const [name, value] of set.headers) {
      const match = CLAUDE_HEADER.exec(name);
      if (!match) continue;
      const entry = claude.get(match[1]) ?? { utilization: null, reset: null };
      if (match[2] === 'utilization') entry.utilization = normalizeNumberValue(value);
      else entry.reset = parseUnixToMs(value);
      claude.set(match[1], entry);
    }
    for (const [family, { utilization, reset }] of claude) {
      if (utilization === null || reset === null) continue;
      const { id, durationMs } = claudeFamilyId(family);
      out.push({ windowId: id, durationMs, resetAtMs: reset, usedPercent: utilization * 100, observedAtMs: set.observedAtMs, source: 'signals' });
    }
    for (const slot of ['primary', 'secondary'] as const) {
      const used = normalizeNumberValue(set.headers.get(`x-codex-${slot}-used-percent`));
      const minutes = normalizeNumberValue(set.headers.get(`x-codex-${slot}-window-minutes`));
      if (used === null || minutes === null || minutes <= 0) continue;
      const resetAt =
        parseUnixToMs(set.headers.get(`x-codex-${slot}-reset-at`)) ??
        (() => {
          const after = normalizeNumberValue(set.headers.get(`x-codex-${slot}-reset-after-seconds`));
          return after === null ? null : set.observedAtMs + after * 1000;
        })();
      if (resetAt === null) continue;
      out.push({
        windowId: windowIdFromMinutes(minutes),
        durationMs: minutes * MINUTE_MS,
        resetAtMs: resetAt,
        usedPercent: used,
        observedAtMs: set.observedAtMs,
        source: 'signals',
      });
    }
  }
  return out;
}

/* ---------- which models a window counts ---------- */

/** Windows that meter every request on the credential. */
const ACCOUNT_WIDE: Record<string, ReadonlySet<string>> = {
  claude: new Set(['five-hour', 'seven-day']),
  codex: new Set(['five-hour', 'weekly', 'daily', 'monthly']),
};

const CLAUDE_SCOPE_HEADER: Record<string, { header: string; name: RegExp }> = {
  'seven-day-fable': { header: '7d_oi', name: /fable/ },
  'seven-day-opus': { header: '7d_opus', name: /opus/ },
  'seven-day-sonnet': { header: '7d_sonnet', name: /sonnet/ },
};

export type WindowModelScope = { kind: 'all' } | { kind: 'models'; models: string[] } | { kind: 'unknown' };

/**
 * Model-scoped limits (Claude's "7-day Fable 5", Codex's "gpt-reserve") only meter some models, so
 * their requests/tokens/cost must be counted for those models alone. Claude sends a scoped window's
 * header (e.g. `7d_oi`) only on responses from models it covers, and CPA keeps headers per model, so
 * the models carrying that header are the scope. Anything that cannot be pinned down is "unknown"
 * rather than silently counted account-wide.
 */
export function windowModelScope(cred: HistoryCredential, windowId: string): WindowModelScope {
  const provider = cred.provider;
  if (ACCOUNT_WIDE[provider]?.has(windowId)) return { kind: 'all' };
  if (provider === 'claude') {
    const rule = CLAUDE_SCOPE_HEADER[windowId] ?? (windowId.startsWith('seven-day-') ? { header: `7d_${windowId.slice(10)}`, name: null } : null);
    if (!rule) return { kind: 'unknown' };
    const models = new Set<string>();
    const quotas = isRecord(cred.file.model_quotas) ? cred.file.model_quotas : {};
    for (const [model, raw] of Object.entries(quotas)) {
      const signals = asRecord(asRecord(raw).signals);
      const carries = Object.keys(signals).some((h) => h.toLowerCase() === `anthropic-ratelimit-unified-${rule.header}-utilization`);
      if (carries || (rule.name && rule.name.test(model.toLowerCase()))) models.add(model);
    }
    return models.size > 0 ? { kind: 'models', models: [...models].sort() } : { kind: 'unknown' };
  }
  if (provider === 'codex') return { kind: 'unknown' };
  return { kind: 'all' };
}

/* ---------- Quota page live reads (localStorage, written by the Quota page) ---------- */

export function observationsFromStoredLive(cred: HistoryCredential): QuotaObservation[] {
  const stored = readStoredLive(cred.key);
  if (!stored) return [];
  const out: QuotaObservation[] = [];
  for (const window of stored.data.windows) {
    if (window.kind === 'billing' || window.usedPercent === null || window.resetAtMs === null) continue;
    out.push({
      windowId: window.id,
      label: window.label,
      durationMs: window.periodHours ? window.periodHours * HOUR_MS : null,
      resetAtMs: window.resetAtMs,
      usedPercent: window.usedPercent,
      observedAtMs: window.observedAtMs ?? stored.at,
      source: 'live',
    });
  }
  return out;
}

/* ---------- Manager quota snapshots ---------- */

export interface SnapshotCycle {
  state?: string;
  scheduled_start_ms?: number | null;
  scheduled_end_ms?: number | null;
  actual_start_ms?: number | null;
  actual_end_ms?: number | null;
  duration_seconds?: number | null;
  boundary_accuracy?: string;
  end_reason?: string;
}

export interface SnapshotWindowRaw {
  provider_window_id?: string;
  window_kind?: string;
  observed_at_ms?: number;
  cycle_start_ms?: number | null;
  cycle_end_ms?: number | null;
  duration_seconds?: number | null;
  used_percent?: number | null;
  remaining_percent?: number | null;
  stale?: boolean;
  availability?: string;
  current_cycle?: SnapshotCycle | null;
  previous_cycle?: SnapshotCycle | null;
}

export interface SnapshotItemRaw {
  row_key?: string;
  provider?: string;
  windows?: SnapshotWindowRaw[];
}

const isReliable = (accuracy: unknown) => accuracy === 'exact' || accuracy === 'derived';

function cycleBoundary(windowId: string, durationMs: number | null, cycle: SnapshotCycle | null | undefined): CycleBoundary | null {
  if (!cycle || !isReliable(cycle.boundary_accuracy)) return null;
  const start = normalizeNumberValue(cycle.actual_start_ms) ?? normalizeNumberValue(cycle.scheduled_start_ms);
  const end = normalizeNumberValue(cycle.actual_end_ms) ?? normalizeNumberValue(cycle.scheduled_end_ms);
  if (start === null || end === null || end <= start) return null;
  return {
    windowId,
    durationMs: normalizeNumberValue(cycle.duration_seconds) !== null ? (normalizeNumberValue(cycle.duration_seconds) as number) * 1000 : durationMs,
    startMs: start,
    endMs: end,
    state: cycle.state === 'active' && cycle.actual_end_ms == null ? 'active' : 'closed',
    endReason: cycle.end_reason || undefined,
  };
}

export function fromSnapshotItem(provider: string, item: SnapshotItemRaw): { observations: QuotaObservation[]; cycles: CycleBoundary[] } {
  const observations: QuotaObservation[] = [];
  const cycles: CycleBoundary[] = [];
  for (const raw of item.windows ?? []) {
    const rawId = normalizeStringValue(raw.provider_window_id);
    if (!rawId) continue;
    const windowId = normalizeSnapshotWindowId(provider, rawId);
    const seconds = normalizeNumberValue(raw.duration_seconds);
    const durationMs = seconds !== null && seconds > 0 ? seconds * 1000 : null;
    for (const cycle of [raw.current_cycle, raw.previous_cycle]) {
      const boundary = cycleBoundary(windowId, durationMs, cycle);
      if (boundary) cycles.push(boundary);
    }
    const used = normalizeNumberValue(raw.used_percent) ?? (normalizeNumberValue(raw.remaining_percent) !== null ? 100 - (normalizeNumberValue(raw.remaining_percent) as number) : null);
    const observedAt = normalizeNumberValue(raw.observed_at_ms);
    const resetAt = normalizeNumberValue(raw.current_cycle?.scheduled_end_ms) ?? normalizeNumberValue(raw.cycle_end_ms);
    if (used === null || observedAt === null || resetAt === null || resetAt <= observedAt) continue;
    if (raw.availability && raw.availability !== 'active') continue;
    observations.push({ windowId, durationMs, resetAtMs: resetAt, usedPercent: used, observedAtMs: observedAt, source: 'snapshot' });
  }
  return { observations, cycles };
}

/* ---------- per-request response headers (analytics events) ---------- */

/** Providers whose responses carry quota windows in headers (CPA parses Codex `x-codex-*`). */
export const HEADER_QUOTA_PROVIDERS = new Set(['codex']);

export function observationsFromEvent(event: EventRow): QuotaObservation[] {
  const quota = event.response_metadata?.quota;
  if (!quota) return [];
  const out: QuotaObservation[] = [];
  const add = (window: ResponseHeaderQuotaWindow | undefined) => {
    if (!window) return;
    const used = normalizeNumberValue(window.used_percent);
    const minutes = normalizeNumberValue(window.window_minutes);
    if (used === null || minutes === null || minutes <= 0) return;
    const resetAt =
      normalizeNumberValue(window.reset_at_ms) ??
      (normalizeNumberValue(window.reset_after_seconds) !== null ? event.timestamp_ms + (window.reset_after_seconds as number) * 1000 : null);
    if (resetAt === null) return;
    out.push({
      windowId: windowIdFromMinutes(minutes),
      durationMs: minutes * MINUTE_MS,
      resetAtMs: resetAt,
      usedPercent: used,
      observedAtMs: event.timestamp_ms,
      source: 'headers',
    });
  };
  add(quota.primary);
  add(quota.secondary);
  return out;
}
