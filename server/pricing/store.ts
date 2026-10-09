/**
 * Price book persistence (`model_prices` + `meta`) and validation. Rows mirror CPA Manager Plus's
 * table where they overlap; context / service tiers are stored inline as JSON. Entries whose source
 * is `manual` are never overwritten by a sync. Semantics ported from CPA Manager Plus (MIT).
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { ContextTier, ModelPrice, PriceBook, PriceFields, ServiceTierRule } from '../../shared/pricing-types.ts';

export const META_REVISION = 'price_revision';
export const META_BOOK_HASH = 'price_book_hash';
export const META_LAST_SYNC = 'last_price_sync_ms';
export const META_LAST_SYNC_ERROR = 'last_price_sync_error';

export class PriceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceValidationError';
  }
}

export function isManual(price: Pick<ModelPrice, 'source'> | undefined): boolean {
  return (price?.source ?? '').trim().toLowerCase() === 'manual';
}

/* ---------------- validation ---------------- */

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

function rate(obj: Obj, key: string, where: string): number | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new PriceValidationError(`${where}: ${key} must be a non-negative number`);
  }
  return value;
}

function flag(obj: Obj, key: string): boolean {
  return obj[key] === true;
}

function text(obj: Obj, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new PriceValidationError(`${key} must be a string`);
  return value.trim() || undefined;
}

function ms(obj: Obj, key: string): number | undefined {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

function fields(obj: Obj, where: string): PriceFields {
  const out: PriceFields = {
    prompt: rate(obj, 'prompt', where) ?? 0,
    completion: rate(obj, 'completion', where) ?? 0,
    cache: rate(obj, 'cache', where) ?? 0,
  };
  const cacheRead = rate(obj, 'cacheRead', where);
  const cacheCreation = rate(obj, 'cacheCreation', where);
  if (cacheRead !== undefined) out.cacheRead = cacheRead;
  if (cacheCreation !== undefined) out.cacheCreation = cacheCreation;
  for (const key of [
    'promptConfigured',
    'completionConfigured',
    'cacheConfigured',
    'cacheReadConfigured',
    'cacheCreationConfigured',
  ] as const) {
    if (flag(obj, key)) out[key] = true;
  }
  return out;
}

function anyConfigured(f: PriceFields): boolean {
  return !!(f.promptConfigured || f.completionConfigured || f.cacheConfigured || f.cacheReadConfigured || f.cacheCreationConfigured);
}

/** Validates and sorts context tiers (strictly positive, unique thresholds; each sets some price). */
export function normalizeContextTiers(value: unknown, where = 'context tier'): ContextTier[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new PriceValidationError(`${where}s must be an array`);
  if (value.length === 0) return undefined;
  const tiers = value.map((raw) => {
    if (!isObj(raw)) throw new PriceValidationError(`${where} must be an object`);
    const threshold = raw.thresholdTokens;
    if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold <= 0) {
      throw new PriceValidationError(`${where} threshold must be a positive integer`);
    }
    const tier: ContextTier = { thresholdTokens: threshold, ...fields(raw, `${where} ${threshold}`) };
    if (!anyConfigured(tier)) throw new PriceValidationError(`${where} at threshold ${threshold} has no configured prices`);
    return tier;
  });
  tiers.sort((a, b) => a.thresholdTokens - b.thresholdTokens);
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].thresholdTokens === tiers[i - 1].thresholdTokens) {
      throw new PriceValidationError(`duplicate ${where} threshold: ${tiers[i].thresholdTokens}`);
    }
  }
  return tiers;
}

/** Validates service-tier rules: lower-cased mode + tier, no identifier shared by two rules. */
export function normalizeServiceTiers(value: unknown, where = 'service tier'): ServiceTierRule[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new PriceValidationError(`${where}s must be an array`);
  if (value.length === 0) return undefined;
  const claimed = new Map<string, number>();
  const rules = value.map((raw, index) => {
    if (!isObj(raw)) throw new PriceValidationError(`${where} must be an object`);
    const mode = typeof raw.mode === 'string' ? raw.mode.trim().toLowerCase() : '';
    const serviceTier = typeof raw.serviceTier === 'string' ? raw.serviceTier.trim().toLowerCase() : '';
    if (!mode || !serviceTier) throw new PriceValidationError(`${where} mode and serviceTier are required`);
    const rule: ServiceTierRule = { mode, serviceTier, ...fields(raw, `${where} ${mode}/${serviceTier}`) };
    if (!anyConfigured(rule)) throw new PriceValidationError(`${where} ${mode}/${serviceTier} has no configured prices`);
    for (const id of [mode, serviceTier]) {
      const owner = claimed.get(id);
      if (owner !== undefined && owner !== index) throw new PriceValidationError(`duplicate ${where} identifier: ${id}`);
      claimed.set(id, index);
    }
    return rule;
  });
  rules.sort((a, b) => a.mode.localeCompare(b.mode) || a.serviceTier.localeCompare(b.serviceTier));
  return rules;
}

