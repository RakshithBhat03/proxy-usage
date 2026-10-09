/**
 * The application context passed to every module. `server/index.ts` builds it in startup order:
 * config → log → db → requireAuth/router → pricing → collector → retention → analytics → http.
 * Optional fields are undefined until their module has started (and stay undefined when disabled).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AnalyticsPool } from './analytics/types.ts';
import type { RequireAuth } from './auth/types.ts';
import type { CollectorHandle } from './collector/types.ts';
import type { Config } from './config.ts';
import type { RetentionHandle } from './db/retention.ts';
import type { Router } from './http/router.ts';
import type { Logger } from './log.ts';
import type { PricingHandle } from './pricing/types.ts';

export interface AppContext {
  config: Config;
  log: Logger;
  /** The single writer connection (main thread). Workers open their own read-only connections. */
  db: DatabaseSync;
  router: Router;
  /** Process start time (ms). */
  startedAtMs: number;
  /** Authenticates a request's management key. Replaceable; `withAuth` reads it per request. */
  requireAuth: RequireAuth;
  pricing?: PricingHandle;
  collector?: CollectorHandle;
  retention?: RetentionHandle;
  analytics?: AnalyticsPool;
}
