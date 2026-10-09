import { apiCall, assertOk, isOk } from '../apiCall';
import { authIndexOfFile } from '../files';
import {
  isRecord,
  normalizeNumberValue,
  normalizeStringValue,
  parseIsoToMs,
  parseJsonPayload,
  resolveResetMs,
  toRemaining,
} from '../parse';
import { claudePlan } from '../plans';
import { QuotaStatusError, type AuthFileItem, type ClaudeExtras, type ClaudeResetGrant, type QuotaData, type QuotaWindow } from '../types';

/** Claude (Anthropic OAuth) quota: `/api/oauth/usage` windows, profile plan, banked reset grants. */

const ORIGIN = 'https://api.anthropic.com';
/** `cedar_ember=1` folds the reset-grant read into the usage call (one request instead of two). */
const CLAUDE_USAGE_URL = `${ORIGIN}/api/oauth/usage?cedar_ember=1&skip_spend=1`;
const CLAUDE_PROFILE_URL = `${ORIGIN}/api/oauth/profile`;

export const CLAUDE_REQUEST_HEADERS: Record<string, string> = {
  'User-Agent': 'claude-cli/2.1.280 (external, cli)',
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'anthropic-beta': 'oauth-2025-04-20',
};

export const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  'five-hour': '5-hour limit',
  'seven-day': '7-day limit',
  'seven-day-oauth-apps': '7-day OAuth apps',
  'seven-day-opus': '7-day Opus',
  'seven-day-sonnet': '7-day Sonnet',
  'seven-day-cowork': '7-day Cowork',
  'seven-day-fable': '7-day Fable 5',
  'cloud-session-credits': 'Cloud session credits',
};

const CLAUDE_USAGE_WINDOW_KEYS = [
  { key: 'five_hour', id: 'five-hour' },
  { key: 'seven_day', id: 'seven-day' },
  { key: 'seven_day_oauth_apps', id: 'seven-day-oauth-apps' },
  { key: 'seven_day_opus', id: 'seven-day-opus' },
  { key: 'seven_day_sonnet', id: 'seven-day-sonnet' },
  { key: 'seven_day_cowork', id: 'seven-day-cowork' },
  { key: 'iguana_necktie', id: 'seven-day-fable' },
] as const;

export const claudePeriodHours = (windowKey: string) => (windowKey === 'five_hour' ? 5 : 24 * 7);

interface ClaudeUsageWindow {
  utilization?: unknown;
  resets_at?: string | null;
  limit_dollars?: unknown;
  used_dollars?: unknown;
  remaining_dollars?: unknown;
}

interface ClaudeUsageLimit {
  kind?: unknown;
  percent?: unknown;
  resets_at?: string | null;
  is_active?: boolean;
  scope?: { model?: { display_name?: unknown } | null } | null;
}

interface ClaudeUsagePayload {
  limits?: ClaudeUsageLimit[];
  extra_usage?: { is_enabled?: boolean; monthly_limit?: unknown; used_credits?: unknown } | null;
  cedar_ember?: unknown;
  [key: string]: unknown;
}

const findFableUsageLimit = (payload: ClaudeUsagePayload) => {
  if (!Array.isArray(payload.limits)) return null;
  const candidates = payload.limits.filter((limit) => {
    const kind = (normalizeStringValue(limit?.kind) ?? '').toLowerCase();
    const model = (normalizeStringValue(limit?.scope?.model?.display_name) ?? '').toLowerCase();
    return kind === 'weekly_scoped' && (model === 'fable' || model === 'fable 5') && normalizeNumberValue(limit?.percent) !== null;
  });
  return candidates.find((limit) => limit.is_active === true) ?? candidates[0] ?? null;
};

const isDollarDenominated = (w: ClaudeUsageWindow) =>
  normalizeNumberValue(w.limit_dollars) !== null || normalizeNumberValue(w.used_dollars) !== null || normalizeNumberValue(w.remaining_dollars) !== null;

