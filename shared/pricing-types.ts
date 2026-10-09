/**
 * Model price book types shared by the browser and the server (`/api/model-prices*`). Prices are
 * USD per 1M tokens. Semantics ported from CPA Manager Plus (MIT).
 */

export interface PriceFields {
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
