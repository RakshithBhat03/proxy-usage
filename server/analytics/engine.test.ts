import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AnalyticsResponse, TimelinePoint } from '../../shared/analytics-types.ts';
import { apiKeyGroupKey, buildAnomalyPoints, percentChange, runAnalytics } from './engine.ts';
import { createTestDb, insertEvents, type FixtureEvent } from './fixtures.test.ts';
import { validateAnalyticsRequest, ValidationError } from './validate.ts';

const H = 3_600_000;
const T0 = Date.parse('2026-10-05T00:00:00Z');
const KEY_A = 'a'.repeat(64);

function query(db: ReturnType<typeof createTestDb>, body: Record<string, unknown>): AnalyticsResponse {
  return JSON.parse(runAnalytics(db, validateAnalyticsRequest({ from_ms: T0, to_ms: T0 + 48 * H, time_zone: 'UTC', ...body })));
}

describe('summary', () => {
  const db = createTestDb();
  // 20 successful claude events with latency 100..2000 and ttft 10..200; 2 failures; 1 zero-token success.
  const events: FixtureEvent[] = Array.from({ length: 20 }, (_, i) => ({
    timestamp_ms: T0 + i * H,
    latency_ms: (i + 1) * 100,
    ttft_ms: (i + 1) * 10,
    input_tokens: 1000,
    cache_read_tokens: 400,
    cached_tokens: 100,
    output_tokens: 50,
    total_tokens: 1050,
    session_id: i < 10 ? 'session-a' : 'session-b',
    cost_usd: 0.5,
  }));
  events.push(
    { timestamp_ms: T0 + 25 * H, failed: true, latency_ms: 0, ttft_ms: null, session_id: 'session-b', cost_usd: null },
    { timestamp_ms: T0 + 26 * H, failed: true, latency_ms: 5000, model: 'gpt-x(high)', provider: 'codex', session_id: '' },
    { timestamp_ms: T0 + 27 * H, input_tokens: 0, output_tokens: 0, total_tokens: 0, model: 'zero-model', cost_usd: 0 },
  );
  insertEvents(db, events);

  it('computes full-profile totals, rates, percentiles and sessions', () => {
    const res = query(db, { now_ms: T0 + 27.25 * H, include: { summary: true, summary_profile: 'full' } });
    const s = res.summary!;
    assert.equal(s.total_calls, 23);
    assert.equal(s.success_calls, 21);
    assert.equal(s.failure_calls, 2);
    assert.equal(s.success_rate, 21 / 23);
    assert.equal(s.input_tokens, 20 * 1000 + 200);
    assert.equal(s.cache_read_tokens, 8000);
    assert.equal(s.cache_hit_rate, (20 * 500) / 20200);
    assert.equal(s.total_cost, 10 + 0.01);
    assert.equal(s.average_cost_per_call, 10.01 / 23);
    // latency 0 excluded from the average; failures with latency included.
    assert.equal(s.average_latency_ms, (21_000 + 5000 + 1000) / 22);
    // nearest rank over 22 positive latencies: index ceil(22*0.95)-1 = 20 → sorted[20]
    const sorted = [...Array.from({ length: 20 }, (_, i) => (i + 1) * 100), 5000, 1000].sort((a, b) => a - b);
    assert.equal(s.p95_latency_ms, sorted[20]);
    assert.equal(s.zero_token_calls, 1);
    assert.deepEqual(s.zero_token_models, ['zero-model']);
    assert.equal(s.sessions, 2);
    assert.equal(s.session_failures, 1);
    assert.equal(s.session_success_rate, 0.5);
    // rolling 30m before now: only the event at T0+27h
    assert.equal(s.rpm_30m, 1 / 30);
    assert.equal(s.tpm_30m, 0);
    // two UTC days with traffic
    assert.equal(s.avg_daily_requests, 23 / 2);
  });

  it('compact profile skips the full-only metrics', () => {
    const s = query(db, { include: { summary: true, summary_profile: 'compact' } }).summary!;
    assert.equal(s.total_calls, 23);
    assert.equal(s.p95_latency_ms, null);
    assert.equal(s.rpm_30m, 0);
    assert.equal(s.sessions, 0);
    assert.equal(s.zero_token_models, null);
    const withP95 = query(db, { include: { summary: true, summary_profile: 'compact', summary_percentiles: true } }).summary!;
    assert.ok(withP95.p95_latency_ms !== null && withP95.p95_ttft_ms !== null);
  });

  it('adds the previous equal-length window', () => {
    const res = query(db, { from_ms: T0 + 24 * H, to_ms: T0 + 48 * H, include: { summary: true, summary_comparison: true } });
    assert.equal(res.summary!.total_calls, 3);
    assert.deepEqual(
      { ...res.summary_comparison, total_cost: Math.round(res.summary_comparison!.total_cost * 100) / 100 },
      { from_ms: T0, to_ms: T0 + 24 * H, total_calls: 20, success_calls: 20, failure_calls: 0, success_rate: 1, total_tokens: 21_000, total_cost: 10 },
    );
  });

  it('builds model × tier stats with CPAMP speed semantics', () => {
    const res = query(db, { include: { model_tier_stats: true, model_stats: true } });
    const claude = res.model_tier_stats!.find((m) => m.model === 'claude-test')!;
    assert.equal(claude.service_tier, 'normal');
    assert.equal(claude.calls, 21);
    // TPS: mean of output*1000/latency over rows with output>0 and latency>0 (failed rows included)
    const tps = Array.from({ length: 20 }, (_, i) => (50 * 1000) / ((i + 1) * 100));
    assert.ok(Math.abs(claude.output_tps! - tps.reduce((a, b) => a + b) / 20) < 1e-9);
    assert.equal(claude.tps_samples, 20);
    assert.equal(claude.average_ttft_ms, 105);
    const gpt = res.model_tier_stats!.find((m) => m.model === 'gpt-x')!;
    assert.equal(gpt.tps_samples, 1); // failed but has output and latency
    assert.equal(gpt.average_latency_ms, null); // success-only
    assert.equal(res.model_stats![0].model, 'claude-test');
  });
});

