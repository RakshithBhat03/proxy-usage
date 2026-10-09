/**
 * Model price book + client-side cost for raw events.
 *
 * Aggregated analytics (summary, timeline, stats) already carry server-computed cost. Raw `EventRow`s
 * do not, so anything aggregated in the browser (sub-hour buckets, the live request table) prices
 * events here. Ported from CPAMP `be/service/pricing/cost.go` and `web/utils/usage.ts` calculateCost
 * (see docs/research/usage-api.md §3.2, §7). Prices are USD per 1M tokens.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api/client';
import type { EventRow } from './api/analytics';

interface PriceFields {
  prompt: number;
  completion: number;
  cache: number;
  cacheRead?: number;
  cacheCreation?: number;
  promptConfigured?: boolean;
  completionConfigured?: boolean;
  cacheConfigured?: boolean;
  cacheReadConfigured?: boolean;
  cacheCreationConfigured?: boolean;
}

export interface ContextTier extends PriceFields {
  thresholdTokens: number;
}

export interface ServiceTierRule extends PriceFields {
  mode: string;
  serviceTier: string;
}

export interface ModelPrice extends PriceFields {
  source?: string;
  sourceModelId?: string;
  rawJson?: string;
  contextTiers?: ContextTier[];
  serviceTiers?: ServiceTierRule[];
  updatedAtMs?: number;
  syncedAtMs?: number;
}

export type PriceBook = Record<string, ModelPrice>;

export interface SyncCandidate {
  sourceModelId: string;
  score: number;
  reason: string;
  price: ModelPrice;
}

export interface SyncResult {
  source: 'models.dev' | 'litellm' | 'openrouter' | 'multi' | '';
  sources?: string[];
  imported: number;
  skipped: number;
  matched?: Record<string, ModelPrice>;
  candidates?: Array<{ model: string; candidates: SyncCandidate[] }>;
  unmatched?: string[];
  preserved?: string[];
  proxyUsed?: boolean;
  sourceResults?: Array<{ source: string; models: number; skipped: number; error?: string }>;
  prices: PriceBook;
  runtimeModelCount?: number;
  runtimeModelDiscoveryError?: string;
}

/* ---------------- API ---------------- */

export const MODEL_PRICES_QUERY_KEY = ['model-prices'] as const;

export async function fetchModelPrices(signal?: AbortSignal): Promise<PriceBook> {
  const data = await api<{ prices?: PriceBook }>('/v0/management/model-prices', { signal });
  return data.prices ?? {};
}

/** Replaces the whole price book (there are no per-model endpoints). */
export async function saveModelPrices(prices: PriceBook): Promise<PriceBook> {
  const data = await api<{ prices?: PriceBook }>('/v0/management/model-prices', { method: 'PUT', body: { prices } });
  return data.prices ?? {};
}

/** Pulls prices from models.dev → LiteLLM → OpenRouter. Manual entries are never overwritten. */
export function syncModelPrices(models: string[], includeRuntimeModels = true): Promise<SyncResult> {
  return api<SyncResult>('/v0/management/model-prices/sync', {
    method: 'POST',
    body: { models, includeRuntimeModels },
  });
}

export function useModelPrices() {
  return useQuery({
    queryKey: MODEL_PRICES_QUERY_KEY,
    queryFn: ({ signal }) => fetchModelPrices(signal),
    staleTime: 5 * 60_000,
  });
}

/* ---------------- Cost ---------------- */

const LONG_CONTEXT_THRESHOLD = 272_000;
const LEGACY_LONG_CONTEXT_MODELS = ['gpt-5.4', 'gpt-5.4-pro', 'gpt-5.5', 'gpt-5.6'];

const normalize = (value: string | undefined) => (value ?? '').trim().toLowerCase();
const stripReasoningSuffix = (model: string) => model.replace(/\s*\([^)]*\)\s*$/, '').trim();

export function findPrice(book: PriceBook, candidates: Array<string | undefined>): { key: string; price: ModelPrice } | null {
  const keys = Object.keys(book);
  for (const raw of candidates) {
    if (!raw) continue;
    const candidate = stripReasoningSuffix(raw);
    if (book[candidate]) return { key: candidate, price: book[candidate] };
    const lower = normalize(candidate);
    const match = keys.find((key) => normalize(key) === lower);
    if (match) return { key: match, price: book[match] };
    // Provider-prefixed ids ("anthropic/claude-x") vs bare ids.
    const bare = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower;
    const prefixed = keys.find((key) => {
      const k = normalize(key);
      return k === bare || k.endsWith(`/${bare}`);
    });
    if (prefixed) return { key: prefixed, price: book[prefixed] };
  }
  return null;
}

function overlay(base: ModelPrice, fields: PriceFields): ModelPrice {
  return {
    ...base,
    prompt: fields.promptConfigured || fields.prompt > 0 ? fields.prompt : base.prompt,
    completion: fields.completionConfigured || fields.completion > 0 ? fields.completion : base.completion,
    cache: fields.cacheConfigured || fields.cache > 0 ? fields.cache : base.cache,
    cacheRead: fields.cacheReadConfigured || (fields.cacheRead ?? 0) > 0 ? fields.cacheRead : base.cacheRead,
    cacheReadConfigured: fields.cacheReadConfigured || base.cacheReadConfigured,
    cacheCreation:
      fields.cacheCreationConfigured || (fields.cacheCreation ?? 0) > 0 ? fields.cacheCreation : base.cacheCreation,
    cacheCreationConfigured: fields.cacheCreationConfigured || base.cacheCreationConfigured,
  };
}

