/**
 * Daily maintenance on the writer connection:
 *  - when RETENTION_DAYS > 0, delete older events in 5k-row batches, yielding between batches so the
 *    collector keeps writing;
 *  - prune dead letters older than 30 days;
 *  - release free pages (incremental vacuum), `PRAGMA optimize`, and truncate the WAL.
 */
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { AppContext } from '../context.ts';

const BATCH = 5000;
const VACUUM_PAGES_PER_STEP = 2000;
const DAY_MS = 86_400_000;
const FIRST_RUN_DELAY_MS = 5 * 60_000;
const DEAD_LETTER_DAYS = 30;

export interface RetentionStatus {
  retention_days: number;
  last_run_at_ms: number | null;
  last_deleted_events: number;
  last_error: string | null;
  next_run_at_ms: number | null;
}

export interface RetentionResult {
  deletedEvents: number;
  deletedDeadLetters: number;
  freedPages: number;
}

export interface RetentionHandle {
  status(): RetentionStatus;
  /** Runs maintenance now (also used by the daily timer). Concurrent calls share one run. */
  runNow(): Promise<RetentionResult>;
  stop(): void;
}

async function deleteInBatches(ctx: AppContext, sql: string, cutoffMs: number): Promise<number> {
  const stmt = ctx.db.prepare(sql);
  let total = 0;
  for (;;) {
    const { changes } = stmt.run(cutoffMs, BATCH);
    total += Number(changes);
    if (Number(changes) < BATCH) return total;
    await yieldToLoop();
  }
}

export async function runRetention(ctx: AppContext, nowMs = Date.now()): Promise<RetentionResult> {
  const { db, config } = ctx;
  let deletedEvents = 0;
  if (config.retentionDays > 0) {
    deletedEvents = await deleteInBatches(
      ctx,
      'DELETE FROM events WHERE id IN (SELECT id FROM events WHERE timestamp_ms < ? ORDER BY timestamp_ms LIMIT ?)',
      nowMs - config.retentionDays * DAY_MS,
    );
  }
  const deletedDeadLetters = await deleteInBatches(
    ctx,
    'DELETE FROM dead_letters WHERE id IN (SELECT id FROM dead_letters WHERE created_at_ms < ? ORDER BY id LIMIT ?)',
    nowMs - DEAD_LETTER_DAYS * DAY_MS,
  );

  let freedPages = 0;
  const freelist = db.prepare('PRAGMA freelist_count');
  for (;;) {
    const row = freelist.get() as { freelist_count: number } | undefined;
    const free = Number(row?.freelist_count ?? 0);
    if (free <= 0) break;
    db.exec(`PRAGMA incremental_vacuum(${Math.min(free, VACUUM_PAGES_PER_STEP)})`);
    const after = Number((freelist.get() as { freelist_count: number } | undefined)?.freelist_count ?? 0);
    if (after >= free) break; // auto_vacuum is off for this file; nothing to release
    freedPages += free - after;
    await yieldToLoop();
  }
  db.exec('PRAGMA optimize');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { deletedEvents, deletedDeadLetters, freedPages };
}

export function startRetention(ctx: AppContext): RetentionHandle {
  const log = ctx.log.child('retention');
  const state: RetentionStatus = {
    retention_days: ctx.config.retentionDays,
    last_run_at_ms: null,
    last_deleted_events: 0,
    last_error: null,
    next_run_at_ms: null,
  };
  let running: Promise<RetentionResult> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const runNow = (): Promise<RetentionResult> => {
    running ??= (async () => {
      const started = Date.now();
      try {
        const result = await runRetention(ctx, started);
        state.last_deleted_events = result.deletedEvents;
        state.last_error = null;
        log.info('maintenance done', { ...result, ms: Date.now() - started });
        return result;
      } catch (err) {
        state.last_error = (err as Error).message;
        log.error('maintenance failed', { error: err });
        throw err;
      } finally {
        state.last_run_at_ms = started;
        running = null;
      }
    })();
    return running;
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    state.next_run_at_ms = Date.now() + delayMs;
    timer = setTimeout(() => {
      runNow()
        .catch(() => undefined)
        .finally(() => schedule(DAY_MS));
    }, delayMs);
    timer.unref();
  };
  schedule(FIRST_RUN_DELAY_MS);

  return {
    status: () => ({ ...state }),
    runNow,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      state.next_run_at_ms = null;
    },
  };
}
