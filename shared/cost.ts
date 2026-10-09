/**
 * Per-request USD cost from a model price book. Used by the server to price events at insert time
 * and by the browser for anything it aggregates from raw events. Semantics ported from CPA Manager
 * Plus (MIT). Prices are USD per 1M tokens.
 */
import type { EventRow } from './analytics-types.ts';
import { normalizeKey, normalizeServiceTier, stripParenSuffix } from './model-identity.ts';
import type { ModelPrice, PriceBook, PriceFields } from './pricing-types.ts';

const LONG_CONTEXT_THRESHOLD = 272_000;
const LEGACY_LONG_CONTEXT_MODELS = ['gpt-5.4', 'gpt-5.4-pro', 'gpt-5.5', 'gpt-5.6'];

export function findPrice(book: PriceBook, candidates: Array<string | null | undefined>): { key: string; price: ModelPrice } | null {
  const keys = Object.keys(book);
  for (const raw of candidates) {
    if (!raw) continue;
    const candidate = stripParenSuffix(raw);
    if (Object.hasOwn(book, candidate)) return { key: candidate, price: book[candidate] };
    const lower = normalizeKey(candidate);
    const match = keys.find((key) => normalizeKey(key) === lower);
    if (match) return { key: match, price: book[match] };
    // Provider-prefixed ids ("anthropic/claude-x") vs bare ids.
    const bare = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower;
    const prefixed = keys.find((key) => {
      const k = normalizeKey(key);
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

function serviceTierMultiplier(model: string, tier: string): number {
  const t = normalizeKey(tier);
  if (t === 'flex' || t === 'batch') return 0.5;
  if (t === 'priority' || t === 'fast') {
    const m = normalizeKey(model);
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
  modelCandidates: Array<string | null | undefined>,
  tokens: CostTokens,
  serviceTier?: string | null,
): number | null {
  const found = findPrice(book, modelCandidates);
  if (!found) return null;
  let price = found.price;
  const behaviorModel = normalizeKey(found.key);
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

  const tier = normalizeKey(serviceTier);
  const tierKey = normalizeServiceTier(serviceTier);
  if (tier && tierKey !== 'normal' && !(legacyLong && tierKey === 'fast')) {
    const rule = (price.serviceTiers ?? []).find(
      (r) => normalizeKey(r.mode) === tier || normalizeKey(r.serviceTier) === tier || normalizeKey(r.mode) === tierKey,
    );
    if (rule) {
      price = overlay(price, rule);
      ruleApplied = true;
    }
  }

  const multiplier = ruleApplied || legacyLong ? 1 : serviceTierMultiplier(behaviorModel, tier);
  return segmentCost(tokens, price, inMul * multiplier, outMul * multiplier);
}

/** The event fields `estimateEventCost` reads. Server rows and browser `EventRow`s both fit. */
export type CostEvent = Pick<
  EventRow,
  | 'model'
  | 'resolved_model'
  | 'analytics_model'
  | 'requested_model'
  | 'input_tokens'
  | 'output_tokens'
  | 'cached_tokens'
  | 'cache_read_tokens'
  | 'cache_creation_tokens'
  | 'service_tier'
>;

/** Cost of a raw analytics event (price key: resolved → analytics → requested → model). */
export function estimateEventCost(book: PriceBook, event: CostEvent): number | null {
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
