import { apiCall, assertOk, getApiCallErrorMessage, isOk } from '../apiCall';
import { authIndexOfFile, resolveCodexAccountId } from '../files';
import {
  asRecord,
  isRecord,
  normalizeNumberValue,
  normalizePlanType,
  normalizeStringValue,
  parseIsoToMs,
  parseJsonPayload,
  parseOffsetSecondsToMs,
  periodHoursFromSeconds,
  resolveResetMs,
  slugify,
  toRemaining,
} from '../parse';
import { codexPlan } from '../plans';
import type { AuthFileItem, CodexExtras, CodexResetCredit, QuotaData, QuotaWindow } from '../types';

/** Codex (ChatGPT) quota: `wham/usage` windows, plan, credits and manual reset credits. */

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const CODEX_RESET_CREDITS_CONSUME_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume';
const OPTIONAL_TIMEOUT_MS = 8000;

const CODEX_REQUEST_HEADERS: Record<string, string> = {
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'User-Agent': 'codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)',
};

export function buildCodexRequestHeader(file: AuthFileItem): Record<string, string> {
  const header = { ...CODEX_REQUEST_HEADERS };
  const accountId = resolveCodexAccountId(file);
  if (accountId) header['Chatgpt-Account-Id'] = accountId;
  return header;
}

export interface CodexUsageWindow {
  used_percent?: unknown;
  usedPercent?: unknown;
  limit_window_seconds?: unknown;
  limitWindowSeconds?: unknown;
  reset_after_seconds?: unknown;
  resetAfterSeconds?: unknown;
  reset_at?: unknown;
  resetAt?: unknown;
}

export interface CodexRateLimitInfo {
  allowed?: boolean;
  limit_reached?: boolean;
  limitReached?: boolean;
  primary_window?: CodexUsageWindow | null;
  primaryWindow?: CodexUsageWindow | null;
  secondary_window?: CodexUsageWindow | null;
  secondaryWindow?: CodexUsageWindow | null;
}

interface CodexUsagePayload {
  plan_type?: unknown;
  planType?: unknown;
  rate_limit?: CodexRateLimitInfo | null;
  rateLimit?: CodexRateLimitInfo | null;
  code_review_rate_limit?: CodexRateLimitInfo | null;
  codeReviewRateLimit?: CodexRateLimitInfo | null;
  additional_rate_limits?: Array<{ limit_name?: unknown; limitName?: unknown; metered_feature?: unknown; meteredFeature?: unknown; rate_limit?: CodexRateLimitInfo | null; rateLimit?: CodexRateLimitInfo | null }>;
  additionalRateLimits?: CodexUsagePayload['additional_rate_limits'];
  credits?: { balance?: unknown; unlimited?: unknown } | null;
  rate_limit_reset_credits?: unknown;
  rateLimitResetCredits?: unknown;
}

const FIVE_HOUR_SECONDS = 18000;
const WEEK_SECONDS = 604800;
const MIN_MONTH_SECONDS = 28 * 86400;
const MAX_MONTH_SECONDS = 31 * 86400;

const secondsOf = (w?: CodexUsageWindow | null) => (w ? normalizeNumberValue(w.limit_window_seconds ?? w.limitWindowSeconds) : null);
const isMonthly = (w?: CodexUsageWindow | null) => {
  const s = secondsOf(w);
  return s !== null && s >= MIN_MONTH_SECONDS && s <= MAX_MONTH_SECONDS;
};

/** Classifies primary/secondary by duration; legacy payloads without durations fall back to order. */
export function pickCodexWindows(info?: CodexRateLimitInfo | null) {
  const primary = info?.primary_window ?? info?.primaryWindow ?? null;
  const secondary = info?.secondary_window ?? info?.secondaryWindow ?? null;
  let fiveHour: CodexUsageWindow | null = null;
  let weekly: CodexUsageWindow | null = null;
  for (const w of [primary, secondary]) {
    if (!w) continue;
    const s = secondsOf(w);
    if (s === FIVE_HOUR_SECONDS && !fiveHour) fiveHour = w;
    else if ((s === WEEK_SECONDS || isMonthly(w)) && !weekly) weekly = w;
  }
  if (!fiveHour) fiveHour = primary && primary !== weekly ? primary : null;
  if (!weekly) weekly = secondary && secondary !== fiveHour ? secondary : null;
  return { fiveHour, weekly };
}

