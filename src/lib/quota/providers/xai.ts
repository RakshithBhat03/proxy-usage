import { apiCall, assertOk, isOk } from '../apiCall';
import { authIndexOfFile } from '../files';
import { asRecord, isRecord, normalizeNumberValue, normalizeStringValue, parseJsonPayload, resolveResetMs, toRemaining } from '../parse';
import { xaiPlan } from '../plans';
import type { AuthFileItem, QuotaData, QuotaWindow, XaiExtras } from '../types';

/** xAI / Grok CLI billing: a weekly credit window plus monthly credits and pay-as-you-go. */

const XAI_BILLING_WEEKLY_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const XAI_BILLING_MONTHLY_URL = 'https://cli-chat-proxy.grok.com/v1/billing';
const XAI_USER_URL = 'https://cli-chat-proxy.grok.com/v1/user?include=subscription';
const XAI_SETTINGS_URL = 'https://cli-chat-proxy.grok.com/v1/settings';
const XAI_API_ME_URL = 'https://api.x.ai/v1/me';
const XAI_API_CHAT_URL = 'https://api.x.ai/v1/chat/completions';

const XAI_REQUEST_HEADERS: Record<string, string> = {
  Authorization: 'Bearer $TOKEN$',
  'x-xai-token-auth': 'xai-grok-cli',
  'x-grok-client-version': '0.2.91',
  accept: '*/*',
  'user-agent': 'grok-pager/0.2.91 grok-shell/0.2.91 (macos; aarch64)',
};
const XAI_API_REQUEST_HEADERS: Record<string, string> = { Authorization: 'Bearer $TOKEN$', accept: 'application/json' };

interface XaiBillingSummary {
  periodType: 'weekly' | 'monthly' | 'unknown';
  usagePercent: number | null;
  periodStart?: string;
  periodEnd?: string;
  productUsage: Array<{ product: string; usagePercent: number | null }>;
  monthlyLimitCents: number | null;
  usedCents: number | null;
  includedUsedCents: number | null;
  onDemandCapCents: number | null;
  onDemandUsedCents: number | null;
  onDemandUsedPercent: number | null;
  prepaidBalanceCents: number | null;
  usedPercent: number | null;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
}

const cents = (value: unknown) => (isRecord(value) ? normalizeNumberValue(value.val) : normalizeNumberValue(value));

/** Port of CPAMC `buildXaiBillingSummary`. */
export function buildXaiBillingSummary(raw: unknown): XaiBillingSummary | null {
  if (!isRecord(raw)) return null;
  const config = raw;
  const currentPeriod = asRecord(config.currentPeriod ?? config.current_period);
  const rawType = (normalizeStringValue(currentPeriod.type) ?? '').toLowerCase();
  const periodType = rawType.includes('weekly') ? 'weekly' : rawType.includes('monthly') ? 'monthly' : 'unknown';
  const creditUsagePercent = normalizeNumberValue(config.creditUsagePercent ?? config.credit_usage_percent);
  const billingPeriodStart = normalizeStringValue(config.billingPeriodStart ?? config.billing_period_start) ?? undefined;
  const billingPeriodEnd = normalizeStringValue(config.billingPeriodEnd ?? config.billing_period_end) ?? undefined;
  const periodStart = normalizeStringValue(currentPeriod.start) ?? billingPeriodStart;
  const periodEnd = normalizeStringValue(currentPeriod.end) ?? billingPeriodEnd;
  const rawProducts = config.productUsage ?? config.product_usage;
  const productUsage = (Array.isArray(rawProducts) ? rawProducts : [])
    .filter(isRecord)
    .map((item, index) => ({
      product: normalizeStringValue(item.product) ?? `Product ${index + 1}`,
      usagePercent: normalizeNumberValue(item.usagePercent ?? item.usage_percent),
    }));
  const monthlyLimitCents = cents(config.monthlyLimit ?? config.monthly_limit);
  const usedCents = cents(config.used);
  const onDemandCapCents = cents(config.onDemandCap ?? config.on_demand_cap);
  const explicitOnDemandUsed = cents(config.onDemandUsed ?? config.on_demand_used);
  const includedUsedCents =
    usedCents === null ? null : monthlyLimitCents !== null && monthlyLimitCents > 0 ? Math.min(usedCents, monthlyLimitCents) : usedCents;
  const derivedOnDemand = usedCents !== null && monthlyLimitCents !== null ? Math.max(0, usedCents - monthlyLimitCents) : null;
  const onDemandUsedCents = explicitOnDemandUsed ?? derivedOnDemand;
  const usedPercent = monthlyLimitCents !== null && monthlyLimitCents > 0 && includedUsedCents !== null ? (includedUsedCents / monthlyLimitCents) * 100 : null;
  const onDemandUsedPercent = onDemandCapCents !== null && onDemandCapCents > 0 && onDemandUsedCents !== null ? (onDemandUsedCents / onDemandCapCents) * 100 : null;

  const hasWeekly = creditUsagePercent !== null || periodType === 'weekly' || productUsage.length > 0;
  const hasMonthly = monthlyLimitCents !== null || usedCents !== null || (!hasWeekly && (onDemandCapCents !== null || !!billingPeriodEnd));
  if (!hasWeekly && !hasMonthly) return null;
  return {
    periodType: hasWeekly ? (periodType === 'unknown' ? 'weekly' : periodType) : 'monthly',
    usagePercent: hasWeekly ? creditUsagePercent : usedPercent,
    periodStart: hasWeekly ? periodStart : billingPeriodStart,
    periodEnd: hasWeekly ? periodEnd : billingPeriodEnd,
    productUsage,
    monthlyLimitCents,
    usedCents,
    includedUsedCents,
    onDemandCapCents,
    onDemandUsedCents,
    onDemandUsedPercent,
    prepaidBalanceCents: cents(config.prepaidBalance ?? config.prepaid_balance),
    usedPercent,
    billingPeriodStart: hasMonthly ? billingPeriodStart : undefined,
    billingPeriodEnd: hasMonthly ? billingPeriodEnd : undefined,
  };
}

