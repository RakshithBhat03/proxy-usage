/**
 * Matches runtime model ids against the fetched price sources. Port of CPA Manager Plus's matcher
 * (MIT): per-source indexes (exact → case-insensitive → source-model-id → provider-prefix tail →
 * normalized tokens), sources tried in priority order (models.dev official > LiteLLM > OpenRouter),
 * a match is automatic only when it is unique within its source, and anything else gets fuzzy
 * candidates for the user to confirm.
 *
 * Additions over the original: a vendor-namespace preference by model family ("claude" →
 * anthropic, "gpt"/"o*" → openai, ...) used for models.dev entries that are not in the canonical
 * catalog and as a tie-break between otherwise ambiguous matches; ambiguous matches that all carry
 * the same price are accepted; and identity fallbacks (thinking suffix, -YYYYMMDD date, -latest)
 * are tried only when the raw id matches nothing.
 */
import { analyticsModel } from '../../shared/model-identity.ts';
import type { ModelPrice, SyncCandidate } from '../../shared/pricing-types.ts';
import { emptyMetadata, type MatchMetadata } from './sources.ts';

export const MAX_SYNC_CANDIDATES = 8;
export const MIN_CANDIDATE_SCORE = 0.55;
export const MIN_WEAK_CANDIDATE_SCORE = 0.34;

export interface SourceEntry {
  key: string;
  /** `source` and `sourceModelId` are set. */
  price: ModelPrice;
}

export interface PriceCollection {
  entries: SourceEntry[];
  metadata: MatchMetadata;
}

export function sourcePriority(source: string | undefined): number {
  switch (source) {
    case 'models.dev':
      return 0;
    case 'litellm':
      return 1;
    case 'openrouter':
      return 2;
    default:
      return 3;
  }
}

/* ---------------- identity helpers ---------------- */

const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;

export function modelTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  const flush = () => {
    if (current && current !== 'models') tokens.push(current);
    current = '';
  };
  for (const ch of value.trim().toLowerCase()) {
    if (LETTER_OR_DIGIT.test(ch)) current += ch;
    else flush();
  }
  flush();
  return tokens;
}

export function lastModelSegment(value: string): string {
  const parts = value.trim().split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i].trim();
    if (!part || part.toLowerCase() === 'models') continue;
    return part;
  }
  return value.trim();
}

export function canonicalModelId(value: string): string {
  return modelTokens(value).join('');
}

export function canonicalModelTail(value: string): string {
  return modelTokens(lastModelSegment(value)).join('');
}

function splitAlphaNumericToken(token: string): string[] {
  const parts: string[] = [];
  let current = '';
  let previous = 0;
  for (const ch of token) {
    const cls = /\p{L}/u.test(ch) ? 1 : /\p{Nd}/u.test(ch) ? 2 : 0;
    if (cls === 0) {
      if (current) parts.push(current);
      current = '';
      previous = 0;
      continue;
    }
    if (previous !== 0 && previous !== cls) {
      parts.push(current);
      current = '';
    }
    current += ch;
    previous = cls;
  }
  if (current) parts.push(current);
  return parts;
}

const TOKEN_ALIASES: Record<string, string[]> = {
  mimo: ['minimax', 'm2', 'm25'],
  minimax: ['mimo'],
  m2: ['mimo', 'minimax'],
  m25: ['mimo', 'minimax'],
  low: ['lite'],
  lite: ['low'],
  flashlow: ['flashlite', 'flash', 'lite'],
  flashlite: ['flashlow', 'flash', 'low'],
};

const LOW_SIGNAL = new Set(['latest', 'preview', 'free']);

