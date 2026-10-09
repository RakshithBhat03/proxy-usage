/**
 * Time-zone support for analytics buckets without a tz database in SQLite.
 *
 * A zone's UTC offset over a query range is described by a few constant-offset segments (one per DST
 * period), found with Intl and cached per zone and year. SQL then computes local time as
 * `timestamp_ms + CASE ... END`, which is exact for :30/:45 zones (Asia/Kolkata, Asia/Kathmandu) and
 * across DST transitions.
 *
 * Bucket semantics (ported from CPA Manager Plus, MIT):
 *  - hour bucket: the start of the local wall-clock hour containing the event, as a UTC instant. Using
 *    each event's own offset keeps the repeated hour of a DST fall-back as two distinct buckets.
 *  - day bucket: local midnight of the event's local date (Go `time.Date(y, m, d, 0, 0, 0, 0, loc)`).
 *  - weekday 0 = Sunday ... 6 = Saturday, hour 0..23, both local.
 *  - labels: "HH:mm" for hours, "MM/dd" for days, in the zone.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

const validity = new Map<string, boolean>();
const formatters = new Map<string, Intl.DateTimeFormat>();

/** True when `Intl` knows the IANA zone name. */
export function isValidTimeZone(timeZone: string): boolean {
  const cached = validity.get(timeZone);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    ok = true;
  } catch {
    ok = false;
  }
  if (validity.size > 1000) validity.clear();
  validity.set(timeZone, ok);
  return ok;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** UTC offset (local − UTC, ms) of `timeZone` at instant `ms`, from Intl. */
export function offsetAt(timeZone: string, ms: number): number {
  if (timeZone === 'UTC') return 0;
  const parts = formatter(timeZone).formatToParts(new Date(ms));
  let y = 0;
  let mo = 1;
  let d = 1;
  let h = 0;
  let mi = 0;
  let s = 0;
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        y = Number(part.value);
        break;
      case 'month':
        mo = Number(part.value);
        break;
      case 'day':
        d = Number(part.value);
        break;
      case 'hour':
        h = Number(part.value);
        break;
      case 'minute':
        mi = Number(part.value);
        break;
      case 'second':
        s = Number(part.value);
        break;
    }
  }
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/** A constant-offset period: `offset` applies from `start` (inclusive) until the next segment. */
export interface Segment {
  start: number;
  offset: number;
}

interface YearSegments {
  /** Offset in effect at the start of the year. */
  initial: number;
  transitions: Segment[];
}

const yearCache = new Map<string, YearSegments>();

/** First whole second in (lo, hi] whose offset differs from `loOffset` (lo, hi are whole seconds). */
function findTransition(timeZone: string, lo: number, hi: number, loOffset: number): number {
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (offsetAt(timeZone, mid) === loOffset) lo = mid;
    else hi = mid;
  }
  return hi;
}

function yearSegments(timeZone: string, year: number): YearSegments {
  const key = `${timeZone}|${year}`;
  const cached = yearCache.get(key);
  if (cached) return cached;
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const initial = offsetAt(timeZone, start);
  const transitions: Segment[] = [];
  // Daily probes find each DST period; zones never change offset twice within 12 hours.
  const step = 12 * HOUR_MS;
  let prevT = start;
  let prevOffset = initial;
  for (let t = start + step; t <= end; t += step) {
    const offset = offsetAt(timeZone, t);
    if (offset !== prevOffset) {
      const at = findTransition(timeZone, prevT, t, prevOffset);
      if (at < end) transitions.push({ start: at, offset });
      prevOffset = offset;
    }
    prevT = t;
  }
  const result = { initial, transitions };
  if (yearCache.size > 5000) yearCache.clear();
  yearCache.set(key, result);
  return result;
}

/**
 * Offset segments covering [fromMs − 1 day, toMs + 1 day]. The first segment starts at the range
 * start; later ones at each transition. A fixed-offset zone yields exactly one segment.
 */
export function offsetSegments(timeZone: string, fromMs: number, toMs: number): Segment[] {
  const lo = fromMs - DAY_MS;
  const hi = toMs + DAY_MS;
  if (timeZone === 'UTC') return [{ start: lo, offset: 0 }];
  const segments: Segment[] = [{ start: lo, offset: offsetAt(timeZone, lo) }];
  const firstYear = new Date(lo).getUTCFullYear();
  const lastYear = new Date(hi).getUTCFullYear();
  for (let year = firstYear; year <= lastYear; year++) {
    for (const transition of yearSegments(timeZone, year).transitions) {
      if (transition.start <= lo || transition.start > hi) continue;
      if (transition.offset !== segments[segments.length - 1].offset) segments.push(transition);
    }
  }
  return segments;
}

