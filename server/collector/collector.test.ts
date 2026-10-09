/**
 * End-to-end collector tests against a local fake CLIProxyAPI that serves the management HTTP API
 * and RESP on one port (CPA sniffs the protocol the same way). Synthetic data only.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../config.ts';
import type { AppContext } from '../context.ts';
import { RespParser, encodeCommand } from '../cpa/resp.ts';
import { openDatabase } from '../db/open.ts';
import { createLogger } from '../log.ts';
import { startCollector, type CollectorTimings } from './index.ts';

const KEY = 'test-management-key';

interface FakeCpaOptions {
  usageEnabled?: boolean;
  configStatus?: number;
  respAuth?: 'ok' | 'reject';
  subscribe?: 'ok' | 'unsupported';
  queue?: Array<Record<string, unknown>>;
  authFiles?: Array<Record<string, unknown>>;
}

interface FakeCpa {
  url: string;
  http: string[];
  resp: string[];
  usageEnabled: boolean;
  queue: Array<Record<string, unknown>>;
  publish(payload: string): void;
  dropSubscribers(): void;
  close(): Promise<void>;
}

async function fakeCpa(options: FakeCpaOptions = {}): Promise<FakeCpa> {
  const subscribers = new Set<net.Socket>();
  const sockets = new Set<net.Socket>();
  const state: FakeCpa = {
    url: '',
    http: [],
    resp: [],
    usageEnabled: options.usageEnabled ?? true,
    queue: [...(options.queue ?? [])],
    publish(payload) {
      const frame = encodeCommand(['message', 'usage', payload]);
      for (const s of subscribers) s.write(frame);
    },
    dropSubscribers() {
      for (const s of subscribers) s.destroy();
      subscribers.clear();
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };

  const httpResponse = (socket: net.Socket, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    socket.write(
      `HTTP/1.1 ${status} X\r\nContent-Type: application/json\r\nX-CPA-VERSION: 9.9.9-test\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
    );
  };

  const handleHttp = (socket: net.Socket, method: string, target: string, headers: Record<string, string>, body: string) => {
    const url = new URL(target, 'http://fake');
    state.http.push(`${method} ${url.pathname}`);
    if (headers.authorization !== `Bearer ${KEY}`) return httpResponse(socket, 401, { error: 'invalid management key' });
    if (url.pathname === '/v0/management/config') {
      if (options.configStatus) return httpResponse(socket, options.configStatus, { error: 'nope' });
      return httpResponse(socket, 200, {
        'usage-statistics-enabled': state.usageEnabled,
        'redis-usage-queue-retention-seconds': 60,
        'api-keys': ['sk-config-secret-should-never-be-logged'],
      });
    }
    if (url.pathname === '/v0/management/usage-statistics-enabled') {
      if (method === 'PUT') state.usageEnabled = (JSON.parse(body) as { value: boolean }).value;
      return httpResponse(socket, 200, { 'usage-statistics-enabled': state.usageEnabled });
    }
    if (url.pathname === '/v0/management/auth-files') return httpResponse(socket, 200, { files: options.authFiles ?? [] });
    if (url.pathname === '/v0/management/usage-queue') {
      const count = Number(url.searchParams.get('count') ?? '1');
      return httpResponse(socket, 200, state.queue.splice(0, count));
    }
    return httpResponse(socket, 404, { error: 'not found' });
  };

  const serveHttp = (socket: net.Socket, first: Buffer) => {
    let buf = first;
    const drain = () => {
      for (;;) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString().split('\r\n');
        const [method, target] = head[0].split(' ');
        const headers: Record<string, string> = {};
        for (const line of head.slice(1)) {
          const i = line.indexOf(':');
          headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        const length = Number(headers['content-length'] ?? 0);
        if (buf.length < end + 4 + length) return;
        const body = buf.subarray(end + 4, end + 4 + length).toString();
        buf = buf.subarray(end + 4 + length);
        handleHttp(socket, method, target, headers, body);
      }
    };
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      drain();
    });
    drain();
  };

  const serveResp = (socket: net.Socket, first: Buffer) => {
    const parser = new RespParser();
    const handle = (chunk: Buffer) => {
      for (const value of parser.push(chunk)) {
        if (!Array.isArray(value)) continue;
        const [command, arg] = value.map(String);
        state.resp.push(command);
        if (command === 'AUTH') socket.write(options.respAuth === 'reject' || arg !== KEY ? '-ERR invalid management key\r\n' : '+OK\r\n');
        else if (command === 'SUBSCRIBE') {
          if (options.subscribe === 'unsupported') socket.write("-ERR unknown command 'SUBSCRIBE'\r\n");
          else {
            socket.write(`*3\r\n$9\r\nsubscribe\r\n$${Buffer.byteLength(arg)}\r\n${arg}\r\n:1\r\n`);
            subscribers.add(socket);
          }
        } else if (command === 'PING') socket.write('*2\r\n$4\r\npong\r\n$0\r\n\r\n');
      }
    };
    socket.on('data', handle);
    handle(first);
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      subscribers.delete(socket);
    });
    socket.on('error', () => {});
    socket.once('data', (first: Buffer) => (first[0] === 0x2a ? serveResp(socket, first) : serveHttp(socket, first)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return state;
}

function makeCtx(url: string, env: Record<string, string> = {}): AppContext {
  const config = loadConfig({ CPA_URL: url, CPA_MANAGEMENT_KEY: KEY, COLLECTOR_POLL_MS: '100', ...env }, []);
  return {
    config,
    log: createLogger('error'),
    db: openDatabase(':memory:'),
    startedAtMs: Date.now(),
  } as unknown as AppContext;
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const FAST: Partial<CollectorTimings> = { backoffBaseMs: 20, backoffMaxMs: 50, random: () => 0.5 };

function usage(i: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: `2026-03-04T10:00:0${i}.5Z`,
    request_id: `req-${i}`,
    model: 'claude-test-4',
    provider: 'claude',
    executor_type: 'ClaudeExecutor',
    endpoint: 'POST /v1/messages',
    auth_index: 'idx-claude',
    source: 'user@example.com',
    api_key: 'sk-test-e2e-00000000000000000000000000',
    latency_ms: 10 * i,
    tokens: { input_tokens: 10, output_tokens: 5 },
    ...extra,
  };
}

const count = (ctx: AppContext) => (ctx.db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n;

describe('collector', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  after(async () => {
    for (const fn of cleanups.reverse()) await fn();
  });

  it('subscribes via RESP, drains the queue, enriches and stores events', async () => {
    const cpa = await fakeCpa({
      usageEnabled: false,
      queue: [usage(1), usage(2)],
      authFiles: [{ auth_index: 'idx-claude', name: 'claude-user.json', provider: 'claude', email: 'user@example.com' }],
    });
    cleanups.push(() => cpa.close());
    const ctx = makeCtx(cpa.url);
    const collector = startCollector(ctx, FAST);
    await waitFor(() => collector.status().state === 'running' && count(ctx) === 2);

    cpa.publish(JSON.stringify(usage(3)));
    cpa.publish(JSON.stringify(usage(1))); // duplicate of a drained record
    cpa.publish('{"support_refresh":true}');
    cpa.publish('{"refresh":true}');
    cpa.publish('not json');
    await waitFor(() => collector.status().counts.duplicates === 1 && count(ctx) === 3);

    const status = collector.status();
    assert.equal(status.transport, 'resp');
    assert.equal(status.cpa_version, '9.9.9-test');
    assert.equal(status.usage_statistics_enabled, true);
    assert.equal(status.usage_statistics_auto_enabled, true);
    assert.equal(cpa.usageEnabled, true);
    assert.deepEqual(status.counts, { received: 5, inserted: 3, duplicates: 1, dead_letters: 1, reconnects: 1 });
    assert.ok(cpa.http.includes('PUT /v0/management/usage-statistics-enabled'));

    const row = ctx.db.prepare("SELECT auth_file_snapshot, account_snapshot, api_key_hash FROM events WHERE request_id = 'req-3'").get() as Record<
      string,
      string
    >;
    assert.equal(row.auth_file_snapshot, 'claude-user.json');
    assert.equal(row.account_snapshot, 'user@example.com');
    const snap = ctx.db.prepare('SELECT file_name FROM auth_snapshots').get() as { file_name: string };
    assert.equal(snap.file_name, 'claude-user.json');
    const dead = ctx.db.prepare('SELECT source, payload FROM dead_letters').all() as Array<Record<string, string>>;
    assert.equal(dead.length, 1);
    assert.equal(dead[0].source, 'resp');
    assert.ok(!JSON.stringify(ctx.db.prepare('SELECT * FROM events').all()).includes('sk-test-e2e'));

    // Reconnect after the server drops the subscription.
    cpa.dropSubscribers();
    await waitFor(() => collector.status().counts.reconnects === 2 && collector.status().state === 'running');
    cpa.publish(JSON.stringify(usage(4)));
    await waitFor(() => count(ctx) === 4);

    await collector.stop();
    assert.equal(collector.status().state, 'stopped');
    ctx.db.close();
  });

  it('stops after one rejected key (HTTP 401) and waits the long auth backoff', async () => {
    const cpa = await fakeCpa();
    cleanups.push(() => cpa.close());
    const ctx = makeCtx(cpa.url, { CPA_MANAGEMENT_KEY: 'wrong-key' });
    const collector = startCollector(ctx, FAST);
    await waitFor(() => collector.status().state === 'auth_failed');
    await new Promise((r) => setTimeout(r, 200));
    const status = collector.status();
    assert.equal(status.state, 'auth_failed');
    assert.ok((status.next_retry_at_ms ?? 0) - Date.now() > 14 * 60_000);
    assert.equal(cpa.http.length, 1, 'exactly one management request with the bad key');
    assert.equal(cpa.resp.length, 0);
    await collector.stop();
    ctx.db.close();
  });

  it('treats a RESP AUTH error as an auth failure', async () => {
    const cpa = await fakeCpa({ respAuth: 'reject' });
    cleanups.push(() => cpa.close());
    const ctx = makeCtx(cpa.url);
    const collector = startCollector(ctx, FAST);
    await waitFor(() => collector.status().state === 'auth_failed');
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(cpa.resp, ['AUTH']);
    await collector.stop();
    ctx.db.close();
  });

  it('backs off for a long time on 403', async () => {
    const cpa = await fakeCpa({ configStatus: 403 });
    cleanups.push(() => cpa.close());
    const ctx = makeCtx(cpa.url);
    const collector = startCollector(ctx, FAST);
    await waitFor(() => collector.status().last_error !== null);
    const status = collector.status();
    assert.equal(status.state, 'backoff');
    assert.ok((status.next_retry_at_ms ?? 0) - Date.now() > 29 * 60_000);
    await collector.stop();
    ctx.db.close();
  });

  it('falls back to HTTP polling when SUBSCRIBE is unsupported (auto)', async () => {
    const cpa = await fakeCpa({ subscribe: 'unsupported', queue: [usage(1)] });
    cleanups.push(() => cpa.close());
    const ctx = makeCtx(cpa.url);
    const collector = startCollector(ctx, { ...FAST, upgradeIntervalMs: 150 });
    await waitFor(() => collector.status().transport === 'http' && count(ctx) === 1);
    cpa.queue.push(usage(2));
    await waitFor(() => count(ctx) === 2);
    // The RESP upgrade is retried after upgradeIntervalMs.
    await waitFor(() => cpa.resp.filter((c) => c === 'SUBSCRIBE').length >= 2);
    await collector.stop();
    ctx.db.close();
  });

  it('retries transient failures with backoff', async () => {
    // Nothing listens on this port.
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const ctx = makeCtx(`http://127.0.0.1:${port}`);
    const collector = startCollector(ctx, FAST);
    await waitFor(() => collector.status().state === 'backoff');
    assert.match(String(collector.status().last_error), /ECONNREFUSED/);
    await collector.stop();
    ctx.db.close();
  });

  it('is disabled without a key or with COLLECTOR_MODE=off', async () => {
    const noKey = makeCtx('http://127.0.0.1:1', { CPA_MANAGEMENT_KEY: '' });
    const a = startCollector(noKey);
    assert.equal(a.status().state, 'disabled');
    assert.match(String(a.status().disabled_reason), /CPA_MANAGEMENT_KEY/);
    const off = makeCtx('http://127.0.0.1:1', { COLLECTOR_MODE: 'off' });
    const b = startCollector(off);
    assert.equal(b.status().state, 'disabled');
    assert.equal(b.status().mode, 'off');
    await a.stop();
    await b.stop();
    noKey.db.close();
    off.db.close();
  });
});
