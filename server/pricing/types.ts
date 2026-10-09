import type { PriceBook, SyncResult } from '../../shared/pricing-types.ts';

/** Serialized in `/api/session` (snake_case on purpose). */
export interface PricingStats {
  models: number;
  /** Models priced from a sync source vs entered by hand. */
  synced_models: number;
  manual_models: number;
  last_sync_at_ms: number | null;
  /** Same as `last_sync_at_ms`; the name `SessionResponse.prices` uses. */
  last_sync_ms: number | null;
  last_sync_error: string | null;
  /**
   * Events whose cost_usd is NULL (no price), as of the last recompute; null until first counted.
   * Rows inserted since then are not included.
   */
  unpriced_events: number | null;
  /** Events still priced with an older book revision (a recompute is pending or running). */
  stale_cost_events: number | null;
}

/** `POST /api/model-prices/sync` body. */
export interface SyncRequest {
  models?: string[];
  includeRuntimeModels?: boolean;
}

export interface PricingHandle {
  /** Current in-memory price book (read-only; replaced wholesale on change). */
  book(): PriceBook;
  /**
   * Monotonic book revision. Bumped on every book change; stored per event as
   * `events.cost_revision` so a recompute can find stale rows.
   */
  revision(): number;
  /** The collector reports analytics models it inserted; unknown ones may trigger a sync. */
  noteModels(models: Iterable<string>): void;
  stats(): PricingStats;
  /** Replaces the whole book (`PUT /api/model-prices`). Throws `HttpError(400)` on invalid input. */
  replace(prices: unknown): PriceBook;
  /** Runs a sync now (`POST /api/model-prices/sync`). Throws `HttpError(502)` when every source fails. */
  sync(request: SyncRequest): Promise<SyncResult>;
  stop(): Promise<void>;
}
