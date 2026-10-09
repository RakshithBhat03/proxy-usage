/**
 * Remote price sources and their decoders. models.dev publishes USD per 1M tokens; LiteLLM and
 * OpenRouter publish USD per token (scaled here). All three are fetched in parallel with a timeout;
 * a source that fails is reported per source and never aborts the others. Semantics ported from
 * CPA Manager Plus (MIT).
 */
import type { ContextTier, ModelPrice, ServiceTierRule } from '../../shared/pricing-types.ts';
import { normalizeContextTiers, normalizeServiceTiers } from './store.ts';

export type SourceName = 'models.dev' | 'litellm' | 'openrouter';

export const SOURCE_URLS: Record<SourceName, string> = {
  'models.dev': 'https://models.dev/catalog.json',
  litellm: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  openrouter: 'https://openrouter.ai/api/v1/models',
};

/** Fetch order = priority order (models.dev official > LiteLLM > OpenRouter). */
export const SOURCE_ORDER: readonly SourceName[] = ['models.dev', 'litellm', 'openrouter'];

export const SOURCE_TIMEOUT_MS = 20_000;

/** models.dev identity metadata from the catalog's canonical `models` root. */
export interface MatchMetadata {
  /** lower-cased canonical id or unambiguous tail → canonical id ("gpt-5" → "openai/gpt-5"). */
  canonicalByIdentity: Map<string, string>;
  /** lower-cased provider-scoped ids that equal their canonical id ("openai/gpt-5"). */
  official: Set<string>;
}

export function emptyMetadata(): MatchMetadata {
  return { canonicalByIdentity: new Map(), official: new Set() };
}

