import { apiCall, downloadAuthFileText, isOk } from '../apiCall';
import { authIndexOfFile, isRuntimeOnly } from '../files';
import { asRecord, isRecord, toRemaining } from '../parse';
import { genericPlan } from '../plans';
import { QuotaStatusError, type AuthFileItem, type QuotaData, type QuotaWindow } from '../types';

/** Muse (Meta) quota. Uses the file's own `dca_token` for one request; the secret is never kept. */

const META_MUSE_QUOTA_URL = 'https://api.meta.ai/muse-code/key';

const readDcaToken = (text: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The Muse auth file is not valid JSON.');
  }
  const raw = isRecord(value) ? value.dca_token : undefined;
  const token = typeof raw === 'string' ? raw.trim() : '';
  // Never fall back to any other key in the file.
  if (!/^dca:\S+$/.test(token)) throw new Error('The Muse auth file has no dca_token.');
  return token;
};

const finite = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Reads only the fields the UI needs: the payload can echo api_key and PII. */
export function parseMetaQuotaPayload(payload: unknown): QuotaData | null {
  let parsed = payload;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed)) return null;
  const usage = asRecord(parsed.subs_usage);
  const planName = (typeof parsed.subs_tier_name === 'string' && parsed.subs_tier_name.trim()) || (typeof usage.tier === 'string' && usage.tier.trim()) || null;
  const windowOf = (id: 'window' | 'weekly', raw: unknown): QuotaWindow | null => {
    const record = asRecord(raw);
    const usedRaw = finite(record.used_percent);
    const used = usedRaw === null ? null : Math.min(100, Math.max(0, usedRaw));
    const resetAt = finite(record.resets_at);
    const minutes = id === 'window' ? finite(record.window_duration_mins) : null;
    if (used === null && resetAt === null) return null;
    return {
      id,
      label: id === 'weekly' ? 'Weekly quota' : `${minutes ?? 300}-minute window`,
      usedPercent: used,
      remainingPercent: toRemaining(used),
      // A window with nothing used yet has no meaningful reset; showing one would invent a deadline.
      resetAtMs: resetAt !== null && resetAt > 0 && (used ?? 0) > 0 ? resetAt * 1000 : null,
      periodHours: id === 'weekly' ? 168 : minutes !== null && minutes > 0 ? minutes / 60 : 5,
      kind: 'quota',
    };
  };
  const windows = [windowOf('window', usage.window), windowOf('weekly', usage.weekly)].filter((w): w is QuotaWindow => w !== null);
  return {
    windows,
    plan: genericPlan(planName),
    note: Object.keys(usage).length === 0 ? 'Quota unknown. You may not have made a model request yet.' : undefined,
  };
}

export async function fetchMetaQuota(file: AuthFileItem, signal?: AbortSignal): Promise<QuotaData> {
  const authIndex = authIndexOfFile(file);
  if (!authIndex) throw new Error('Auth file missing auth_index');
  if (isRuntimeOnly(file)) throw new Error('This Muse credential is runtime-only, so its quota cannot be read.');
  let text: string;
  try {
    text = await downloadAuthFileText(file.name, signal);
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    throw new Error('Could not download the Muse auth file.');
  }
  const token = readDcaToken(text);
  const response = await apiCall(
    {
      authIndex,
      method: 'POST',
      url: META_MUSE_QUOTA_URL,
      header: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-api-version': '1.0.0' },
      data: '{}',
    },
    { signal },
  );
  // Never build error text from the body: it can echo secrets.
  if (!isOk(response)) throw new QuotaStatusError(`Muse quota request failed (HTTP ${response.statusCode})`, response.statusCode);
  const quota = parseMetaQuotaPayload(response.body ?? response.bodyText);
  if (!quota) throw new Error('Unexpected Muse quota response.');
  return quota;
}
