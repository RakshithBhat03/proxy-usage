/**
 * Granular time ranges shared by the Usage and Request Monitor pages.
 *
 * The Manager's analytics endpoint accepts any [from_ms, to_ms) window but only buckets by `hour`
 * or `day` (aligned to the request's time zone). Everything finer or coarser is planned here:
 *  - sub-hour buckets (1m–30m) are built client-side from raw events, so they are only offered for
 *    short spans;
 *  - multi-hour buckets (3h/6h/12h) are summed from hourly points;
 *  - weekly buckets are summed from daily points.
 */

export type RangePreset =
  | 'last_15m'
  | 'last_30m'
  | 'last_1h'
  | 'last_3h'
  | 'last_6h'
  | 'last_12h'
  | 'last_24h'
  | 'today'
  | 'yesterday'
  | 'last_2d'
  | 'last_3d'
  | 'last_7d'
  | 'this_week'
  | 'last_week'
  | 'last_14d'
  | 'last_30d'
  | 'this_month'
  | 'last_month'
  | 'last_90d'
  | 'all'
  | 'custom';

export interface TimeRangeValue {
  preset: RangePreset;
  /** Only for `custom`. */
  fromMs?: number;
  toMs?: number;
}

export interface ResolvedRange {
  preset: RangePreset;
  fromMs: number;
  toMs: number;
  label: string;
  /** Rolling ranges move with the clock and are re-resolved on every refresh. */
  live: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Earliest timestamp `all` reaches back to when the data floor is unknown. */
const ALL_TIME_FLOOR = Date.UTC(2020, 0, 1);

export interface PresetDef {
  id: RangePreset;
  label: string;
  short: string;
  group: 'minutes' | 'hours' | 'days' | 'calendar' | 'other';
}

export const RANGE_PRESETS: PresetDef[] = [
  { id: 'last_15m', label: 'Last 15 minutes', short: '15m', group: 'minutes' },
  { id: 'last_30m', label: 'Last 30 minutes', short: '30m', group: 'minutes' },
  { id: 'last_1h', label: 'Last hour', short: '1h', group: 'hours' },
  { id: 'last_3h', label: 'Last 3 hours', short: '3h', group: 'hours' },
  { id: 'last_6h', label: 'Last 6 hours', short: '6h', group: 'hours' },
  { id: 'last_12h', label: 'Last 12 hours', short: '12h', group: 'hours' },
  { id: 'last_24h', label: 'Last 24 hours', short: '24h', group: 'hours' },
  { id: 'last_2d', label: 'Last 2 days', short: '2d', group: 'days' },
  { id: 'last_3d', label: 'Last 3 days', short: '3d', group: 'days' },
  { id: 'last_7d', label: 'Last 7 days', short: '7d', group: 'days' },
  { id: 'last_14d', label: 'Last 14 days', short: '14d', group: 'days' },
  { id: 'last_30d', label: 'Last 30 days', short: '30d', group: 'days' },
  { id: 'last_90d', label: 'Last 90 days', short: '90d', group: 'days' },
  { id: 'today', label: 'Today', short: 'Today', group: 'calendar' },
  { id: 'yesterday', label: 'Yesterday', short: 'Yesterday', group: 'calendar' },
  { id: 'this_week', label: 'This week', short: 'This week', group: 'calendar' },
  { id: 'last_week', label: 'Last week', short: 'Last week', group: 'calendar' },
  { id: 'this_month', label: 'This month', short: 'This month', group: 'calendar' },
  { id: 'last_month', label: 'Last month', short: 'Last month', group: 'calendar' },
  { id: 'all', label: 'All time', short: 'All', group: 'other' },
];

/** The quick chips shown inline next to the picker. */
export const QUICK_PRESETS: RangePreset[] = ['last_1h', 'last_24h', 'today', 'last_7d', 'last_30d'];

const ROLLING: Partial<Record<RangePreset, number>> = {
  last_15m: 15 * MINUTE,
  last_30m: 30 * MINUTE,
  last_1h: HOUR,
  last_3h: 3 * HOUR,
  last_6h: 6 * HOUR,
  last_12h: 12 * HOUR,
  last_24h: DAY,
  last_2d: 2 * DAY,
  last_3d: 3 * DAY,
  last_7d: 7 * DAY,
  last_14d: 14 * DAY,
  last_30d: 30 * DAY,
  last_90d: 90 * DAY,
};

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
/** Weeks start on Monday. */
const startOfWeek = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));