const claudeWindow = (id: string, used: number | null, resetsAt: unknown, periodHours: number | null): QuotaWindow => {
  const resetAtMs = resolveResetMs([resetsAt]);
  return {
    id,
    label: CLAUDE_WINDOW_LABELS[id] ?? id,
    usedPercent: used,
    // A window with no reset pending has not been touched: it counts as fully available.
    remainingPercent: used === null ? (resetAtMs === null ? 100 : null) : toRemaining(used),
    resetAtMs,
    periodHours,
    kind: 'quota',
  };
};

export function buildClaudeQuotaWindows(payload: ClaudeUsagePayload): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const fableLimit = findFableUsageLimit(payload);
  for (const { key, id } of CLAUDE_USAGE_WINDOW_KEYS) {
    const window = payload[key];
    if (!isRecord(window) || !('utilization' in window)) continue;
    const w = window as ClaudeUsageWindow;
    const isCreditPool = key === 'iguana_necktie' && isDollarDenominated(w);
    if (key === 'iguana_necktie' && fableLimit && !isCreditPool) continue; // limits[] wins
    if (isCreditPool) {
      windows.push(claudeWindow('cloud-session-credits', normalizeNumberValue(w.utilization), w.resets_at, null));
      continue;
    }
    windows.push(claudeWindow(id, normalizeNumberValue(w.utilization), w.resets_at, claudePeriodHours(key)));
  }
  if (fableLimit) {
    const used = normalizeNumberValue(fableLimit.percent);
    if (used !== null) windows.push(claudeWindow('seven-day-fable', used, fableLimit.resets_at, claudePeriodHours('seven_day')));
  }
  return windows;
}

/* ---------- plan ---------- */

const normalizeFlag = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(t)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(t)) return false;
  }
  return undefined;
};

interface ClaudeProfile {
  account?: { has_claude_max?: unknown; has_claude_pro?: unknown };
  organization?: { organization_type?: unknown; subscription_status?: unknown; uuid?: unknown };
}

export function resolveClaudePlanType(profile: ClaudeProfile | null): string | null {
  if (!profile) return null;
  const orgType = normalizeStringValue(profile.organization?.organization_type)?.toLowerCase();
  const subStatus = normalizeStringValue(profile.organization?.subscription_status)?.toLowerCase();
  if (orgType === 'claude_team' && subStatus === 'active') return 'plan_team';
  const hasMax = normalizeFlag(profile.account?.has_claude_max);
  if (hasMax) return 'plan_max';
  const hasPro = normalizeFlag(profile.account?.has_claude_pro);
  if (hasPro) return 'plan_pro';
  if (hasMax === false && hasPro === false) return 'plan_free';
  return null;
}

/** The plan almost never changes, so it is cached per credential for a day to save a request. */
const PLAN_CACHE_KEY = 'proxy-usage.quota.claude-plan.v1';
const PLAN_TTL_MS = 24 * 3_600_000;

function readPlanCache(): Record<string, { plan: string | null; at: number }> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PLAN_CACHE_KEY) ?? '{}');
    return isRecord(parsed) ? (parsed as Record<string, { plan: string | null; at: number }>) : {};
  } catch {
    return {};
  }
}

function cachedPlan(authIndex: string): { hit: boolean; plan: string | null } {
  const entry = readPlanCache()[authIndex];
  if (entry && typeof entry.at === 'number' && Date.now() - entry.at < PLAN_TTL_MS) return { hit: true, plan: entry.plan };
  return { hit: false, plan: null };
}

function storePlan(authIndex: string, plan: string | null) {
  try {
    const cache = readPlanCache();
    cache[authIndex] = { plan, at: Date.now() };
    localStorage.setItem(PLAN_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage full or blocked: the plan is simply fetched again next time */
  }
}

/* ---------- reset grants (cedar_ember), strict port of CPAMC claudeResetGrants.ts ---------- */

const GRANT_ID_RE = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ORG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const optionalTimestamp = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return undefined;
  return value;
};
const optionalBoolean = (value: unknown, fallback: boolean): boolean | undefined => {
  if (value === undefined || value === null) return fallback;
  return typeof value === 'boolean' ? value : undefined;
};
const safeLabel = (value: unknown) =>
  typeof value === 'string'
    ? value
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
    : '';