export function buildCodexQuotaWindows(payload: CodexUsagePayload, now = Date.now()): QuotaWindow[] {
  const rateLimit = payload.rate_limit ?? payload.rateLimit ?? undefined;
  const codeReview = payload.code_review_rate_limit ?? payload.codeReviewRateLimit ?? undefined;
  const additional = payload.additional_rate_limits ?? payload.additionalRateLimits ?? [];
  const windows: QuotaWindow[] = [];

  const addWindow = (id: string, label: string, window: CodexUsageWindow | null, limitReached?: boolean, allowed?: boolean) => {
    if (!window) return;
    const resetAtMs =
      resolveResetMs([window.reset_at, window.resetAt]) ?? parseOffsetSecondsToMs(window.reset_after_seconds ?? window.resetAfterSeconds, now);
    const usedRaw = normalizeNumberValue(window.used_percent ?? window.usedPercent);
    const reached = Boolean(limitReached) || allowed === false;
    const used = usedRaw ?? (reached && resetAtMs !== null ? 100 : null);
    windows.push({
      id,
      label,
      usedPercent: used,
      remainingPercent: toRemaining(used),
      resetAtMs,
      periodHours: periodHoursFromSeconds(window.limit_window_seconds ?? window.limitWindowSeconds),
      kind: 'quota',
    });
  };

  const main = pickCodexWindows(rateLimit);
  const reached = rateLimit?.limit_reached ?? rateLimit?.limitReached;
  addWindow('five-hour', '5-hour limit', main.fiveHour, reached, rateLimit?.allowed);
  addWindow(isMonthly(main.weekly) ? 'monthly' : 'weekly', isMonthly(main.weekly) ? 'Monthly limit' : 'Weekly limit', main.weekly, reached, rateLimit?.allowed);

  const cr = pickCodexWindows(codeReview);
  const crReached = codeReview?.limit_reached ?? codeReview?.limitReached;
  addWindow('code-review-five-hour', 'Code review 5-hour limit', cr.fiveHour, crReached, codeReview?.allowed);
  addWindow(
    isMonthly(cr.weekly) ? 'code-review-monthly' : 'code-review-weekly',
    isMonthly(cr.weekly) ? 'Code review monthly limit' : 'Code review weekly limit',
    cr.weekly,
    crReached,
    codeReview?.allowed,
  );

  if (Array.isArray(additional)) {
    additional.forEach((item, index) => {
      const info = item?.rate_limit ?? item?.rateLimit ?? null;
      if (!info) return;
      const name =
        normalizeStringValue(item?.limit_name ?? item?.limitName) ??
        normalizeStringValue(item?.metered_feature ?? item?.meteredFeature) ??
        `additional-${index + 1}`;
      const prefix = slugify(name) || `additional-${index + 1}`;
      const aw = pickCodexWindows(info);
      const ar = info.limit_reached ?? info.limitReached;
      addWindow(`${prefix}-five-hour-${index}`, `${name} 5-hour limit`, aw.fiveHour, ar, info.allowed);
      const monthly = isMonthly(aw.weekly);
      addWindow(`${prefix}-${monthly ? 'monthly' : 'weekly'}-${index}`, `${name} ${monthly ? 'monthly' : 'weekly'} limit`, aw.weekly, ar, info.allowed);
    });
  }
  return windows;
}

export function normalizeCodexAccountCredits(credits: CodexUsagePayload['credits']) {
  const value = credits?.balance;
  const balance = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : null;
  return {
    balance: balance && /^\d+(?:\.\d+)?$/.test(balance) && Number.isFinite(Number(balance)) ? balance : null,
    unlimited: credits?.unlimited === true || credits?.unlimited === 'True' || credits?.unlimited === 'true',
  };
}

export interface CodexResetCreditsSummary {
  availableCount: number | null;
  applicableAvailableCount: number | null;
  credits: CodexResetCredit[];
  invalidPayload: boolean;
}

/** Keeps only available codex_rate_limits credits that state an expiry. */
export function normalizeCodexResetCreditsPayload(payload: unknown): CodexResetCreditsSummary {
  const parsed = typeof payload === 'string' ? parseJsonPayload<unknown>(payload) : payload;
  if (!isRecord(parsed)) return { availableCount: null, applicableAvailableCount: null, credits: [], invalidPayload: true };
  const hasExpectedShape = ['credits', 'available_count', 'availableCount', 'applicable_available_count', 'applicableAvailableCount'].some(
    (key) => key in parsed,
  );
  const credits: CodexResetCredit[] = [];
  if (Array.isArray(parsed.credits)) {
    parsed.credits.forEach((item, index) => {
      const record = asRecord(item);
      if (normalizeStringValue(record.reset_type ?? record.resetType) !== 'codex_rate_limits') return;
      if (normalizeStringValue(record.status) !== 'available') return;
      const expiresAtMs = parseIsoToMs(normalizeStringValue(record.expires_at ?? record.expiresAt));
      if (expiresAtMs === null) return;
      credits.push({
        id: normalizeStringValue(record.id) ?? `credit-${index}`,
        grantedAtMs: parseIsoToMs(normalizeStringValue(record.granted_at ?? record.grantedAt)),
        expiresAtMs,
      });
    });
  }
  credits.sort((a, b) => a.expiresAtMs - b.expiresAtMs);
  return {
    availableCount: normalizeNumberValue(parsed.available_count ?? parsed.availableCount),
    applicableAvailableCount: normalizeNumberValue(parsed.applicable_available_count ?? parsed.applicableAvailableCount),
    credits,
    invalidPayload: !hasExpectedShape,
  };
}

