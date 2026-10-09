/**
 * Synthetic event fixtures for analytics tests (no real data). Importing this file registers no tests.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { analyticsModelForRequest } from '../../shared/model-identity.ts';
import { openDatabase } from '../db/open.ts';
import { registerAnalyticsFunctions } from './sql.ts';

export interface FixtureEvent {
  timestamp_ms: number;
  model?: string;
  requested_model?: string | null;
  resolved_model?: string | null;
  provider?: string;
  auth_provider_snapshot?: string;
  auth_index?: string;
  auth_file_snapshot?: string | null;
  source?: string;
  source_hash?: string;
  account_snapshot?: string;
  auth_label_snapshot?: string;
  api_key_hash?: string | null;
  service_tier?: string | null;
  session_id?: string | null;
  executor_type?: string;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  cache_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  total_tokens?: number;
  latency_ms?: number | null;
  ttft_ms?: number | null;
  failed?: boolean;
  fail_status_code?: number | null;
  fail_summary?: string | null;
  response_metadata_json?: string | null;
  header_trace_id?: string | null;
  endpoint?: string;
  user_agent?: string | null;
  cost_usd?: number | null;
  generate?: boolean | null;
  stream?: boolean | null;
}

let seq = 0;

export function createTestDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  registerAnalyticsFunctions(db);
  return db;
}

export function insertEvents(db: DatabaseSync, events: FixtureEvent[]): void {
  const stmt = db.prepare(`INSERT INTO events (
    event_hash, request_id, timestamp_ms, timestamp, received_at_ms, created_at_ms, provider, executor_type, model,
    analytics_model, requested_model, resolved_model, endpoint, method, path, user_agent, auth_index, source, source_hash,
    api_key_hash, account_snapshot, auth_label_snapshot, auth_file_snapshot, auth_provider_snapshot, service_tier,
    session_id, generate, stream, input_tokens, output_tokens, reasoning_tokens, cached_tokens, cache_tokens,
    cache_read_tokens, cache_creation_tokens, normalized_total_input_tokens, total_tokens, latency_ms, ttft_ms, failed,
    fail_status_code, fail_summary, response_metadata_json, header_trace_id, search_text, cost_usd
  ) VALUES (${Array.from({ length: 46 }, () => '?').join(', ')})`);
  for (const e of events) {
    seq++;
    const model = e.model ?? 'claude-test';
    const requested = e.requested_model === undefined ? model : e.requested_model;
    const analytics = analyticsModelForRequest(model, requested);
    const input = e.input_tokens ?? 100;
    const output = e.output_tokens ?? 10;
    const authIndex = e.auth_index ?? 'aaaa000000000001';
    const source = e.source ?? 'u***@example.test';
    const endpoint = e.endpoint ?? 'POST /v1/messages';
    const [method, path] = endpoint.split(' ');
    const searchText = [
      model, requested ?? '', analytics, e.resolved_model ?? '', endpoint, source, authIndex, e.account_snapshot ?? '',
      e.auth_file_snapshot ?? '', e.api_key_hash ?? '', e.fail_summary ?? '', e.header_trace_id ?? '',
    ]
      .join('\u001f')
      .toLowerCase();
    stmt.run(
      createHash('sha256').update(`fixture-${seq}`).digest('hex'),
      `req-${seq}`,
      e.timestamp_ms,
      new Date(e.timestamp_ms).toISOString(),
      e.timestamp_ms,
      e.timestamp_ms,
      e.provider ?? 'claude',
      e.executor_type ?? 'ClaudeExecutor',
      model,
      analytics,
      requested ?? null,
      e.resolved_model ?? null,
      endpoint,
      method,
      path,
      e.user_agent === undefined ? 'test-agent/1.0' : e.user_agent,
      authIndex,
      source,
      e.source_hash ?? 'sh-1',
      e.api_key_hash ?? null,
      e.account_snapshot ?? 'user1@example.test',
      e.auth_label_snapshot ?? 'user1@example.test',
      e.auth_file_snapshot === undefined ? 'claude-user1@example.test.json' : e.auth_file_snapshot,
      e.auth_provider_snapshot ?? e.provider ?? 'claude',
      e.service_tier === undefined ? 'auto' : e.service_tier,
      e.session_id ?? null,
      e.generate === undefined || e.generate === null ? null : e.generate ? 1 : 0,
      e.stream === undefined || e.stream === null ? null : e.stream ? 1 : 0,
      input,
      output,
      e.reasoning_tokens ?? 0,
      e.cached_tokens ?? 0,
      e.cache_tokens ?? 0,
      e.cache_read_tokens ?? 0,
      e.cache_creation_tokens ?? 0,
      input,
      e.total_tokens ?? input + output,
      e.latency_ms === undefined ? 1000 : e.latency_ms,
      e.ttft_ms === undefined ? 200 : e.ttft_ms,
      e.failed ? 1 : 0,
      e.fail_status_code === undefined ? (e.failed ? 500 : 200) : e.fail_status_code,
      e.fail_summary ?? null,
      e.response_metadata_json ?? null,
      e.header_trace_id ?? null,
      searchText,
      e.cost_usd === undefined ? 0.01 : e.cost_usd,
    );
  }
}
