import { HOUR_MS, MINUTE_MS } from '@/lib/quota/parse';
import type { HistoryWindow, WindowUsage } from './types';

/* ---------- burn-rate projection of the quota percentage ---------- */

export interface PaceForecast {
  /** %/hour since the window started (it is 0% at the start by definition). */
  ratePerHour: number;
  projectedAtReset: number;
  /** When this pace reaches 100%, if that is before the reset. */
  runsOutAtMs: number | null;
}

export interface QuotaForecast {
  usedNow: number;
  observedAtMs: number;
  exhausted: boolean;
  /** Under ~5% of the window elapsed, or a reading from long ago: the projection is shaky. */
  lowConfidence: boolean;
  average: PaceForecast | null;
  /** Pace over the latest stretch of readings (needs at least two readings ≥ 10 min apart). */
  recent: (PaceForecast & { spanMs: number }) | null;
}

function pace(used: number, fromMs: number, ratePerMs: number, endMs: number): PaceForecast {
  const projected = used + ratePerMs * Math.max(0, endMs - fromMs);
  const runsOutAtMs = ratePerMs > 0 && used < 100 ? fromMs + (100 - used) / ratePerMs : null;
  return {
    ratePerHour: ratePerMs * HOUR_MS,
    projectedAtReset: projected,
    runsOutAtMs: runsOutAtMs !== null && runsOutAtMs < endMs ? runsOutAtMs : null,
  };
}

/**
 * Linear projection to the reset. The average pace treats the window as starting at 0% (true for
 * every fixed window), so a single reading is enough. The recent pace uses the readings of the last
 * max(30 min, 10% of the window) and reacts to bursts; both are shown so neither is mistaken for
 * the other.
 */
export function forecastWindow(window: HistoryWindow, now: number): QuotaForecast | null {
  if (window.status !== 'current' || window.lastUsed === null || window.lastObservedAtMs === null) return null;
  const used = window.lastUsed;
  const at = window.lastObservedAtMs;
  const end = window.endMs;
  const elapsed = at - window.startMs;
  const duration = window.durationMs ?? end - window.startMs;
  const exhausted = used >= 100;
  const lowConfidence = elapsed < Math.max(5 * MINUTE_MS, duration * 0.05) || now - at > Math.max(HOUR_MS, duration * 0.25);

  const average = elapsed > MINUTE_MS && !exhausted ? pace(used, at, used / elapsed, end) : null;

  let recent: QuotaForecast['recent'] = null;
  const lookback = Math.max(30 * MINUTE_MS, duration * 0.1);
  const inWindow = window.points.filter((p) => p.t >= at - lookback && p.t <= at);
  if (inWindow.length >= 2 && !exhausted) {
    const first = inWindow[0];
    const span = at - first.t;
    if (span >= 10 * MINUTE_MS) {
      const rate = Math.max(0, used - first.used) / span;
      recent = { ...pace(used, at, rate, end), spanMs: span };
    }
  }
  return { usedNow: used, observedAtMs: at, exhausted, lowConfidence, average, recent };
}

/* ---------- "Current window forecast" (requests / tokens / cost) ---------- */

export interface UsageMetrics {
  requests: number;
  tokens: number;
  cost: number;
}

export interface CapacityForecast extends UsageMetrics {
  basis: 'quota' | 'previous';
}

const usable = (m: UsageMetrics | null | undefined): m is UsageMetrics =>
  !!m && [m.requests, m.tokens, m.cost].every((v) => Number.isFinite(v) && v >= 0);

/**
 * Semantics follow CPA Manager Plus (MIT): if the provider says the
 * window is `used%` consumed and we counted `current` requests/tokens/cost inside it (up to that
 * reading), a full window is `current × 100 / used%`. Without a usable percentage it falls back to
 * the previous window's actual totals.
 */
export function estimateWindowUsage(input: { usedPercent: number | null; current: UsageMetrics | null; previous?: UsageMetrics | null }): CapacityForecast | null {
  const { usedPercent, current, previous } = input;
  const hasUsage = usable(current) && (current.requests > 0 || current.tokens > 0 || current.cost > 0);
  if (hasUsage && usedPercent !== null && Number.isFinite(usedPercent) && usedPercent > 0 && usedPercent <= 100) {
    const k = 100 / usedPercent;
    return {
      requests: Math.max(current.requests, Math.round(current.requests * k)),
      tokens: Math.max(current.tokens, Math.round(current.tokens * k)),
      cost: Math.max(current.cost, Math.round(current.cost * k * 100) / 100),
      basis: 'quota',
    };
  }
  if (usable(previous)) return { ...previous, basis: 'previous' };
  return null;
}

export const toMetrics = (usage: WindowUsage | null | undefined): UsageMetrics | null =>
  usage && usage.matched && usage.complete ? { requests: usage.requests, tokens: usage.tokens, cost: usage.cost } : null;

/**
 * Usage expected by the reset at the average request pace so far, capped at the capacity estimate
 * (a window that runs out stops accepting requests).
 */
export function projectUsageAtReset(window: HistoryWindow, current: UsageMetrics, now: number, capacity: CapacityForecast | null): UsageMetrics | null {
  const elapsed = Math.min(now, window.endMs) - window.startMs;
  const total = window.endMs - window.startMs;
  if (elapsed <= MINUTE_MS || total <= 0) return null;
  const k = Math.max(1, total / elapsed);
  const scaled = { requests: Math.round(current.requests * k), tokens: Math.round(current.tokens * k), cost: current.cost * k };
  if (!capacity || capacity.basis !== 'quota') return scaled;
  return {
    requests: Math.min(scaled.requests, capacity.requests),
    tokens: Math.min(scaled.tokens, capacity.tokens),
    cost: Math.min(scaled.cost, capacity.cost),
  };
}
