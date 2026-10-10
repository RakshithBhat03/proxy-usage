/**
 * `/api/system` against a fake CLIProxyAPI (local node:http server). Synthetic keys and data only;
 * never talks to a real CPA.
 */
import assert from 'node:assert/strict';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../config.ts';
import type { AppContext } from '../context.ts';
import { openDatabase } from '../db/open.ts';
import { Router } from '../http/router.ts';
import { startHttp, type HttpHandle } from '../http/server.ts';
import { createLogger } from '../log.ts';
import { createAuthVerifier } from '../auth/verify.ts';
import type { SystemResponse } from '../../shared/system-types.ts';
import { latestFromBody, registerSystemRoutes } from './routes.ts';
import { runtimeFromConfig } from './runtime.ts';

const KEY = 'configured-test-key';

type FakeHandler = (req: IncomingMessage, res: ServerResponse) => void;

const SECRET_API_KEY = 'sk-client-secret-123';
const SECRET_PROXY = 'http://user:proxy-pass@proxy.example:3128';
const FAKE_CONFIG = {
  debug: true,
  'request-log': false,
  'logging-to-file': true,
  'ws-auth': true,
  'usage-statistics-enabled': true,
  'redis-usage-queue-retention-seconds': 60,
  'request-retry': 3,
  'max-retry-interval': 30,
  'proxy-url': SECRET_PROXY,
  'api-keys': [SECRET_API_KEY, 'sk-other'],
  'remote-management': { 'secret-key': 'hashed-secret' },
  routing: { strategy: 'fill-first' },
  tls: { enable: false },
};

/** Fake CPA running 8.0.23 whose newest release is `latest`. */
const fakeCpa =
  (latest: () => { status: number; body: string }): FakeHandler =>
  (req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"message":"CLI Proxy API Server"}');
      return;
    }
    res.setHeader('X-CPA-VERSION', '8.0.23');
    res.setHeader('X-CPA-COMMIT', 'abc1234');
    res.setHeader('X-CPA-BUILD-DATE', '2026-10-09T14:33:49Z');
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"invalid management key"}');
      return;
    }
    if (req.url === '/v0/management/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(FAKE_CONFIG));
      return;
    }
    if (req.url === '/v0/management/request-error-logs') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"files":[{"name":"a.log"},{"name":"b.log"}]}');
      return;
    }
    if (req.url === '/v0/management/latest-version') {
      const reply = latest();
      res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(reply.body);
      return;
    }
    res.writeHead(404).end();
  };

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

interface Harness {
  base: string;
  latestCalls: () => number;
  ctx: AppContext;
}

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  await Promise.all(cleanups.map((fn) => fn()));
});

async function setup(handler: FakeHandler, cpaUrl?: string): Promise<Harness> {
  let latestCalls = 0;
  const fake = http.createServer((req, res) => {
    if (req.url === '/v0/management/latest-version') latestCalls++;
    req.resume();
    req.on('end', () => handler(req, res));
  });
  const fakePort = await listen(fake);
  const config = {
    ...loadConfig({ CPA_URL: cpaUrl ?? `http://127.0.0.1:${fakePort}`, CPA_MANAGEMENT_KEY: KEY, COLLECTOR_MODE: 'off' }, []),
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
  };
  const log = createLogger('error');
  const ctx: AppContext = {
    config,
    log,
    db: openDatabase(':memory:'),
    router: new Router(),
    startedAtMs: Date.now(),
    requireAuth: createAuthVerifier({ config, log }),
  };
  registerSystemRoutes(ctx);
  const app: HttpHandle = await startHttp(ctx);
  cleanups.push(async () => {
    await app.close(100);
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    ctx.db.close();
  });
  return { base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, latestCalls: () => latestCalls, ctx };
}

async function getSystem(base: string, query = '', key = KEY): Promise<{ status: number; body: SystemResponse }> {
  const res = await fetch(`${base}/api/system${query}`, { headers: { Authorization: `Bearer ${key}` } });
  return { status: res.status, body: (await res.json()) as SystemResponse };
}