/** The weekly endpoint wins the period; dates are never mixed across the two endpoints' clocks. */
export function mergeXaiBillingSummaries(primary: XaiBillingSummary | null, fallback: XaiBillingSummary | null): XaiBillingSummary | null {
  if (!primary) return fallback;
  if (!fallback) return primary;
  const period = primary.periodType !== 'unknown' ? primary : fallback.periodType !== 'unknown' ? fallback : primary;
  return {
    periodType: period.periodType,
    usagePercent: period.usagePercent,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    productUsage: primary.productUsage.length > 0 ? primary.productUsage : fallback.productUsage,
    monthlyLimitCents: primary.monthlyLimitCents ?? fallback.monthlyLimitCents,
    usedCents: primary.usedCents ?? fallback.usedCents,
    includedUsedCents: primary.includedUsedCents ?? fallback.includedUsedCents,
    onDemandCapCents: primary.onDemandCapCents ?? fallback.onDemandCapCents,
    onDemandUsedCents: primary.onDemandUsedCents ?? fallback.onDemandUsedCents,
    onDemandUsedPercent: primary.onDemandUsedPercent ?? fallback.onDemandUsedPercent,
    prepaidBalanceCents: primary.prepaidBalanceCents ?? fallback.prepaidBalanceCents,
    usedPercent: primary.usedPercent ?? fallback.usedPercent,
    billingPeriodStart: primary.billingPeriodStart ?? fallback.billingPeriodStart,
    billingPeriodEnd: primary.billingPeriodEnd ?? fallback.billingPeriodEnd,
  };
}

const periodHours = (start?: string, end?: string) => {
  const endMs = resolveResetMs([end]);
  const startMs = resolveResetMs([start]);
  return endMs !== null && startMs !== null && endMs > startMs ? (endMs - startMs) / 3_600_000 : null;
};

export function xaiSummaryToQuota(summary: XaiBillingSummary): Pick<QuotaData, 'windows' | 'xai'> {
  const windows: QuotaWindow[] = [];
  if (summary.periodType === 'weekly') {
    windows.push({
      id: 'weekly',
      label: 'Weekly limit',
      usedPercent: summary.usagePercent,
      remainingPercent: toRemaining(summary.usagePercent),
      resetAtMs: resolveResetMs([summary.periodEnd]),
      periodHours: periodHours(summary.periodStart, summary.periodEnd) ?? 168,
      kind: 'quota',
    });
  }
  if (summary.usedPercent !== null || summary.monthlyLimitCents !== null) {
    windows.push({
      id: 'monthly-credits',
      label: 'Monthly credits',
      usedPercent: summary.usedPercent,
      remainingPercent: toRemaining(summary.usedPercent),
      resetAtMs: resolveResetMs([summary.billingPeriodEnd]),
      periodHours: periodHours(summary.billingPeriodStart, summary.billingPeriodEnd),
      kind: 'billing',
      amount:
        summary.includedUsedCents !== null && summary.monthlyLimitCents !== null
          ? `$${(summary.includedUsedCents / 100).toFixed(2)} / $${(summary.monthlyLimitCents / 100).toFixed(2)}`
          : undefined,
    });
  }
  const xai: XaiExtras = {
    payAsYouGo:
      summary.onDemandCapCents !== null || summary.onDemandUsedCents !== null
        ? { capCents: summary.onDemandCapCents, usedCents: summary.onDemandUsedCents, usedPercent: summary.onDemandUsedPercent }
        : null,
    prepaidBalanceCents: summary.prepaidBalanceCents,
    productUsage: summary.productUsage,
  };
  return { windows, xai };
}

const resolveXaiUserId = (file: AuthFileItem): string | null => {
  const metadata = asRecord(file.metadata);
  const attributes = asRecord(file.attributes);
  for (const candidate of [file.sub, file.subject, file.user_id, file.userId, metadata.sub, metadata.user_id, attributes.sub, attributes.user_id]) {
    const id = normalizeStringValue(candidate);
    if (id) return id;
  }
  return null;
};