describe('filters', () => {
  const db = createTestDb();
  insertEvents(db, [
    { timestamp_ms: T0 + 1, model: 'claude-a', provider: 'claude', auth_index: 'idx1', auth_file_snapshot: 'f1.json', cache_read_tokens: 10, latency_ms: 500 },
    { timestamp_ms: T0 + 2, model: 'gpt-b(high)', requested_model: 'gpt-b(high)', provider: 'codex', auth_index: 'idx2', auth_file_snapshot: 'f2.json', cache_creation_tokens: 5, latency_ms: 5000, failed: true },
    { timestamp_ms: T0 + 3, model: 'gpt-b', provider: 'codex', auth_index: 'idx2', auth_file_snapshot: null, source_hash: 'shx', api_key_hash: KEY_A, latency_ms: 2000, account_snapshot: 'Person@Example.test' },
    { timestamp_ms: T0 + 4, model: 'claude-c', provider: 'claude', auth_index: 'idx3', auth_file_snapshot: 'f3.json', cached_tokens: 7 },
  ]);
  const count = (body: Record<string, unknown>) => query(db, { ...body, include: { summary: true } }).summary!.total_calls;

  it('applies each filter', () => {
    assert.equal(count({ filters: { providers: ['CODEX'] } }), 2);
    assert.equal(count({ filters: { models: ['gpt-b(high)', ' gpt-b '] } }), 2);
    assert.equal(count({ filters: { credential_ids: ['f1.json', 'idx2'] } }), 2);
    assert.equal(count({ filters: { auth_indices: ['idx2'] } }), 2);
    assert.equal(count({ filters: { auth_files: ['f3.json'] } }), 1);
    assert.equal(count({ filters: { include_failed: false } }), 3);
    assert.equal(count({ filters: { failed_only: true } }), 1);
    assert.equal(count({ filters: { min_latency_ms: 2000 } }), 2);
    assert.equal(count({ filters: { cache_status: 'hit' } }), 3);
    assert.equal(count({ filters: { cache_status: 'miss' } }), 1);
    assert.equal(count({ filters: { cache_status: 'read' } }), 1);
    assert.equal(count({ filters: { cache_status: 'creation' } }), 1);
    assert.equal(count({ filters: { accounts: ['person@example.test'] } }), 1);
    assert.equal(count({ filters: { api_key_hashes: [KEY_A] } }), 1);
    assert.equal(count({ filters: { providers: ['codex'], models: ['claude-a'] } }), 0);
    assert.equal(count({ filters: { models: [] } }), 4);
  });

  it('searches the haystack and ORs the exact api key hash', () => {
    assert.equal(count({ search_query: 'CLAUDE' }), 2);
    assert.equal(count({ search_query: 'claude', search_api_key_hash: KEY_A.toUpperCase() }), 3);
    assert.equal(count({ search_api_key_hash: KEY_A }), 1);
  });

  it('selector lists ignore request filters', () => {
    const res = query(db, { filters: { providers: ['codex'] }, include: { filter_options: true, filter_selectors: true } });
    assert.deepEqual(res.filter_options!.models, ['claude-a', 'claude-c', 'gpt-b']);
    assert.deepEqual(res.filter_options!.providers, ['claude', 'codex']);
    assert.deepEqual(res.filter_options!.api_key_hashes, [KEY_A]);
    assert.equal(res.filter_options!.api_key_count, 4);
  });

  it('groups credentials and API keys', () => {
    const res = query(db, { include: { credential_stats: true, api_key_stats: true, channel_share: true, failure_sources: true } });
    assert.deepEqual(res.credential_stats!.map((c) => c.id).sort(), ['f1.json', 'f2.json', 'f3.json', 'idx2']);
    const f2 = res.credential_stats!.find((c) => c.id === 'f2.json')!;
    assert.deepEqual(f2.models!.map((m) => m.model), ['gpt-b']);
    assert.equal(f2.failure_calls, 1);
    const keyed = res.api_key_stats!.find((k) => k.id === KEY_A)!;
    assert.equal(keyed.calls, 1);
    assert.ok(res.api_key_stats!.some((k) => k.id.startsWith('unknown-client-api-key:sh-1:idx1:')));
    assert.equal(apiKeyGroupKey('', '', 'i', '', ''), 'unknown-client-api-key:-:i:-:-');
    assert.equal(res.channel_share!.find((c) => c.auth_index === 'idx2')!.calls, 2);
    assert.deepEqual(res.failure_sources!.map((f) => [f.auth_index, f.calls, f.failure]), [['idx2', 1, 1]]);
  });

  it('rejects invalid requests', () => {
    const bad = (body: Record<string, unknown>) => () => validateAnalyticsRequest({ from_ms: T0, to_ms: T0 + H, ...body });
    assert.throws(bad({ time_zone: 'Mars/Base' }), (err: ValidationError) => err.code === 'invalid_time_zone');
    assert.throws(bad({ to_ms: T0 }), ValidationError);
    assert.throws(bad({ from_ms: 'x' }), ValidationError);
    assert.throws(bad({ include: { events_page: { limit: 50_001 } } }), ValidationError);
    assert.equal(validateAnalyticsRequest({ from_ms: T0, to_ms: T0 + H, include: { drilldown_preview: { from_ms: T0, to_ms: T0 + 1, limit: 500 } } }).include.drilldown!.limit, 100);
    assert.equal(validateAnalyticsRequest({ from_ms: T0, to_ms: T0 + 25 * H }).granularity, 'day');
    assert.equal(validateAnalyticsRequest({ from_ms: T0, to_ms: T0 + 24 * H }).granularity, 'hour');
  });
});