/** Validates one price and returns a clean copy (unknown fields dropped). */
export function normalizePrice(model: string, value: unknown, nowMs: number): ModelPrice {
  if (!isObj(value)) throw new PriceValidationError(`price for ${model} must be an object`);
  const price: ModelPrice = { ...fields(value, `price for ${model}`) };
  const source = text(value, 'source');
  const sourceModelId = text(value, 'sourceModelId');
  const rawJson = typeof value.rawJson === 'string' && value.rawJson ? value.rawJson : undefined;
  if (source) price.source = source;
  if (sourceModelId) price.sourceModelId = sourceModelId;
  if (rawJson) price.rawJson = rawJson;
  try {
    const contextTiers = normalizeContextTiers(value.contextTiers);
    const serviceTiers = normalizeServiceTiers(value.serviceTiers);
    if (contextTiers) price.contextTiers = contextTiers;
    if (serviceTiers) price.serviceTiers = serviceTiers;
  } catch (err) {
    throw new PriceValidationError(`price for ${model}: ${(err as Error).message}`);
  }
  price.updatedAtMs = ms(value, 'updatedAtMs') ?? nowMs;
  const synced = ms(value, 'syncedAtMs');
  if (synced) price.syncedAtMs = synced;
  return price;
}

/** Validates a whole `{ [model]: price }` book. Keys are trimmed; empty keys are rejected. */
export function normalizeBook(value: unknown, nowMs: number): PriceBook {
  if (!isObj(value)) throw new PriceValidationError('prices must be an object keyed by model id');
  const book: PriceBook = {};
  for (const [rawKey, raw] of Object.entries(value)) {
    const model = rawKey.trim();
    if (!model) throw new PriceValidationError('model id must not be empty');
    if (Object.hasOwn(book, model)) throw new PriceValidationError(`duplicate model id: ${model}`);
    book[model] = normalizePrice(model, raw, nowMs);
  }
  return book;
}

/**
 * Fingerprint of everything that affects cost (not timestamps, provenance or raw JSON). A book
 * change bumps the pricing revision only when this changes.
 */
export function bookFingerprint(book: PriceBook): string {
  const hash = createHash('sha256');
  for (const model of Object.keys(book).sort()) {
    const p = book[model];
    const pick = (f: PriceFields) => [
      f.prompt,
      f.completion,
      f.cache,
      f.cacheRead ?? 0,
      f.cacheCreation ?? 0,
      !!f.promptConfigured,
      !!f.completionConfigured,
      !!f.cacheConfigured,
      !!f.cacheReadConfigured,
      !!f.cacheCreationConfigured,
    ];
    hash.update(
      JSON.stringify([
        model,
        pick(p),
        (p.contextTiers ?? []).map((t) => [t.thresholdTokens, pick(t)]),
        (p.serviceTiers ?? []).map((t) => [t.mode, t.serviceTier, pick(t)]),
      ]),
    );
    hash.update('\n');
  }
  return hash.digest('hex');
}

/* ---------------- rows ---------------- */

interface PriceRow {
  model: string;
  prompt_per_1m: number;
  completion_per_1m: number;
  cache_per_1m: number;
  cache_read_per_1m: number;
  cache_creation_per_1m: number;
  prompt_configured: number;
  completion_configured: number;
  cache_configured: number;
  cache_read_configured: number;
  cache_creation_configured: number;
  context_tiers_json: string | null;
  service_tiers_json: string | null;
  source: string | null;
  source_model_id: string | null;
  raw_json: string | null;
  updated_at_ms: number;
  synced_at_ms: number | null;
}