describe('GET /api/system', () => {
  it('requires a management key', async () => {
    const h = await setup(fakeCpa(() => ({ status: 200, body: '{"latest-version":"v8.0.23"}' })));
    const res = await fetch(`${h.base}/api/system`);
    assert.equal(res.status, 401);
    assert.equal(h.latestCalls(), 0);
  });

  it('reports the CPA build and an available update', async () => {
    const h = await setup(fakeCpa(() => ({ status: 200, body: '{"latest-version":"v8.1.0"}' })));
    const { status, body } = await getSystem(h.base);
    assert.equal(status, 200);
    assert.equal(body.cpa.reachable, true);
    assert.equal(body.cpa.version, '8.0.23');
    assert.equal(body.cpa.commit, 'abc1234');
    assert.equal(body.cpa.build_date, '2026-10-09T14:33:49Z');
    assert.equal(body.cpa.latest_version, 'v8.1.0');
    assert.equal(body.cpa.update_available, true);
    assert.equal(body.cpa.release_url, 'https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.1.0');
    assert.equal(body.collector.state, 'disabled');
    assert.equal(body.db.events, 0);
    assert.equal(body.db.schema_version > 0, true);
    assert.equal(body.cpa.error_log_files, 2);
    assert.deepEqual(body.cpa.runtime, {
      routing_strategy: 'fill-first',
      request_retry: 3,
      max_retry_interval_s: 30,
      proxy_configured: true,
      api_keys: 2,
      usage_queue_retention_s: 60,
      flags: {
        usage_statistics: true,
        request_log: false,
        logging_to_file: true,
        debug: true,
        ws_auth: true,
        tls: false,
        plugins: null,
        cooling_disabled: null,
      },
    });
  });

  it('never returns config secrets', async () => {
    const h = await setup(fakeCpa(() => ({ status: 200, body: '{"latest-version":"v8.0.23"}' })));
    const res = await fetch(`${h.base}/api/system`, { headers: { Authorization: `Bearer ${KEY}` } });
    const text = await res.text();
    for (const secret of [SECRET_API_KEY, 'proxy-pass', 'proxy.example', 'hashed-secret', KEY]) {
      assert.equal(text.includes(secret), false, `leaked ${secret}`);
    }
  });

  it('says up to date when the versions match, and caches the check', async () => {
    const h = await setup(fakeCpa(() => ({ status: 200, body: '{"latest-version":"v8.0.23"}' })));
    const first = await getSystem(h.base);
    assert.equal(first.body.cpa.update_available, false);
    await getSystem(h.base);
    assert.equal(h.latestCalls(), 1);
    // A forced refresh inside the minimum interval still reuses the last answer.
    await getSystem(h.base, '?refresh=1');
    assert.equal(h.latestCalls(), 1);
  });

  it('reports a failed check without failing the page', async () => {
    const h = await setup(fakeCpa(() => ({ status: 502, body: '{"error":"github unreachable"}' })));
    const { status, body } = await getSystem(h.base);
    assert.equal(status, 200);
    assert.equal(body.cpa.latest_version, null);
    assert.equal(body.cpa.latest_error, 'github unreachable');
    assert.equal(body.cpa.update_available, null);
  });

  it('reports an unreachable CPA', async () => {
    const h = await setup(fakeCpa(() => ({ status: 200, body: '{}' })), 'http://127.0.0.1:9');
    const { status, body } = await getSystem(h.base);
    assert.equal(status, 200);
    assert.equal(body.cpa.reachable, false);
    assert.equal(body.cpa.latency_ms, null);
    assert.ok(body.cpa.latest_error);
    assert.equal(body.cpa.runtime, null);
    assert.ok(body.cpa.runtime_error);
  });
});

describe('runtimeFromConfig', () => {
  it('reads the v8 nested layout too', () => {
    const runtime = runtimeFromConfig({
      observability: { usage: { 'usage-statistics-enabled': false, 'redis-usage-queue-retention-seconds': 120 } },
      'proxy-url': '',
    });
    assert.equal(runtime.flags.usage_statistics, false);
    assert.equal(runtime.usage_queue_retention_s, 120);
    assert.equal(runtime.proxy_configured, false);
    assert.equal(runtime.routing_strategy, null);
    assert.equal(runtime.api_keys, null);
  });
});

describe('latestFromBody', () => {
  it('reads the CPA field and tolerates other shapes', () => {
    assert.equal(latestFromBody('{"latest-version":"v8.0.24"}'), 'v8.0.24');
    assert.equal(latestFromBody('{"latest_version":"8.0.24"}'), '8.0.24');
    assert.equal(latestFromBody('{}'), null);
    assert.equal(latestFromBody('not json'), null);
  });
});