describe('events page', () => {
  const db = createTestDb();
  // 25 events over 5 distinct timestamps (5 rows share each ms) to exercise the (ms, id) cursor.
  insertEvents(
    db,
    Array.from({ length: 25 }, (_, i) => ({
      timestamp_ms: T0 + Math.floor(i / 5) * 1000,
      response_metadata_json: i === 24 ? '{"trace":{"cf_ray":"abc"}}' : null,
      latency_ms: i === 0 ? null : 100,
      fail_summary: i === 1 ? 'boom' : null,
      failed: i === 1,
      generate: i === 2 ? true : null,
      user_agent: i === 3 ? '' : 'ua',
    })),
  );

  it('pages newest first with a keyset cursor and no duplicates', () => {
    const seen: string[] = [];
    let before: Record<string, number> = {};
    let pages = 0;
    for (;;) {
      const page = query(db, { include: { events_page: { limit: 10, ...before } } }).events!;
      assert.equal(page.total_count, 25);
      pages++;
      for (let i = 1; i < page.items.length; i++) assert.ok(page.items[i - 1].timestamp_ms >= page.items[i].timestamp_ms);
      seen.push(...page.items.map((e) => e.event_hash));
      if (!page.has_more) {
        assert.equal(page.next_before_ms, 0);
        break;
      }
      before = { before_ms: page.next_before_ms, before_id: page.next_before_id };
    }
    assert.equal(pages, 3);
    assert.equal(new Set(seen).size, 25);
  });

  it('writes EventRow JSON with omitempty semantics', () => {
    const items = query(db, { include: { events_page: { limit: 50_000 } } }).events!.items;
    const newest = items[0];
    assert.deepEqual(newest.response_metadata, { trace: { cf_ray: 'abc' } });
    assert.equal(newest.failed, false);
    assert.equal(newest.fail_status_code, 200);
    assert.ok(!('client_ip' in newest));
    assert.equal(newest.analytics_model, 'claude-test');
    const oldest = items[items.length - 1];
    assert.equal(oldest.latency_ms, null);
    assert.ok(!('response_metadata' in oldest));
    const failed = items.find((e) => e.failed)!;
    assert.equal(failed.fail_summary, 'boom');
    assert.equal(items.find((e) => e.generate === true)!.generate, true);
    assert.ok(items.some((e) => !('user_agent' in e)));
    assert.ok(items.every((e) => !('cost' in e) && !('stream' in e)));
  });

  it('serves the drilldown preview with its own range', () => {
    const res = query(db, { include: { summary: true, drilldown_preview: { from_ms: T0, to_ms: T0 + 1000, limit: 3 } } });
    assert.equal(res.drilldown_preview!.items.length, 3);
    assert.equal(res.drilldown_preview!.total_count, 3);
    assert.ok(res.drilldown_preview!.items.every((e) => e.timestamp_ms === T0));
  });
});