export function presetLabel(preset: RangePreset): string {
  return RANGE_PRESETS.find((p) => p.id === preset)?.label ?? 'Custom range';
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatRangeStamp(ms: number, withTime = true): string {
  const d = new Date(ms);
  const date = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return withTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

/** "10/04 – 10/17" or "10/08 09:00 – 10/08 14:30" depending on span. */
export function describeSpan(fromMs: number, toMs: number): string {
  const wholeDays =
    new Date(fromMs).getHours() === 0 &&
    new Date(fromMs).getMinutes() === 0 &&
    new Date(toMs).getHours() === 0 &&
    new Date(toMs).getMinutes() === 0;
  if (wholeDays) {
    const lastDay = toMs - 1;
    return toMs - fromMs <= DAY
      ? formatRangeStamp(fromMs, false)
      : `${formatRangeStamp(fromMs, false)} – ${formatRangeStamp(lastDay, false)}`;
  }
  return `${formatRangeStamp(fromMs)} – ${formatRangeStamp(toMs)}`;
}

export function resolveRange(value: TimeRangeValue, now = Date.now(), dataFloorMs?: number): ResolvedRange {
  const today = startOfDay(new Date(now));
  const rolling = ROLLING[value.preset];
  if (rolling) {
    return { preset: value.preset, fromMs: now - rolling, toMs: now, label: presetLabel(value.preset), live: true };
  }
  switch (value.preset) {
    case 'today':
      return { preset: 'today', fromMs: today.getTime(), toMs: now, label: 'Today', live: true };
    case 'yesterday':
      return {
        preset: 'yesterday',
        fromMs: addDays(today, -1).getTime(),
        toMs: today.getTime(),
        label: 'Yesterday',
        live: false,
      };
    case 'this_week':
      return { preset: 'this_week', fromMs: startOfWeek(today).getTime(), toMs: now, label: 'This week', live: true };
    case 'last_week': {
      const thisWeek = startOfWeek(today);
      return {
        preset: 'last_week',
        fromMs: addDays(thisWeek, -7).getTime(),
        toMs: thisWeek.getTime(),
        label: 'Last week',
        live: false,
      };
    }
    case 'this_month':
      return {
        preset: 'this_month',
        fromMs: new Date(today.getFullYear(), today.getMonth(), 1).getTime(),
        toMs: now,
        label: 'This month',
        live: true,
      };
    case 'last_month':
      return {
        preset: 'last_month',
        fromMs: new Date(today.getFullYear(), today.getMonth() - 1, 1).getTime(),
        toMs: new Date(today.getFullYear(), today.getMonth(), 1).getTime(),
        label: 'Last month',
        live: false,
      };
    case 'all':
      return {
        preset: 'all',
        fromMs: dataFloorMs && dataFloorMs > 0 ? startOfDay(new Date(dataFloorMs)).getTime() : ALL_TIME_FLOOR,
        toMs: now,
        label: 'All time',
        live: true,
      };
    case 'custom': {
      const fromMs = value.fromMs ?? now - DAY;
      const toMs = value.toMs && value.toMs > fromMs ? value.toMs : now;
      return { preset: 'custom', fromMs, toMs, label: describeSpan(fromMs, toMs), live: false };
    }
    default:
      return { preset: 'last_24h', fromMs: now - DAY, toMs: now, label: 'Last 24 hours', live: true };
  }
}

/** Moves a range back (-1) or forward (+1) by its own span, as a custom range. */
export function shiftRange(range: ResolvedRange, direction: -1 | 1, now = Date.now()): TimeRangeValue {
  const span = range.toMs - range.fromMs;
  let fromMs = range.fromMs + direction * span;
  let toMs = range.toMs + direction * span;
  if (toMs > now) {
    toMs = now;
    fromMs = now - span;
  }
  return { preset: 'custom', fromMs, toMs };
}

/* ---------------- Buckets ---------------- */

export type BucketSize = 'auto' | '1m' | '5m' | '15m' | '30m' | '1h' | '3h' | '6h' | '12h' | '1d' | '1w';
export type ConcreteBucket = Exclude<BucketSize, 'auto'>;

export const BUCKET_MS: Record<ConcreteBucket, number> = {
  '1m': MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '30m': 30 * MINUTE,
  '1h': HOUR,
  '3h': 3 * HOUR,
  '6h': 6 * HOUR,
  '12h': 12 * HOUR,
  '1d': DAY,
  '1w': 7 * DAY,
};

export const BUCKET_LABELS: Record<BucketSize, string> = {
  auto: 'Auto',
  '1m': '1 min',
  '5m': '5 min',
  '15m': '15 min',
  '30m': '30 min',
  '1h': 'Hourly',
  '3h': '3 hours',
  '6h': '6 hours',
  '12h': '12 hours',
  '1d': 'Daily',
  '1w': 'Weekly',
};

/** Raw-event bucketing is capped so a sub-hour chart never needs more than one large events page. */
export const MAX_EVENT_BUCKET_SPAN_MS = DAY;
const MAX_BUCKETS = 400;

export interface BucketPlan {
  size: ConcreteBucket;
  bucketMs: number;
  /**
   * Where points come from: `events` = aggregate raw events in the browser, `hour`/`day` = ask the
   * server for that granularity and (if `size` is larger) merge consecutive points.
   */
  source: 'events' | 'hour' | 'day';
}

export function autoBucket(spanMs: number): ConcreteBucket {
  if (spanMs <= HOUR) return '1m';
  if (spanMs <= 3 * HOUR) return '5m';
  if (spanMs <= 12 * HOUR) return '15m';
  if (spanMs <= 2 * DAY) return '1h';
  if (spanMs <= 7 * DAY) return '3h';
  if (spanMs <= 120 * DAY) return '1d';
  return '1w';
}

/** Bucket sizes that make sense for a span (not too many, not fewer than ~2 points). */
export function allowedBuckets(spanMs: number): ConcreteBucket[] {
  return (Object.keys(BUCKET_MS) as ConcreteBucket[]).filter((size) => {
    const ms = BUCKET_MS[size];
    if (ms < HOUR && spanMs > MAX_EVENT_BUCKET_SPAN_MS) return false;
    const count = spanMs / ms;
    return count <= MAX_BUCKETS && count >= 2;
  });
}

export function planBuckets(range: Pick<ResolvedRange, 'fromMs' | 'toMs'>, requested: BucketSize): BucketPlan {
  const span = range.toMs - range.fromMs;
  const allowed = allowedBuckets(span);
  let size: ConcreteBucket = requested === 'auto' ? autoBucket(span) : requested;
  if (!allowed.includes(size)) size = allowed.includes(autoBucket(span)) ? autoBucket(span) : (allowed[0] ?? '1h');
  const bucketMs = BUCKET_MS[size];
  const source: BucketPlan['source'] = bucketMs < HOUR ? 'events' : bucketMs < DAY ? 'hour' : 'day';
  return { size, bucketMs, source };
}

/**
 * Start of the bucket containing `ms`, aligned in local time: minutes/hours to the local clock,
 * days to local midnight, weeks to Monday.
 */
export function bucketStart(ms: number, size: ConcreteBucket): number {
  const d = new Date(ms);
  if (size === '1w') return startOfWeek(d).getTime();
  if (size === '1d') return startOfDay(d).getTime();
  const step = BUCKET_MS[size];
  if (step >= HOUR) {
    const hours = step / HOUR;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(d.getHours() / hours) * hours).getTime();
  }
  const minutes = step / MINUTE;
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    Math.floor(d.getMinutes() / minutes) * minutes,
  ).getTime();
}

