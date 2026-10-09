import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchScope, normalizeModelScope, runAccountWindowUsage } from './accountWindow.ts';
import { createTestDb, insertEvents } from './fixtures.test.ts';
import { ValidationError } from './validate.ts';

const H = 3_600_000;
const T0 = Date.parse('2026-10-05T00:00:00Z');

describe('account window usage', () => {
  const db = createTestDb();
  insertEvents(db, [
    { timestamp_ms: T0 + 1 * H, auth_index: 'idx1', auth_file_snapshot: 'one.json', model: 'claude-a', total_tokens: 100, cost_usd: 1 },
    { timestamp_ms: T0 + 2 * H, auth_index: 'idx1', auth_file_snapshot: 'one.json', model: 'claude-b', total_tokens: 50, cost_usd: 2, failed: true },
    { timestamp_ms: T0 + 3 * H, auth_index: 'idx1', auth_file_snapshot: 'one.json', model: '', requested_model: null, total_tokens: 10, cost_usd: 0 },
    { timestamp_ms: T0 + 4 * H, auth_index: 'idx2', auth_file_snapshot: 'two.json', model: 'claude-a', total_tokens: 7, cost_usd: 0.5 },
    { timestamp_ms: T0 + 9 * H, auth_index: 'idx1', auth_file_snapshot: 'one.json', model: 'claude-a', total_tokens: 1000, cost_usd: 9 },
  ]);
  const base = { row_key: 'r', provider_window_id: 'five-hour', auth_provider_snapshot: 'claude', from_ms: T0, to_ms: T0 + 5 * H };

  it('matches by auth_index, else auth file, and sums the window', () => {
    const res = runAccountWindowUsage(db, {
      windows: [
        { ...base, request_key: 'a', auth_index: 'idx1', auth_file_snapshot: 'two.json' },
        { ...base, request_key: 'b', auth_file_snapshot: 'two.json' },
        { ...base, request_key: 'c', auth_index: 'nobody' },
      ],
    });
    const [a, b, c] = res.items;
    assert.deepEqual(
      [a.request_key, a.matched, a.total_requests, a.success_calls, a.failure_calls, a.total_tokens, a.total_cost, a.last_seen_ms, a.scope_match_status],
      ['a', true, 3, 2, 1, 160, 3, T0 + 3 * H, 'complete'],
    );
    assert.equal(a.success_rate, 2 / 3);
    assert.equal(a.sync_status, 'ready');
    assert.deepEqual([b.total_requests, b.total_tokens], [1, 7]);
    assert.deepEqual([c.matched, c.total_requests, c.success_rate, c.last_seen_ms, c.sync_status], [false, 0, null, null, 'empty']);
  });

  it('narrows to a model scope and reports unmatched requests', () => {
    const res = runAccountWindowUsage(db, {
      windows: [
        { ...base, request_key: 'm', auth_index: 'idx1', model_scope: { kind: 'models', models: ['Claude-A(high)'], complete: true } },
        { ...base, request_key: 'i', auth_index: 'idx1', model_scope: { kind: 'models', models: ['claude-a'], complete: false } },
      ],
    });
    const [m, i] = res.items;
    assert.deepEqual([m.total_requests, m.total_tokens], [1, 100]);
    assert.equal(m.scope_match_status, 'partial'); // the model-less event cannot be classified
    assert.equal(m.unmatched_requests, 1);
    assert.deepEqual([i.matched, i.scope_match_status], [false, 'unmatched']);
  });

  it('normalizes scopes like CPA Manager Plus', () => {
    assert.deepEqual(normalizeModelScope(undefined), { kind: 'all', key: '', models: [], complete: true });
    assert.equal(normalizeModelScope({ kind: 'models', models: [] }), null);
    assert.equal(normalizeModelScope({ kind: 'bogus' }), null);
    assert.equal(normalizeModelScope({ kind: 'family', key: 'claude_gpt' })!.complete, true);
    assert.deepEqual(matchScope('gpt-5', '', normalizeModelScope({ kind: 'family', key: 'claude_gpt' })!), [true, false]);
    assert.deepEqual(matchScope('gpt-5.3-codex-spark', '', normalizeModelScope({ kind: 'family', key: 'codex_main' })!), [false, false]);
  });

  it('validates the request', () => {
    const bad = (body: unknown) => () => runAccountWindowUsage(db, body);
    assert.throws(bad({ windows: [] }), ValidationError);
    assert.throws(bad({ windows: Array.from({ length: 401 }, () => ({ ...base, auth_index: 'x' })) }), /less than or equal to 400/);
    assert.throws(bad({ windows: [{ ...base, auth_index: 'x', to_ms: T0 }] }), ValidationError);
    assert.throws(bad({ windows: [{ ...base }] }), /credential identity/);
    assert.throws(bad({ windows: [{ ...base, auth_index: 'x', period: 'later' }] }), /period/);
  });
});
