/** Shared normalizers ported from CPAMC `utils/quota/{parsers,resetInstants,relativeTime}.ts`. */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

export function normalizeStringValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value.toString();
  return null;
}

export function normalizeNumberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** "45%" -> 0.45; numbers pass through. */
export function normalizeQuotaFraction(value: unknown): number | null {
  const numeric = normalizeNumberValue(value);
  if (numeric !== null) return numeric;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.endsWith('%')) {
      const parsed = Number(trimmed.slice(0, -1));
      return Number.isFinite(parsed) ? parsed / 100 : null;
    }
  }
  return null;
}

export function normalizePlanType(value: unknown): string | null {
  const normalized = normalizeStringValue(value);
  return normalized ? normalized.toLowerCase() : null;
}

/** String-or-object JSON parser used for every provider payload. */
export function parseJsonPayload<T>(payload: unknown): T | null {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return null;
    }
  }
  return typeof payload === 'object' ? (payload as T) : null;
}

export const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

/** Used percent -> remaining percent. */
export const toRemaining = (used: number | null): number | null => (used === null ? null : clampPercent(100 - used));

/* ---------- reset instants ---------- */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export function parseIsoToMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Over-precise fractional seconds ("…843214+00:00") are not parseable everywhere.
  const normalized = trimmed.replace(/(\.\d{6})\d+/, '$1');
  if (/^\d+(\.\d+)?$/.test(normalized)) return null;
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Seconds or milliseconds, decided by magnitude. */
export function parseUnixToMs(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
}

export function parseOffsetSecondsToMs(value: unknown, now: number): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return now + n * 1000;
}

export function resolveResetMs(candidates: readonly unknown[]): number | null {
  for (const candidate of candidates) {
    const iso = parseIsoToMs(candidate);
    if (iso !== null) return iso;
    const unix = parseUnixToMs(candidate);
    if (unix !== null) return unix;
  }
  return null;
}

export function periodHoursFromSeconds(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return (n * 1000) / HOUR_MS;
}

/* ---------- relative time ---------- */

export function relativeTimeParts(targetMs: number, nowMs: number) {
  const delta = targetMs - nowMs;
  const sign = delta < 0 ? -1 : 1;
  const abs = Math.abs(delta);
  if (abs >= DAY_MS) return { value: sign * Math.floor(abs / DAY_MS), unit: 'day' as const };
  if (abs >= HOUR_MS) return { value: sign * Math.floor(abs / HOUR_MS), unit: 'hour' as const };
  return { value: sign * Math.max(1, Math.floor(abs / MINUTE_MS)), unit: 'minute' as const };
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

/** "in 11 days" / "in 3 hours" / "in 33 minutes" / "4 days ago". Truncates, never rounds up. */
export function formatRelativeInstant(targetMs: number, nowMs: number): string {
  const { value, unit } = relativeTimeParts(targetMs, nowMs);
  return rtf.format(value, unit);
}

const pad = (value: number) => String(value).padStart(2, '0');

/** "09/13, 13:00" — browser local, 24h. */
export function formatInstantShort(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const formatDay = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
};

export const formatTime = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export interface ResetDisplay {
  absolute: string;
  relative: string | null;
}

export function buildResetDisplay(atMs: number | null | undefined, nowMs: number): ResetDisplay | null {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return null;
  return { absolute: formatInstantShort(atMs), relative: formatRelativeInstant(atMs, nowMs) };
}

/** `GMT`, `GMT+8`, `GMT+5:30` for the given offset east of UTC in minutes. */
export function formatUtcOffsetLabel(offsetMinutesEast: number): string {
  if (!offsetMinutesEast) return 'GMT';
  const sign = offsetMinutesEast > 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutesEast);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `GMT${sign}${hours}${minutes ? `:${pad(minutes)}` : ''}`;
}

export const localUtcOffsetLabel = () => formatUtcOffsetLabel(-new Date().getTimezoneOffset());

/** "3 min ago" style age for cached values. */
export function formatAge(atMs: number | null | undefined, nowMs: number): string {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return '';
  const delta = Math.max(0, nowMs - atMs);
  if (delta < MINUTE_MS) return 'just now';
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)} min ago`;
  if (delta < DAY_MS) {
    const hours = Math.floor(delta / HOUR_MS);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(delta / DAY_MS);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export const slugify = (raw: string) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
