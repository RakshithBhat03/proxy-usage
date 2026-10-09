/**
 * Worker-thread pool for analytics queries (ANALYTICS_WORKERS threads, each with its own read-only
 * DB connection), so heavy queries never block the collector socket or the HTTP loop.
 *
 * Tasks queue FIFO when every worker is busy. A task that runs past the timeout gets its worker
 * terminated and replaced; a crashed worker is respawned (with backoff) and its task fails with 500.
 */
import { Worker } from 'node:worker_threads';
import type { AppContext } from '../context.ts';
import { HttpError } from '../http/respond.ts';
import type { Logger } from '../log.ts';
import type { AnalyticsPool } from './types.ts';
import type { WorkerReply, WorkerRequest } from './worker.ts';

export const TASK_TIMEOUT_MS = 60_000;
const MAX_QUEUE = 200;

interface Task {
  id: number;
  op: string;
  input: unknown;
  resolve: (json: string) => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: NodeJS.Timeout;
  queuedAt: number;
}

interface Slot {
  worker: Worker;
  task: Task | null;
  /** Consecutive crashes, for respawn backoff. */
  crashes: number;
}

export interface PoolOptions {
  size: number;
  dbPath: string;
  log: Pick<Logger, 'debug' | 'warn' | 'error'>;
  timeoutMs?: number;
}

const abortError = () => new HttpError(499, 'client_closed', 'request aborted');

export function startWorkerPool(options: PoolOptions): AnalyticsPool {
  const { size, dbPath, log } = options;
  const timeoutMs = options.timeoutMs ?? TASK_TIMEOUT_MS;
  const slots: Slot[] = [];
  const queue: Task[] = [];
  let nextId = 1;
  let closing = false;

  const settle = (task: Task) => {
    if (task.timer) clearTimeout(task.timer);
    if (task.signal && task.onAbort) task.signal.removeEventListener('abort', task.onAbort);
  };

  const spawn = (slot: Slot | null): Slot => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { dbPath } });
    const target: Slot = slot ?? { worker, task: null, crashes: 0 };
    target.worker = worker;
    target.task = null;
    worker.on('message', (reply: WorkerReply) => {
      const task = target.task;
      if (!task || task.id !== reply.id) return;
      target.task = null;
      target.crashes = 0;
      worker.unref();
      settle(task);
      if (reply.ok) {
        log.debug('analytics task done', { op: task.op, ms: Math.round(reply.ms) });
        task.resolve(reply.json);
      } else {
        if (reply.error.status >= 500) log.error('analytics task failed', { op: task.op, error: reply.error.message });
        task.reject(new HttpError(reply.error.status, reply.error.code, reply.error.message));
      }
      dispatch();
    });
    worker.on('error', (err) => {
      log.error('analytics worker crashed', { error: err });
    });
    worker.on('exit', (code) => {
      if (target.worker !== worker) return; // already replaced (timeout)
      const task = target.task;
      target.task = null;
      if (task) {
        settle(task);
        task.reject(new HttpError(500, 'analytics_failed', `analytics worker exited (code ${code})`));
      }
      if (closing) return;
      target.crashes++;
      const delay = Math.min(30_000, 250 * 2 ** Math.min(target.crashes - 1, 7));
      log.warn('analytics worker exited; respawning', { code, delayMs: delay });
      setTimeout(() => {
        if (closing) return;
        spawn(target);
        dispatch();
      }, delay).unref();
    });
    worker.unref();
    return target;
  };

  const start = (slot: Slot, task: Task) => {
    slot.task = task;
    task.timer = setTimeout(() => {
      if (slot.task !== task) return;
      log.warn('analytics task timed out; restarting worker', { op: task.op, timeoutMs });
      slot.task = null;
      settle(task);
      task.reject(new HttpError(504, 'analytics_timeout', `analytics query exceeded ${Math.round(timeoutMs / 1000)}s`));
      const old = slot.worker;
      spawn(slot);
      void old.terminate();
      dispatch();
    }, timeoutMs);
    task.timer.unref();
    const message: WorkerRequest = { id: task.id, op: task.op, input: task.input };
    // Idle workers are unref'd so they never hold the process open; a running task keeps it alive.
    slot.worker.ref();
    slot.worker.postMessage(message);
  };

  const dispatch = () => {
    for (const slot of slots) {
      if (slot.task || queue.length === 0) continue;
      let task = queue.shift();
      while (task && task.signal?.aborted) task = queue.shift();
      if (!task) return;
      start(slot, task);
    }
  };

  for (let i = 0; i < size; i++) slots.push(spawn(null));

  return {
    size,
    run<T = unknown>(op: string, input: unknown, signal?: AbortSignal): Promise<T> {
      if (closing) return Promise.reject(new HttpError(503, 'shutting_down', 'server is shutting down'));
      if (signal?.aborted) return Promise.reject(abortError());
      if (queue.length >= MAX_QUEUE) {
        return Promise.reject(new HttpError(503, 'analytics_busy', 'too many analytics queries queued', { retry_after_s: 5 }));
      }
      return new Promise<T>((resolve, reject) => {
        const task: Task = {
          id: nextId++,
          op,
          input,
          resolve: resolve as (json: string) => void,
          reject,
          signal,
          queuedAt: Date.now(),
        };
        if (signal) {
          // Aborting only drops a queued task; a running query finishes and its result is discarded.
          task.onAbort = () => {
            const index = queue.indexOf(task);
            if (index >= 0) {
              queue.splice(index, 1);
              settle(task);
              reject(abortError());
            }
          };
          signal.addEventListener('abort', task.onAbort, { once: true });
        }
        queue.push(task);
        dispatch();
      });
    },
    async close() {
      closing = true;
      for (const task of queue.splice(0)) {
        settle(task);
        task.reject(new HttpError(503, 'shutting_down', 'server is shutting down'));
      }
      await Promise.all(
        slots.map(async (slot) => {
          const task = slot.task;
          slot.task = null;
          if (task) {
            settle(task);
            task.reject(new HttpError(503, 'shutting_down', 'server is shutting down'));
          }
          await slot.worker.terminate();
        }),
      );
    },
  };
}

export function createAnalyticsPool(ctx: AppContext): AnalyticsPool {
  return startWorkerPool({
    size: ctx.config.analyticsWorkers,
    dbPath: ctx.config.dbPath,
    log: ctx.log.child('analytics'),
  });
}
