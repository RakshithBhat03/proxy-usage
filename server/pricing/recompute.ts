/**
 * Re-prices stored events after a book change. A SQL function on the writer connection wraps
 * `estimateEventCost` (shared/cost.ts, the single cost implementation); rows are updated in id
 * batches of 10k, yielding to the event loop between batches. Progress is implicit in
 * `events.cost_revision`, so an interrupted recompute resumes on the next start.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { setImmediate as yieldToLoop } from 'node:timers/promises';

import { estimateEventCost } from '../../shared/cost.ts';
import type { PriceBook } from '../../shared/pricing-types.ts';
import type { Logger } from '../log.ts';

export const RECOMPUTE_BATCH = 10_000;
export const COST_FUNCTION = 'pricing_event_cost';

type SqlValue = number | bigint | string | null | Uint8Array;

const num = (value: SqlValue): number => (typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : 0);
const str = (value: SqlValue): string | null => (typeof value === 'string' ? value : null);

/**
 * Registers `pricing_event_cost(resolved_model, analytics_model, requested_model, model,
 * input_tokens, output_tokens, cached_tokens, cache_read_tokens, cache_creation_tokens,
 * service_tier)` → USD or NULL when unpriced. Reads the current book on every call.
 */
export function registerCostFunction(db: DatabaseSync, getBook: () => PriceBook): void {
  // Explicit parameters: node:sqlite registers the function with `fn.length` arguments.
  const fn = (
    resolved: SqlValue,
    analytics: SqlValue,
    requested: SqlValue,
    model: SqlValue,
    input: SqlValue,
    output: SqlValue,
    cached: SqlValue,
    cacheRead: SqlValue,
    cacheCreation: SqlValue,
    tier: SqlValue,
  ) => {
    const cost = estimateEventCost(getBook(), {
      resolved_model: str(resolved),
      analytics_model: str(analytics) ?? '',
      requested_model: str(requested),
      model: str(model) ?? '',
      input_tokens: num(input),
      output_tokens: num(output),
      cached_tokens: num(cached),
      cache_read_tokens: num(cacheRead),
      cache_creation_tokens: num(cacheCreation),
      service_tier: str(tier),
    } as Parameters<typeof estimateEventCost>[1]);
    return cost === null || !Number.isFinite(cost) ? null : cost;
  };
  db.function(COST_FUNCTION, { deterministic: false }, fn);
}

export interface RecomputeProgress {
  /** Rows still priced with an older revision (null = not counted yet). */
  stale: number | null;
  /** Rows with NULL cost after the last completed recompute. */
  unpriced: number | null;
  running: boolean;
}

/**
 * Background recompute loop. `kick()` starts (or restarts after a revision bump) a pass over every
 * row with `cost_revision < revision()`. Only one pass runs at a time.
 */
export class Recomputer {
  readonly progress: RecomputeProgress = { stale: null, unpriced: null, running: false };
  readonly #revision: () => number;
  readonly #log: Logger;
  readonly #batch: number;
  #pending = false;
  #stopped = false;
  #loop: Promise<void> | null = null;
  readonly #firstStale: StatementSync;
  readonly #batchEnd: StatementSync;
  readonly #update: StatementSync;
  readonly #countStale: StatementSync;
  readonly #countUnpriced: StatementSync;

  constructor(db: DatabaseSync, revision: () => number, log: Logger, batch = RECOMPUTE_BATCH) {
    this.#revision = revision;
    this.#log = log;
    this.#batch = batch;
    this.#firstStale = db.prepare('SELECT min(id) AS id FROM events WHERE cost_revision < ?');
    this.#batchEnd = db.prepare('SELECT max(id) AS id FROM (SELECT id FROM events WHERE id > ? ORDER BY id LIMIT ?)');
    this.#update = db.prepare(`UPDATE events
      SET cost_usd = ${COST_FUNCTION}(resolved_model, analytics_model, requested_model, model, input_tokens,
            output_tokens, cached_tokens, cache_read_tokens, cache_creation_tokens, service_tier),
          cost_revision = ?
      WHERE id > ? AND id <= ? AND cost_revision < ?`);
    this.#countStale = db.prepare('SELECT count(*) AS n FROM events WHERE cost_revision < ?');
    this.#countUnpriced = db.prepare('SELECT count(*) AS n FROM events WHERE cost_usd IS NULL');
  }

  /** True when any row is priced with an older revision (index lookup). */
  hasStale(): boolean {
    const row = this.#firstStale.get(this.#revision()) as { id: number | null } | undefined;
    return row?.id != null;
  }

  /** Counts NULL-cost rows (full scan; called after a pass and once at startup). */
  countUnpriced(): number {
    const n = Number((this.#countUnpriced.get() as { n: number }).n);
    this.progress.unpriced = n;
    return n;
  }

  /** Starts a pass, or flags the running pass to restart with the newest revision. */
  kick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#pending = true;
    this.#loop ??= this.#run().finally(() => {
      this.#loop = null;
    });
    return this.#loop;
  }

  /** Resolves when the current pass (if any) has finished. */
  idle(): Promise<void> {
    return this.#loop ?? Promise.resolve();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.idle();
  }

  async #run(): Promise<void> {
    this.progress.running = true;
    try {
      while (this.#pending && !this.#stopped) {
        this.#pending = false;
        await this.#pass();
      }
      if (!this.#stopped) this.countUnpriced();
    } catch (err) {
      this.#log.error('cost recompute failed', { error: err });
    } finally {
      this.progress.running = false;
    }
  }

  async #pass(): Promise<void> {
    const revision = this.#revision();
    const first = (this.#firstStale.get(revision) as { id: number | null } | undefined)?.id;
    if (first == null) {
      this.progress.stale = 0;
      return;
    }
    const total = Number((this.#countStale.get(revision) as { n: number }).n);
    this.progress.stale = total;
    const started = Date.now();
    this.#log.info('recomputing event costs', { revision, rows: total });
    let cursor = Number(first) - 1;
    let updated = 0;
    while (!this.#stopped) {
      if (this.#pending && this.#revision() !== revision) return; // a newer book: restart
      const end = (this.#batchEnd.get(cursor, this.#batch) as { id: number | null } | undefined)?.id;
      if (end == null) break;
      const changes = Number(this.#update.run(revision, cursor, end, revision).changes);
      updated += changes;
      this.progress.stale = Math.max(0, (this.progress.stale ?? 0) - changes);
      cursor = Number(end);
      await yieldToLoop();
    }
    if (this.#stopped) return;
    // Rows inserted during the pass with an older revision (e.g. a collector batch priced just
    // before the change) sit behind the cursor; pick them up with another pass.
    if (this.hasStale() && this.#revision() === revision) {
      const remaining = Number((this.#countStale.get(revision) as { n: number }).n);
      this.progress.stale = remaining;
      if (remaining > 0) this.#pending = true;
    } else if (this.#revision() === revision) {
      this.progress.stale = 0;
    }
    this.#log.info('event costs recomputed', { revision, rows: updated, ms: Date.now() - started });
  }
}
