/**
 * Auth, status and CPA forwarding against a fake CLIProxyAPI (local node:http server).
 * Synthetic keys and data only; never talks to a real CPA.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http, { type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../config.ts';
import type { AppContext } from '../context.ts';
import { openDatabase } from '../db/open.ts';
import { Router } from '../http/router.ts';
import { startHttp, type HttpHandle } from '../http/server.ts';
import { createLogger } from '../log.ts';
import type { PricingHandle } from '../pricing/types.ts';
import type { SessionResponse, StatusResponse } from '../../shared/session-types.ts';
import { registerAuthRoutes } from './routes.ts';
import { BUDGET_MAX_FAILURES, createAuthVerifier, IP_MAX_ATTEMPTS, type AuthVerifier } from './verify.ts';

const CONFIGURED_KEY = 'configured-test-key';
const GOOD_KEY = 'other-good-key';

interface FakeCall {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

type FakeHandler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

/** Default fake CPA: accepts CONFIGURED_KEY / GOOD_KEY, rejects anything else with 401. */
const defaultCpa: FakeHandler = (req, res) => {
  res.setHeader('X-CPA-VERSION', 'v9.9.9-test');
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"message":"CLI Proxy API Server"}');
    return;
  }
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${CONFIGURED_KEY}` && auth !== `Bearer ${GOOD_KEY}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"invalid management key"}');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"debug":false}');
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

interface Harness {
  base: string;
  calls: FakeCall[];
  /** Calls excluding the public reachability probe (`GET /`). */
  mgmtCalls(): FakeCall[];
  ctx: AppContext;
  verifier: AuthVerifier;
  close(): Promise<void>;
}

const open: Harness[] = [];
after(async () => {
  await Promise.all(open.map((h) => h.close()));
});

async function setup(handler: FakeHandler = defaultCpa, options: { cpaUrl?: string; pricing?: PricingHandle } = {}): Promise<Harness> {
  const calls: FakeCall[] = [];
  const fake = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      calls.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  const fakePort = await listen(fake);
  const config = {
    ...loadConfig(
      {
        CPA_URL: options.cpaUrl ?? `http://127.0.0.1:${fakePort}`,
        CPA_MANAGEMENT_KEY: CONFIGURED_KEY,
        RETENTION_DAYS: '30',
        COLLECTOR_MODE: 'off',
      },
      [],
    ),
    port: 0,
    host: '127.0.0.1',
  };
  const log = createLogger('error');
  const verifier = createAuthVerifier({ config, log });
  const ctx: AppContext = {
    config,
    log,
    db: openDatabase(':memory:'),
    router: new Router(),
    startedAtMs: Date.now(),
    requireAuth: verifier,
    pricing: options.pricing,
  };
  registerAuthRoutes(ctx);
  const app: HttpHandle = await startHttp(ctx);
  const port = (app.server.address() as AddressInfo).port;
  const harness: Harness = {
    base: `http://127.0.0.1:${port}`,
    calls,
    mgmtCalls: () => calls.filter((c) => c.url !== '/'),
    ctx,
    verifier,
    async close() {
      await app.close(100);
      fake.closeAllConnections();
      await new Promise<void>((resolve) => fake.close(() => resolve()));
      ctx.db.close();
    },
  };
  open.push(harness);
  return harness;
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  json<T = Record<string, unknown>>(): T;
}

