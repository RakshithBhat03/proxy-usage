import type { EventRow } from '@/lib/api/analytics';
import { estimateEventCost, findPrice, type PriceBook } from '@/lib/pricing';
import { cacheReadTokens, freshInputTokens } from './events';

export interface TokenComponent {
  id: 'fresh' | 'cacheRead' | 'cacheWrite' | 'output' | 'reasoning';
  label: string;
  tokens: number;
  cost: number | null;
  /** Reasoning is billed inside output; shown for visibility only. */
  included?: boolean;
}

/**
 * Per-component cost for the detail sheet. Components are priced at base rates, then scaled so they
 * sum to `estimateEventCost` (which also applies context tiers, service tiers and long-context
 * premiums), keeping the breakdown consistent with the row's total.
 */
export function costBreakdown(book: PriceBook | undefined, event: EventRow): { total: number | null; parts: TokenComponent[] } {
  const fresh = freshInputTokens(event);
  const read = cacheReadTokens(event);
  const write = Math.max(event.cache_creation_tokens ?? 0, 0);
  const output = Math.max(event.output_tokens ?? 0, 0);
  const reasoning = Math.max(event.reasoning_tokens ?? 0, 0);

  const found = book
    ? findPrice(book, [event.resolved_model, event.analytics_model, event.requested_model, event.model])
    : null;
  const total = book ? estimateEventCost(book, event) : null;

  let raw: Record<'fresh' | 'cacheRead' | 'cacheWrite' | 'output', number> | null = null;
  if (found) {
    const p = found.price;
    const readPrice = p.cacheReadConfigured || (p.cacheRead ?? 0) > 0 ? (p.cacheRead ?? 0) : p.cache > 0 ? p.cache : p.prompt * 0.1;
    const writePrice = p.cacheCreationConfigured || (p.cacheCreation ?? 0) > 0 ? (p.cacheCreation ?? 0) : p.prompt;
    raw = {
      fresh: (fresh * p.prompt) / 1e6,
      cacheRead: ((event.cached_tokens ?? 0) * p.cache + (event.cache_read_tokens ?? 0) * readPrice) / 1e6,
      cacheWrite: (write * writePrice) / 1e6,
      output: (output * p.completion) / 1e6,
    };
  }
  const rawSum = raw ? raw.fresh + raw.cacheRead + raw.cacheWrite + raw.output : 0;
  const scale = raw && total !== null && rawSum > 0 ? total / rawSum : 1;
  const priced = (value: number | undefined) => (raw && value !== undefined ? value * scale : null);

  return {
    total,
    parts: [
      { id: 'fresh', label: 'Fresh input', tokens: fresh, cost: priced(raw?.fresh) },
      { id: 'cacheRead', label: 'Cache read', tokens: read, cost: priced(raw?.cacheRead) },
      { id: 'cacheWrite', label: 'Cache write', tokens: write, cost: priced(raw?.cacheWrite) },
      { id: 'output', label: 'Output', tokens: output, cost: priced(raw?.output) },
      { id: 'reasoning', label: 'Reasoning', tokens: reasoning, cost: null, included: true },
    ],
  };
}
