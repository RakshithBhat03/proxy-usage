import type { AccountQuota, QuotaLevel, QuotaWindow } from './types';

/** Meter bands (CPAMC QuotaMeter): >= 70 green, >= 30 amber, below red. Input is REMAINING. */
export const QUOTA_HIGH_THRESHOLD = 70;
export const QUOTA_MEDIUM_THRESHOLD = 30;

export function quotaLevel(remaining: number | null | undefined): QuotaLevel {
  if (remaining === null || remaining === undefined || !Number.isFinite(remaining)) return 'unknown';
  const value = Math.min(100, Math.max(0, remaining));
  return value >= QUOTA_HIGH_THRESHOLD ? 'high' : value >= QUOTA_MEDIUM_THRESHOLD ? 'medium' : 'low';
}

export const formatRemaining = (remaining: number | null | undefined) =>
  remaining === null || remaining === undefined || !Number.isFinite(remaining) ? '--' : `${Math.round(remaining)}%`;

/** Windows that represent quota (billing rollovers excluded). */
export const quotaWindows = (quota: AccountQuota | null | undefined): QuotaWindow[] =>
  (quota?.windows ?? []).filter((window) => window.kind !== 'billing');

export function minRemaining(quota: AccountQuota | null | undefined): number | null {
  let min: number | null = null;
  for (const window of quotaWindows(quota)) {
    if (window.remainingPercent === null) continue;
    min = min === null ? window.remainingPercent : Math.min(min, window.remainingPercent);
  }
  return min;
}

/**
 * Merges cached sources: for each window id the newer observation wins (signals vs snapshot).
 * Non-window facts (plan, Codex extras) come from whichever candidate has them.
 */
export function mergeCachedQuota(...candidates: Array<AccountQuota | null | undefined>): AccountQuota | null {
  const present = candidates.filter((c): c is AccountQuota => Boolean(c));
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  const byId = new Map<string, QuotaWindow>();
  const order: string[] = [];
  let newestSource = present[0];
  for (const candidate of present) {
    if ((candidate.observedAtMs ?? 0) > (newestSource.observedAtMs ?? 0)) newestSource = candidate;
    for (const window of candidate.windows) {
      const existing = byId.get(window.id);
      if (!existing) order.push(window.id);
      if (!existing || (window.observedAtMs ?? 0) > (existing.observedAtMs ?? 0)) byId.set(window.id, window);
    }
  }
  const base = present.find((c) => c.codex || c.plan) ?? present[0];
  return {
    ...base,
    windows: order.map((id) => byId.get(id) as QuotaWindow),
    plan: present.find((c) => c.plan)?.plan ?? null,
    source: newestSource.source,
    observedAtMs: Math.max(...present.map((c) => c.observedAtMs ?? 0)) || null,
  };
}

/** Live answers replace cached ones wholesale; Codex keeps id_token facts the live call lacks. */
export function resolveDisplayQuota(live: AccountQuota | null, cached: AccountQuota | null): AccountQuota | null {
  if (!live) return cached;
  if (live.codex && cached?.codex && live.codex.renewsAtMs === null) {
    return { ...live, codex: { ...live.codex, renewsAtMs: cached.codex.renewsAtMs } };
  }
  return live;
}