function request(
  base: string,
  path: string,
  options: { method?: string; key?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.key !== undefined) headers.Authorization = `Bearer ${options.key}`;
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method: options.method ?? 'GET', headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body.toString('utf8')) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('management key verification', () => {
  it('rejects a missing key without calling CPA', async () => {
    const h = await setup();
    const reply = await request(h.base, '/api/session');
    assert.equal(reply.status, 401);
    assert.equal(reply.json().code, 'missing_management_key');
    assert.equal(h.mgmtCalls().length, 0);
  });

  it('accepts the configured key without calling CPA', async () => {
    const h = await setup();
    const reply = await request(h.base, '/api/session', { key: CONFIGURED_KEY });
    assert.equal(reply.status, 200);
    assert.equal(h.mgmtCalls().length, 0);
  });

  it('also reads X-Management-Key', async () => {
    const h = await setup();
    const reply = await request(h.base, '/api/session', { headers: { 'X-Management-Key': CONFIGURED_KEY } });
    assert.equal(reply.status, 200);
  });

  it('verifies other keys with CPA once, then serves them from the positive cache', async () => {
    const h = await setup();
    for (let i = 0; i < 3; i++) {
      const reply = await request(h.base, '/api/session', { key: GOOD_KEY });
      assert.equal(reply.status, 200);
    }
    const calls = h.mgmtCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/v0/management/config');
    assert.equal(calls[0].headers.authorization, `Bearer ${GOOD_KEY}`);
  });

  it('caches a wrong key: the second attempt does not reach CPA', async () => {
    const h = await setup();
    const first = await request(h.base, '/api/session', { key: 'wrong-key-1' });
    assert.equal(first.status, 401);
    assert.equal(first.json().code, 'invalid_management_key');
    const second = await request(h.base, '/api/session', { key: 'wrong-key-1' });
    assert.equal(second.status, 401);
    assert.equal(h.mgmtCalls().length, 1);
    assert.equal(h.verifier.stats().budgetUsed, 1);
  });

  it('stops asking CPA once the global failure budget is spent', async () => {
    const h = await setup();
    for (let i = 0; i < BUDGET_MAX_FAILURES; i++) {
      assert.equal((await request(h.base, '/api/session', { key: `wrong-${i}` })).status, 401);
    }
    const limited = await request(h.base, '/api/session', { key: 'wrong-next' });
    assert.equal(limited.status, 429);
    const body = limited.json<{ code: string; retry_after_s: number }>();
    assert.equal(body.code, 'login_rate_limited');
    assert.ok(body.retry_after_s > 0 && body.retry_after_s <= 30 * 60);
    assert.equal(limited.headers['retry-after'], String(body.retry_after_s));
    assert.equal(h.mgmtCalls().length, BUDGET_MAX_FAILURES);
    // The configured key and cached good keys still work.
    assert.equal((await request(h.base, '/api/session', { key: CONFIGURED_KEY })).status, 200);
  });

  it('never lets concurrent wrong keys overshoot the budget', async () => {
    const h = await setup((req, res, body) => setTimeout(() => defaultCpa(req, res, body), 50));
    const replies = await Promise.all(
      Array.from({ length: 6 }, (_, i) => request(h.base, '/api/session', { key: `parallel-wrong-${i}` })),
    );
    assert.ok(h.mgmtCalls().length <= BUDGET_MAX_FAILURES);
    assert.ok(replies.some((r) => r.status === 429));
  });

  it('limits CPA verifications per client IP', async () => {
    // 500s do not spend the failure budget, so only the per-IP limiter applies.
    const h = await setup((req, res) => {
      if (req.url === '/') return void res.writeHead(200).end();
      res.writeHead(500).end('boom');
    });
    for (let i = 0; i < IP_MAX_ATTEMPTS; i++) {
      const reply = await request(h.base, '/api/session', { key: `ip-key-${i}` });
      assert.equal(reply.status, 502);
      assert.equal(reply.json().code, 'cpa_error');
    }
    const limited = await request(h.base, '/api/session', { key: 'ip-key-next' });
    assert.equal(limited.status, 429);
    assert.equal(limited.json().code, 'login_rate_limited');
    assert.ok((limited.json().retry_after_s as number) > 0);
    assert.equal(h.mgmtCalls().length, IP_MAX_ATTEMPTS);
  });

  it('maps CPA 403 to 503 cpa_forbidden with the reason and the allow-remote hint', async () => {
    const h = await setup((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":"remote management disabled"}');
    });
    const reply = await request(h.base, '/api/session', { key: 'some-key' });
    assert.equal(reply.status, 503);
    const body = reply.json<{ code: string; error: string }>();
    assert.equal(body.code, 'cpa_forbidden');
    assert.match(body.error, /remote management disabled/);
    assert.match(body.error, /allow-remote/);
    assert.match(body.error, /MANAGEMENT_PASSWORD/);
    assert.equal(h.verifier.stats().budgetUsed, 0);
  });

  it('maps an unreachable CPA to 502 cpa_unreachable', async () => {
    const closed = http.createServer();
    const port = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const h = await setup(defaultCpa, { cpaUrl: `http://127.0.0.1:${port}` });
    const reply = await request(h.base, '/api/session', { key: 'some-key' });
    assert.equal(reply.status, 502);
    assert.equal(reply.json().code, 'cpa_unreachable');
    assert.equal(h.verifier.stats().budgetUsed, 0);

    const status = await request(h.base, '/api/status');
    assert.equal(status.status, 200);
    assert.equal(status.json<StatusResponse>().cpa.reachable, false);
  });
});