export function nextBucket(startMs: number, size: ConcreteBucket): number {
  const d = new Date(startMs);
  if (size === '1w') return addDays(d, 7).getTime();
  if (size === '1d') return addDays(d, 1).getTime();
  return startMs + BUCKET_MS[size];
}

/** Every bucket start covering [fromMs, toMs), so empty buckets can be zero-filled. */
export function bucketStarts(fromMs: number, toMs: number, size: ConcreteBucket): number[] {
  const starts: number[] = [];
  let cursor = bucketStart(fromMs, size);
  while (cursor < toMs && starts.length < 5000) {
    starts.push(cursor);
    cursor = nextBucket(cursor, size);
  }
  return starts;
}

export function formatBucketLabel(ms: number, size: ConcreteBucket): string {
  const d = new Date(ms);
  if (size === '1d' || size === '1w') return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Merges numeric fields of points into fixed buckets, zero-filling gaps. `sumKeys` are added;
 * anything else (rates, averages) should be recomputed by the caller from the sums.
 */
export function rebucket<T extends { bucket_ms: number }, K extends keyof T>(
  points: T[],
  fromMs: number,
  toMs: number,
  size: ConcreteBucket,
  sumKeys: K[],
): Array<{ bucket_ms: number } & Record<K, number>> {
  const buckets = new Map<number, { bucket_ms: number } & Record<K, number>>();
  for (const start of bucketStarts(fromMs, toMs, size)) {
    const empty = { bucket_ms: start } as { bucket_ms: number } & Record<K, number>;
    for (const key of sumKeys) (empty as Record<K, number>)[key] = 0;
    buckets.set(start, empty);
  }
  for (const point of points) {
    const start = bucketStart(point.bucket_ms, size);
    const bucket = buckets.get(start);
    if (!bucket) continue;
    for (const key of sumKeys) {
      const value = Number(point[key]);
      if (Number.isFinite(value)) (bucket as Record<K, number>)[key] += value;
    }
  }
  return Array.from(buckets.values());
}

/* ---------------- URL state ---------------- */

const PRESET_IDS = new Set<string>([...RANGE_PRESETS.map((p) => p.id), 'custom']);
const BUCKET_IDS = new Set<string>(Object.keys(BUCKET_LABELS));

export function readRangeFromParams(params: URLSearchParams, fallback: RangePreset): TimeRangeValue {
  const preset = params.get('range');
  if (preset === 'custom') {
    const fromMs = Number(params.get('from'));
    const toMs = Number(params.get('to'));
    if (fromMs > 0 && toMs > fromMs) return { preset: 'custom', fromMs, toMs };
  }
  if (preset && PRESET_IDS.has(preset) && preset !== 'custom') return { preset: preset as RangePreset };
  return { preset: fallback };
}

export function writeRangeToParams(params: URLSearchParams, value: TimeRangeValue): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set('range', value.preset);
  if (value.preset === 'custom' && value.fromMs && value.toMs) {
    next.set('from', String(Math.round(value.fromMs)));
    next.set('to', String(Math.round(value.toMs)));
  } else {
    next.delete('from');
    next.delete('to');
  }
  return next;
}

