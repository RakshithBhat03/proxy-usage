import type { AuthFile } from '@/lib/api/authFiles';

/**
 * Unified quota model. Every provider adapter normalizes to `QuotaData`; the page renders that one
 * shape as cards, ledger rows and timeline lanes. Percentages are always REMAINING (100 = untouched).
 */

export type QuotaProvider = 'claude' | 'antigravity' | 'codex' | 'xai' | 'kimi' | 'devin' | 'meta';

/** Tab and grouping order, matching CPAMC's QUOTA_TAB_ORDER. */
export const QUOTA_PROVIDERS: readonly QuotaProvider[] = ['claude', 'antigravity', 'codex', 'xai', 'kimi', 'devin', 'meta'];

export type QuotaSource = 'live' | 'signals';

/** Auth-file entry as returned by `/v0/management/auth-files`; extra keys are read defensively. */
export type AuthFileItem = AuthFile;

export interface QuotaWindow {
  /** Stable per provider: 'five-hour', 'seven-day', 'seven-day-fable', 'weekly', ... */
  id: string;
  label: string;
  remainingPercent: number | null;
  usedPercent: number | null;
  /** null => "No reset pending". */
  resetAtMs: number | null;
  periodHours: number | null;
  /** Antigravity group label. */
  group?: string;
  /** Billing rollovers (xAI monthly credits) are shown but never treated as quota resets. */
  kind?: 'quota' | 'billing';
  /** Count-based providers (Kimi): "12 / 100". */
  amount?: string;
  /** Cached window whose reset already passed: it has rolled over since it was observed. */
  stale?: boolean;
  observedAtMs?: number | null;
}

export type PlanTier = 'elite' | 'premium' | 'plain';

export interface PlanInfo {
  id: string;
  label: string;
  tier: PlanTier;
}

export interface CodexResetCredit {
  id: string;
  grantedAtMs: number | null;
  expiresAtMs: number;
}

export interface CodexExtras {
  creditBalance: string | null;
  creditsUnlimited: boolean;
  renewsAtMs: number | null;
  manualResets: {
    available: number | null;
    applicable: number | null;
    credits: CodexResetCredit[];
    error?: string;
  };
}

export interface ClaudeResetGrant {
  id: string;
  label: string;
  left: number;
  total: number;
  endsAtMs: number | null;
  usableNow: boolean;
  paused: boolean;
  useRequiresLimit: boolean;
}

export interface ClaudeExtras {
  extraUsage?: { usedCents: number; limitCents: number } | null;
  resetGrants?: {
    eligible: boolean;
    atLimit: boolean;
    count: number;
    grants: ClaudeResetGrant[];
    nextGrantId: string | null;
    cooldownUntilMs: number | null;
  } | null;
}

export interface XaiExtras {
  payAsYouGo: { capCents: number | null; usedCents: number | null; usedPercent: number | null } | null;
  prepaidBalanceCents: number | null;
  productUsage: Array<{ product: string; usagePercent: number | null }>;
  /** Paid API credentials only expose a health check, not totals. */
  healthOnly?: boolean;
}

export interface QuotaData {
  windows: QuotaWindow[];
  plan: PlanInfo | null;
  codex?: CodexExtras;
  claude?: ClaudeExtras;
  xai?: XaiExtras;
  /** Neutral message shown instead of meters ("Quota unknown..."). */
  note?: string;
}

export interface AccountQuota extends QuotaData {
  source: QuotaSource;
  observedAtMs: number | null;
}

/** One credential on the page, derived from the auth-file list. */
export interface QuotaEntry {
  /** Cache key: file name (Devin: name + '\0' + auth_index). */
  key: string;
  provider: QuotaProvider;
  file: AuthFileItem;
  name: string;
  email: string | null;
  authIndex: string | null;
  disabled: boolean;
}

export type QuotaLevel = 'high' | 'medium' | 'low' | 'unknown';

export class QuotaStatusError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'QuotaStatusError';
    this.status = status;
  }
}

export const statusOfError = (error: unknown): number | undefined => {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
};
