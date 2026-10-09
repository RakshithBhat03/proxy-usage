import { asRecord, isRecord, normalizeNumberValue, normalizePlanType, normalizeStringValue, parseIsoToMs, parseUnixToMs, toRemaining } from './parse';
import { codexPlan } from './plans';
import { CLAUDE_WINDOW_LABELS } from './providers/claude';
import { buildCodexQuotaWindows, codexFileFacts } from './providers/codex';
import type { AccountQuota, QuotaEntry, QuotaWindow } from './types';

/**
 * Passive quota: CPA records provider rate-limit RESPONSE HEADERS from real traffic on each auth
 * entry (`quota.signals` = last request, `model_quotas[model].signals` = last request per model).
 * Reading them costs zero provider calls, which makes them the instant first paint.
 */

interface SignalSet {
  observedAtMs: number;
  /** Lower-cased header name -> value. */
  headers: Map<string, string>;
}

function collectSignalSets(entry: QuotaEntry): SignalSet[] {
  const sets: SignalSet[] = [];
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
  push(entry.file.quota);
  const models = entry.file.model_quotas;
  if (isRecord(models)) Object.values(models).forEach(push);
  return sets;
}

/** Cached windows whose reset has passed rolled over since they were seen: show them as full. */
export function settleStaleWindow(window: QuotaWindow, now: number): QuotaWindow {
  if (window.resetAtMs === null || window.resetAtMs > now) return window;
  return { ...window, usedPercent: 0, remainingPercent: 100, resetAtMs: null, stale: true };
}

const CLAUDE_HEADER = /^anthropic-ratelimit-unified-(5h|7d|7d_[a-z0-9]+)-(utilization|reset|status)$/;

function claudeFamily(family: string): { id: string; label: string; periodHours: number } {
  if (family === '5h') return { id: 'five-hour', label: CLAUDE_WINDOW_LABELS['five-hour'], periodHours: 5 };
  if (family === '7d') return { id: 'seven-day', label: CLAUDE_WINDOW_LABELS['seven-day'], periodHours: 168 };
  const scope = family.slice(3);
  // `7d_oi` is the weekly scoped limit that equals "7-day Fable 5" in the live usage API.
  if (scope === 'oi') return { id: 'seven-day-fable', label: CLAUDE_WINDOW_LABELS['seven-day-fable'], periodHours: 168 };
  const id = `seven-day-${scope}`;
  return { id, label: CLAUDE_WINDOW_LABELS[id] ?? `7-day ${scope.charAt(0).toUpperCase()}${scope.slice(1)}`, periodHours: 168 };
}

function claudeWindowsFromSignals(sets: SignalSet[], now: number): QuotaWindow[] {
  const latest = new Map<string, { utilization: number | null; reset: number | null; observedAtMs: number }>();
  for (const set of sets) {
    const families = new Map<string, { utilization: number | null; reset: number | null }>();
    for (const [name, value] of set.headers) {
      const match = CLAUDE_HEADER.exec(name);
      if (!match) continue;
      const [, family, field] = match;
      const current = families.get(family) ?? { utilization: null, reset: null };
      if (field === 'utilization') current.utilization = normalizeNumberValue(value);
      if (field === 'reset') current.reset = parseUnixToMs(value);
      families.set(family, current);
    }
    for (const [family, value] of families) {
      if (value.utilization === null) continue;
      const previous = latest.get(family);
      if (!previous || previous.observedAtMs < set.observedAtMs) latest.set(family, { ...value, observedAtMs: set.observedAtMs });
    }
  }
  const order = ['5h', '7d'];
  return [...latest.entries()]
    .sort(([a], [b]) => (order.indexOf(a) === -1 ? 9 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 9 : order.indexOf(b)))
    .map(([family, value]) => {
      const meta = claudeFamily(family);
      const used = value.utilization === null ? null : value.utilization * 100;
      return settleStaleWindow(
        {
          id: meta.id,
          label: meta.label,
          usedPercent: used,
          remainingPercent: toRemaining(used),
          resetAtMs: value.reset,
          periodHours: meta.periodHours,
          kind: 'quota' as const,
          observedAtMs: value.observedAtMs,
        },
        now,
      );
    });
}

function codexFromSignals(sets: SignalSet[], now: number) {
  const withWindows = sets.filter((set) => set.headers.has('x-codex-primary-used-percent')).sort((a, b) => b.observedAtMs - a.observedAtMs);
  const latest = withWindows[0] ?? [...sets].sort((a, b) => b.observedAtMs - a.observedAtMs)[0];
  if (!latest) return null;
  const h = latest.headers;
  const window = (prefix: 'primary' | 'secondary') => {
    const used = h.get(`x-codex-${prefix}-used-percent`);
    if (used === undefined) return null;
    const minutes = normalizeNumberValue(h.get(`x-codex-${prefix}-window-minutes`));
    return {
      used_percent: used,
      limit_window_seconds: minutes === null ? undefined : minutes * 60,
      reset_at: h.get(`x-codex-${prefix}-reset-at`),
      reset_after_seconds: h.get(`x-codex-${prefix}-reset-after-seconds`),
    };
  };
  const windows = withWindows.length
    ? buildCodexQuotaWindows({ rate_limit: { primary_window: window('primary'), secondary_window: window('secondary') } }, latest.observedAtMs).map((w) =>
        settleStaleWindow({ ...w, observedAtMs: latest.observedAtMs }, now),
      )
    : [];
  const unlimited = (h.get('x-codex-credits-unlimited') ?? '').toLowerCase() === 'true';
  const balanceRaw = h.get('x-codex-credits-balance');
  return {
    windows,
    observedAtMs: latest.observedAtMs,
    planType: normalizePlanType(h.get('x-codex-plan-type')),
    creditBalance: balanceRaw && /^\d+(?:\.\d+)?$/.test(balanceRaw) ? balanceRaw : null,
    creditsUnlimited: unlimited,
  };
}

/** Cached quota from traffic headers (plus Codex plan/renewal from the decoded id_token). */
export function quotaFromSignals(entry: QuotaEntry, now: number): AccountQuota | null {
  const sets = collectSignalSets(entry);
  if (entry.provider === 'claude') {
    const windows = claudeWindowsFromSignals(sets, now);
    if (windows.length === 0) return null;
    return { windows, plan: null, source: 'signals', observedAtMs: Math.max(...windows.map((w) => w.observedAtMs ?? 0)) };
  }
  if (entry.provider === 'codex') {
    const facts = codexFileFacts(entry.file);
    const signals = codexFromSignals(sets, now);
    return {
      windows: signals?.windows ?? [],
      plan: codexPlan(signals?.planType ?? facts.planType),
      codex: {
        creditBalance: signals?.creditBalance ?? null,
        creditsUnlimited: signals?.creditsUnlimited ?? false,
        renewsAtMs: facts.renewsAtMs,
        manualResets: { available: null, applicable: null, credits: [] },
      },
      source: 'signals',
      observedAtMs: signals && signals.windows.length > 0 ? signals.observedAtMs : null,
    };
  }
  return null;
}
