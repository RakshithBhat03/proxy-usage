import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { closeDatabase, openDatabase } from '../db/open.ts';
import { HttpError } from '../http/respond.ts';
import { insertEvents } from './fixtures.test.ts';
import { startWorkerPool } from './pool.ts';
import { validateAnalyticsRequest } from './validate.ts';

const T0 = Date.parse('2026-10-05T00:00:00Z');
const quiet = { debug() {}, warn() {}, error() {} };

describe('worker pool', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'analytics-pool-'));
  const dbPath = path.join(dir, 'usage.sqlite');
  const writer = openDatabase(dbPath);
  insertEvents(writer, Array.from({ length: 50 }, (_, i) => ({ timestamp_ms: T0 + i * 60_000, auth_index: 'idx1' })));
  const pool = startWorkerPool({ size: 2, dbPath, log: quiet });

  after(async () => {
    await pool.close();
    closeDatabase(writer);
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs queries on read-only workers, queueing beyond the pool size', async () => {
    const request = validateAnalyticsRequest({
      from_ms: T0,
      to_ms: T0 + 3_600_000,
      time_zone: 'Asia/Kolkata',
      include: { summary: true, timeline: true, events_page: { limit: 5 } },
    });
    const results = await Promise.all(Array.from({ length: 5 }, () => pool.run<string>('analytics', request)));
    for (const json of results) {
      const res = JSON.parse(json);
      assert.equal(res.summary.total_calls, 50);
      assert.equal(res.events.items.length, 5);
      assert.equal(res.events.total_count, 50);
    }
    const windows = await pool.run<string>('account-window', [
      { index: 0, requestKey: 'k', rowKey: 'r', windowKey: '', providerWindowId: 'w', period: 'current', fromMs: T0, toMs: T0 + 3_600_000, scope: { kind: 'all', key: '', models: [], complete: true }, match: { column: 'auth_index', value: 'idx1' } },
    ]);
    assert.equal(JSON.parse(windows).items[0].total_requests, 50);
  });

  it('surfaces worker errors as HttpErrors and drops aborted queued tasks', async () => {
    await assert.rejects(pool.run('nope', {}), (err: HttpError) => err.status === 400 && err.code === 'unknown_op');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(pool.run('ping', {}, controller.signal), (err: HttpError) => err.code === 'client_closed');
  });

  it('times out a stuck task and replaces the worker', async () => {
    const fast = startWorkerPool({ size: 1, dbPath, log: quiet, timeoutMs: 1 });
    try {
      const request = validateAnalyticsRequest({ from_ms: T0, to_ms: T0 + 3_600_000, include: { summary: true, heatmap: true } });
      await assert.rejects(fast.run('analytics', request), (err: HttpError) => err.status === 504);
    } finally {
      await fast.close();
    }
  });
});