export interface DecodedSource {
  prices: Record<string, ModelPrice>;
  skipped: number;
  metadata?: MatchMetadata;
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Number or numeric string; negative values (e.g. OpenRouter's "-1" = variable) count as absent. */
function readFloat(entry: Obj, key: string): number | undefined {
  const value = entry[key];
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value.trim());
  else return undefined;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function readFirstFloat(entry: Obj, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = readFloat(entry, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Per-token → per-1M, rounded to 12 significant digits to drop float noise (3e-6 × 1e6 = 3). */
function perMillion(value: number | undefined): number {
  return value === undefined ? 0 : Number((value * 1_000_000).toPrecision(12));
}

interface Rates {
  prompt?: number;
  completion?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

function hasAny(r: Rates): boolean {
  return r.prompt !== undefined || r.completion !== undefined || r.cacheRead !== undefined || r.cacheCreation !== undefined;
}

/** Rates already in per-1M units → price fields (cache mirrors cache read, as CPA Manager Plus). */
function priceFields(r: Rates) {
  return {
    prompt: r.prompt ?? 0,
    completion: r.completion ?? 0,
    cache: r.cacheRead ?? 0,
    cacheRead: r.cacheRead ?? 0,
    cacheCreation: r.cacheCreation ?? 0,
    promptConfigured: r.prompt !== undefined,
    completionConfigured: r.completion !== undefined,
    cacheReadConfigured: r.cacheRead !== undefined,
    cacheCreationConfigured: r.cacheCreation !== undefined,
  };
}

function compact<T extends object>(value: T): T {
  const out = { ...value } as Record<string, unknown>;
  for (const [key, v] of Object.entries(out)) if (v === false || v === undefined) delete out[key];
  return out as T;
}

/* ---------------- models.dev ---------------- */

function modelsDevRates(cost: Obj): Rates {
  return {
    prompt: readFloat(cost, 'input'),
    completion: readFloat(cost, 'output'),
    cacheRead: readFloat(cost, 'cache_read'),
    cacheCreation: readFloat(cost, 'cache_write'),
  };
}

function readModelsDevContextTiers(cost: Obj): ContextTier[] | undefined {
  const raw = cost.tiers;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tiers: ContextTier[] = [];
  for (const item of raw) {
    if (!isObj(item) || !isObj(item.tier)) continue;
    const type = typeof item.tier.type === 'string' ? item.tier.type.trim().toLowerCase() : '';
    if (type !== 'context') continue;
    const size = Number(item.tier.size);
    if (!Number.isInteger(size) || size <= 0) return undefined;
    const rates = modelsDevRates(item);
    if (!hasAny(rates)) return undefined;
    const f = priceFields(rates);
    tiers.push(compact({ thresholdTokens: size, ...f, cacheConfigured: f.cacheReadConfigured }));
  }
  try {
    return normalizeContextTiers(tiers);
  } catch {
    return undefined;
  }
}

/**
 * models.dev `experimental.modes` → service-tier rules. `fast` maps to the provider tier in the
 * mode's request body (default "priority", what Codex sends); `flex` likewise (default "flex").
 */
function readModelsDevServiceTiers(entry: Obj): ServiceTierRule[] | undefined {
  const modes = isObj(entry.experimental) && isObj(entry.experimental.modes) ? entry.experimental.modes : null;
  if (!modes) return undefined;
  const rules: ServiceTierRule[] = [];
  for (const [mode, fallbackTier] of [
    ['fast', 'priority'],
    ['flex', 'flex'],
  ] as const) {
    const spec = modes[mode];
    if (!isObj(spec) || !isObj(spec.cost)) continue;
    const rates = modelsDevRates(spec.cost);
    if (!hasAny(rates)) continue;
    const body = isObj(spec.provider) && isObj(spec.provider.body) ? spec.provider.body : {};
    const tier = typeof body.service_tier === 'string' && body.service_tier.trim() ? body.service_tier : fallbackTier;
    const f = priceFields(rates);
    rules.push(compact({ mode, serviceTier: tier, ...f, cacheConfigured: f.cacheReadConfigured }));
  }
  try {
    return normalizeServiceTiers(rules);
  } catch {
    return undefined;
  }
}

/** Builds canonical metadata from the catalog's `models` root (ids like "openai/gpt-5"). */
export function modelsDevMetadata(canonicalIds: Iterable<string>): MatchMetadata {
  const metadata = emptyMetadata();
  const tails = new Map<string, string>();
  for (const raw of canonicalIds) {
    const id = raw.trim();
    if (!id) continue;
    metadata.canonicalByIdentity.set(id.toLowerCase(), id);
    const slash = id.indexOf('/');
    const tail = slash >= 0 ? id.slice(slash + 1).trim() : '';
    if (!tail) continue;
    const key = tail.toLowerCase();
    const existing = tails.get(key);
    tails.set(key, existing !== undefined && existing.toLowerCase() !== id.toLowerCase() ? '' : id);
  }
  for (const [tail, id] of tails) if (id) metadata.canonicalByIdentity.set(tail, id);
  return metadata;
}

/**
 * Decodes either models.dev root: `catalog.json` (`{ models: {canonical}, providers: {id: {models}} }`)
 * or `api.json` (`{ [providerId]: { models } }`, no canonical metadata). Keys are "provider/model".
 */
export function decodeModelsDev(root: unknown, nowMs = Date.now()): DecodedSource {
  if (!isObj(root)) throw new Error('models.dev response is not an object');
  let providers: Obj = root;
  let metadata = emptyMetadata();
  if ('providers' in root) {
    if (!isObj(root.providers)) throw new Error('models.dev catalog providers is not an object');
    if (!isObj(root.models) || Object.keys(root.models).length === 0) {
      throw new Error('models.dev catalog contained no canonical models');
    }
    providers = root.providers;
    metadata = modelsDevMetadata(Object.keys(root.models));
  }
  const prices: Record<string, ModelPrice> = {};
  let skipped = 0;
  for (const providerId of Object.keys(providers).sort()) {
    const provider = providers[providerId];
    if (!isObj(provider) || !isObj(provider.models)) continue;
    const pid = providerId.trim();
    for (const rawModelId of Object.keys(provider.models).sort()) {
      const entry = provider.models[rawModelId];
      const modelId = rawModelId.trim();
      if (!pid || !modelId || !isObj(entry) || !isObj(entry.cost)) {
        skipped++;
        continue;
      }
      const rates = modelsDevRates(entry.cost);
      if (!hasAny(rates)) {
        skipped++;
        continue;
      }
      const sourceModelId = `${pid}/${modelId}`;
      const price: ModelPrice = compact({
        ...priceFields(rates),
        source: 'models.dev',
        sourceModelId,
        rawJson: JSON.stringify(entry),
        contextTiers: readModelsDevContextTiers(entry.cost),
        serviceTiers: readModelsDevServiceTiers(entry),
        updatedAtMs: nowMs,
        syncedAtMs: nowMs,
      });
      prices[sourceModelId] = price;
      const canonical = metadata.canonicalByIdentity.get(sourceModelId.toLowerCase());
      if (canonical && canonical.toLowerCase() === sourceModelId.toLowerCase()) {
        metadata.official.add(sourceModelId.toLowerCase());
      }
    }
  }
  if (Object.keys(prices).length === 0) throw new Error('models.dev catalog contained no usable prices');
  return { prices, skipped, metadata };
}

/* ---------------- LiteLLM ---------------- */

export function decodeLiteLLM(root: unknown, nowMs = Date.now()): DecodedSource {
  if (!isObj(root)) throw new Error('LiteLLM response is not an object');
  const prices: Record<string, ModelPrice> = {};
  let skipped = 0;
  for (const [modelId, entry] of Object.entries(root)) {
    if (modelId === 'sample_spec' || !modelId.trim() || !isObj(entry)) {
      skipped++;
      continue;
    }
    const raw: Rates = {
      prompt: readFloat(entry, 'input_cost_per_token'),
      completion: readFloat(entry, 'output_cost_per_token'),
      cacheRead: readFirstFloat(entry, 'cache_read_input_token_cost', 'input_cache_read'),
      cacheCreation: readFirstFloat(
        entry,
        'cache_creation_input_token_cost',
        'cache_write_input_token_cost',
        'input_cache_write',
        'input_cache_creation',
      ),
    };
    if (!hasAny(raw)) {
      skipped++;
      continue;
    }
    prices[modelId] = perTokenPrice(raw, 'litellm', modelId, entry, nowMs);
  }
  return { prices, skipped };
}

function perTokenPrice(raw: Rates, source: SourceName, modelId: string, entry: Obj, nowMs: number): ModelPrice {
  const f = priceFields(raw);
  return compact({
    ...f,
    prompt: perMillion(raw.prompt),
    completion: perMillion(raw.completion),
    cache: perMillion(raw.cacheRead),
    cacheRead: perMillion(raw.cacheRead),
    cacheCreation: perMillion(raw.cacheCreation),
    source,
    sourceModelId: modelId,
    rawJson: JSON.stringify(entry),
    updatedAtMs: nowMs,
    syncedAtMs: nowMs,
  });
}

/* ---------------- OpenRouter ---------------- */

export function decodeOpenRouter(root: unknown, nowMs = Date.now()): DecodedSource {
  if (!isObj(root) || !Array.isArray(root.data)) throw new Error('OpenRouter response has no data array');
  const prices: Record<string, ModelPrice> = {};
  let skipped = 0;
  for (const entry of root.data) {
    const modelId = isObj(entry) && typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!modelId || !isObj(entry) || !isObj(entry.pricing)) {
      skipped++;
      continue;
    }
    const pricing = entry.pricing;
    const raw: Rates = {
      prompt: readFloat(pricing, 'prompt'),
      completion: readFloat(pricing, 'completion'),
      cacheRead: readFirstFloat(pricing, 'input_cache_read', 'cache_read_input_token_cost'),
      cacheCreation: readFirstFloat(
        pricing,
        'input_cache_write',
        'input_cache_creation',
        'cache_creation_input_token_cost',
        'cache_write_input_token_cost',
      ),
    };
    if (!hasAny(raw)) {
      skipped++;
      continue;
    }
    prices[modelId] = perTokenPrice(raw, 'openrouter', modelId, entry, nowMs);
  }
  return { prices, skipped };
}

export const DECODERS: Record<SourceName, (root: unknown, nowMs?: number) => DecodedSource> = {
  'models.dev': decodeModelsDev,
  litellm: decodeLiteLLM,
  openrouter: decodeOpenRouter,
};

/* ---------------- fetching ---------------- */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SourceOutcome {
  source: SourceName;
  decoded?: DecodedSource;
  error?: string;
}

/** Per-URL ETag cache so an unchanged source is not downloaded and decoded again. */
export class SourceCache {
  readonly #entries = new Map<string, { etag: string; decoded: DecodedSource }>();

  get(url: string) {
    return this.#entries.get(url);
  }

  set(url: string, etag: string, decoded: DecodedSource): void {
    this.#entries.set(url, { etag, decoded });
  }
}

async function fetchOne(
  source: SourceName,
  url: string,
  fetchImpl: FetchLike,
  cache: SourceCache | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<DecodedSource> {
  // A ref'd timer (AbortSignal.timeout is unref'd and would let a test process exit mid-fetch).
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('timeout')), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const cached = cache?.get(url);
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'cpa-usage-price-sync' };
  if (cached) headers['If-None-Match'] = cached.etag;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: combined, redirect: 'follow' });
    if (res.status === 304 && cached) {
      await res.body?.cancel();
      return cached.decoded;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    }
    const json = (await res.json()) as unknown;
    const decoded = DECODERS[source](json);
    const etag = res.headers.get('etag')?.trim();
    if (cache && etag) cache.set(url, etag, decoded);
    return decoded;
  } catch (err) {
    if (timeout.signal.aborted) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches every source in parallel. Never rejects; failures are returned per source. */
export async function fetchSources(options: {
  fetchImpl?: FetchLike;
  urls?: Partial<Record<SourceName, string>>;
  cache?: SourceCache;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<SourceOutcome[]> {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? SOURCE_TIMEOUT_MS;
  return Promise.all(
    SOURCE_ORDER.map(async (source): Promise<SourceOutcome> => {
      const url = (options.urls?.[source] ?? SOURCE_URLS[source]).trim();
      if (!url) return { source, error: 'missing source URL' };
      try {
        return { source, decoded: await fetchOne(source, url, fetchImpl, options.cache, timeoutMs, options.signal) };
      } catch (err) {
        return { source, error: `model price sync failed: ${(err as Error).message || String(err)}` };
      }
    }),
  );
}