function parseGrant(value: unknown): ClaudeResetGrant | null {
  if (!isRecord(value)) return null;
  const { id, resets_total: total, resets_left: left } = value;
  if (typeof id !== 'string' || !GRANT_ID_RE.test(id)) return null;
  if (!isCount(total) || !isCount(left) || left > total) return null;
  const startsAt = optionalTimestamp(value.starts_at);
  const endsAt = optionalTimestamp(value.ends_at);
  const paused = optionalBoolean(value.paused, false);
  // Missing usability flags default to the refusing side.
  const usableNow = optionalBoolean(value.usable_now, false);
  const useRequiresLimit = optionalBoolean(value.use_requires_limit, true);
  if (value.clears !== undefined && value.clears !== null && !Array.isArray(value.clears)) return null;
  if (startsAt === undefined || endsAt === undefined || paused === undefined || usableNow === undefined || useRequiresLimit === undefined) return null;
  return { id, label: safeLabel(value.label), left, total, endsAtMs: parseIsoToMs(endsAt), usableNow, paused, useRequiresLimit };
}

/** Null for a missing or malformed block; one bad grant rejects the whole block. */
export function parseClaudeResetGrants(block: unknown): ClaudeExtras['resetGrants'] {
  if (!isRecord(block) || typeof block.eligible !== 'boolean') return null;
  const rawGrants = block.grants ?? [];
  if (!Array.isArray(rawGrants)) return null;
  const grants: ClaudeResetGrant[] = [];
  const seen = new Set<string>();
  for (const raw of rawGrants) {
    const grant = parseGrant(raw);
    if (!grant || seen.has(grant.id)) return null;
    seen.add(grant.id);
    grants.push(grant);
  }
  const atLimit = optionalBoolean(block.at_limit, false);
  const cooldownUntil = optionalTimestamp(block.cooldown_until);
  if (atLimit === undefined || cooldownUntil === undefined) return null;
  const next = block.next_grant_id;
  return {
    eligible: block.eligible,
    atLimit,
    count: grants.reduce((sum, grant) => sum + grant.left, 0),
    grants: grants
      .filter((grant) => grant.left > 0)
      .sort((a, b) => (a.endsAtMs ?? Infinity) - (b.endsAtMs ?? Infinity)),
    nextGrantId: typeof next === 'string' && seen.has(next) ? next : null,
    cooldownUntilMs: parseIsoToMs(cooldownUntil),
  };
}

/** Why a reset grant can't be spent now (null = it can). */
export function claudeResetBlocker(grants: NonNullable<ClaudeExtras['resetGrants']>): string | null {
  if (!grants.eligible) return 'This account is not eligible for limit resets.';
  if (grants.cooldownUntilMs !== null && grants.cooldownUntilMs > Date.now()) return 'Reset is cooling down.';
  const grant = pickResetGrant(grants);
  if (!grant) return 'No resets remaining.';
  if (grant.paused) return 'This reset grant is paused.';
  if (!grant.usableNow) return 'This reset grant is not usable right now.';
  if (grant.useRequiresLimit && !grants.atLimit) return 'Resets can only be used once a limit is reached.';
  return null;
}

export function pickResetGrant(grants: NonNullable<ClaudeExtras['resetGrants']>): ClaudeResetGrant | null {
  return grants.grants.find((grant) => grant.id === grants.nextGrantId) ?? grants.grants.find((grant) => grant.left > 0) ?? null;
}

/* ---------- fetch ---------- */

export async function fetchClaudeQuota(file: AuthFileItem, signal?: AbortSignal): Promise<QuotaData> {
  const authIndex = authIndexOfFile(file);
  if (!authIndex) throw new Error('Auth file missing auth_index');
  const plan = cachedPlan(authIndex);

  const [usageResult, profileResult] = await Promise.allSettled([
    apiCall({ authIndex, method: 'GET', url: CLAUDE_USAGE_URL, header: { ...CLAUDE_REQUEST_HEADERS } }, { signal }),
    plan.hit
      ? Promise.resolve(null)
      : apiCall({ authIndex, method: 'GET', url: CLAUDE_PROFILE_URL, header: { ...CLAUDE_REQUEST_HEADERS } }, { signal, timeoutMs: 8000 }),
  ]);
  if (usageResult.status === 'rejected') throw usageResult.reason;
  assertOk(usageResult.value);
  const payload = parseJsonPayload<ClaudeUsagePayload>(usageResult.value.body ?? usageResult.value.bodyText);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('No quota data available');

  let planId = plan.plan;
  if (!plan.hit && profileResult.status === 'fulfilled' && profileResult.value && isOk(profileResult.value)) {
    planId = resolveClaudePlanType(parseJsonPayload<ClaudeProfile>(profileResult.value.body));
    storePlan(authIndex, planId);
  }

  const extra = payload.extra_usage;
  const extraUsage =
    extra && extra.is_enabled === true
      ? { usedCents: normalizeNumberValue(extra.used_credits) ?? 0, limitCents: normalizeNumberValue(extra.monthly_limit) ?? 0 }
      : null;

  return {
    windows: buildClaudeQuotaWindows(payload),
    plan: claudePlan(planId),
    claude: { extraUsage, resetGrants: parseClaudeResetGrants(payload.cedar_ember) },
  };
}