export function readBucketFromParams(params: URLSearchParams): BucketSize {
  const bucket = params.get('bucket');
  return bucket && BUCKET_IDS.has(bucket) ? (bucket as BucketSize) : 'auto';
}

/* ---------------- Cache identity ---------------- */

/**
 * Stable cache identity for a range. Rolling presets ("last 24h", "today") are keyed by preset, not
 * by their millisecond bounds, so switching back to a range you just viewed hits the query cache
 * instead of refetching; the actual window is recomputed at fetch time with `freshWindow`.
 */
export function rangeKey(range: Pick<ResolvedRange, 'preset' | 'fromMs' | 'toMs' | 'live'>): string {
  if (range.live && range.preset !== 'all') return `live:${range.preset}`;
  if (range.preset === 'all') return `all:${Math.round(range.fromMs)}`;
  return `fixed:${Math.round(range.fromMs)}-${Math.round(range.toMs)}`;
}

/** The window a query should use right now: rolling ranges re-anchor to the clock, fixed ones don't. */
export function freshWindow(range: ResolvedRange, now = Date.now()): { fromMs: number; toMs: number } {
  if (!range.live) return { fromMs: range.fromMs, toMs: range.toMs };
  if (range.preset === 'all') return { fromMs: range.fromMs, toMs: now };
  const resolved = resolveRange({ preset: range.preset }, now);
  return { fromMs: resolved.fromMs, toMs: resolved.toMs };
}