/** Offset in effect at `ms` according to `segments` (sorted by start). */
export function segmentOffset(segments: readonly Segment[], ms: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].start <= ms) lo = mid;
    else hi = mid - 1;
  }
  return segments[lo].offset;
}

/**
 * Per-request time-zone helper: SQL expressions for local time over [fromMs, toMs) and formatting /
 * day-start helpers for results.
 */
export class TzContext {
  readonly timeZone: string;
  readonly segments: Segment[];
  /** SQL for the local offset (ms) of `col`; only segments overlapping the range are emitted. */
  readonly #offsetSql: string;
  readonly #col: string;
  /** Instants after this are outside the precomputed segments. */
  readonly #segmentsEnd: number;

  constructor(timeZone: string, fromMs: number, toMs: number, col = 'timestamp_ms') {
    this.timeZone = timeZone;
    this.segments = offsetSegments(timeZone, fromMs, toMs);
    this.#segmentsEnd = toMs + DAY_MS;
    this.#col = col;
    const relevant = this.segments.filter((segment, index) => {
      const next = this.segments[index + 1];
      return segment.start < toMs && (!next || next.start > fromMs);
    });
    if (relevant.length <= 1) {
      this.#offsetSql = String(relevant[0]?.offset ?? segmentOffset(this.segments, fromMs));
    } else {
      const branches = relevant
        .slice(1)
        .map((segment, index) => `WHEN ${col} < ${segment.start} THEN ${relevant[index].offset}`)
        .join(' ');
      this.#offsetSql = `(CASE ${branches} ELSE ${relevant[relevant.length - 1].offset} END)`;
    }
  }

  /** Local wall-clock time as epoch-like ms (UTC fields = local fields). */
  get localSql(): string {
    return `(${this.#col} + ${this.#offsetSql})`;
  }

  /** UTC start (ms) of the local hour containing the event. */
  get hourBucketSql(): string {
    return `(${this.#col} - (${this.localSql} % ${HOUR_MS}))`;
  }

  /** Local calendar day number (days since 1970-01-01 local). Map to ms with `dayStart`. */
  get dayKeySql(): string {
    return `(${this.localSql} / ${DAY_MS})`;
  }

  /** Local hour of day 0..23. */
  get hourOfDaySql(): string {
    return `((${this.localSql} / ${HOUR_MS}) % 24)`;
  }

  /** Local weekday, 0 = Sunday. */
  get weekdaySql(): string {
    return `(((${this.localSql} / ${DAY_MS}) + 4) % 7)`;
  }

  offsetOf(ms: number): number {
    if (ms < this.segments[0].start || ms > this.#segmentsEnd) return offsetAt(this.timeZone, ms);
    return segmentOffset(this.segments, ms);
  }

  /**
   * UTC instant of local midnight for local day `dayKey`, resolved like Go's `time.Date`: look up
   * the offset at the local time read as UTC, and re-check it at the resulting instant.
   */
  dayStart(dayKey: number): number {
    const local = dayKey * DAY_MS;
    const first = this.offsetOf(local);
    const utc = local - first;
    const second = this.offsetOf(utc);
    return second === first ? utc : local - second;
  }

  /** "HH:mm" in the zone. */
  hourLabel(ms: number): string {
    const local = new Date(ms + this.offsetOf(ms));
    return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
  }

  /** "MM/dd" in the zone. */
  dayLabel(ms: number): string {
    const local = new Date(ms + this.offsetOf(ms));
    return `${pad(local.getUTCMonth() + 1)}/${pad(local.getUTCDate())}`;
  }

  label(ms: number, granularity: 'hour' | 'day'): string {
    return granularity === 'day' ? this.dayLabel(ms) : this.hourLabel(ms);
  }

  /** JS twins of the SQL expressions, for an instant (used on pre-aggregated hour buckets). */
  dayKeyOf(ms: number): number {
    return Math.floor((ms + this.offsetOf(ms)) / DAY_MS);
  }

  hourOfDayOf(ms: number): number {
    return Math.floor((ms + this.offsetOf(ms)) / HOUR_MS) % 24;
  }

  weekdayOf(ms: number): number {
    return (Math.floor((ms + this.offsetOf(ms)) / DAY_MS) + 4) % 7;
  }

  /** Local "YYYY-MM-DD" (tests and debugging). */
  dateKey(ms: number): string {
    const local = new Date(ms + this.offsetOf(ms));
    return local.toISOString().slice(0, 10);
  }
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}
