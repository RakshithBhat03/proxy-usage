import type { IncomingMessage } from 'node:http';

/** Outcome of authenticating a request's management key. */
export type AuthResult =
  | { ok: true; key: string }
  | {
      ok: false;
      /** HTTP status to answer with (401, 403, 429, 502, 503 ...). */
      status: number;
      /** Machine-readable code, e.g. `missing_management_key`, `invalid_management_key`, `rate_limited`. */
      code: string;
      /** Human-readable message. */
      error: string;
      /** Seconds until the client may retry (sent as `retry_after_s` and `Retry-After`). */
      retryAfterS?: number;
    };

export type AuthOk = Extract<AuthResult, { ok: true }>;

/** Authenticates one request (reads its headers; never consumes the body). */
export type RequireAuth = (req: IncomingMessage) => Promise<AuthResult>;
