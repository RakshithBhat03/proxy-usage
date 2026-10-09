import type { EventRow, TimelinePoint } from '@/lib/api/analytics';
import { bucketStart, bucketStarts, nextBucket, type ConcreteBucket } from '@/lib/timeRange';
import { percentile } from './events';

/** Compact per-request point kept for the whole window so sub-hour buckets can be built locally. */
export interface SeriesPoint {
  key: string;
  ts: number;
  failed: boolean;
  latency: number;
}

export function toSeriesPoint(event: EventRow, key: string): SeriesPoint {
  return { key, ts: event.timestamp_ms, failed: !!event.failed, latency: event.latency_ms ?? 0 };
}

export interface ActivityBucket {
  start: number;
  end: number;
  success: number;
  failure: number;
  /** p95 latency in ms (null when no samples). */
  p95: number | null;
  avgLatency: number | null;
}

export function bucketPoints(points: SeriesPoint[], fromMs: number, toMs: number, size: ConcreteBucket): ActivityBucket[] {
  const starts = bucketStarts(fromMs, toMs, size);
  const index = new Map<number, number>();
  starts.forEach((start, i) => index.set(start, i));
  const acc = starts.map(() => ({ success: 0, failure: 0, latencies: [] as number[] }));
  for (const point of points) {
    if (point.ts < fromMs || point.ts >= toMs + 60_000) continue;
    const slot = index.get(bucketStart(point.ts, size));
    if (slot === undefined) continue;
    const bucket = acc[slot];
    if (point.failed) bucket.failure += 1;
    else bucket.success += 1;
    if (point.latency > 0) bucket.latencies.push(point.latency);
  }
  return starts.map((start, i) => {
    const { success, failure, latencies } = acc[i];
    const avg = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
    return { start, end: nextBucket(start, size), success, failure, p95: percentile(latencies, 95), avgLatency: avg };
  });
}

/**
 * Server timeline (hour/day points, gaps omitted) → fixed buckets with zero-fill. p95 cannot be
 * summed, so merged buckets use the call-weighted mean of their points' p95 (exact when the bucket
 * size equals the server granularity).
 */
export function bucketTimeline(points: TimelinePoint[], fromMs: number, toMs: number, size: ConcreteBucket): ActivityBucket[] {
  const starts = bucketStarts(fromMs, toMs, size);
  const index = new Map<number, number>();
  starts.forEach((start, i) => index.set(start, i));
  const acc = starts.map(() => ({ success: 0, failure: 0, p95w: 0, p95n: 0, latw: 0, latn: 0 }));
  for (const point of points) {
    const slot = index.get(bucketStart(point.bucket_ms, size));
    if (slot === undefined) continue;
    const bucket = acc[slot];
    bucket.success += point.success ?? 0;
    bucket.failure += point.failure ?? 0;
    const calls = point.calls ?? 0;
    if (point.p95_latency_ms && calls > 0) {
      bucket.p95w += point.p95_latency_ms * calls;
      bucket.p95n += calls;
    }
    if (point.average_latency_ms && calls > 0) {
      bucket.latw += point.average_latency_ms * calls;
      bucket.latn += calls;
    }
  }
  return starts.map((start, i) => {
    const b = acc[i];
    return {
      start,
      end: nextBucket(start, size),
      success: b.success,
      failure: b.failure,
      p95: b.p95n > 0 ? b.p95w / b.p95n : null,
      avgLatency: b.latn > 0 ? b.latw / b.latn : null,
    };
  });
}

/** Round an axis maximum up to a 1/2/2.5/5 × 10ⁿ step so ticks read cleanly. */
export function niceMax(value: number, intervals: number, integerSteps = false): number {
  if (!(value > 0)) return intervals;
  const raw = value / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  if (integerSteps) step = Math.max(1, Math.ceil(step));
  return step * intervals;
}
