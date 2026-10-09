import { apiCall, assertOk, downloadAuthFileText } from '../apiCall';
import { authIndexOfFile, isRuntimeOnly } from '../files';
import { asRecord, isRecord, parseJsonPayload, parseOffsetSecondsToMs, resolveResetMs } from '../parse';
import type { AuthFileItem, QuotaData, QuotaWindow } from '../types';

/** Kimi coding plan usage: count-based rows (`used` / `limit`). */

const KIMI_USAGE_URL = 'https://api.kimi.com/coding/v1/usages';
const KIMI_AI_USAGE_URL = 'https://api.kimi.ai/coding/v1/usages';

const domainFromValue = (value: unknown): 'ai' | 'com' | null => {
  if (typeof value !== 'string') return null;
  const domain = value.trim().toLowerCase();
  if (['ai', 'kimi-ai', 'kimi.ai'].includes(domain) || domain.endsWith('.kimi.ai')) return 'ai';
  if (['com', 'kimi', 'kimi.com'].includes(domain) || domain.endsWith('.kimi.com')) return 'com';
  return null;
};

const domainFromBaseUrl = (value: unknown): 'ai' | 'com' | null => {
  if (typeof value !== 'string') return null;
  try {
    const host = new URL(value.trim()).hostname.toLowerCase();
    if (host === 'kimi.ai' || host.endsWith('.kimi.ai')) return 'ai';
    if (host === 'kimi.com' || host.endsWith('.kimi.com')) return 'com';
  } catch {
    /* unrecognized base URLs never override the credential type */
  }
  return null;
};

/** Picks one of two fixed hosts; a URL from the file is never used directly (token exfiltration). */
export function parseKimiQuotaUrl(text: string, file: AuthFileItem): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Parser errors can quote credential contents, so they are never propagated.
    throw new Error('Invalid Kimi credential');
  }
  if (!isRecord(value)) throw new Error('Invalid Kimi credential');
  const explicit = typeof value.domain === 'string' && value.domain.trim() ? (domainFromValue(value.domain) ?? 'com') : null;
  const baseUrl = Object.prototype.hasOwnProperty.call(value, 'base_url') ? value.base_url : value['base-url'];
  const provider = String(file.provider ?? file.type ?? '').trim().replace(/_/g, '-');
  const domain =
    explicit ??
    domainFromBaseUrl(baseUrl) ??
    domainFromValue(value.type) ??
    domainFromValue(provider) ??
    (/kimi-ai|kimi\.ai/i.test(`${String(file.id ?? '')} ${file.name}`) ? 'ai' : 'com');
  return domain === 'ai' ? KIMI_AI_USAGE_URL : KIMI_USAGE_URL;
}

const toInt = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  }
  return null;
};

type TimeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week';
const normalizeUnit = (raw: unknown): TimeUnit | null => {
  const unit = typeof raw === 'string' ? raw.trim().toUpperCase().replace(/^TIME_UNIT_/, '') : '';
  if (unit === 'SECONDS' || unit === 'SECOND') return 'second';
  if (!unit || unit === 'MINUTES' || unit === 'MINUTE') return 'minute';
  if (unit === 'HOURS' || unit === 'HOUR') return 'hour';
  if (unit === 'DAYS' || unit === 'DAY') return 'day';
  if (unit === 'WEEKS' || unit === 'WEEK') return 'week';
  return null;
};

const durationToken = (duration: number, unit: unknown) => {
  const u = normalizeUnit(unit);
  if (u === 'second') return `${duration}s`;
  if (u === 'hour') return `${duration}h`;
  if (u === 'day') return `${duration}d`;
  if (u === 'week') return `${duration}w`;
  return duration % 60 === 0 ? `${duration / 60}h` : `${duration}m`;
};

const periodHoursOf = (label: string, duration: number | null, unit: unknown): number | null => {
  if (duration !== null && duration > 0) {
    const u = normalizeUnit(unit);
    if (u === 'second') return duration / 3600;
    if (u === 'hour') return duration;
    if (u === 'day') return duration * 24;
    if (u === 'week') return duration * 168;
    return duration / 60;
  }
  const text = label.toLowerCase();
  if (text.includes('day')) return 24;
  if (text.includes('week')) return 168;
  if (text.includes('month')) return 720;
  if (text.includes('5h') || text.includes('hour')) return 5;
  return null;
};

