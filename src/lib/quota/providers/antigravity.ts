import { apiCall, downloadAuthFileText, getApiCallErrorMessage, isOk } from '../apiCall';
import { authIndexOfFile } from '../files';
import { asRecord, normalizeQuotaFraction, normalizeStringValue, parseJsonPayload, resolveResetMs, slugify } from '../parse';
import { antigravityPlan } from '../plans';
import { QuotaStatusError, statusOfError, type AuthFileItem, type QuotaData, type QuotaWindow } from '../types';

/** Antigravity (Google Cloud Code) grouped quota buckets; remaining is reported as a fraction. */

const ANTIGRAVITY_QUOTA_URLS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
];
const ANTIGRAVITY_CODE_ASSIST_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const ANTIGRAVITY_REQUEST_HEADERS: Record<string, string> = {
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)',
};

const WINDOW_ORDER: Record<string, number> = { '5h': 0, 'five-hour': 0, five_hour: 0, weekly: 1, week: 1 };

const periodHoursOf = (window: string | undefined) => {
  const key = (window ?? '').trim().toLowerCase();
  if (key === '5h' || key === 'five-hour' || key === 'five_hour') return 5;
  if (key === 'weekly' || key === 'week') return 168;
  return null;
};

interface AntigravityBucket {
  bucketId?: unknown;
  bucket_id?: unknown;
  displayName?: unknown;
  display_name?: unknown;
  window?: unknown;
  resetTime?: unknown;
  reset_time?: unknown;
  remainingFraction?: unknown;
  remaining_fraction?: unknown;
}

interface AntigravityPayload {
  groups?: Array<{ displayName?: unknown; display_name?: unknown; buckets?: AntigravityBucket[] }>;
}

/** Flattens groups into windows (group label kept); buckets without a fraction are dropped. */
export function buildAntigravityWindows(payload: AntigravityPayload): QuotaWindow[] {
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const windows: QuotaWindow[] = [];
  groups.forEach((group, groupIndex) => {
    const groupLabel = normalizeStringValue(group.displayName ?? group.display_name) ?? `Quota Group ${groupIndex + 1}`;
    const groupId = slugify(groupLabel) || `quota-group-${groupIndex + 1}`;
    const buckets = (Array.isArray(group.buckets) ? group.buckets : [])
      .map((bucket, bucketIndex) => {
        const fraction = normalizeQuotaFraction(bucket.remainingFraction ?? bucket.remaining_fraction);
        if (fraction === null) return null;
        const window = normalizeStringValue(bucket.window) ?? undefined;
        const rawId = normalizeStringValue(bucket.bucketId ?? bucket.bucket_id) ?? `${groupId}-${window ?? `bucket-${bucketIndex + 1}`}`;
        const remaining = Math.min(100, Math.max(0, fraction * 100));
        return {
          window,
          entry: {
            id: rawId,
            label: normalizeStringValue(bucket.displayName ?? bucket.display_name) ?? rawId,
            remainingPercent: remaining,
            usedPercent: 100 - remaining,
            resetAtMs: resolveResetMs([bucket.resetTime ?? bucket.reset_time]),
            periodHours: periodHoursOf(window),
            group: groupLabel,
            kind: 'quota' as const,
          },
        };
      })
      .filter((bucket): bucket is NonNullable<typeof bucket> => bucket !== null)
      .sort((a, b) => {
        const order = (WINDOW_ORDER[a.window?.toLowerCase() ?? ''] ?? 99) - (WINDOW_ORDER[b.window?.toLowerCase() ?? ''] ?? 99);
        return order || a.entry.label.localeCompare(b.entry.label);
      });
    buckets.forEach((bucket) => windows.push(bucket.entry));
  });
  return windows;
}

async function resolveProjectId(file: AuthFileItem, signal?: AbortSignal): Promise<string> {
  const metadata = asRecord(file.metadata);
  const attributes = asRecord(file.attributes);
  const direct =
    normalizeStringValue(file.project_id ?? file.projectId) ??
    normalizeStringValue(metadata.project_id ?? metadata.projectId) ??
    normalizeStringValue(attributes.project_id ?? attributes.projectId ?? attributes.gemini_virtual_project);
  if (direct) return direct;
  try {
    const parsed = asRecord(parseJsonPayload(await downloadAuthFileText(file.name, signal)));
    return (
      normalizeStringValue(parsed.project_id ?? parsed.projectId) ??
      normalizeStringValue(asRecord(parsed.installed).project_id) ??
      normalizeStringValue(asRecord(parsed.web).project_id) ??
      ''
    );
  } catch {
    return '';
  }
}

async function fetchPlan(authIndex: string, signal?: AbortSignal) {
  try {
    const result = await apiCall(
      { authIndex, method: 'POST', url: ANTIGRAVITY_CODE_ASSIST_URL, header: { ...ANTIGRAVITY_REQUEST_HEADERS }, data: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }) },
      { signal, timeoutMs: 8000 },
    );
    if (!isOk(result)) return null;
    const parsed = asRecord(parseJsonPayload(result.body));
    const paid = asRecord(parsed.paidTier ?? parsed.paid_tier);
    const current = asRecord(parsed.currentTier ?? parsed.current_tier);
    const tier = normalizeStringValue(paid.id) ? paid : current;
    return antigravityPlan(normalizeStringValue(tier.id), normalizeStringValue(tier.name));
  } catch {
    return null;
  }
}

export async function fetchAntigravityQuota(file: AuthFileItem, signal?: AbortSignal): Promise<QuotaData> {
  const authIndex = authIndexOfFile(file);
  if (!authIndex) throw new Error('Auth file missing auth_index');
  const projectId = await resolveProjectId(file, signal);
  if (!projectId) throw new Error('Antigravity credential missing project_id. Re-authenticate the credential.');
  const planPromise = fetchPlan(authIndex, signal);

  let lastError = '';
  let lastStatus: number | undefined;
  let priorityStatus: number | undefined;
  for (const url of ANTIGRAVITY_QUOTA_URLS) {
    try {
      const result = await apiCall(
        { authIndex, method: 'POST', url, header: { ...ANTIGRAVITY_REQUEST_HEADERS }, data: JSON.stringify({ project: projectId }) },
        { signal },
      );
      if (!isOk(result)) {
        lastError = getApiCallErrorMessage(result);
        lastStatus = result.statusCode;
        if (result.statusCode === 403 || result.statusCode === 404) priorityStatus ??= result.statusCode;
        continue;
      }
      const windows = buildAntigravityWindows(parseJsonPayload<AntigravityPayload>(result.body) ?? {});
      if (windows.length === 0) {
        lastError = 'No quota data available';
        continue;
      }
      return { windows, plan: await planPromise };
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      lastError = error instanceof Error ? error.message : 'Request failed';
      const status = statusOfError(error);
      if (status) {
        lastStatus = status;
        if (status === 403 || status === 404) priorityStatus ??= status;
      }
    }
  }
  throw new QuotaStatusError(lastError || 'Request failed', priorityStatus ?? lastStatus);
}