/* ---------- claim (confirmed user action only) ---------- */

const JOURNAL_KEY = 'proxy-usage.quota.claude-reset-journal.v1';
const JOURNAL_TTL_MS = 10 * 60_000;

/** A retry within 10 minutes reuses the same request id so the claim is idempotent upstream. */
function requestIdFor(authIndex: string, grantId: string): string {
  let journal: Record<string, { id: string; at: number }> = {};
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(JOURNAL_KEY) ?? '{}');
    if (isRecord(parsed)) journal = parsed as typeof journal;
  } catch {
    /* fresh journal */
  }
  const key = `${authIndex}:${grantId}`;
  const existing = journal[key];
  if (existing && Date.now() - existing.at < JOURNAL_TTL_MS && REQUEST_ID_RE.test(existing.id)) return existing.id;
  const id = crypto.randomUUID();
  journal[key] = { id, at: Date.now() };
  try {
    sessionStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
  } catch {
    /* best effort */
  }
  return id;
}

const CLAIM_MESSAGES: Record<string, string> = {
  reset: 'Limits reset.',
  already_used: 'This reset was already used.',
  not_limited: 'No limit is reached, so nothing was reset.',
  cooldown: 'Resets are cooling down. Try again later.',
  ineligible: 'This account is not eligible for limit resets.',
  unavailable: 'Limit resets are unavailable right now.',
};

/** Spends one banked reset grant. Never called without an explicit, confirmed click. */
export async function claimClaudeResetGrant(file: AuthFileItem, grantId: string): Promise<{ ok: boolean; message: string }> {
  const authIndex = authIndexOfFile(file);
  if (!authIndex) throw new Error('Auth file missing auth_index');
  if (!GRANT_ID_RE.test(grantId)) throw new Error('Invalid reset grant');
  const profile = await apiCall({ authIndex, method: 'GET', url: CLAUDE_PROFILE_URL, header: { ...CLAUDE_REQUEST_HEADERS } }, { timeoutMs: 12000 });
  assertOk(profile);
  const uuid = parseJsonPayload<ClaudeProfile>(profile.body)?.organization?.uuid;
  if (typeof uuid !== 'string' || !ORG_UUID_RE.test(uuid)) throw new Error('Could not resolve the Claude organization.');
  const requestId = requestIdFor(authIndex, grantId);
  const response = await apiCall(
    {
      authIndex,
      method: 'POST',
      url: `${ORIGIN}/api/organizations/${uuid.toLowerCase()}/reset_rate_limits`,
      header: { ...CLAUDE_REQUEST_HEADERS },
      data: JSON.stringify({ program: 'cedar_ember', grant_id: grantId, request_id: requestId }),
    },
    { timeoutMs: 25000 },
  );
  if (response.statusCode === 429) return { ok: false, message: 'Rate limited by Anthropic. Try again shortly.' };
  if (response.statusCode === 401 || response.statusCode === 403) throw new QuotaStatusError('Please check the credential status', response.statusCode);
  const result = isRecord(response.body) ? response.body.result : undefined;
  if (isOk(response) && typeof result === 'string' && result in CLAIM_MESSAGES) {
    return { ok: result === 'reset', message: CLAIM_MESSAGES[result] };
  }
  throw new Error('The reset outcome is unknown. Refresh the quota before trying again.');
}
