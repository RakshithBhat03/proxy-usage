import { DAY_MS, HOUR_MS } from './parse';
import type { AccountQuota, QuotaProvider, QuotaWindow } from './types';

/**
 * "Quota windows" timeline model (port of CPAMC quotaTimelineModel.ts on the unified model).
 * Pure, clock injected. Answers "when does capacity come back, and does it come back at once?".
 */

export { DAY_MS };

export type TimelineMode = 'weekly' | 'session';
export const TIMELINE_SPAN_DAYS: Record<TimelineMode, number> = { weekly: 14, session: 3 };
const SESSION_PERIOD_HOURS = 5;

export interface TimelineLimit {
  label: string;
  remaining: number;
}

export interface TimelineResetCredit {
  id: string;
  grantedAtMs: number | null;
  expiresAtMs: number;
}

export interface TimelineResetCreditMark extends TimelineResetCredit {
  leftPercent: number;
}

export interface TimelineLane {
  name: string;
  displayName: string;
  provider: QuotaProvider;
  /** A known reset instant; every other boundary derives from it. */
  anchorMs: number | null;
  periodHours: number | null;
  remaining: number | null;
  limits: TimelineLimit[];
  resetCredits: TimelineResetCredit[];
}

export interface TimelineWindow {
  startMs: number;
  endMs: number;
  leftPercent: number;
  widthPercent: number;
  state: 'past' | 'live' | 'next';
  remaining: number | null;
}

export function windowsIn(anchorMs: number, periodMs: number, fromMs: number, toMs: number) {
  if (!Number.isFinite(anchorMs) || !(periodMs > 0) || !(toMs > fromMs)) return [];
  if (Math.ceil((toMs - fromMs) / periodMs) + 2 > 1000) return []; // pathological guard
  let end = anchorMs + Math.ceil((fromMs - anchorMs) / periodMs) * periodMs;
  const out: Array<{ startMs: number; endMs: number }> = [];
  while (end - periodMs < toMs) {
    out.push({ startMs: end - periodMs, endMs: end });
    end += periodMs;
  }
  return out;
}

export function startOfDay(ms: number) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Sunday-based week start. */
export function startOfWeek(ms: number) {
  const d = new Date(startOfDay(ms));
  d.setDate(d.getDate() - d.getDay());
  return d.getTime();
}

/** Date arithmetic (not ms) keeps spans DST-safe. */
export function timelineSpan(mode: TimelineMode, offset: number, now: number) {
  const days = TIMELINE_SPAN_DAYS[mode];
  const base = new Date(mode === 'weekly' ? startOfWeek(now) : startOfDay(now));
  base.setDate(base.getDate() + offset * (mode === 'weekly' ? 7 : 1));
  const startMs = base.getTime();
  const end = new Date(startMs);
  end.setDate(end.getDate() + days);
  return { startMs, endMs: end.getTime(), days };
}

export function projectLane(lane: TimelineLane, spanStartMs: number, spanEndMs: number, now: number, mode: TimelineMode): TimelineWindow[] {
  const ph = lane.periodHours;
  if (lane.anchorMs === null || !ph) return [];
  if (mode === 'session' && ph !== SESSION_PERIOD_HOURS) return [];
  const span = spanEndMs - spanStartMs;
  if (span <= 0) return [];
  const pct = (ms: number) => ((ms - spanStartMs) / span) * 100;
  return windowsIn(lane.anchorMs, ph * HOUR_MS, spanStartMs, spanEndMs)
    .map((w): TimelineWindow | null => {
      const left = Math.max(0, pct(w.startMs));
      const right = Math.min(100, pct(w.endMs));
      if (right <= 0 || left >= 100 || right <= left) return null;
      const state = w.endMs <= now ? 'past' : w.startMs <= now ? 'live' : 'next';
      return {
        startMs: w.startMs,
        endMs: w.endMs,
        leftPercent: left,
        widthPercent: right - left,
        state,
        // Only the API-reported current window (ending exactly at the anchor) carries usage.
        remaining: state === 'live' && w.endMs === lane.anchorMs ? lane.remaining : null,
      };
    })
    .filter((w): w is TimelineWindow => w !== null);
}

