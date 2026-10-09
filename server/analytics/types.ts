/**
 * Worker-thread pool for analytics queries. Workers open the DB read-only (`openReadOnly`), so heavy
 * queries never block the collector or the HTTP loop.
 */
export interface AnalyticsPool {
  /** Number of worker threads. */
  readonly size: number;
  /**
   * Runs one operation (e.g. `'analytics'`, `'account-window'`) on a worker and resolves with its
   * result. Implementations may resolve with pre-serialized JSON text (see `sendJsonText`).
   */
  run<T = unknown>(op: string, input: unknown, signal?: AbortSignal): Promise<T>;
  close(): Promise<void>;
}