function similarityTokens(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (token: string) => {
    const t = token.trim().toLowerCase();
    if (!t || t === 'models' || LOW_SIGNAL.has(t) || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const token of modelTokens(value)) {
    add(token);
    const splits = splitAlphaNumericToken(token);
    splits.forEach(add);
    (TOKEN_ALIASES[token] ?? []).forEach(add);
    for (const split of splits) (TOKEN_ALIASES[split] ?? []).forEach(add);
  }
  return out;
}

function sameModelFamily(left: string[], right: string[]): boolean {
  return ['qwen', 'gemini', 'minimax', 'mimo'].some((family) => left.includes(family) && right.includes(family));
}

function tokenJaccard(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const l = new Set(left);
  const r = new Set(right);
  let intersection = 0;
  for (const token of l) if (r.has(token)) intersection++;
  const union = l.size + r.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function levenshtein(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    curr[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr[j + 1] = Math.min(curr[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function editSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  const maxLen = Math.max(Array.from(left).length, Array.from(right).length);
  return maxLen === 0 ? 0 : 1 - levenshtein(left, right) / maxLen;
}

export function modelSimilarity(left: string, right: string): [number, string] {
  const leftTail = canonicalModelTail(left);
  const rightTail = canonicalModelTail(right);
  if (leftTail && rightTail) {
    if (leftTail === rightTail) return [0.94, 'same-model-with-provider-prefix'];
    if (leftTail.includes(rightTail) || rightTail.includes(leftTail)) return [0.78, 'model-name-contains'];
  }
  const leftCanonical = canonicalModelId(left);
  const rightCanonical = canonicalModelId(right);
  if (leftCanonical && rightCanonical) {
    if (leftCanonical === rightCanonical) return [0.9, 'normalized-model-name'];
    if (leftCanonical.includes(rightCanonical) || rightCanonical.includes(leftCanonical)) {
      return [0.74, 'normalized-name-contains'];
    }
  }
  const leftTokens = similarityTokens(left);
  const rightTokens = similarityTokens(right);
  const tokenScore = tokenJaccard(leftTokens, rightTokens);
  const editScore = editSimilarity(leftTail, rightTail);
  const score = Math.max(tokenScore * 0.86, editScore * 0.82);
  if (tokenScore >= 0.65) return [Math.max(score, 0.72), 'shared-model-tokens'];
  if (tokenScore >= 0.4) return [Math.max(score, 0.58), 'shared-model-tokens'];
  if (sameModelFamily(leftTokens, rightTokens)) return [Math.max(score, 0.46), 'same-model-family'];
  if (editScore >= 0.68) return [score, 'similar-model-name'];
  return [score, 'weak-similarity'];
}

export function modelIdentitySimilarity(left: string, right: string): [number, string] {
  if (left === right) return [1, 'exact-model-id'];
  if (left.toLowerCase() === right.toLowerCase()) return [0.98, 'case-insensitive-model-id'];
  return modelSimilarity(left, right);
}

/* ---------------- vendor namespaces ---------------- */

const VENDOR_FAMILIES: Array<[RegExp, string[]]> = [
  [/^claude/, ['anthropic']],
  [/^(gpt|chatgpt|codex|o\d|text-embedding|dall-e|whisper|tts-|davinci|babbage|computer-use)/, ['openai']],
  [/^(gemini|gemma|imagen|veo|learnlm)/, ['google', 'gemini']],
  [/^grok/, ['xai', 'x-ai']],
  [/^deepseek/, ['deepseek']],
  [/^(qwen|qwq)/, ['alibaba', 'qwen']],
  [/^(glm|chatglm|cogview)/, ['zai', 'zhipuai', 'z-ai']],
  [/^(kimi|moonshot)/, ['moonshotai']],
  [/^(mistral|mixtral|codestral|devstral|magistral|pixtral|ministral|voxtral)/, ['mistral', 'mistralai']],
  [/^(llama|meta-llama)/, ['meta', 'meta-llama']],
  [/^minimax/, ['minimax']],
  [/^(command|c4ai)/, ['cohere']],
  [/^(jamba)/, ['ai21']],
];

/** Vendor namespaces that publish a model family ("claude-x" → ["anthropic"]). */
export function vendorNamespaces(modelId: string): string[] {
  const tail = lastModelSegment(modelId).toLowerCase();
  for (const [pattern, vendors] of VENDOR_FAMILIES) if (pattern.test(tail)) return vendors;
  return [];
}

/** Path segments before the model name ("vercel_ai_gateway/xai/grok-4" → [vercel_ai_gateway, xai]). */
function namespacesOf(id: string | undefined): string[] {
  const parts = (id ?? '').trim().toLowerCase().split('/');
  return parts.slice(0, -1).filter(Boolean);
}

/** Same cost-relevant fields (rates, flags, tiers). */
function samePrice(a: ModelPrice, b: ModelPrice): boolean {
  const pick = (p: ModelPrice) =>
    JSON.stringify([
      p.prompt,
      p.completion,
      p.cache,
      p.cacheRead ?? 0,
      p.cacheCreation ?? 0,
      !!p.cacheReadConfigured,
      !!p.cacheCreationConfigured,
      p.contextTiers ?? [],
      p.serviceTiers ?? [],
    ]);
  return pick(a) === pick(b);
}

/* ---------------- identity variants ---------------- */

/**
 * Ids tried in order when the raw id has no automatic match: without a CPA thinking suffix,
 * without a -YYYYMMDD / -YYYY-MM-DD date, without -latest.
 */
export function identityVariants(modelId: string): string[] {
  const out: string[] = [];
  const add = (value: string) => {
    const v = value.trim();
    if (v && !out.includes(v)) out.push(v);
  };
  add(modelId);
  const base = analyticsModel(modelId.trim());
  add(base);
  const undated = base.replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  add(undated);
  add(undated.replace(/-latest$/i, ''));
  return out;
}

/* ---------------- matcher ---------------- */

interface Entry {
  key: string;
  price: ModelPrice;
  source: string;
  direct: string[];
  alias: string[];
}

export interface AutoMatch {
  price: ModelPrice;
  reason: string;
}

function push(index: Map<string, number[]>, identity: string, entryIndex: number): void {
  if (!identity) return;
  const list = index.get(identity);
  if (!list) index.set(identity, [entryIndex]);
  else if (list[list.length - 1] !== entryIndex) list.push(entryIndex);
}

function modelsDevModelId(sourceModelId: string | undefined): string {
  const id = (sourceModelId ?? '').trim();
  const slash = id.indexOf('/');
  return slash >= 0 ? id.slice(slash + 1).trim() : '';
}

export class PriceMatcher {
  readonly entries: Entry[] = [];
  readonly #exact = new Map<string, number[]>();
  readonly #caseFold = new Map<string, number[]>();
  readonly #aliasExact = new Map<string, number[]>();
  readonly #aliasFold = new Map<string, number[]>();
  readonly #tail = new Map<string, number[]>();
  readonly #canonical = new Map<string, number[]>();
  readonly #bySource = new Map<string, number[]>();
  /** models.dev entries by lower-cased "provider/model". */
  readonly #modelsDevById = new Map<string, number>();
  readonly sources: string[];
  readonly metadata: MatchMetadata;

  constructor(collection: PriceCollection) {
    this.metadata = collection.metadata;
    for (const { key, price } of collection.entries) {
      const source = (price.source ?? '').trim();
      const direct = [...new Set([key.trim(), (price.sourceModelId ?? '').trim()].filter(Boolean))];
      const alias: string[] = [];
      if (source === 'models.dev') {
        const id = modelsDevModelId(price.sourceModelId);
        if (id) alias.push(id);
      }
      const i = this.entries.length;
      this.entries.push({ key, price, source, direct, alias });
      push(this.#bySource, source, i);
      if (source === 'models.dev' && price.sourceModelId) this.#modelsDevById.set(price.sourceModelId.toLowerCase(), i);
      for (const id of direct) {
        push(this.#exact, id, i);
        push(this.#caseFold, id.toLowerCase(), i);
        push(this.#tail, canonicalModelTail(id), i);
        push(this.#canonical, canonicalModelId(id), i);
      }
      for (const id of alias) {
        push(this.#aliasExact, id, i);
        push(this.#aliasFold, id.toLowerCase(), i);
        push(this.#tail, canonicalModelTail(id), i);
        push(this.#canonical, canonicalModelId(id), i);
      }
    }
    this.sources = [...this.#bySource.keys()].sort(
      (a, b) => sourcePriority(a) - sourcePriority(b) || (a < b ? -1 : a > b ? 1 : 0),
    );
  }

  #filter(indexes: number[] | undefined, source: string): number[] {
    return (indexes ?? []).filter((i) => this.entries[i].source === source);
  }

  /** The first identity stage with matches in `source`. */
  indexedMatches(modelId: string, source: string): [number[], string] {
    const id = modelId.trim();
    if (!id) return [[], ''];
    const stages: Array<[number[] | undefined, string]> = [
      [this.#exact.get(id), 'exact'],
      [this.#caseFold.get(id.toLowerCase()), 'case-insensitive'],
      [this.#aliasExact.get(id), 'source-model-id'],
      [this.#aliasFold.get(id.toLowerCase()), 'case-insensitive-source-model-id'],
      [this.#tail.get(canonicalModelTail(id)), 'provider-prefix'],
      [this.#canonical.get(canonicalModelId(id)), 'normalized'],
    ];
    for (const [indexes, reason] of stages) {
      if (reason === 'provider-prefix' && !canonicalModelTail(id)) continue;
      if (reason === 'normalized' && !canonicalModelId(id)) continue;
      const matches = this.#filter(indexes, source);
      if (matches.length) return [matches, reason];
    }
    return [[], ''];
  }

  #directMatches(modelId: string, source: string): [number[], string] {
    const exact = this.#filter(this.#exact.get(modelId), source);
    if (exact.length) return [exact, 'exact'];
    const fold = this.#filter(this.#caseFold.get(modelId.toLowerCase()), source);
    if (fold.length) return [fold, 'case-insensitive'];
    return [[], ''];
  }

  #officialMatches(modelId: string): number[] {
    const canonical = this.metadata.canonicalByIdentity.get(modelId.trim().toLowerCase());
    if (!canonical) return [];
    const i = this.#modelsDevById.get(canonical.toLowerCase());
    return i !== undefined && this.metadata.official.has(canonical.toLowerCase()) ? [i] : [];
  }

  /** models.dev "vendor/<id>" for the model's family vendor(s), when exactly one exists. */
  #vendorMatch(modelId: string): number | undefined {
    const tail = lastModelSegment(modelId).toLowerCase();
    const found = vendorNamespaces(modelId)
      .map((vendor) => this.#modelsDevById.get(`${vendor}/${tail}`))
      .filter((i): i is number => i !== undefined);
    return found.length === 1 ? found[0] : undefined;
  }

  /**
   * Resolves ambiguous matches within one source: narrow to the family vendor's namespace, then
   * accept the remaining matches when they all carry the same price (the cost is unambiguous).
   */
  #resolveAmbiguous(modelId: string, matches: number[]): [number, string] | undefined {
    let pool = matches;
    const vendors = vendorNamespaces(modelId);
    if (vendors.length) {
      const preferred = matches.filter((i) => {
        const e = this.entries[i];
        return [...namespacesOf(e.price.sourceModelId), ...namespacesOf(e.key)].some((ns) => vendors.includes(ns));
      });
      if (preferred.length === 1) return [preferred[0], 'vendor'];
      if (preferred.length > 1) pool = preferred;
    }
    const first = this.entries[pool[0]].price;
    if (pool.every((i) => samePrice(this.entries[i].price, first))) return [pool[0], 'consensus'];
    return undefined;
  }

  #automaticForId(modelId: string): AutoMatch | null {
    const id = modelId.trim();
    if (!id) return null;
    for (const source of this.sources) {
      if (source === 'models.dev') {
        if (this.metadata.canonicalByIdentity.size > 0) {
          const official = this.#officialMatches(id);
          if (official.length === 1) return { price: this.entries[official[0]].price, reason: 'models.dev-official' };
        }
        const vendor = this.#vendorMatch(id);
        if (vendor !== undefined) return { price: this.entries[vendor].price, reason: 'models.dev-vendor' };
        if (this.metadata.canonicalByIdentity.size > 0) {
          // Non-official models.dev entries (resellers) only match a fully qualified id.
          if (id.includes('/')) {
            const [direct, reason] = this.#directMatches(id, source);
            if (direct.length === 1) return { price: this.entries[direct[0]].price, reason };
          }
          continue;
        }
      }
      const [matches, reason] = this.indexedMatches(id, source);
      if (matches.length === 1) return { price: this.entries[matches[0]].price, reason };
      if (matches.length > 1) {
        const resolved = this.#resolveAmbiguous(id, matches);
        if (resolved) return { price: this.entries[resolved[0]].price, reason: `${reason}-${resolved[1]}` };
      }
    }
    return null;
  }

  /** The unambiguous price for a model, trying identity fallbacks only when the raw id fails. */
  findAutomatic(modelId: string): AutoMatch | null {
    const variants = identityVariants(modelId);
    for (let v = 0; v < variants.length; v++) {
      const match = this.#automaticForId(variants[v]);
      if (match) return v === 0 ? match : { ...match, reason: `${match.reason}-normalized` };
    }
    return null;
  }

  #candidate(modelId: string, entry: Entry): SyncCandidate | null {
    let score = 0;
    let reason = '';
    for (const id of entry.direct) {
      const [s, r] = modelIdentitySimilarity(modelId, id);
      if (s > score) [score, reason] = [s, r];
    }
    for (const id of entry.alias) {
      const s = Math.min(modelIdentitySimilarity(modelId, id)[0], 0.94);
      if (s > score) [score, reason] = [s, 'same-model-with-provider-prefix'];
    }
    if (score < MIN_CANDIDATE_SCORE && !(score >= MIN_WEAK_CANDIDATE_SCORE && reason === 'same-model-family')) return null;
    return {
      sourceModelId: (entry.price.sourceModelId ?? '').trim() || entry.key,
      score: Math.round(score * 100) / 100,
      reason,
      price: entry.price,
    };
  }

  #isOfficial(c: SyncCandidate): boolean {
    return c.price.source === 'models.dev' && this.metadata.official.has(c.sourceModelId.toLowerCase());
  }

  /** Up to 8 fuzzy candidates per source for a model without an automatic match. */
  findCandidates(modelId: string): SyncCandidate[] {
    const out: SyncCandidate[] = [];
    for (const source of this.sources) {
      let [indexes] = this.indexedMatches(modelId, source);
      if (!indexes.length) indexes = this.#bySource.get(source) ?? [];
      const list: SyncCandidate[] = [];
      for (const i of indexes) {
        const c = this.#candidate(modelId, this.entries[i]);
        if (c) list.push(c);
      }
      list.sort((a, b) => {
        const ao = this.#isOfficial(a);
        const bo = this.#isOfficial(b);
        if (ao !== bo) return ao ? -1 : 1;
        if (a.score === b.score) return a.sourceModelId < b.sourceModelId ? -1 : a.sourceModelId > b.sourceModelId ? 1 : 0;
        return b.score - a.score;
      });
      out.push(...list.slice(0, MAX_SYNC_CANDIDATES));
    }
    return out;
  }
}

/* ---------------- selection ---------------- */

export interface Selection {
  prices: Record<string, ModelPrice>;
  matched: Record<string, ModelPrice>;
  candidates: Array<{ model: string; candidates: SyncCandidate[] }>;
  unmatched: string[];
}

/** Trimmed, de-duplicated, order-preserving. */
export function normalizeRequestedModels(models: Iterable<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Picks a price for each requested model. Unambiguous matches go into `prices`; the rest get
 * fuzzy `candidates` (when `withCandidates`) or land in `unmatched`.
 */
export function selectPrices(collection: PriceCollection, models: string[], withCandidates: boolean): Selection {
  const matcher = new PriceMatcher(collection);
  const result: Selection = { prices: {}, matched: {}, candidates: [], unmatched: [] };
  for (const model of normalizeRequestedModels(models)) {
    const match = matcher.findAutomatic(model);
    if (match) {
      result.prices[model] = match.price;
      result.matched[model] = match.price;
      continue;
    }
    const candidates = withCandidates ? matcher.findCandidates(model) : [];
    if (candidates.length) result.candidates.push({ model, candidates });
    else result.unmatched.push(model);
  }
  return result;
}

/**
 * When a preferred source failed, keep existing prices from that source instead of downgrading
 * them to a lower-priority source. A successful source that simply omits a model still allows the
 * normal fallback. Returns the preserved model ids.
 */
export function preserveFailedSourcePrices(
  selection: Selection,
  existing: Record<string, ModelPrice>,
  failedSources: ReadonlySet<string>,
  requestedModels: string[],
): string[] {
  if (failedSources.size === 0) return [];
  const scope = requestedModels.length ? new Set(requestedModels.map((m) => m.trim())) : null;
  const preserved: string[] = [];
  for (const [model, price] of Object.entries(existing)) {
    if (scope && !scope.has(model)) continue;
    if (!failedSources.has(price.source ?? '')) continue;
    const candidate = selection.prices[model];
    if (candidate && sourcePriority(price.source) >= sourcePriority(candidate.source)) continue;
    if (candidate) {
      delete selection.prices[model];
      delete selection.matched[model];
    }
    preserved.push(model);
  }
  return preserved.sort();
}

export function collectionFrom(
  sources: Array<{ source: string; prices: Record<string, ModelPrice>; metadata?: MatchMetadata }>,
): PriceCollection {
  const collection: PriceCollection = { entries: [], metadata: emptyMetadata() };
  for (const { source, prices, metadata } of sources) {
    if (metadata) {
      for (const [identity, id] of metadata.canonicalByIdentity) {
        const existing = collection.metadata.canonicalByIdentity.get(identity);
        if (existing !== undefined && existing.toLowerCase() !== id.toLowerCase()) {
          collection.metadata.canonicalByIdentity.delete(identity);
        } else {
          collection.metadata.canonicalByIdentity.set(identity, id);
        }
      }
      for (const id of metadata.official) collection.metadata.official.add(id);
    }
    for (const key of Object.keys(prices).sort()) {
      const price = prices[key];
      collection.entries.push({
        key,
        price: { ...price, source: price.source || source, sourceModelId: price.sourceModelId || key },
      });
    }
  }
  return collection;
}
