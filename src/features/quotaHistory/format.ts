import { quotaLevel } from '@/lib/quota/model';
import { formatStamp } from '@/lib/format';
import type { QuotaLevel } from '@/lib/quota/types';

/** Fill colors for the Quota page bands (by REMAINING: ≥ 70 green, ≥ 30 amber, below red). */
export const LEVEL_COLOR: Record<QuotaLevel, string> = {
  high: 'var(--viz-success)',
  medium: 'var(--quota-medium-color)',
  low: 'var(--viz-failure)',
  unknown: 'var(--text-quaternary)',
};

export const usedLevel = (used: number | null | undefined): QuotaLevel =>
  used === null || used === undefined || !Number.isFinite(used) ? 'unknown' : quotaLevel(100 - used);

export const usedColor = (used: number | null | undefined) => LEVEL_COLOR[usedLevel(used)];

export const formatUsed = (used: number | null | undefined) =>
  used === null || used === undefined || !Number.isFinite(used) ? '--' : `${Math.round(used)}%`;

export function formatRate(perHour: number): string {
  if (perHour <= 0) return '0%/h';
  if (perHour < 0.1) return '<0.1%/h';
  return `${perHour < 10 ? perHour.toFixed(1) : Math.round(perHour)}%/h`;
}

/** 4h 50m · 6d 3h · 35m */
export function formatSpanLength(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** "10/08, 12:00 → 17:00" or "10/01, 23:30 → 10/08, 23:30". */
export function formatPeriod(startMs: number, endMs: number): string {
  return `${formatStamp(startMs)} → ${sameDay(startMs, endMs) ? clock(endMs) : formatStamp(endMs)}`;
}

/** "in 1h 18m" / "4h 2m ago" with the same compact units as the rest of this view. */
export function formatIn(targetMs: number, now: number): string {
  const delta = targetMs - now;
  return delta >= 0 ? `in ${formatSpanLength(delta)}` : `${formatSpanLength(-delta)} ago`;
}

/** "21:40" today, "10/10, 21:40" otherwise. */
export const formatWhen = (ms: number, now: number) => (sameDay(ms, now) ? clock(ms) : formatStamp(ms));
