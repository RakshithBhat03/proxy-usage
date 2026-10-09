/**
 * Model price book API + client-side helpers for raw events.
 *
 * Aggregated analytics (summary, timeline, stats) already carry server-computed cost. Raw `EventRow`s
 * do not, so anything aggregated in the browser (sub-hour buckets, the live request table) prices
 * events with the shared cost math in `shared/cost.ts` (re-exported here). Prices are USD per 1M tokens.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api/client';
import type { EventRow } from './api/analytics';
import type { PriceBook, SyncResult } from '@shared/pricing-types.ts';

export type {
  ContextTier,
  ModelPrice,
  PriceBook,
  PriceFields,
  ServiceTierRule,
  SyncCandidate,
  SyncResult,
} from '@shared/pricing-types.ts';
export { estimateCost, estimateEventCost, findPrice, type CostEvent, type CostTokens } from '@shared/cost.ts';

/* ---------------- API ---------------- */

export const MODEL_PRICES_QUERY_KEY = ['model-prices'] as const;

export async function fetchModelPrices(signal?: AbortSignal): Promise<PriceBook> {
  const data = await api<{ prices?: PriceBook }>('/api/model-prices', { signal });
  return data.prices ?? {};
}

/** Replaces the whole price book (there are no per-model endpoints). */
export async function saveModelPrices(prices: PriceBook): Promise<PriceBook> {
  const data = await api<{ prices?: PriceBook }>('/api/model-prices', { method: 'PUT', body: { prices } });
  return data.prices ?? {};
}

/** Pulls prices from models.dev → LiteLLM → OpenRouter. Manual entries are never overwritten. */
export function syncModelPrices(models: string[], includeRuntimeModels = true): Promise<SyncResult> {
  return api<SyncResult>('/api/model-prices/sync', {
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