function normalizeTier(tier: string | undefined): string {
  const t = normalize(tier);
  if (!t || t === 'auto' || t === 'default' || t === 'standard' || t === 'standard_only') return 'normal';
  if (t === 'priority' || t === 'fast') return 'fast';
  return t;
}

function serviceTierMultiplier(model: string, tier: string): number {
  const t = normalize(tier);
  if (t === 'flex' || t === 'batch') return 0.5;
  if (t === 'priority' || t === 'fast') {
    const m = normalize(model);
    if (m.startsWith('gpt-5.5')) return 2.5;
    if (m.startsWith('gpt-5.6') || m.startsWith('gpt-5.4-mini') || m.startsWith('gpt-5.4') || m.startsWith('gpt-5.3-codex'))
      return 2;
  }
  return 1;
}

export interface CostTokens {
  input: number;
  output: number;
  cached: number;
  cacheRead: number;
  cacheCreation: number;
}

function segmentCost(t: CostTokens, p: ModelPrice, inMul: number, outMul: number): number {
  const readTokens = t.cached + t.cacheRead;
  const promptTokens = Math.max(t.input - readTokens - t.cacheCreation, 0);
  const cacheReadPrice =
    p.cacheReadConfigured || (p.cacheRead ?? 0) > 0 ? (p.cacheRead ?? 0) : p.cache > 0 ? p.cache : p.prompt * 0.1;
  const cacheCreationPrice = p.cacheCreationConfigured || (p.cacheCreation ?? 0) > 0 ? (p.cacheCreation ?? 0) : p.prompt;
  return (
    (promptTokens * p.prompt * inMul +
      t.cached * p.cache * inMul +
      t.cacheRead * cacheReadPrice * inMul +
      t.cacheCreation * cacheCreationPrice * inMul +
      t.output * p.completion * outMul) /
    1_000_000
  );
}

/** USD cost for one request's tokens, or null when the model has no price. */
export function estimateCost(
  book: PriceBook,
  modelCandidates: Array<string | undefined>,
  tokens: CostTokens,
  serviceTier?: string,
): number | null {
  const found = findPrice(book, modelCandidates);
  if (!found) return null;
  let price = found.price;
  const behaviorModel = normalize(found.key);
  let inMul = 1;
  let outMul = 1;
  let ruleApplied = false;

  const tiers = (price.contextTiers ?? []).filter((tier) => tokens.input > tier.thresholdTokens);
  if (tiers.length > 0) {
    const highest = tiers.reduce((a, b) => (b.thresholdTokens > a.thresholdTokens ? b : a));
    price = overlay(price, highest);
    ruleApplied = true;
  }

  const legacyLong =
    !price.contextTiers?.length &&
    tokens.input > LONG_CONTEXT_THRESHOLD &&
    LEGACY_LONG_CONTEXT_MODELS.some((m) => behaviorModel.startsWith(m));
  if (legacyLong) {
    inMul = 2;
    outMul = 1.5;
  }

  const tier = normalize(serviceTier);
  const tierKey = normalizeTier(serviceTier);
  if (tier && tierKey !== 'normal' && !(legacyLong && tierKey === 'fast')) {
    const rule = (price.serviceTiers ?? []).find(
      (r) => normalize(r.mode) === tier || normalize(r.serviceTier) === tier || normalize(r.mode) === tierKey,
    );
    if (rule) {
      price = overlay(price, rule);
      ruleApplied = true;
    }
  }

  const multiplier = ruleApplied || legacyLong ? 1 : serviceTierMultiplier(behaviorModel, tier);
  return segmentCost(tokens, price, inMul * multiplier, outMul * multiplier);
}

/** Cost of a raw analytics event (price key: resolved → analytics → requested → model). */
export function estimateEventCost(book: PriceBook, event: EventRow): number | null {
  return estimateCost(
    book,
    [event.resolved_model, event.analytics_model, event.requested_model, event.model],
    {
      input: event.input_tokens ?? 0,
      output: event.output_tokens ?? 0,
      cached: event.cached_tokens ?? 0,
      cacheRead: event.cache_read_tokens ?? 0,
      cacheCreation: event.cache_creation_tokens ?? 0,
    },
    event.service_tier,
  );
}

/** Output speed for one request, matching the server: output tokens / total latency seconds. */
export function eventOutputTps(event: Pick<EventRow, 'output_tokens' | 'latency_ms'>): number | null {
  const latency = event.latency_ms ?? 0;
  return event.output_tokens > 0 && latency > 0 ? event.output_tokens / (latency / 1000) : null;
}

/** Generation-only speed: excludes time to first token (null when TTFT is missing or ≥ latency). */
export function eventGenerationTps(event: Pick<EventRow, 'output_tokens' | 'latency_ms' | 'ttft_ms'>): number | null {
  const latency = event.latency_ms ?? 0;
  const ttft = event.ttft_ms ?? 0;
  const gen = latency - ttft;
  return event.output_tokens > 0 && ttft > 0 && gen > 0 ? event.output_tokens / (gen / 1000) : null;
}
