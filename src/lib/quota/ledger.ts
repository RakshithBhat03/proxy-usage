import { quotaLevel } from './model';
import type { AccountQuota, QuotaLevel, QuotaProvider } from './types';

/**
 * Ledger (multi-account) rules from quota.md §11.3: column order per provider, the primary and
 * secondary window used by the summary strip, and the cross-account sums.
 */

export const LEDGER_WINDOW_ORDER: Record<QuotaProvider, string[]> = {
  claude: ['five-hour', 'seven-day-fable', 'seven-day', 'seven-day-opus', 'seven-day-sonnet', 'seven-day-oauth-apps', 'seven-day-cowork', 'cloud-session-credits'],
  codex: ['five-hour', 'weekly', 'monthly'],
  xai: ['weekly', 'monthly-credits'],
  kimi: ['summary', 'monthly'],
  antigravity: [],
  devin: ['weekly', 'daily'],
  meta: ['weekly', 'window'],
};

// The 5-hour window is what runs out first in practice, so it leads; weekly windows follow.
const LEDGER_PRIMARY: Record<QuotaProvider, string[]> = {
  claude: ['five-hour', 'seven-day-fable', 'seven-day'],
  codex: ['five-hour', 'weekly', 'monthly'],
  xai: ['weekly', 'monthly-credits'],
  kimi: ['summary', 'monthly'],
  devin: ['weekly', 'daily'],
  meta: ['weekly', 'window'],
  antigravity: [],
};

const LEDGER_SECONDARY: Record<QuotaProvider, string[]> = {
  claude: ['seven-day-fable', 'seven-day'],
  codex: ['weekly', 'monthly'],
  devin: ['daily'],
  meta: ['window'],
  xai: [],
  kimi: [],
  antigravity: [],
};

export const MANUAL_RESETS_COLUMN = 'manual-resets';

export interface LedgerColumn {
  id: string;
  label: string;
}

/** Every window id reported across the accounts, in ledger order (unknown ids keep first-seen order). */
export function ledgerWindowIds(provider: QuotaProvider, accounts: AccountQuota[]): LedgerColumn[] {
  const seen = new Map<string, { label: string; periodHours: number; firstSeen: number }>();
  let counter = 0;
  for (const account of accounts) {
    for (const window of account.windows) {
      if (!seen.has(window.id)) seen.set(window.id, { label: window.label, periodHours: window.periodHours ?? 0, firstSeen: counter++ });
    }
  }
  const order = LEDGER_WINDOW_ORDER[provider];
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index === -1 ? order.length : index;
  };
  return [...seen.entries()]
    .sort(([a, ma], [b, mb]) => {
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      // Antigravity (no fixed ids): longest period first, then label.
      if (provider === 'antigravity') return mb.periodHours - ma.periodHours || ma.label.localeCompare(mb.label);
      return ma.firstSeen - mb.firstSeen;
    })
    .map(([id, meta]) => ({ id, label: meta.label }));
}

/** Up to `max` columns; Codex reserves the last slot for "Manual resets" when any account reports them. */
export function ledgerColumns(provider: QuotaProvider, accounts: AccountQuota[], max = 3): { columns: LedgerColumn[]; overflow: LedgerColumn[] } {
  const all = ledgerWindowIds(provider, accounts);
  const hasResets = provider === 'codex' && accounts.some((a) => a.codex?.manualResets.available != null);
  const windowSlots = hasResets ? max - 1 : max;
  const columns = all.slice(0, windowSlots);
  if (hasResets) columns.push({ id: MANUAL_RESETS_COLUMN, label: 'Manual resets' });
  return { columns, overflow: all.slice(windowSlots) };
}

export function primaryWindowId(provider: QuotaProvider, accounts: AccountQuota[]): string | null {
  const reported = (id: string) => accounts.some((a) => a.windows.some((w) => w.id === id));
  const preferred = LEDGER_PRIMARY[provider].find(reported);
  if (preferred) return preferred;
  // No preference list (Antigravity) or nothing matched: the longest-period window wins.
  return ledgerWindowIds(provider, accounts)[0]?.id ?? null;
}

export function secondaryWindowId(provider: QuotaProvider, accounts: AccountQuota[], primary: string | null): string | null {
  const reported = (id: string) => accounts.some((a) => a.windows.some((w) => w.id === id));
  return LEDGER_SECONDARY[provider].find((id) => id !== primary && reported(id)) ?? null;
}

export interface WindowSummary {
  windowId: string;
  label: string;
  sumRemaining: number | null;
  maxTotal: number;
  unknownCount: number;
  segments: Array<{ key: string; remaining: number | null; level: QuotaLevel }>;
  soonestResetMs: number | null;
}

export function summarizeWindow(accounts: Array<{ key: string; quota: AccountQuota | null }>, windowId: string, now: number): WindowSummary {
  let label = windowId;
  const segments = accounts.map(({ key, quota }) => {
    const window = quota?.windows.find((w) => w.id === windowId);
    if (window) label = window.label;
    const remaining = window ? window.remainingPercent : null;
    return { key, remaining, level: quotaLevel(remaining), resetAtMs: window?.resetAtMs ?? null };
  });
  const known = segments.filter((s) => s.remaining !== null);
  return {
    windowId,
    label,
    sumRemaining: known.length ? Math.round(known.reduce((total, s) => total + (s.remaining as number), 0)) : null,
    maxTotal: accounts.length * 100,
    unknownCount: segments.length - known.length,
    segments: segments.map(({ key, remaining, level }) => ({ key, remaining, level })),
    soonestResetMs: segments.reduce<number | null>(
      (min, s) => (s.resetAtMs !== null && s.resetAtMs > now && (min === null || s.resetAtMs < min) ? s.resetAtMs : min),
      null,
    ),
  };
}

export interface ProviderSummary {
  provider: QuotaProvider;
  credentialCount: number;
  primary: WindowSummary | null;
  secondary: WindowSummary | null;
  /** Every other window aggregate, revealed by the summary's "Show" toggle. */
  others: WindowSummary[];
}

export function summarizeProvider(provider: QuotaProvider, accounts: Array<{ key: string; quota: AccountQuota | null }>, now: number): ProviderSummary {
  const loaded = accounts.map((a) => a.quota).filter((q): q is AccountQuota => Boolean(q));
  const primaryId = primaryWindowId(provider, loaded);
  const secondaryId = secondaryWindowId(provider, loaded, primaryId);
  const others = ledgerWindowIds(provider, loaded)
    .filter((column) => column.id !== primaryId && column.id !== secondaryId)
    .map((column) => summarizeWindow(accounts, column.id, now));
  return {
    provider,
    credentialCount: accounts.length,
    primary: primaryId ? summarizeWindow(accounts, primaryId, now) : null,
    secondary: secondaryId ? summarizeWindow(accounts, secondaryId, now) : null,
    others,
  };
}

export type QuotaViewMode = 'auto' | 'cards' | 'ledger';

/** Ledger once any provider has >= 2 credentials or there are >= 4 in total, otherwise cards. */
export function defaultQuotaView(countsByProvider: Partial<Record<QuotaProvider, number>>): 'ledger' | 'cards' {
  const counts = Object.values(countsByProvider).map((n) => n ?? 0);
  const total = counts.reduce((sum, n) => sum + n, 0);
  return counts.some((n) => n >= 2) || total >= 4 ? 'ledger' : 'cards';
}