describe('status and session', () => {
  it('GET /api/status is public and reports host, reachability and the version seen', async () => {
    const h = await setup();
    const before = (await request(h.base, '/api/status')).json<StatusResponse>();
    assert.equal(typeof before.app_version, 'string');
    assert.match(before.cpa.host, /^127\.0\.0\.1:\d+$/);
    assert.equal(before.cpa.reachable, true);
    assert.equal(before.cpa.version, null);
    assert.ok(h.calls.every((c) => c.url === '/' && !c.headers.authorization), 'probe must not send a key');

    await request(h.base, '/api/session', { key: GOOD_KEY });
    const afterVerify = (await request(h.base, '/api/status')).json<StatusResponse>();
    assert.equal(afterVerify.cpa.version, 'v9.9.9-test');
    // Probe result is cached for 15 s.
    assert.equal(h.calls.filter((c) => c.url === '/').length, 1);
  });

  it('GET /api/session reports collector, DB, retention and price stats', async () => {
    const pricing = {
      stats: () => ({
        models: 42,
        synced_models: 40,
        manual_models: 2,
        last_sync_at_ms: 1_700_000_000_000,
        last_sync_ms: 1_700_000_000_000,
        last_sync_error: null,
        unpriced_events: 0,
        stale_cost_events: 0,
      }),
    } as unknown as PricingHandle;
    const h = await setup(defaultCpa, { pricing });
    const insert = h.ctx.db.prepare(
      `INSERT INTO events (event_hash, timestamp_ms, timestamp, received_at_ms, created_at_ms, model) VALUES (?, ?, '', 0, 0, 'm')`,
    );
    insert.run('e1', 1000);
    insert.run('e2', 5000);
    insert.run('e3', 3000);
    const reply = await request(h.base, '/api/session', { key: CONFIGURED_KEY });
    assert.equal(reply.status, 200);
    const body = reply.json<SessionResponse>();
    assert.equal(body.ok, true);
    assert.equal(body.collector.state, 'disabled');
    assert.deepEqual(body.collector.counts, { received: 0, inserted: 0, duplicates: 0, dead_letters: 0, reconnects: 0 });
    assert.deepEqual(body.db.events, 3);
    assert.equal(body.db.oldest_event_ms, 1000);
    assert.equal(body.db.newest_event_ms, 5000);
    assert.ok(body.db.size_bytes > 0);
    assert.equal(body.retention_days, 30);
    assert.deepEqual(body.prices, { models: 42, last_sync_ms: 1_700_000_000_000 });
  });

  it('GET /api/session falls back to zeroed price stats and an empty DB', async () => {
    const h = await setup();
    const body = (await request(h.base, '/api/session', { key: CONFIGURED_KEY })).json<SessionResponse>();
    assert.deepEqual(body.prices, { models: 0, last_sync_ms: null });
    assert.equal(body.db.events, 0);
    assert.equal(body.db.oldest_event_ms, null);
  });
});