/** Plan and renewal come straight from the decoded `id_token` in the list, with no network call. */
export function codexFileFacts(file: AuthFileItem) {
  const idToken = asRecord(file.id_token);
  return {
    planType: normalizePlanType(idToken.plan_type ?? file.plan_type),
    renewsAtMs: resolveResetMs([idToken.chatgpt_subscription_active_until]),
  };
}

async function fetchResetCreditDetails(authIndex: string, header: Record<string, string>, signal?: AbortSignal) {
  try {
    const result = await apiCall(
      {
        authIndex,
        method: 'GET',
        url: CODEX_RESET_CREDITS_URL,
        header: { ...header, Accept: 'application/json', 'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop' },
      },
      { signal, timeoutMs: OPTIONAL_TIMEOUT_MS },
    );
    if (!isOk(result)) return { summary: null, error: getApiCallErrorMessage(result) };
    const summary = normalizeCodexResetCreditsPayload(result.body ?? result.bodyText);
    if (summary.invalidPayload) return { summary: null, error: 'Unexpected reset-credit payload' };
    return { summary, error: '' };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return { summary: null, error: error instanceof Error ? error.message : 'Request failed' };
  }
}

export async function fetchCodexQuota(file: AuthFileItem, signal?: AbortSignal): Promise<QuotaData> {
  const authIndex = authIndexOfFile(file);
  if (!authIndex) throw new Error('Auth file missing auth_index');
  const header = buildCodexRequestHeader(file);
  const facts = codexFileFacts(file);

  const result = await apiCall({ authIndex, method: 'GET', url: CODEX_USAGE_URL, header }, { signal });
  assertOk(result);
  const payload = parseJsonPayload<CodexUsagePayload>(result.body ?? result.bodyText);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('No quota data available');

  const usageCredits = normalizeCodexResetCreditsPayload(payload.rate_limit_reset_credits ?? payload.rateLimitResetCredits ?? null);
  // Expiry details cost one extra request, so only ask when there is something to list.
  const details = (usageCredits.availableCount ?? 0) > 0 ? await fetchResetCreditDetails(authIndex, header, signal) : { summary: null, error: '' };
  const detailCount = details.summary && details.summary.credits.length > 0 ? details.summary.credits.length : null;
  const available = details.summary?.availableCount ?? detailCount ?? usageCredits.availableCount;
  const applicable = usageCredits.applicableAvailableCount ?? details.summary?.applicableAvailableCount ?? available;
  const accountCredits = normalizeCodexAccountCredits(payload.credits);

  const codex: CodexExtras = {
    creditBalance: accountCredits.balance,
    creditsUnlimited: accountCredits.unlimited,
    renewsAtMs: facts.renewsAtMs,
    manualResets: { available, applicable, credits: details.summary?.credits ?? [], error: details.error || undefined },
  };
  const planType = normalizePlanType(payload.plan_type ?? payload.planType) ?? facts.planType;
  const windows = buildCodexQuotaWindows(payload);
  const note = planType === 'free' && windows.length === 0 ? 'This credential has no Codex access (plan: free).' : undefined;
  return { windows, plan: codexPlan(planType), codex, note };
}

/**
 * Consumes one manual reset credit. Only ever called from the confirmation dialog: it spends a
 * scarce, non-refundable credit.
 */
export async function consumeCodexResetCredit(file: AuthFileItem): Promise<void> {
  const authIndex = authIndexOfFile(file);
  if (!authIndex) throw new Error('Auth file missing auth_index');
  const result = await apiCall({
    authIndex,
    method: 'POST',
    url: CODEX_RESET_CREDITS_CONSUME_URL,
    header: buildCodexRequestHeader(file),
    data: JSON.stringify({ redeem_request_id: crypto.randomUUID() }),
  });
  assertOk(result);
  const code = isRecord(result.body) ? result.body.code : undefined;
  if (code !== 'reset' && code !== 'already_redeemed') {
    throw new Error('Quota reset was not confirmed. Refresh the quota before trying again.');
  }
}
