/**
 * Price book service: loads `model_prices`, syncs from models.dev → LiteLLM → OpenRouter, and
 * recomputes `events.cost_usd` when the book changes. Semantics ported from CPA Manager Plus (MIT).
 *
 * Auto-sync (PRICE_SYNC_INTERVAL_HOURS > 0): at startup when never synced or the last sync is older
 * than the interval, then on that interval, and at most hourly after `noteModels` reports a model
 * the book cannot price. Auto-sync applies unambiguous matches only; manual entries are never
 * overwritten.
 */
import { findPrice } from '../../shared/cost.ts';
import type { ModelPrice, PriceBook, SyncResult } from '../../shared/pricing-types.ts';
import type { AppContext } from '../context.ts';
import { HttpError } from '../http/respond.ts';
import { collectionFrom, normalizeRequestedModels, preserveFailedSourcePrices, selectPrices } from './match.ts';
import { Recomputer, registerCostFunction } from './recompute.ts';
import { fetchSources, SourceCache, type FetchLike, type SourceName } from './sources.ts';
import {
  bookFingerprint,
  deleteMeta,
  getMeta,
  getMetaInt,
  isManual,
  loadBook,
  META_BOOK_HASH,
  META_LAST_SYNC,
  META_LAST_SYNC_ERROR,
  META_REVISION,
  normalizeBook,
  PriceValidationError,
  setMeta,
  transaction,
  upsertSynced,
  writeBook,
} from './store.ts';
import type { PricingHandle, PricingStats, SyncRequest } from './types.ts';

const HOUR_MS = 3_600_000;
/** Minimum spacing between syncs triggered by newly seen models. */
const NEW_MODEL_SYNC_SPACING_MS = HOUR_MS;
/** Delay before a new-model sync, so a burst of new models shares one sync. */
const NEW_MODEL_SYNC_DELAY_MS = 30_000;
/** Retry delay after an auto-sync where every source failed. */
const FAILED_SYNC_RETRY_MS = HOUR_MS;
/** Safety net for rows stamped with an older revision after a recompute pass finished. */
const STALE_CHECK_MS = 10 * 60_000;

export interface PricingOptions {
  fetch?: FetchLike;
  urls?: Partial<Record<SourceName, string>>;
  timeoutMs?: number;
  /** Set false to disable auto-sync timers (tests). Auto-sync is always off when the interval is 0. */
  autoSync?: boolean;
  now?: () => number;
  /** Recompute batch size (tests). */
  batch?: number;
  /** Delays before the startup sync and a new-model sync (tests). */
  startupDelayMs?: number;
  newModelDelayMs?: number;
}

type Ctx = Pick<AppContext, 'config' | 'log' | 'db'>;