function parseJsonArray(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function rowToPrice(row: PriceRow): ModelPrice {
  const price: ModelPrice = {
    prompt: row.prompt_per_1m,
    completion: row.completion_per_1m,
    cache: row.cache_per_1m,
  };
  if (row.cache_read_per_1m || row.cache_read_configured) price.cacheRead = row.cache_read_per_1m;
  if (row.cache_creation_per_1m || row.cache_creation_configured) price.cacheCreation = row.cache_creation_per_1m;
  if (row.prompt_configured) price.promptConfigured = true;
  if (row.completion_configured) price.completionConfigured = true;
  if (row.cache_configured) price.cacheConfigured = true;
  if (row.cache_read_configured) price.cacheReadConfigured = true;
  if (row.cache_creation_configured) price.cacheCreationConfigured = true;
  if (row.source) price.source = row.source;
  if (row.source_model_id) price.sourceModelId = row.source_model_id;
  if (row.raw_json) price.rawJson = row.raw_json;
  // Tiers were validated on write; a corrupt value is dropped rather than failing the whole book.
  try {
    const contextTiers = normalizeContextTiers(parseJsonArray(row.context_tiers_json));
    if (contextTiers) price.contextTiers = contextTiers;
  } catch {
    /* ignore */
  }
  try {
    const serviceTiers = normalizeServiceTiers(parseJsonArray(row.service_tiers_json));
    if (serviceTiers) price.serviceTiers = serviceTiers;
  } catch {
    /* ignore */
  }
  price.updatedAtMs = row.updated_at_ms;
  if (row.synced_at_ms) price.syncedAtMs = row.synced_at_ms;
  return price;
}

export function loadBook(db: DatabaseSync): PriceBook {
  const rows = db.prepare('SELECT * FROM model_prices ORDER BY model').all() as unknown as PriceRow[];
  const book: PriceBook = {};
  for (const row of rows) book[row.model] = rowToPrice(row);
  return book;
}

const INSERT_SQL = `INSERT OR REPLACE INTO model_prices (
  model, prompt_per_1m, completion_per_1m, cache_per_1m, cache_read_per_1m, cache_creation_per_1m,
  prompt_configured, completion_configured, cache_configured, cache_read_configured, cache_creation_configured,
  context_tiers_json, service_tiers_json, source, source_model_id, raw_json, updated_at_ms, synced_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function writePrice(db: DatabaseSync, model: string, p: ModelPrice): void {
  db.prepare(INSERT_SQL).run(
    model,
    p.prompt,
    p.completion,
    p.cache,
    p.cacheRead ?? 0,
    p.cacheCreation ?? 0,
    p.promptConfigured ? 1 : 0,
    p.completionConfigured ? 1 : 0,
    p.cacheConfigured ? 1 : 0,
    p.cacheReadConfigured ? 1 : 0,
    p.cacheCreationConfigured ? 1 : 0,
    p.contextTiers?.length ? JSON.stringify(p.contextTiers) : null,
    p.serviceTiers?.length ? JSON.stringify(p.serviceTiers) : null,
    p.source ?? null,
    p.sourceModelId ?? null,
    p.rawJson ?? null,
    p.updatedAtMs ?? Date.now(),
    p.syncedAtMs ?? null,
  );
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Replaces every row with `book` (caller wraps in a transaction). */
export function writeBook(db: DatabaseSync, book: PriceBook): void {
  db.exec('DELETE FROM model_prices');
  for (const [model, price] of Object.entries(book)) writePrice(db, model, price);
}

export interface UpsertResult {
  imported: number;
  skipped: number;
  /** Models skipped because the stored entry is manual. */
  manual: string[];
}

/**
 * Upserts synced prices (caller wraps in a transaction). Manual rows are never touched; invalid
 * prices are skipped. Every written row gets `updatedAtMs = syncedAtMs = now`.
 */
export function upsertSynced(
  db: DatabaseSync,
  current: PriceBook,
  prices: Record<string, ModelPrice>,
  nowMs: number,
): UpsertResult {
  const result: UpsertResult = { imported: 0, skipped: 0, manual: [] };
  for (const [model, candidate] of Object.entries(prices)) {
    if (isManual(current[model])) {
      result.manual.push(model);
      continue;
    }
    let price: ModelPrice;
    try {
      price = normalizePrice(model, candidate, nowMs);
    } catch {
      result.skipped++;
      continue;
    }
    price.source ||= 'sync';
    price.sourceModelId ||= model;
    price.updatedAtMs = nowMs;
    price.syncedAtMs = nowMs;
    writePrice(db, model, price);
    result.imported++;
  }
  result.manual.sort();
  return result;
}

/* ---------------- meta ---------------- */

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(db: DatabaseSync, key: string, value: string, nowMs = Date.now()): void {
  db.prepare(
    `INSERT INTO meta (key, value, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
  ).run(key, value, nowMs);
}

export function deleteMeta(db: DatabaseSync, key: string): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(key);
}

export function getMetaInt(db: DatabaseSync, key: string): number | null {
  const value = getMeta(db, key);
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