describe('CPA forwarding', () => {
  it('forwards auth-files with the caller key and strips sensitive headers both ways', async () => {
    const h = await setup((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'session=abc',
        'Access-Control-Allow-Origin': '*',
        'X-CPA-VERSION': 'v9.9.9-test',
        'X-Custom': 'kept',
      });
      res.end('{"files":[]}');
    });
    const reply = await request(h.base, '/v0/management/auth-files?x=1', {
      key: GOOD_KEY,
      headers: {
        Cookie: 'ui=1',
        Origin: 'http://evil.example',
        'X-Forwarded-For': '203.0.113.9',
        'X-Real-IP': '203.0.113.9',
        'X-Management-Key': 'should-not-pass',
        Connection: 'keep-alive, X-Hop',
        'X-Hop': 'secret',
      },
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.toString(), '{"files":[]}');
    assert.equal(reply.headers['set-cookie'], undefined);
    assert.equal(reply.headers['access-control-allow-origin'], undefined);
    assert.equal(reply.headers['x-custom'], 'kept');
    assert.equal(reply.headers['x-frame-options'], 'DENY');

    const calls = h.mgmtCalls();
    // verification + forward
    assert.deepEqual(calls.map((c) => c.url), ['/v0/management/config', '/v0/management/auth-files?x=1']);
    const forwarded = calls[1].headers;
    assert.equal(forwarded.authorization, `Bearer ${GOOD_KEY}`);
    for (const name of ['cookie', 'origin', 'x-forwarded-for', 'x-real-ip', 'x-management-key', 'x-hop']) {
      assert.equal(forwarded[name], undefined, `${name} must not be forwarded`);
    }
    assert.match(forwarded.host ?? '', /^127\.0\.0\.1:\d+$/);
  });

  it('streams auth-files/download with query passthrough and download headers', async () => {
    const payload = randomBytes(3 * 1024 * 1024);
    const h = await setup((req, res) => {
      if (req.url === '/v0/management/config') return void res.writeHead(200).end('{}');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="a.json"' });
      // Chunked, written in pieces.
      let offset = 0;
      const pump = () => {
        while (offset < payload.length) {
          const chunk = payload.subarray(offset, offset + 64 * 1024);
          offset += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      pump();
    });
    const reply = await request(h.base, '/v0/management/auth-files/download?name=a%20b.json', { key: CONFIGURED_KEY });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers['content-type'], 'application/octet-stream');
    assert.equal(reply.headers['content-disposition'], 'attachment; filename="a.json"');
    assert.ok(reply.body.equals(payload));
    assert.equal(h.mgmtCalls()[0].url, '/v0/management/auth-files/download?name=a%20b.json');
  });

  it('forwards api-call JSON bodies and passes the status through', async () => {
    const h = await setup((_req, res, body) => {
      res.writeHead(418, { 'Content-Type': 'application/json' }).end(JSON.stringify({ echo: JSON.parse(body.toString()) }));
    });
    const reply = await request(h.base, '/v0/management/api-call', {
      method: 'POST',
      key: CONFIGURED_KEY,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: 'https://example.invalid' }),
    });
    assert.equal(reply.status, 418);
    assert.deepEqual(reply.json(), { echo: { method: 'GET', url: 'https://example.invalid' } });
    const call = h.mgmtCalls()[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['content-type'], 'application/json');
  });

  it('rejects api-call bodies over 8 MB without calling CPA', async () => {
    const h = await setup();
    // Raw socket: announce an oversized body but never send it; the server must answer 413 up front.
    const port = new URL(h.base).port;
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(port), '127.0.0.1', () => {
        socket.write(
          'POST /v0/management/api-call HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${port}\r\nAuthorization: Bearer ${CONFIGURED_KEY}\r\n` +
            `Content-Type: application/json\r\nContent-Length: ${8 * 1024 * 1024 + 1}\r\n\r\n`,
        );
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\r\n\r\n')) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 413 /);
    assert.equal(h.mgmtCalls().length, 0);
  });

  it('maps a forwarded 401 to invalid_management_key and forgets the cached key', async () => {
    let accept = true;
    const h = await setup((req, res) => {
      if (req.url === '/v0/management/config' && accept) return void res.writeHead(200).end('{}');
      res.writeHead(401).end('{"error":"invalid management key"}');
    });
    assert.equal((await request(h.base, '/v0/management/auth-files', { key: GOOD_KEY })).status, 401);
    // First request: verify OK (1 call) + forward rejected (1 call).
    assert.equal(h.mgmtCalls().length, 2);
    accept = false;
    const again = await request(h.base, '/api/session', { key: GOOD_KEY });
    assert.equal(again.status, 401);
    assert.equal(again.json().code, 'invalid_management_key');
    assert.equal(h.mgmtCalls().length, 2, 'the rejected key must not be sent to CPA again');
    assert.equal(h.verifier.stats().budgetUsed, 1);
  });

  it('keeps every other /v0 path at 404 without calling CPA', async () => {
    const h = await setup();
    for (const path of ['/v0/management/config', '/v0/management/usage', '/v0/management/auth-files/x']) {
      const reply = await request(h.base, path, { key: CONFIGURED_KEY });
      assert.equal(reply.status, 404, path);
    }
    assert.equal((await request(h.base, '/v0/management/auth-files', { method: 'DELETE', key: CONFIGURED_KEY })).status, 405);
    assert.equal(h.mgmtCalls().length, 0);
  });

  it('requires auth before forwarding', async () => {
    const h = await setup();
    assert.equal((await request(h.base, '/v0/management/auth-files')).status, 401);
    assert.equal(h.mgmtCalls().length, 0);
  });
});