const decodeJwtTier = (token: string): number | null => {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = asRecord(JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))));
    const entry = Object.entries(decoded).find(([key]) => {
      const k = key.toLowerCase();
      return k === 'tier' || k.endsWith('/tier') || k.endsWith(':tier');
    });
    const tier = Number(entry?.[1]);
    return Number.isFinite(tier) ? tier : null;
  } catch {
    return null;
  }
};

/** Paid API credentials: `using_api` plus the `paid` prefix, or a JWT tier >= 1. */
export function isPaidXaiAuthFile(file: AuthFileItem): boolean {
  const records = [file as Record<string, unknown>, asRecord(file.metadata), asRecord(file.attributes)];
  const truthy = (v: unknown) => v === true || v === 1 || (typeof v === 'string' && ['true', '1', 'yes'].includes(v.toLowerCase()));
  const usesApi = records.some((r) => truthy(r.using_api ?? r.usingApi));
  const paidPrefix = records.some((r) => typeof r.prefix === 'string' && r.prefix.toLowerCase() === 'paid');
  if (usesApi && paidPrefix) return true;
  return records.some((r) =>
    ['access_token', 'id_token', 'token'].some((key) => typeof r[key] === 'string' && (decodeJwtTier(r[key] as string) ?? 0) >= 1),
  );
}

async function requestBilling(authIndex: string, url: string, header: Record<string, string>, signal?: AbortSignal) {
  const result = await apiCall({ authIndex, method: 'GET', url, header }, { signal });
  assertOk(result);
  return buildXaiBillingSummary(asRecord(parseJsonPayload(result.body)).config);
}

async function requestPlan(authIndex: string, signal?: AbortSignal) {
  const read = async (url: string, keys: string[]) => {
    try {
      const result = await apiCall({ authIndex, method: 'GET', url, header: { ...XAI_REQUEST_HEADERS } }, { signal, timeoutMs: 8000 });
      if (!isOk(result)) return null;
      const record = asRecord(parseJsonPayload(result.body));
      for (const key of keys) {
        const value = normalizeStringValue(record[key]);
        if (value) return value;
      }
      return null;
    } catch {
      return null;
    }
  };
  const [tier, display] = await Promise.all([
    read(XAI_USER_URL, ['subscriptionTier', 'subscription_tier']),
    read(XAI_SETTINGS_URL, ['subscription_tier_display', 'subscriptionTierDisplay']),
  ]);
  return xaiPlan(tier, display);
}

/**
 * The paid-API health check sends a real (1-token) completion, so it only runs when the user
 * explicitly refreshes that one credential.
 */
async function requestPaidHealth(authIndex: string, signal?: AbortSignal): Promise<QuotaData> {
  const chat = await apiCall(
    {
      authIndex,
      method: 'POST',
      url: XAI_API_CHAT_URL,
      header: { ...XAI_API_REQUEST_HEADERS, 'Content-Type': 'application/json' },
      data: JSON.stringify({ model: 'grok-4.5', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
    },
    { signal, timeoutMs: 15000 },
  );
  assertOk(chat);
  void (await apiCall({ authIndex, method: 'GET', url: XAI_API_ME_URL, header: XAI_API_REQUEST_HEADERS }, { signal, timeoutMs: 15000 }).catch(() => null));
  return {
    windows: [],
    plan: { id: 'paid', label: 'Paid API', tier: 'premium' },
    xai: { payAsYouGo: null, prepaidBalanceCents: null, productUsage: [], healthOnly: true },
    note: 'Paid API chat is available. xAI does not expose quota totals for this OAuth credential.',
  };
}

export async function fetchXaiQuota(file: AuthFileItem, options: { signal?: AbortSignal; allowProbe?: boolean } = {}): Promise<QuotaData> {
  const { signal, allowProbe = false } = options;
  const authIndex = authIndexOfFile(file);
  if (!authIndex) throw new Error('Auth file missing auth_index');
  const probeHint = 'Paid xAI credential: click Refresh quota on this card to run a 1-token health check.';
  if (isPaidXaiAuthFile(file)) {
    if (!allowProbe) throw new Error(probeHint);
    return requestPaidHealth(authIndex, signal);
  }
  const header = { ...XAI_REQUEST_HEADERS };
  const userId = resolveXaiUserId(file);
  if (userId) header['x-userid'] = userId;
  const [weekly, monthly, plan] = await Promise.allSettled([
    requestBilling(authIndex, XAI_BILLING_WEEKLY_URL, header, signal),
    requestBilling(authIndex, XAI_BILLING_MONTHLY_URL, header, signal),
    requestPlan(authIndex, signal),
  ]);
  const summary = mergeXaiBillingSummaries(weekly.status === 'fulfilled' ? weekly.value : null, monthly.status === 'fulfilled' ? monthly.value : null);
  const planInfo = plan.status === 'fulfilled' ? plan.value : null;
  if (summary) return { ...xaiSummaryToQuota(summary), plan: planInfo };
  const billingError = weekly.status === 'rejected' && monthly.status === 'rejected' ? weekly.reason : new Error('No quota data available');
  if (!allowProbe) throw billingError;
  try {
    return await requestPaidHealth(authIndex, signal);
  } catch {
    throw billingError;
  }
}