export async function startPricing(ctx: Ctx, options: PricingOptions = {}): Promise<PricingHandle> {
  const { db } = ctx;
  const log = ctx.log.child('pricing');
  const now = options.now ?? Date.now;
  const intervalMs = ctx.config.priceSyncIntervalHours * HOUR_MS;
  const autoSync = (options.autoSync ?? true) && intervalMs > 0;
  const cache = new SourceCache();

  let book: PriceBook = loadBook(db);
  let revision = getMetaInt(db, META_REVISION) ?? 0;
  // Never go below a revision already stamped on events (e.g. meta restored from an older backup).
  const maxStamped = Number((db.prepare('SELECT max(cost_revision) AS r FROM events').get() as { r: number | null }).r ?? 0);
  if (maxStamped > revision) revision = maxStamped;
  // The book changed outside this process (first start, import script): price with a new revision.
  const fingerprint = bookFingerprint(book);
  if (getMeta(db, META_BOOK_HASH) !== fingerprint) {
    if (Object.keys(book).length > 0 || revision > 0) revision++;
    setMeta(db, META_BOOK_HASH, fingerprint, now());
  }
  setMeta(db, META_REVISION, String(revision), now());

  registerCostFunction(db, () => book);
  const recomputer = new Recomputer(db, () => revision, log, options.batch);

  let lastSyncMs = getMetaInt(db, META_LAST_SYNC);
  let lastSyncError = getMeta(db, META_LAST_SYNC_ERROR);
  let lastAttemptMs = 0;
  let stopped = false;
  const abort = new AbortController();
  /** Every model ever seen in events (loaded lazily) plus those reported by `noteModels`. */
  let runtimeModels: Set<string> | null = null;
  /** Models the last sync looked for; an unpriced one does not re-trigger a sync. */
  const attempted = new Set<string>();
  let chain: Promise<unknown> = Promise.resolve();
  let syncTimer: NodeJS.Timeout | null = null;
  let syncTimerAt = 0;

  const loadRuntimeModels = (): Set<string> => {
    if (runtimeModels) return runtimeModels;
    const rows = db
      .prepare(
        `SELECT analytics_model AS m FROM events WHERE analytics_model <> '' GROUP BY analytics_model
         UNION SELECT resolved_model FROM events WHERE resolved_model IS NOT NULL AND resolved_model <> '' AND resolved_model <> analytics_model`,
      )
      .all() as Array<{ m: string }>;
    runtimeModels = new Set(rows.map((r) => r.m.trim()).filter(Boolean));
    return runtimeModels;
  };

  /** Installs a new book; bumps the revision and starts a recompute when costs can change. */
  const commitBook = (mutate: () => void): void => {
    const before = bookFingerprint(book);
    const { next, after } = transaction(db, () => {
      mutate();
      const loaded = loadBook(db);
      const hash = bookFingerprint(loaded);
      if (hash !== before) {
        setMeta(db, META_REVISION, String(revision + 1), now());
        setMeta(db, META_BOOK_HASH, hash, now());
      }
      return { next: loaded, after: hash };
    });
    book = next;
    if (after !== before) {
      revision++;
      log.info('price book changed', { revision, models: Object.keys(book).length });
      void recomputer.kick();
    }
  };

  const runSync = async (request: SyncRequest, mode: 'manual' | 'auto'): Promise<SyncResult> => {
    lastAttemptMs = now();
    let models = normalizeRequestedModels(Array.isArray(request.models) ? request.models : []);
    let runtimeModelCount: number | undefined;
    let runtimeModelDiscoveryError: string | undefined;
    if (request.includeRuntimeModels) {
      try {
        runtimeModels = null; // re-read: the collector may not report every model
        const runtime = [...loadRuntimeModels()];
        runtimeModelCount = runtime.length;
        models = normalizeRequestedModels([...models, ...runtime]);
      } catch (err) {
        runtimeModelDiscoveryError = `runtime model discovery failed: ${(err as Error).message}`;
      }
    }
    if (models.length === 0) {
      return { source: '', imported: 0, skipped: 0, prices: book, runtimeModelCount, runtimeModelDiscoveryError };
    }

    const outcomes = await fetchSources({
      fetchImpl: options.fetch,
      urls: options.urls,
      cache,
      timeoutMs: options.timeoutMs,
      signal: abort.signal,
    });
    if (stopped) throw new HttpError(503, 'shutting_down', 'server is shutting down');
    const sourceResults = outcomes.map((o) => ({
      source: o.source,
      models: o.decoded ? Object.keys(o.decoded.prices).length : 0,
      skipped: o.decoded?.skipped ?? 0,
      ...(o.error ? { error: o.error } : {}),
    }));
    const ok = outcomes.filter((o) => o.decoded);
    for (const m of models) attempted.add(m);
    if (ok.length === 0) {
      const message = `model price sync failed; existing prices were not changed: ${outcomes
        .map((o) => `${o.source}: ${o.error}`)
        .join('; ')}`;
      lastSyncError = message;
      setMeta(db, META_LAST_SYNC_ERROR, message, now());
      throw new HttpError(502, 'price_sync_failed', message, { sourceResults });
    }
    const sources = ok.map((o) => o.source);
    const collection = collectionFrom(
      ok.map((o) => ({ source: o.source, prices: o.decoded!.prices, metadata: o.decoded!.metadata })),
    );
    const selection = selectPrices(collection, models, mode === 'manual');
    const failed = new Set(outcomes.filter((o) => o.error).map((o) => o.source as string));
    // Read the book at write time: a PUT may have landed while the sources were downloading.
    const preserved = preserveFailedSourcePrices(selection, book, failed, models);

    let upsert = { imported: 0, skipped: 0, manual: [] as string[] };
    const syncedAt = now();
    commitBook(() => {
      upsert = upsertSynced(db, book, selection.prices, syncedAt);
      setMeta(db, META_LAST_SYNC, String(syncedAt), syncedAt);
      deleteMeta(db, META_LAST_SYNC_ERROR);
    });
    lastSyncMs = syncedAt;
    lastSyncError = null;
    for (const model of upsert.manual) delete selection.matched[model];
    const decodeSkipped = ok.reduce((sum, o) => sum + o.decoded!.skipped, 0);
    const priced = (model: string) => Object.hasOwn(book, model);
    const result: SyncResult = {
      source: sources.length === 1 ? sources[0] : 'multi',
      sources,
      imported: upsert.imported,
      skipped: upsert.skipped + decodeSkipped,
      matched: selection.matched,
      candidates: selection.candidates.filter((c) => !priced(c.model)),
      unmatched: selection.unmatched.filter((m) => !priced(m)),
      preserved,
      sourceResults,
      prices: book,
      runtimeModelCount,
      runtimeModelDiscoveryError,
    };
    log.info(`${mode} price sync done`, {
      sources,
      failed: [...failed],
      requested: models.length,
      imported: upsert.imported,
      unmatched: result.unmatched?.length ?? 0,
      candidates: result.candidates?.length ?? 0,
      manual: upsert.manual.length,
      preserved: preserved.length,
    });
    return result;
  };

  /** Serializes syncs: a manual sync waits for a running auto-sync and vice versa. */
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const autoModels = (): string[] => {
    runtimeModels = null; // re-read: the collector may not report every model
    const runtime = [...loadRuntimeModels()];
    const synced = Object.entries(book)
      .filter(([, p]) => !isManual(p))
      .map(([m]) => m);
    return normalizeRequestedModels([...runtime, ...synced]);
  };

  const schedule = (atMs: number): void => {
    if (!autoSync || stopped) return;
    if (syncTimer && syncTimerAt <= atMs) return; // an earlier run is already scheduled
    if (syncTimer) clearTimeout(syncTimer);
    syncTimerAt = atMs;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncTimerAt = 0;
      void autoRun();
    }, Math.max(0, atMs - now()));
    syncTimer.unref();
  };

  const autoRun = async (): Promise<void> => {
    if (stopped) return;
    try {
      await enqueue(() => runSync({ models: autoModels() }, 'auto'));
      schedule(now() + intervalMs);
    } catch (err) {
      if (stopped) return;
      log.warn('auto price sync failed', { error: (err as Error).message });
      schedule(now() + Math.min(intervalMs, FAILED_SYNC_RETRY_MS));
    }
  };

  // Resume an interrupted recompute and report counts.
  setImmediate(() => {
    if (stopped) return;
    try {
      if (recomputer.hasStale()) void recomputer.kick();
      else {
        recomputer.progress.stale = 0;
        recomputer.countUnpriced();
      }
    } catch (err) {
      log.error('cost recompute check failed', { error: err });
    }
  }).unref();
  const staleTimer = setInterval(() => {
    if (!stopped && !recomputer.progress.running && recomputer.hasStale()) void recomputer.kick();
  }, STALE_CHECK_MS);
  staleTimer.unref();

  if (autoSync) {
    const due = lastSyncMs == null ? now() : lastSyncMs + intervalMs;
    schedule(Math.max(now() + (options.startupDelayMs ?? 2_000), due));
  }
  log.info('price book loaded', {
    models: Object.keys(book).length,
    revision,
    last_sync_ms: lastSyncMs,
    auto_sync_hours: autoSync ? ctx.config.priceSyncIntervalHours : 0,
  });

  return {
    book: () => book,
    revision: () => revision,
    noteModels(models) {
      let unknown = false;
      const known = runtimeModels;
      for (const raw of models) {
        const model = typeof raw === 'string' ? raw.trim() : '';
        if (!model) continue;
        if (known && !known.has(model)) known.add(model);
        if (attempted.has(model) || findPrice(book, [model])) continue;
        unknown = true;
      }
      if (!unknown || !autoSync || stopped) return;
      const earliest = lastAttemptMs ? lastAttemptMs + NEW_MODEL_SYNC_SPACING_MS : 0;
      schedule(Math.max(now() + (options.newModelDelayMs ?? NEW_MODEL_SYNC_DELAY_MS), earliest));
    },
    stats(): PricingStats {
      const entries = Object.values(book);
      const manual = entries.filter((p: ModelPrice) => isManual(p)).length;
      return {
        models: entries.length,
        synced_models: entries.length - manual,
        manual_models: manual,
        last_sync_at_ms: lastSyncMs,
        last_sync_ms: lastSyncMs,
        last_sync_error: lastSyncError,
        unpriced_events: recomputer.progress.unpriced,
        stale_cost_events: recomputer.progress.stale,
      };
    },
    replace(prices) {
      let next: PriceBook;
      try {
        next = normalizeBook(prices, now());
      } catch (err) {
        if (err instanceof PriceValidationError) throw new HttpError(400, 'invalid_model_prices', err.message);
        throw err;
      }
      commitBook(() => writeBook(db, next));
      return book;
    },
    sync(request) {
      return enqueue(() => runSync(request, 'manual'));
    },
    async stop() {
      stopped = true;
      if (syncTimer) clearTimeout(syncTimer);
      clearInterval(staleTimer);
      abort.abort();
      await chain;
      await recomputer.stop();
    },
  };
}
