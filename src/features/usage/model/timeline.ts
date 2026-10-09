import type { AnomalyPoint, EventRow, TimelinePoint } from '@/lib/api/analytics';
import { estimateEventCost, type PriceBook } from '@/lib/pricing';
import { bucketStart, bucketStarts, nextBucket, rebucket, type BucketPlan, type ConcreteBucket } from '@/lib/timeRange';

/** One chart column, whatever the source (server hour/day points or raw events). */
export interface ChartBucket {
  start: number;
  end: number;
  calls: number;
  success: number;
  failure: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** Uncached prompt tokens: input minus every cache bucket. */
  freshInput: number;
  /** cached + cache_read (both billed at the read rate). */
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  avgLatency: number | null;
  p95Latency: number | null;
  p95Ttft: number | null;
  /** True when p95 is the max of several source points (percentiles cannot be merged). */
  p95Approx: boolean;
  cacheHitRate: number | null;
  /** Events path only: requests whose model has no price (cost under-reported). */
  unpriced: number;
  anomalies: AnomalyPoint[];
}

const SUM_KEYS = [
  'calls',
  'success',
  'failure',
  'input_tokens',
  'output_tokens',
  'cached_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'reasoning_tokens',
  'total_tokens',
  'cost',
  'lat_w',
  'lat_n',
] as const;

type WeightedPoint = TimelinePoint & { lat_w: number; lat_n: number };

function finish(
  start: number,
  size: ConcreteBucket,
  sums: {
    calls: number;
    success: number;
    failure: number;
    input: number;
    output: number;
    cached: number;
    cacheRead: number;
    cacheCreation: number;
    reasoning: number;
    total: number;
    cost: number;
  },
  extra: Pick<ChartBucket, 'avgLatency' | 'p95Latency' | 'p95Ttft' | 'p95Approx' | 'unpriced'>,
): ChartBucket {
  const read = sums.cached + sums.cacheRead;
  return {
    start,
    end: nextBucket(start, size),
    calls: sums.calls,
    success: sums.success,
    failure: sums.failure,
    inputTokens: sums.input,
    outputTokens: sums.output,
    reasoningTokens: sums.reasoning,
    totalTokens: sums.total,
    freshInput: Math.max(sums.input - read - sums.cacheCreation, 0),
    cacheRead: read,
    cacheWrite: sums.cacheCreation,
    cost: sums.cost,
    cacheHitRate: sums.input > 0 ? Math.min(1, read / sums.input) : null,
    anomalies: [],
    ...extra,
  };
}

/**
 * Server points (hour/day, empty buckets omitted) → zero-filled buckets of the planned size.
 * Latency is averaged weighted by calls; p95 of a merged bucket is the max of its parts.
 */
export function bucketsFromTimeline(
  points: TimelinePoint[],
  fromMs: number,
  toMs: number,
  plan: BucketPlan,
): ChartBucket[] {
  const weighted: WeightedPoint[] = points.map((p) => {
    const hasLatency = p.average_latency_ms !== null && p.calls > 0;
    return { ...p, lat_w: hasLatency ? (p.average_latency_ms ?? 0) * p.calls : 0, lat_n: hasLatency ? p.calls : 0 };
  });
  const merged = rebucket(weighted, fromMs, toMs, plan.size, [...SUM_KEYS]);
  const p95 = new Map<number, { lat: number | null; ttft: number | null; parts: number }>();
  for (const p of points) {
    const key = bucketStart(p.bucket_ms, plan.size);
    const prev = p95.get(key) ?? { lat: null, ttft: null, parts: 0 };
    const max = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));
    p95.set(key, { lat: max(prev.lat, p.p95_latency_ms), ttft: max(prev.ttft, p.p95_ttft_ms), parts: prev.parts + 1 });
  }
  return merged.map((b) => {
    const pct = p95.get(b.bucket_ms);
    return finish(
      b.bucket_ms,
      plan.size,
      {
        calls: b.calls,
        success: b.success,
        failure: b.failure,
        input: b.input_tokens,
        output: b.output_tokens,
        cached: b.cached_tokens,
        cacheRead: b.cache_read_tokens,
        cacheCreation: b.cache_creation_tokens,
        reasoning: b.reasoning_tokens,
        total: b.total_tokens,
        cost: b.cost,
      },
      {
        avgLatency: b.lat_n > 0 ? b.lat_w / b.lat_n : null,
        p95Latency: pct?.lat ?? null,
        p95Ttft: pct?.ttft ?? null,
        p95Approx: (pct?.parts ?? 0) > 1,
        unpriced: 0,
      },
    );
  });
}

/** Nearest-rank p95, the same definition the server uses. */
export function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

/** Raw events → sub-hour buckets, priced in the browser (events carry no cost). */
export function bucketsFromEvents(
  events: EventRow[],
  fromMs: number,
  toMs: number,
  plan: BucketPlan,
  prices: PriceBook,
): ChartBucket[] {
  interface Acc {
    calls: number;
    success: number;
    failure: number;
    input: number;
    output: number;
    cached: number;
    cacheRead: number;
    cacheCreation: number;
    reasoning: number;
    total: number;
    cost: number;
    unpriced: number;
    latencies: number[];
    ttfts: number[];
  }
  const accs = new Map<number, Acc>();
  for (const start of bucketStarts(fromMs, toMs, plan.size)) {
    accs.set(start, {
      calls: 0,
      success: 0,
      failure: 0,
      input: 0,
      output: 0,
      cached: 0,
      cacheRead: 0,
      cacheCreation: 0,
      reasoning: 0,
      total: 0,
      cost: 0,
      unpriced: 0,
      latencies: [],
      ttfts: [],
    });
  }
  for (const e of events) {
    const acc = accs.get(bucketStart(e.timestamp_ms, plan.size));
    if (!acc) continue;
    acc.calls += 1;
    if (e.failed) acc.failure += 1;
    else acc.success += 1;
    acc.input += e.input_tokens ?? 0;
    acc.output += e.output_tokens ?? 0;
    acc.cached += e.cached_tokens ?? 0;
    acc.cacheRead += e.cache_read_tokens ?? 0;
    acc.cacheCreation += e.cache_creation_tokens ?? 0;
    acc.reasoning += e.reasoning_tokens ?? 0;
    acc.total += e.total_tokens ?? 0;
    const cost = estimateEventCost(prices, e);
    if (cost === null) {
      if ((e.total_tokens ?? 0) > 0) acc.unpriced += 1;
    } else acc.cost += cost;
    if ((e.latency_ms ?? 0) > 0) acc.latencies.push(e.latency_ms as number);
    if ((e.ttft_ms ?? 0) > 0) acc.ttfts.push(e.ttft_ms as number);
  }
  return Array.from(accs.entries()).map(([start, a]) =>
    finish(
      start,
      plan.size,
      a,
      {
        avgLatency: a.latencies.length ? a.latencies.reduce((s, v) => s + v, 0) / a.latencies.length : null,
        p95Latency: p95(a.latencies),
        p95Ttft: p95(a.ttfts),
        p95Approx: false,
        unpriced: a.unpriced,
      },
    ),
  );
}

/** Pins server anomalies (hour/day buckets) onto whatever bucket now contains them. */
export function attachAnomalies(buckets: ChartBucket[], anomalies: AnomalyPoint[]): ChartBucket[] {
  if (anomalies.length === 0 || buckets.length === 0) return buckets;
  return buckets.map((b) => {
    const hits = anomalies.filter((a) => a.bucket_ms >= b.start && a.bucket_ms < b.end);
    return hits.length ? { ...b, anomalies: hits } : b;
  });
}
