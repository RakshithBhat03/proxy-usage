import type { AuthFile } from '@/lib/api/authFiles';

/**
 * Credential quota history. Quota windows are reconstructed from every place a "used % + reset
 * time" pair was ever recorded (traffic headers, auth-file signals, the Quota page's live reads,
 * and this browser's own log), then joined with per-window request/token/cost totals.
 */

export type WindowKind = 'five-hour' | 'weekly' | 'other';

/** Where a quota reading came from; ordered roughly by how much history each one holds. */
export type ObservationSource = 'headers' | 'signals' | 'live' | 'log';

/** One reading of one quota window: at `observedAtMs` it was `usedPercent` used and reset at `resetAtMs`. */
export interface QuotaObservation {
  windowId: string;
  label?: string;
  durationMs: number | null;
  resetAtMs: number;
  usedPercent: number;
  observedAtMs: number;
  source: ObservationSource;
}

/** How a window's start was found: from its observed reset and duration, or the fixed weekly schedule. */
export type BoundaryBasis = 'observed' | 'schedule';

export interface UsagePoint {
  t: number;
  used: number;
}

export interface HistoryWindow {
  /** Stable across refreshes: `${windowId}@${scheduled reset, minute precision}`. */
  uid: string;
  windowId: string;
  label: string;
  kind: WindowKind;
  durationMs: number | null;
  startMs: number;
  /** Actual end: the scheduled reset, or the moment an early (manual) reset replaced it. */
  endMs: number;
  scheduledEndMs: number;
  status: 'current' | 'past';
  endedEarly: boolean;
  boundary: BoundaryBasis;
  peakUsed: number | null;
  lastUsed: number | null;
  lastObservedAtMs: number | null;
  firstObservedAtMs: number | null;
  points: UsagePoint[];
  sources: ObservationSource[];
}

/** One credential the history can be shown for (built from the auth-file list). */
export interface HistoryCredential {
  key: string;
  name: string;
  provider: string;
  email: string | null;
  authIndex: string | null;
  disabled: boolean;
  file: AuthFile;
}

export interface WindowUsage {
  matched: boolean;
  requests: number;
  successCalls: number;
  failureCalls: number;
  tokens: number;
  cost: number;
  successRate: number | null;
  lastSeenMs: number | null;
  complete: boolean;
}