describe('timeline, heatmap and anomalies', () => {
  it('buckets by local hour/day in the requested zone', () => {
    const db = createTestDb();
    insertEvents(db, [
      { timestamp_ms: Date.parse('2026-10-05T18:29:00Z'), cost_usd: 1 }, // 23:59 IST Oct 5
      { timestamp_ms: Date.parse('2026-10-05T18:31:00Z'), cost_usd: 2 }, // 00:01 IST Oct 6
      { timestamp_ms: Date.parse('2026-10-05T18:45:00Z'), cost_usd: 3, latency_ms: 9000 },
    ]);
    const body = { from_ms: Date.parse('2026-10-05T00:00:00Z'), to_ms: Date.parse('2026-10-07T00:00:00Z'), time_zone: 'Asia/Kolkata' };
    const hours = query(db, { ...body, include: { timeline: true, granularity: 'hour', hourly_distribution: true } });
    assert.deepEqual(hours.timeline!.map((p) => [new Date(p.bucket_ms).toISOString(), p.label, p.calls, p.cost]), [
      ['2026-10-05T17:30:00.000Z', '23:00', 1, 1],
      ['2026-10-05T18:30:00.000Z', '00:00', 2, 5],
    ]);
    assert.equal(hours.timeline![1].p95_latency_ms, 9000);
    assert.deepEqual(hours.hourly_distribution!.map((p) => [p.hour, p.calls]), [[0, 2], [23, 1]]);
    const days = query(db, { ...body, include: { timeline: true, granularity: 'day', heatmap: true } });
    assert.deepEqual(days.timeline!.map((p) => [new Date(p.bucket_ms).toISOString(), p.label, p.calls]), [
      ['2026-10-04T18:30:00.000Z', '10/05', 1],
      ['2026-10-05T18:30:00.000Z', '10/06', 2],
    ]);
    // Oct 5 2026 is a Monday, Oct 6 a Tuesday.
    assert.deepEqual(days.heatmap!.map((p) => [p.weekday, p.hour, p.calls]), [[1, 23, 1], [2, 0, 2]]);
    assert.deepEqual(days.heatmap![1].model_contributors!.map((c) => [c.key, c.share]), [['claude-test', 1]]);
    assert.equal(days.heatmap![1].api_key_contributors, undefined);
  });

  it('caps heatmap contributors at five', () => {
    const db = createTestDb();
    insertEvents(db, Array.from({ length: 7 }, (_, i) => ({ timestamp_ms: T0 + i, model: `m${i}` })));
    const cell = query(db, { include: { heatmap: true } }).heatmap![0];
    assert.equal(cell.calls, 7);
    assert.equal(cell.model_contributors!.length, 5);
  });

  it('flags spikes against the previous bucket', () => {
    const point = (i: number, over: Partial<TimelinePoint>): TimelinePoint => ({
      bucket_ms: T0 + i * H, label: '', calls: 10, tokens: 1000, success: 10, failure: 0, input_tokens: 1000, output_tokens: 0,
      cached_tokens: 0, cache_read_tokens: 800, cache_creation_tokens: 0, cache_hit_rate: 0.8, reasoning_tokens: 0,
      total_tokens: 1000, cost: 1, average_latency_ms: 100, p95_latency_ms: 100, p95_ttft_ms: null, success_rate: 1, failure_rate: 0,
      ...over,
    });
    const anomalies = buildAnomalyPoints(
      [
        point(0, {}),
        point(1, { calls: 30, total_tokens: 3000, cost: 5, p95_latency_ms: 200 }), // request, cost, latency
        point(2, { calls: 30, total_tokens: 3000, cost: 5, cache_hit_rate: 0.5, failure_rate: 0.3 }), // cache drop + failure
        point(3, { calls: 30, total_tokens: 3000, cost: 5 }),
      ],
      'hour',
    );
    assert.deepEqual(anomalies.map((a) => [a.bucket_ms, a.severity, a.metric_keys]), [
      [T0 + H, 'high', ['request_spike', 'cost_spike', 'latency_spike']],
      [T0 + 2 * H, 'medium', ['cache_hit_drop', 'failure_rate_spike']],
    ]);
    assert.equal(anomalies[0].bucket_end_ms, T0 + 2 * H);
    assert.equal(percentChange(5, 0), 1);
    assert.equal(percentChange(0, 0), 0);
    assert.deepEqual(buildAnomalyPoints([point(0, {})], 'hour'), []);
  });

  it('omits empty sections', () => {
    const db = createTestDb();
    const res = query(db, { include: { timeline: true, heatmap: true, credential_stats: true, summary: true } });
    assert.equal(res.timeline, undefined);
    assert.equal(res.heatmap, undefined);
    assert.equal(res.summary!.total_calls, 0);
    assert.equal(res.summary!.average_latency_ms, null);
  });
});

