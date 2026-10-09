import { HOUR_MS } from './parse';
import { QUOTA_PROVIDERS, type AccountQuota, type QuotaEntry } from './types';
import { minRemaining } from './model';

/**
 * Reset schedule (port of CPAMC resetSchedule.ts): which row recovers first, which is urgent
 * (< 1h), and the "soonest reset" sort key. Renewal dates and billing rollovers are excluded.
 */

export interface QuotaRowInstant {
  rowId: string;
  atMs: number;
  kind: 'window' | 'credit';
}

export const resetCreditRowId = (id: string, index: number) => `credit:${id || index}`;

export function collectQuotaRowInstants(quota: AccountQuota | null | undefined): QuotaRowInstant[] {
  if (!quota) return [];
  const instants: QuotaRowInstant[] = [];
  for (const window of quota.windows) {
    if (window.kind === 'billing' || window.resetAtMs === null) continue;
    instants.push({ rowId: window.id, atMs: window.resetAtMs, kind: 'window' });
  }
  quota.codex?.manualResets.credits.forEach((credit, index) => {
    instants.push({ rowId: resetCreditRowId(credit.id, index), atMs: credit.expiresAtMs, kind: 'credit' });
  });
  return instants;
}

export function pickSoonestRowId(instants: QuotaRowInstant[], now: number, maxAheadMs = Infinity): string | null {
  let best: QuotaRowInstant | null = null;
  for (const instant of instants) {
    const ahead = instant.atMs - now;
    if (ahead <= 0 || ahead >= maxAheadMs) continue;
    if (!best || instant.atMs < best.atMs || (instant.atMs === best.atMs && instant.rowId < best.rowId)) best = instant;
  }
  return best?.rowId ?? null;
}

/** Only the single soonest reset under one hour away is emphasized. */
export const pickUrgentRowId = (instants: QuotaRowInstant[], now: number) => pickSoonestRowId(instants, now, HOUR_MS);

export function nextRecoveryMs(quota: AccountQuota | null | undefined, now: number): number | null {
  let min: number | null = null;
  for (const instant of collectQuotaRowInstants(quota)) {
    if (instant.kind !== 'window' || instant.atMs <= now) continue;
    min = min === null ? instant.atMs : Math.min(min, instant.atMs);
  }
  return min;
}

export type QuotaSortMode = 'default' | 'lowest' | 'soonest' | 'name' | 'provider';

export const QUOTA_SORT_OPTIONS: Array<{ value: QuotaSortMode; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'lowest', label: 'Lowest remaining' },
  { value: 'soonest', label: 'Soonest reset' },
  { value: 'name', label: 'Name' },
  { value: 'provider', label: 'Provider' },
];

/** Stable sort; entries without a key keep their original order at the end. */
export function sortQuotaEntries(
  entries: QuotaEntry[],
  mode: QuotaSortMode,
  quotaFor: (entry: QuotaEntry) => AccountQuota | null,
  now: number,
): QuotaEntry[] {
  // Classification already groups by provider in tab order, keeping the server's file order.
  if (mode === 'default') return entries;
  const indexed = entries.map((entry, index) => ({ entry, index }));
  if (mode === 'provider') {
    return indexed
      .sort((a, b) => QUOTA_PROVIDERS.indexOf(a.entry.provider) - QUOTA_PROVIDERS.indexOf(b.entry.provider) || a.entry.name.localeCompare(b.entry.name))
      .map(({ entry }) => entry);
  }
  if (mode === 'name') {
    return indexed.sort((a, b) => a.entry.name.localeCompare(b.entry.name) || a.index - b.index).map(({ entry }) => entry);
  }
  const keyOf = (entry: QuotaEntry) => (mode === 'lowest' ? minRemaining(quotaFor(entry)) : nextRecoveryMs(quotaFor(entry), now));
  return indexed
    .map((item) => ({ ...item, key: keyOf(item.entry) }))
    .sort((a, b) => {
      if (a.key === null && b.key === null) return a.index - b.index;
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      return a.key - b.key || a.index - b.index;
    })
    .map(({ entry }) => entry);
}
