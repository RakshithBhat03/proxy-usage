const compactFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const integerFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 1234 -> "1,234"; large values stay exact. */
export function formatInt(value: number | null | undefined): string {
  return isFiniteNumber(value) ? integerFormatter.format(value) : '--';
}

/** 1234567 -> "1.2M". */
export function formatCompact(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return '--';
  return Math.abs(value) < 1000 ? integerFormatter.format(value) : compactFormatter.format(value);
}

export function formatTokens(value: number | null | undefined): string {
  return formatCompact(value);
}

/** Dollar amounts: sub-cent values keep 4 decimals so cheap models are not shown as $0.00. */
export function formatCost(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return '--';
  const abs = Math.abs(value);
  const digits = abs === 0 ? 2 : abs < 0.01 ? 4 : abs < 100 ? 2 : 0;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (!isFiniteNumber(value)) return '--';
  return `${value.toFixed(digits).replace(/\.0+$/, '')}%`;
}

/** Ratio in [0,1] -> percent string. */
export function formatRatio(value: number | null | undefined, digits = 1): string {
  return isFiniteNumber(value) ? formatPercent(value * 100, digits) : '--';
}

/** Milliseconds -> "820 ms", "4.2 s", "3m 05s". */
export function formatDuration(ms: number | null | undefined): string {
  if (!isFiniteNumber(ms)) return '--';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

export function formatTps(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return '--';
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} tok/s`;
}

function toDate(input: Date | number | string): Date {
  return input instanceof Date ? input : new Date(input);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "10/08, 22:10" — the compact stamp used throughout the CPA panels. */
export function formatStamp(input: Date | number | string | null | undefined): string {
  if (input === null || input === undefined || input === '') return '--';
  const d = toDate(input);
  if (Number.isNaN(d.getTime())) return '--';
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "22:10:05" */
export function formatClock(input: Date | number | string | null | undefined, withSeconds = true): string {
  if (input === null || input === undefined || input === '') return '--';
  const d = toDate(input);
  if (Number.isNaN(d.getTime())) return '--';
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

/** "in 2 hours", "in 33 minutes", "4 days ago". */
export function formatRelative(input: Date | number | string | null | undefined, now = Date.now()): string {
  if (input === null || input === undefined || input === '') return '--';
  const target = toDate(input).getTime();
  if (Number.isNaN(target)) return '--';
  const diff = target - now;
  const abs = Math.abs(diff);
  const units: Array<[number, string]> = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
    [1000, 'second'],
  ];
  for (const [size, unit] of units) {
    if (abs >= size || unit === 'second') {
      const amount = Math.max(1, Math.floor(abs / size));
      const label = `${amount} ${unit}${amount === 1 ? '' : 's'}`;
      return diff >= 0 ? `in ${label}` : `${label} ago`;
    }
  }
  return '--';
}

/**
 * Masks emails, including ones embedded in auth filenames, keeping the first character of the
 * local part and of the domain: `claude-user@example.com.json` -> `claude-u•••@e•••.com.json`.
 * Hyphens end the local part because CPA prefixes filenames with `<provider>-<id>-`.
 */
export function maskIdentifier(value: string): string {
  return value.replace(/([A-Za-z0-9._%+])[A-Za-z0-9._%+]*@([A-Za-z0-9])[A-Za-z0-9-]*/g, '$1•••@$2•••');
}

/** Bytes -> "812 B", "4.2 MB", "1.31 GB". */
export function formatBytes(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return unit === 0 ? `${Math.round(size)} B` : `${size.toFixed(size < 10 ? 2 : size < 100 ? 1 : 0)} ${units[unit]}`;
}