const resetMsOf = (data: Record<string, unknown>): number | null => {
  const absolute = resolveResetMs([data.reset_at, data.resetAt, data.reset_time, data.resetTime]);
  if (absolute !== null) return absolute;
  const now = Date.now();
  for (const key of ['reset_in', 'resetIn', 'ttl']) {
    const relative = parseOffsetSecondsToMs(data[key], now);
    if (relative !== null) return relative;
  }
  return null;
};

function toRow(id: string, data: Record<string, unknown>, fallbackLabel: string, duration: number | null = null, unit?: unknown): QuotaWindow | null {
  const limit = toInt(data.limit);
  let used = toInt(data.used);
  if (used === null) {
    const remaining = toInt(data.remaining);
    if (remaining !== null && limit !== null) used = limit - remaining;
  }
  if (used === null && limit === null) return null;
  const explicit = (typeof data.name === 'string' && data.name.trim()) || (typeof data.title === 'string' && data.title.trim()) || '';
  const label = explicit || fallbackLabel;
  const u = used ?? 0;
  const l = limit ?? 0;
  const remaining = l > 0 ? Math.round(((l - u) / l) * 100) : u > 0 ? 0 : null;
  return {
    id,
    label,
    remainingPercent: remaining === null ? null : Math.min(100, Math.max(0, remaining)),
    usedPercent: remaining === null ? null : 100 - Math.min(100, Math.max(0, remaining)),
    resetAtMs: resetMsOf(data),
    periodHours: periodHoursOf(label, duration, unit),
    kind: 'quota',
    amount: l > 0 ? `${u} / ${l}` : undefined,
  };
}

export function buildKimiQuotaWindows(payload: Record<string, unknown>): QuotaWindow[] {
  const rows: QuotaWindow[] = [];
  if (Array.isArray(payload.limits)) {
    payload.limits.forEach((rawItem, index) => {
      const item = asRecord(rawItem);
      const detail = isRecord(item.detail) ? item.detail : item;
      const window = asRecord(item.window);
      const duration = toInt(window.duration) ?? toInt(item.duration) ?? toInt(detail.duration);
      const unit = window.timeUnit ?? item.timeUnit ?? detail.timeUnit;
      const named = ['name', 'title', 'scope'].map((key) => item[key] ?? detail[key]).find((v): v is string => typeof v === 'string' && !!v.trim());
      const fallback = named?.trim() ?? (duration !== null && duration > 0 ? `${durationToken(duration, unit)} limit` : `Limit #${index + 1}`);
      const row = toRow(`limit-${index}`, detail, fallback, duration, unit);
      if (row) rows.push(row);
    });
  }
  if (isRecord(payload.usage)) {
    const row = toRow('summary', payload.usage, 'Weekly limit');
    if (row) rows.push({ ...row, periodHours: row.periodHours ?? 168 });
  }
  const monthly = asRecord(asRecord(payload.usages).limit_month_total);
  const ratio = Number(monthly.used_ratio);
  if (monthly.used_ratio !== undefined && Number.isFinite(ratio)) {
    const row = toRow('monthly', { used: Math.round(ratio * 100), limit: 100, reset_time: monthly.reset_time }, 'Monthly limit');
    if (row) rows.push({ ...row, amount: undefined });
  }
  return rows;
}

export async function fetchKimiQuota(file: AuthFileItem, signal?: AbortSignal): Promise<QuotaData> {
  const authIndex = authIndexOfFile(file);
  if (!authIndex) throw new Error('Auth file missing auth_index');
  if (isRuntimeOnly(file)) throw new Error('Kimi credential is not downloadable, so its quota host is unknown.');
  let url: string;
  try {
    url = parseKimiQuotaUrl(await downloadAuthFileText(file.name, signal), file);
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    throw new Error('Could not resolve the Kimi quota host for this credential.');
  }
  const result = await apiCall({ authIndex, method: 'GET', url, header: { Authorization: 'Bearer $TOKEN$' } }, { signal });
  assertOk(result);
  const payload = parseJsonPayload<Record<string, unknown>>(result.body);
  if (!isRecord(payload)) throw new Error('No quota data available');
  return { windows: buildKimiQuotaWindows(payload), plan: null };
}
