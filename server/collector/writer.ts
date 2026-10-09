/**
 * Batched event writer: buffers normalized rows and flushes at 200 rows or 250 ms in one
 * `BEGIN IMMEDIATE` transaction with a prepared `INSERT OR IGNORE` (dedupe on `event_hash`).
 * Cost is computed at insert time from the current price book (NULL when the model is unpriced).
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { estimateEventCost } from '../../shared/cost.ts';
import type { Logger } from '../log.ts';
import type { PricingHandle } from '../pricing/types.ts';
import { buildSearchText, type EventRowInsert } from './normalize.ts';

export const FLUSH_ROWS = 200;
export const FLUSH_INTERVAL_MS = 250;

/** Insert column order (every EventRowInsert key). */
export const INSERT_COLUMNS = [
  'request_id',
  'event_hash',
  'timestamp_ms',
  'timestamp',
  'received_at_ms',
  'created_at_ms',
  'provider',
  'executor_type',
  'model',
  'analytics_model',
  'requested_model',
  'resolved_model',
  'response_model',
  'endpoint',
  'method',
  'path',
  'client_ip',
  'x_forwarded_for',
  'user_agent',
  'auth_type',
  'auth_index',
  'source',
  'source_hash',
  'api_key_hash',
  'account_snapshot',
  'auth_label_snapshot',
  'auth_file_snapshot',
  'auth_provider_snapshot',
  'auth_account_id_snapshot',
  'auth_project_id_snapshot',
  'auth_snapshot_at_ms',
  'reasoning_effort',
  'service_tier',
  'request_service_tier',
  'response_service_tier',
  'cache_input_mode',
  'session_id',
  'parent_session_id',
  'access_token_sha256',
  'generate',
  'stream',
  'trace_id',
  'execution_id',
  'node_kind',
  'is_fork',
  'is_compaction',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cached_tokens',
  'cache_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'normalized_uncached_input_tokens',
  'normalized_total_input_tokens',
  'normalized_cache_read_tokens',
  'normalized_cache_creation_tokens',
  'total_tokens',
  'raw_tokens_json',
  'latency_ms',
  'ttft_ms',
  'failed',
  'fail_status_code',
  'fail_summary',
  'response_metadata_json',
  'header_quota_recover_at_ms',
  'header_quota_used_percent',
  'header_quota_plan_type',
  'header_error_kind',
  'header_error_code',
  'header_trace_id',
  'search_text',
  'cost_usd',
  'cost_revision',
] as const satisfies ReadonlyArray<keyof EventRowInsert>;

export interface WriteResult {
  inserted: number;
  duplicates: number;
}

export interface EventWriterOptions {
  db: DatabaseSync;
  log: Logger;
  /** Read lazily: pricing may start after the collector. */
  pricing: () => PricingHandle | undefined;
  onFlushed?: (result: WriteResult, insertedRows: EventRowInsert[]) => void;
  flushRows?: number;
  flushIntervalMs?: number;
}

export class EventWriter {
  private readonly db: DatabaseSync;
  private readonly log: Logger;
  private readonly pricing: () => PricingHandle | undefined;
  private readonly onFlushed?: (result: WriteResult, insertedRows: EventRowInsert[]) => void;
  private readonly flushRows: number;
  private readonly flushIntervalMs: number;
  private buffer: EventRowInsert[] = [];
  private timer: NodeJS.Timeout | null = null;
  private insertStmt: StatementSync | null = null;
  private readonly seenModels = new Set<string>();
  private readonly retried = new WeakSet<EventRowInsert>();
  private stopped = false;
  totals: WriteResult = { inserted: 0, duplicates: 0 };

  constructor(options: EventWriterOptions) {
    this.db = options.db;
    this.log = options.log;
    this.pricing = options.pricing;
    this.onFlushed = options.onFlushed;
    this.flushRows = options.flushRows ?? FLUSH_ROWS;
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  }

  get pending(): number {
    return this.buffer.length;
  }

  enqueue(rows: EventRowInsert[]): void {
    if (rows.length === 0) return;
    if (this.stopped) {
      this.log.warn('writer stopped; dropping events', { count: rows.length });
      return;
    }
    this.buffer.push(...rows);
    if (this.buffer.length >= this.flushRows) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushIntervalMs);
  }

  /** Writes everything buffered now. Never throws (errors are logged; rows are retried once). */
  flush(): WriteResult {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const total: WriteResult = { inserted: 0, duplicates: 0 };
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.flushRows);
      try {
        const result = this.write(batch);
        total.inserted += result.inserted;
        total.duplicates += result.duplicates;
      } catch (err) {
        this.log.error('event batch write failed', { error: err as Error, rows: batch.length });
        // A transient lock (busy_timeout exceeded) gets one more chance on the next flush.
        if (!this.retried.has(batch[0]) && !this.stopped) {
          for (const row of batch) this.retried.add(row);
          this.buffer.unshift(...batch);
          this.timer ??= setTimeout(() => {
            this.timer = null;
            this.flush();
          }, 2_000);
          break;
        }
      }
    }
    return total;
  }

  /** Flushes and refuses further rows. */
  stop(): WriteResult {
    const result = this.flush();
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return result;
  }

  private statement(): StatementSync {
    this.insertStmt ??= this.db.prepare(
      `INSERT OR IGNORE INTO events (${INSERT_COLUMNS.join(', ')}) VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`,
    );
    return this.insertStmt;
  }

  private write(batch: EventRowInsert[]): WriteResult {
    const stmt = this.statement();
    const pricing = this.pricing();
    const book = pricing?.book();
    const revision = pricing?.revision() ?? 0;
    const now = Date.now();
    const inserted: EventRowInsert[] = [];
    let duplicates = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of batch) {
        row.created_at_ms = now;
        row.search_text = buildSearchText(row);
        row.cost_usd = book ? estimateEventCost(book, row) : null;
        if (row.cost_usd !== null && !Number.isFinite(row.cost_usd)) row.cost_usd = null;
        row.cost_revision = book ? revision : 0;
        const result = stmt.run(...INSERT_COLUMNS.map((column) => row[column]));
        if (Number(result.changes) > 0) inserted.push(row);
        else duplicates++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw err;
    }
    const result = { inserted: inserted.length, duplicates };
    this.totals.inserted += result.inserted;
    this.totals.duplicates += result.duplicates;
    if (pricing && inserted.length > 0) {
      const fresh = new Set<string>();
      for (const row of inserted) {
        if (row.analytics_model && !this.seenModels.has(row.analytics_model)) {
          this.seenModels.add(row.analytics_model);
          fresh.add(row.analytics_model);
        }
      }
      if (fresh.size > 0) {
        try {
          pricing.noteModels(fresh);
        } catch (err) {
          this.log.warn('pricing.noteModels failed', { error: err as Error });
        }
      }
    }
    this.onFlushed?.(result, inserted);
    return result;
  }
}