describe('execution paths', () => {
  /** Deep equality with a relative tolerance for floats (sums run in a different order). */
  function assertClose(actual: unknown, expected: unknown, at = '$'): void {
    if (typeof actual === 'number' && typeof expected === 'number') {
      const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
      assert.ok(Math.abs(actual - expected) <= 1e-9 * scale, `${at}: ${actual} != ${expected}`);
      return;
    }
    if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
      assert.equal(Array.isArray(actual), Array.isArray(expected), at);
      const a = actual as Record<string, unknown>;
      const e = expected as Record<string, unknown>;
      assert.deepEqual(Object.keys(a), Object.keys(e), at);
      for (const key of Object.keys(e)) assertClose(a[key], e[key], `${at}.${key}`);
      return;
    }
    assert.deepEqual(actual, expected, at);
  }

  // Deterministic pseudo-random events across the 2026 US fall-back, with identity gaps.
  const db = createTestDb();
  let state = 42;
  const rand = (n: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % n;
  };
  const start = Date.parse('2026-10-28T00:00:00Z');
  const events: FixtureEvent[] = Array.from({ length: 1500 }, () => {
    const cred = rand(5);
    return {
      timestamp_ms: start + rand(10 * 24 * 60) * 60_000 + rand(60_000),
      model: ['claude-a', 'gpt-b', 'gpt-b(high)', '', 'zero'][rand(5)],
      service_tier: [null, 'priority', 'flex'][rand(3)],
      provider: cred < 3 ? 'claude' : 'codex',
      auth_provider_snapshot: rand(4) === 0 ? '' : cred < 3 ? 'claude' : 'codex',
      auth_index: `idx${cred}`,
      auth_file_snapshot: rand(3) === 0 ? null : `f${cred}.json`,
      source: rand(2) ? `src${cred}` : '',
      source_hash: `sh${rand(3)}`,
      account_snapshot: rand(3) === 0 ? '' : `acct${cred}`,
      auth_label_snapshot: rand(2) ? `label${cred}` : '',
      api_key_hash: [null, KEY_A, 'b'.repeat(64)][rand(3)],
      session_id: rand(4) === 0 ? '' : `s${rand(40)}`,
      input_tokens: rand(5000),
      output_tokens: rand(800),
      cached_tokens: rand(300),
      cache_read_tokens: rand(400),
      cache_creation_tokens: rand(100),
      reasoning_tokens: rand(200),
      total_tokens: rand(7) === 0 ? 0 : 1 + rand(6000),
      latency_ms: rand(5) === 0 ? 0 : rand(9000),
      ttft_ms: rand(4) === 0 ? null : rand(900),
      failed: rand(6) === 0,
      cost_usd: rand(5) === 0 ? null : rand(10_000) / 1e4,
    };
  });
  insertEvents(db, events);
  const all = {
    summary: true,
    summary_profile: 'full',
    summary_comparison: true,
    timeline: true,
    anomaly_points: true,
    hourly_distribution: true,
    heatmap: true,
    model_stats: true,
    model_tier_stats: true,
    credential_stats: true,
    credential_timeline: true,
    api_key_stats: true,
    channel_share: true,
    failure_sources: true,
  };

  it('the single-scan facts path matches the per-section path', () => {
    for (const timeZone of ['America/New_York', 'Asia/Kolkata', 'Asia/Kathmandu', 'UTC']) {
      for (const [granularity, from, to] of [
        ['hour', start + 5 * 24 * H + 17 * 60_000, start + 6 * 24 * H],
        ['day', start, start + 10 * 24 * H],
        ['day', start + 3 * H + 7, start + 9 * 24 * H - 11],
        ['hour', start + 2 * 24 * H, start + 7 * 24 * H],
      ] as const) {
        for (const include of [all, { ...all, summary_profile: 'compact', summary_percentiles: true }]) {
          const req = validateAnalyticsRequest({ from_ms: from, to_ms: to, time_zone: timeZone, now_ms: to, include: { ...include, granularity } });
          const facts = JSON.parse(runAnalytics(db, req, 'facts'));
          const sections = JSON.parse(runAnalytics(db, req, 'sections'));
          delete facts.generated_at_ms;
          delete sections.generated_at_ms;
          assert.ok(sections.timeline.length > 0 && sections.credential_stats.length > 0);
          assert.equal(facts.granularity, granularity);
          assertClose(facts, sections, `${timeZone}/${granularity}/${from}`);
        }
      }
    }
  });
});