export function projectResetCredits(lane: TimelineLane, spanStartMs: number, spanEndMs: number, now: number): TimelineResetCreditMark[] {
  const span = spanEndMs - spanStartMs;
  if (span <= 0) return [];
  return lane.resetCredits
    .filter((c) => c.expiresAtMs > now && c.expiresAtMs >= spanStartMs && c.expiresAtMs < spanEndMs)
    .map((c) => ({ ...c, leftPercent: ((c.expiresAtMs - spanStartMs) / span) * 100 }));
}

/** Longest period that still fits the view; soonest reset breaks ties. Nothing fits -> all usable. */
export function pickLaneWindow<T extends { resetAtMs?: number | null; periodHours?: number | null }>(windows: readonly T[], maxPeriodHours?: number): T | null {
  const usable = windows.filter((w) => typeof w.resetAtMs === 'number' && Number.isFinite(w.resetAtMs));
  if (usable.length === 0) return null;
  const periodOf = (w: T) => (typeof w.periodHours === 'number' && w.periodHours > 0 ? w.periodHours : 0);
  const fitting = maxPeriodHours === undefined ? usable : usable.filter((w) => periodOf(w) <= maxPeriodHours);
  const pool = fitting.length > 0 ? fitting : usable;
  return pool.reduce((best, w) => {
    const d = periodOf(w) - periodOf(best);
    if (d !== 0) return d > 0 ? w : best;
    return (w.resetAtMs as number) < (best.resetAtMs as number) ? w : best;
  });
}

export const laneHasWindow = (lane: TimelineLane) => lane.anchorMs !== null;

export interface TimelineLaneInput {
  name: string;
  displayName: string;
  provider: QuotaProvider;
  quota: AccountQuota | null | undefined;
  maxPeriodHours?: number;
}

export function buildTimelineLane({ name, displayName, provider, quota, maxPeriodHours }: TimelineLaneInput): TimelineLane {
  const empty: TimelineLane = { name, displayName, provider, anchorMs: null, periodHours: null, remaining: null, limits: [], resetCredits: [] };
  if (!quota) return empty;
  // Billing rollovers (xAI monthly credits) are not quota resets.
  const windows = quota.windows.filter((w): w is QuotaWindow & { resetAtMs: number } => w.kind !== 'billing' && typeof w.resetAtMs === 'number');
  const limits = quota.windows
    .filter((w) => w.kind !== 'billing' && w.remainingPercent !== null)
    .map((w) => ({ label: w.label, remaining: Math.round(w.remainingPercent as number) }));
  let chosen: QuotaWindow | null = null;
  if (provider === 'codex') {
    // Model-scoped weekly windows ("gpt-reserve weekly") must not steal the account lane.
    const preferredId = maxPeriodHours !== undefined && maxPeriodHours <= SESSION_PERIOD_HOURS ? 'five-hour' : 'weekly';
    chosen =
      windows.find(
        (w) => w.id === preferredId && typeof w.periodHours === 'number' && w.periodHours > 0 && (maxPeriodHours === undefined || w.periodHours <= maxPeriodHours),
      ) ?? null;
  }
  chosen = chosen ?? pickLaneWindow(windows, maxPeriodHours);
  if (!chosen) return { ...empty, limits };
  return {
    ...empty,
    anchorMs: chosen.resetAtMs,
    periodHours: chosen.periodHours,
    remaining: chosen.remainingPercent === null ? null : Math.round(chosen.remainingPercent),
    limits,
    resetCredits: (quota.codex?.manualResets.credits ?? []).map((c) => ({ id: c.id, grantedAtMs: c.grantedAtMs, expiresAtMs: c.expiresAtMs })),
  };
}
