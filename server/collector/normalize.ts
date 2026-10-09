/**
 * CPA usage record → `events` row. Port of CPA Manager Plus `usage/event.go` `NormalizeRaw` and
 * `PrepareSensitiveFieldsForPersistence` (MIT). Field lookups keep Go's semantics exactly where they
 * feed `event_hash` (first *present* key wins, even when its value is null or empty), so events
 * imported from CPAMP dedupe against live ones.
 *
 * Privacy: the client `api_key` is hashed (sha256) and dropped here; the raw key never leaves this
 * function. Failure bodies are reduced to a redacted `fail_summary`.
 */
import { analyticsModelForRequest } from '../../shared/model-identity.ts';
import { deriveResponseHeaderColumns, parseResponseHeaderMetadata } from './headers.ts';
import {
  containsCredential,
  maskSource,
  sanitizeCredentialText,
  sanitizeRequestMetadata,
  sha256Hex,
  storedFailSummary,
} from './redact.ts';

/** One `events` row (column names = DB columns, minus id and generated columns). */
export interface EventRowInsert {
  request_id: string;
  event_hash: string;
  timestamp_ms: number;
  timestamp: string;
  received_at_ms: number;
  created_at_ms: number;
  provider: string;
  executor_type: string;
  model: string;
  analytics_model: string;
  requested_model: string;
  resolved_model: string;
  response_model: string;
  endpoint: string;
  method: string;
  path: string;
  client_ip: string;
  x_forwarded_for: string;
  user_agent: string;
  auth_type: string;
  auth_index: string;
  source: string;
  source_hash: string;
  api_key_hash: string;
  account_snapshot: string;
  auth_label_snapshot: string;
  auth_file_snapshot: string;
  auth_provider_snapshot: string;
  auth_account_id_snapshot: string;
  auth_project_id_snapshot: string;
  auth_snapshot_at_ms: number | null;
  reasoning_effort: string;
  service_tier: string;
  request_service_tier: string;
  response_service_tier: string;
  cache_input_mode: string;
  session_id: string;
  parent_session_id: string;
  access_token_sha256: string;
  generate: number | null;
  stream: number | null;
  trace_id: string;
  execution_id: string;
  node_kind: string;
  is_fork: number | null;
  is_compaction: number | null;
  /** Normalized total input (includes cache buckets), see `normalizeCacheAccounting`. */
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  /** Legacy cached tokens left after removing fine-grained cache buckets (`compatibleCachedTokens`). */
  cached_tokens: number;
  cache_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  normalized_uncached_input_tokens: number;
  normalized_total_input_tokens: number;
  normalized_cache_read_tokens: number;
  normalized_cache_creation_tokens: number;
  total_tokens: number;
  raw_tokens_json: string | null;
  latency_ms: number | null;
  ttft_ms: number | null;
  failed: number;
  fail_status_code: number | null;
  fail_summary: string;
  response_metadata_json: string | null;
  header_quota_recover_at_ms: number | null;
  header_quota_used_percent: number | null;
  header_quota_plan_type: string;
  header_error_kind: string;
  header_error_code: string;
  header_trace_id: string;
  search_text: string;
  cost_usd: number | null;
  cost_revision: number;
}

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

/** Go `first`: the value of the first key that is present (null when present-but-null). */
function first(record: Rec | undefined, ...keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) if (Object.hasOwn(record, key)) return record[key];
  return undefined;
}

/** Go `strconv.FormatFloat(v, 'f', -1, 64)` / `FormatInt` for JSON numbers. */
function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return BigInt(value).toString();
  if (!Number.isFinite(value)) return String(value);
  const text = String(value);
  if (!/e/i.test(text)) return text;
  // Expand exponent notation (Go 'f' format never uses exponents).
  return value.toFixed(20).replace(/\.?0+$/, '');
}

/** Go `readString`: trimmed string; numbers/bools formatted; present-but-null → ''. */
export function readString(record: Rec | undefined, ...keys: string[]): string {
  const raw = first(record, ...keys);
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number') return formatNumber(raw);
  if (typeof raw === 'boolean') return String(raw);
  return JSON.stringify(raw).trim();
}

/** Go `readIntFrom`: numbers truncate, strings need a strict base-10 integer, else 0. */
function readInt(record: Rec | undefined, ...keys: string[]): number {
  const raw = first(record, ...keys);
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : 0;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : 0;
  }
  return 0;
}

function readFirstInt(record: Rec, keys: string[]): number {
  for (const key of keys) {
    const value = readInt(record, key);
    if (value !== 0) return value;
  }
  return 0;
}

function readNestedThenTopInt(record: Rec, keys: string[]): number {
  for (const parent of ['tokens', 'usage']) {
    const nested = record[parent];
    if (isRecord(nested)) {
      const value = readFirstInt(nested, keys);
      if (value !== 0) return value;
    }
  }
  return readFirstInt(record, keys);
}

function readOptionalInt(record: Rec, ...keys: string[]): number | null {
  const value = readInt(record, ...keys);
  const raw = first(record, ...keys);
  if (value === 0 && (raw === null || raw === undefined)) return null;
  return value;
}

function readOptionalBool(record: Rec, ...keys: string[]): boolean | null {
  const raw = first(record, ...keys);
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  if (typeof raw === 'number') {
    if (raw === 1) return true;
    if (raw === 0) return false;
  }
  return null;
}

const boolInt = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);

function readFailed(record: Rec): boolean {
  const failed = first(record, 'failed', 'is_failed', 'isFailed');
  if (typeof failed === 'boolean') return failed;
  const success = first(record, 'success', 'ok');
  if (typeof success === 'boolean') return !success;
  if (readInt(record, 'status', 'status_code', 'statusCode', 'http_status', 'httpStatus') >= 400) return true;
  const error = first(record, 'error', 'error_message', 'errorMessage');
  return error !== null && error !== undefined;
}

function readFail(record: Rec): { statusCode: number; body: string } {
  const failRaw = first(record, 'fail');
  const fail = isRecord(failRaw) ? failRaw : {};
  let statusCode = readInt(fail, 'status_code', 'statusCode');
  if (statusCode === 0) statusCode = readInt(record, 'fail_status_code', 'failStatusCode');
  let body = readString(fail, 'body');
  if (!body) body = readString(record, 'fail_body', 'failBody');
  return { statusCode, body };
}

// ---------------------------------------------------------------------------------------------
// Timestamps

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})([T ])(\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(Z|[+-]\d{2}:\d{2})?$/;

function utcRfc3339Nano(secondsMs: number, frac: string): string {
  const base = new Date(secondsMs).toISOString().slice(0, 19);
  const trimmed = frac.replace(/0+$/, '');
  return `${base}${trimmed ? `.${trimmed}` : ''}Z`;
}

function fromEpochMs(ms: number): { ms: number; text: string } {
  const seconds = Math.floor(ms / 1000) * 1000;
  return { ms, text: utcRfc3339Nano(seconds, String(ms - seconds).padStart(3, '0')) };
}

/**
 * Go `readTimestamp`: RFC 3339 (any fraction up to ns, with zone), or zone-less
 * "YYYY-MM-DD HH:MM:SS" / "YYYY-MM-DDTHH:MM:SS" (UTC), or epoch seconds/ms. The text form is Go's
 * UTC `RFC3339Nano` (trailing fraction zeros trimmed) — it feeds `event_hash`.
 */
export function readTimestamp(record: Rec, nowMs: number): { ms: number; text: string } {
  const raw = first(record, 'timestamp', 'time', 'created_at', 'createdAt', 'created', 'request_time', 'requestTime');
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    let ms = Math.trunc(raw);
    if (ms < 10_000_000_000) ms *= 1000;
    return fromEpochMs(ms);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^[+-]?\d+$/.test(trimmed)) {
      let ms = Number(trimmed);
      if (ms < 10_000_000_000) ms *= 1000;
      return fromEpochMs(ms);
    }
    const m = TS_RE.exec(trimmed);
    if (m) {
      const [, y, mo, d, sep, h, mi, s, fracRaw = '', zone] = m;
      // Go layouts: RFC3339 needs 'T' + zone; zone-less layouts accept either separator. Go only
      // accepts up to 9 fraction digits and '.' (',' is accepted from Go 1.17 for parsing).
      const validLayout = zone ? sep === 'T' : true;
      if (validLayout && fracRaw.length <= 9) {
        const secondsMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
        const check = new Date(secondsMs);
        const valid =
          check.getUTCFullYear() === Number(y) &&
          check.getUTCMonth() === Number(mo) - 1 &&
          check.getUTCDate() === Number(d) &&
          Number(h) < 24 &&
          Number(mi) < 60 &&
          Number(s) < 60;
        if (valid) {
          let offsetMs = 0;
          if (zone && zone !== 'Z') {
            const sign = zone[0] === '-' ? -1 : 1;
            const zh = Number(zone.slice(1, 3));
            const zm = Number(zone.slice(4, 6));
            if (zh < 24 && zm < 60) offsetMs = sign * (zh * 60 + zm) * 60_000;
          }
          const utcSecondsMs = secondsMs - offsetMs;
          const frac = fracRaw.padEnd(9, '0');
          return { ms: utcSecondsMs + Number(frac.slice(0, 3)), text: utcRfc3339Nano(utcSecondsMs, frac) };
        }
      }
    }
  }
  return fromEpochMs(nowMs);
}

// ---------------------------------------------------------------------------------------------
// Cache accounting / service tier (usage/event.go)

export const CACHE_INPUT_INCLUDED = 'included_in_input';
export const CACHE_INPUT_SEPARATE = 'separate_from_input';
export const CACHE_INPUT_READ_INCLUDED_CREATION_SEPARATE = 'read_included_creation_separate';
const CACHE_MODES = new Set([CACHE_INPUT_INCLUDED, CACHE_INPUT_SEPARATE, CACHE_INPUT_READ_INCLUDED_CREATION_SEPARATE]);

export interface CacheInputContext {
  explicitMode: string;
  executorType: string;
  provider: string;
  providerSnapshot: string;
  authType: string;
  resolvedModel: string;
  requestedModel: string;
  displayModel: string;
}

function classifyExecutor(executorType: string): string | null {
  const executor = executorType.trim().toLowerCase();
  if (!executor) return null;
  if (executor === 'devinexecutor') return CACHE_INPUT_READ_INCLUDED_CREATION_SEPARATE;
  if (executor.includes('claude')) return CACHE_INPUT_SEPARATE;
  const markers = ['openaicompat', 'openai_compat', 'openai-compat', 'openai', 'codex', 'gemini', 'aistudio', 'ai_studio', 'ai-studio', 'antigravity', 'xai', 'kimi'];
  return markers.some((m) => executor.includes(m)) ? CACHE_INPUT_INCLUDED : null;
}

function classifyProvider(value: string): string | null {
  const provider = value.trim().toLowerCase();
  if (!provider) return null;
  if (provider === 'devin' || provider.startsWith('devin/')) return CACHE_INPUT_READ_INCLUDED_CREATION_SEPARATE;
  if (provider.includes('anthropic') || provider.includes('claude')) return CACHE_INPUT_SEPARATE;
  const markers = ['openai', 'codex', 'gemini', 'vertex', 'aistudio', 'ai_studio', 'ai-studio', 'interaction', 'antigravity', 'xai', 'kimi', 'moonshot'];
  return markers.some((m) => provider.includes(m)) ? CACHE_INPUT_INCLUDED : null;
}

function classifyModel(value: string): string | null {
  const model = value.trim().toLowerCase();
  if (!model) return null;
  if (model === 'devin' || model.startsWith('devin/')) return CACHE_INPUT_READ_INCLUDED_CREATION_SEPARATE;
  if (model.includes('anthropic') || model.includes('claude')) return CACHE_INPUT_SEPARATE;
  const markers = ['gpt-', 'openai', 'codex', 'gemini', 'vertex', 'aistudio', 'antigravity', 'grok', 'xai', 'kimi', 'moonshot'];
  return markers.some((m) => model.includes(m)) ? CACHE_INPUT_INCLUDED : null;
}

export function inferCacheInputMode(context: CacheInputContext, cacheRead: number, cacheCreation: number): string {
  const explicit = context.explicitMode.trim().toLowerCase();
  if (CACHE_MODES.has(explicit)) return explicit;
  const byExecutor = classifyExecutor(context.executorType);
  if (byExecutor) return byExecutor;
  for (const provider of [context.provider, context.providerSnapshot]) {
    const mode = classifyProvider(provider);
    if (mode) return mode;
  }
  for (const model of [context.resolvedModel, context.requestedModel, context.displayModel]) {
    const mode = classifyModel(model);
    if (mode) return mode;
  }
  return cacheRead > 0 || cacheCreation > 0 ? CACHE_INPUT_SEPARATE : CACHE_INPUT_INCLUDED;
}

/** Legacy cached tokens minus fine-grained read/creation buckets (CPA mirrors them for Claude). */
export function compatibleCachedTokens(cached: number, cache: number, cacheRead: number, cacheCreation: number): number {
  const c = Math.max(cached, cache);
  if (c <= 0) return 0;
  const fine = Math.max(cacheRead, 0) + Math.max(cacheCreation, 0);
  return c <= fine ? 0 : c - fine;
}

export interface CacheAccounting {
  mode: string;
  uncachedInput: number;
  totalInput: number;
  cacheRead: number;
  cacheCreation: number;
}

export function normalizeCacheAccounting(
  context: CacheInputContext,
  input: number,
  cached: number,
  cache: number,
  cacheRead: number,
  cacheCreation: number,
): CacheAccounting {
  const mode = inferCacheInputMode(context, cacheRead, cacheCreation);
  const inp = Math.max(input, 0);
  const read = compatibleCachedTokens(cached, cache, cacheRead, cacheCreation) + Math.max(cacheRead, 0);
  const creation = Math.max(cacheCreation, 0);
  if (mode === CACHE_INPUT_SEPARATE) return { mode, uncachedInput: inp, totalInput: inp + read + creation, cacheRead: read, cacheCreation: creation };
  if (mode === CACHE_INPUT_READ_INCLUDED_CREATION_SEPARATE) {
    return { mode, uncachedInput: Math.max(inp - read, 0), totalInput: inp + creation, cacheRead: read, cacheCreation: creation };
  }
  return { mode, uncachedInput: Math.max(inp - read - creation, 0), totalInput: inp, cacheRead: read, cacheCreation: creation };
}

/** Codex reports default/auto even in fast mode, so Codex prefers the request tier. */
export function effectiveServiceTier(context: CacheInputContext, requestTier: string, legacyTier: string, responseTier: string): string {
  const identity = [context.executorType, context.provider, context.providerSnapshot, context.authType].join(' ').toLowerCase();
  if (identity.includes('codex')) return requestTier || legacyTier || responseTier;
  return responseTier || legacyTier || requestTier;
}

function cacheInputModeFromRecord(record: Rec): string {
  for (const parent of ['tokens', 'usage']) {
    const nested = record[parent];
    if (!isRecord(nested)) continue;
    const mode = readString(nested, 'cache_input_mode', 'cacheInputMode').toLowerCase();
    if (CACHE_MODES.has(mode)) return mode;
  }
  const mode = readString(record, 'cache_input_mode', 'cacheInputMode').toLowerCase();
  return CACHE_MODES.has(mode) ? mode : '';
}

// ---------------------------------------------------------------------------------------------
// Hashing / search

/** Go `hashString`: sha256 hex of the trimmed value, '' for empty. */
export function hashString(value: string): string {
  const trimmed = value.trim();
  return trimmed ? sha256Hex(trimmed) : '';
}

export interface EventHashInput {
  requestId: string;
  timestamp: string;
  endpoint: string;
  model: string;
  authIndex: string;
  sourceHash: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheTokens: number;
  failed: boolean;
  latencyMs: number | null;
}

/** CPAMP `buildEventHash` (raw token counts, pre-persistence endpoint/source hash). */
export function buildEventHash(e: EventHashInput): string {
  const parts = [
    e.requestId,
    e.timestamp,
    e.endpoint,
    e.model,
    e.authIndex,
    e.sourceHash,
    String(e.inputTokens),
    String(e.outputTokens),
    String(e.reasoningTokens),
    String(Math.max(e.cachedTokens, e.cacheTokens)),
    e.failed ? 'true' : 'false',
  ];
  if (e.latencyMs !== null) parts.push(String(e.latencyMs));
  return hashString(parts.join('|'));
}

/** CPAMP's search columns, in order (usageprojection.SearchColumns). */
export const SEARCH_COLUMNS = [
  'request_id',
  'event_hash',
  'model',
  'requested_model',
  'analytics_model',
  'resolved_model',
  'endpoint',
  'method',
  'path',
  'client_ip',
  'x_forwarded_for',
  'user_agent',
  'source',
  'source_hash',
  'api_key_hash',
  'auth_index',
  'account_snapshot',
  'auth_label_snapshot',
  'auth_file_snapshot',
  'auth_provider_snapshot',
  'auth_project_id_snapshot',
  'reasoning_effort',
  'service_tier',
  'executor_type',
  'fail_summary',
  'header_quota_plan_type',
  'header_error_kind',
  'header_error_code',
  'header_trace_id',
] as const;

/** Lower-cased search document: search columns joined by U+001F (no cross-field matches). */
export function buildSearchText(row: Partial<Record<(typeof SEARCH_COLUMNS)[number], unknown>>): string {
  return SEARCH_COLUMNS.map((column) => {
    const value = row[column];
    return value === null || value === undefined ? '' : String(value);
  })
    .join('\u001f')
    .toLowerCase();
}

// ---------------------------------------------------------------------------------------------

const ENDPOINT_RE = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\S+)/;

export class NormalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NormalizeError';
  }
}

/**
 * Normalizes one raw usage record (JSON text). Throws NormalizeError for invalid JSON or a
 * non-object payload. `cost_usd`, `search_text` and auth snapshots are filled in later.
 */
export function normalizeRecord(raw: string, nowMs = Date.now()): EventRowInsert {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new NormalizeError(`invalid JSON: ${(err as Error).message.slice(0, 120)}`);
  }
  if (!isRecord(payload)) throw new NormalizeError('usage payload is not a JSON object');
  const record = payload;

  const ts = readTimestamp(record, nowMs);
  let method = readString(record, 'method', 'http_method', 'httpMethod').toUpperCase();
  let path = readString(record, 'path', 'url_path', 'urlPath', 'route');
  let endpoint = readString(record, 'endpoint', 'api', 'request', 'operation');
  if (!endpoint && method && path) endpoint = `${method} ${path}`;
  if (endpoint) {
    const match = ENDPOINT_RE.exec(endpoint);
    if (match) {
      if (!method) method = match[1].toUpperCase();
      if (!path) path = match[2];
    }
  }
  if (!endpoint) endpoint = '-';

  const input = readNestedThenTopInt(record, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
  const output = readNestedThenTopInt(record, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
  const reasoning = readNestedThenTopInt(record, ['reasoning_tokens', 'reasoningTokens']);
  const cached = readNestedThenTopInt(record, ['cached_tokens', 'cachedTokens']);
  const cache = readNestedThenTopInt(record, ['cache_tokens', 'cacheTokens']);
  const cacheRead = readNestedThenTopInt(record, ['cache_read_tokens', 'cacheReadTokens', 'cache_read_input_tokens', 'cacheReadInputTokens']);
  const cacheCreation = readNestedThenTopInt(record, [
    'cache_creation_tokens',
    'cacheCreationTokens',
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
    'cache_write_tokens',
    'cacheWriteTokens',
    'cache_write_input_tokens',
    'cacheWriteInputTokens',
  ]);
  let total = readNestedThenTopInt(record, ['total_tokens', 'totalTokens', 'total']);

  const latencyMs = readOptionalInt(record, 'latency_ms', 'latencyMs', 'duration_ms', 'durationMs', 'elapsed_ms', 'elapsedMs');
  const ttftMs = readOptionalInt(record, 'ttft_ms', 'ttftMs', 'time_to_first_token_ms', 'timeToFirstTokenMs');
  const failed = readFailed(record);
  const fail = readFail(record);

  const sourceRaw = readString(record, 'source', 'api_key', 'apiKey', 'key', 'account', 'email');
  // The client API key: hash and drop. Never stored, never logged.
  const apiKeyHash = hashString(readString(record, 'api_key', 'apiKey', 'key'));
  const authIndex = readString(record, 'auth_index', 'authIndex', 'AuthIndex');
  const requestedModel = readString(record, 'alias', 'requested_model', 'requestedModel');
  const resolvedModel = readString(record, 'resolved_model', 'resolvedModel', 'model', 'model_name', 'modelName');
  const model = requestedModel || resolvedModel || '-';
  const provider = readString(record, 'provider', 'type', 'auth_type', 'authType');
  const executorType = readString(record, 'executor_type', 'executorType');
  const authType = readString(record, 'auth_type', 'authType');
  const requestServiceTier = readString(record, 'request_service_tier', 'requestServiceTier', 'service_tier', 'serviceTier');
  const responseServiceTier = readString(record, 'response_service_tier', 'responseServiceTier');
  const authProviderSnapshot = readString(record, 'auth_provider_snapshot', 'authProviderSnapshot');
  const context: CacheInputContext = {
    explicitMode: cacheInputModeFromRecord(record),
    executorType,
    provider,
    providerSnapshot: authProviderSnapshot,
    authType,
    resolvedModel,
    requestedModel,
    displayModel: model,
  };
  const serviceTier = effectiveServiceTier(context, requestServiceTier, '', responseServiceTier);
  const accounting = normalizeCacheAccounting(context, input, cached, cache, cacheRead, cacheCreation);
  if (total <= 0) total = accounting.totalInput + Math.max(output, 0) + Math.max(reasoning, 0);

  const requestId = readString(record, 'request_id', 'requestId', 'id');
  const sourceHashRaw = hashString(sourceRaw);
  const eventHash = buildEventHash({
    requestId,
    timestamp: ts.text,
    endpoint,
    model,
    authIndex,
    sourceHash: sourceHashRaw,
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cachedTokens: cached,
    cacheTokens: cache,
    failed,
    latencyMs,
  });

  // Persistence boundary (PrepareSensitiveFieldsForPersistence).
  let source = maskSource(sourceRaw);
  let sourceHash = sourceHashRaw;
  if (source) {
    const sourceSha = sha256Hex(source);
    if (containsCredential(source) || (apiKeyHash && sourceSha.toLowerCase() === apiKeyHash.toLowerCase())) {
      source = `h:${sourceSha}`;
      sourceHash = sourceSha;
    }
  }

  const metadata = parseResponseHeaderMetadata(first(record, 'response_headers', 'responseHeaders', 'headers'), ts.ms);
  const derived = deriveResponseHeaderColumns(metadata);

  const tokensRaw = first(record, 'tokens', 'usage');
  const rawTokens = isRecord(tokensRaw) ? JSON.stringify(tokensRaw) : null;

  const scrub = (value: string) => (value ? sanitizeCredentialText(value) : '');

  return {
    request_id: requestId,
    event_hash: eventHash,
    timestamp_ms: ts.ms,
    timestamp: ts.text,
    received_at_ms: nowMs,
    created_at_ms: nowMs,
    provider,
    executor_type: executorType,
    model,
    analytics_model: analyticsModelForRequest(model, requestedModel),
    requested_model: requestedModel,
    resolved_model: resolvedModel,
    response_model: readString(record, 'response_model', 'responseModel'),
    endpoint: scrub(endpoint),
    method,
    path: scrub(path),
    client_ip: scrub(sanitizeRequestMetadata(readString(record, 'client_ip', 'clientIp'), 64)),
    x_forwarded_for: scrub(sanitizeRequestMetadata(readString(record, 'x_forwarded_for', 'xForwardedFor'), 2048)),
    user_agent: scrub(sanitizeRequestMetadata(readString(record, 'user_agent', 'userAgent'), 1024)),
    auth_type: authType,
    auth_index: authIndex,
    source,
    source_hash: sourceHash,
    api_key_hash: apiKeyHash,
    account_snapshot: readString(record, 'account_snapshot', 'accountSnapshot'),
    auth_label_snapshot: readString(record, 'auth_label_snapshot', 'authLabelSnapshot'),
    auth_file_snapshot: readString(record, 'auth_file_snapshot', 'authFileSnapshot'),
    auth_provider_snapshot: authProviderSnapshot,
    auth_account_id_snapshot: readString(record, 'auth_account_id_snapshot', 'authAccountIdSnapshot'),
    auth_project_id_snapshot: readString(record, 'auth_project_id_snapshot', 'authProjectIdSnapshot', 'project_id', 'projectId'),
    auth_snapshot_at_ms: readInt(record, 'auth_snapshot_at_ms', 'authSnapshotAtMs') || null,
    reasoning_effort: readString(record, 'reasoning_effort', 'reasoningEffort'),
    service_tier: serviceTier,
    request_service_tier: requestServiceTier,
    response_service_tier: responseServiceTier,
    cache_input_mode: accounting.mode,
    session_id: readString(record, 'session_id', 'sessionId'),
    parent_session_id: readString(record, 'parent_session_id', 'parentSessionId'),
    access_token_sha256: readString(record, 'access_token_sha256', 'accessTokenSHA256', 'accessTokenSha256'),
    generate: boolInt(readOptionalBool(record, 'generate', 'Generate')),
    stream: boolInt(readOptionalBool(record, 'stream', 'Stream')),
    trace_id: readString(record, 'trace_id', 'traceId'),
    execution_id: readString(record, 'execution_id', 'executionId'),
    node_kind: readString(record, 'node_kind', 'nodeKind'),
    is_fork: boolInt(readOptionalBool(record, 'is_fork', 'isFork')),
    is_compaction: boolInt(readOptionalBool(record, 'is_compaction', 'isCompaction')),
    input_tokens: accounting.totalInput,
    output_tokens: output,
    reasoning_tokens: reasoning,
    cached_tokens: compatibleCachedTokens(cached, cache, cacheRead, cacheCreation),
    cache_tokens: cache,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
    normalized_uncached_input_tokens: accounting.uncachedInput,
    normalized_total_input_tokens: accounting.totalInput,
    normalized_cache_read_tokens: accounting.cacheRead,
    normalized_cache_creation_tokens: accounting.cacheCreation,
    total_tokens: total,
    raw_tokens_json: rawTokens,
    latency_ms: latencyMs,
    ttft_ms: ttftMs,
    failed: failed ? 1 : 0,
    fail_status_code: fail.statusCode || null,
    fail_summary: fail.body ? storedFailSummary(fail.body) : '',
    response_metadata_json: derived.metadataJson,
    header_quota_recover_at_ms: derived.quotaRecoverAtMs,
    header_quota_used_percent: derived.quotaUsedPercent,
    header_quota_plan_type: scrub(derived.quotaPlanType),
    header_error_kind: scrub(derived.errorKind),
    header_error_code: scrub(derived.errorCode),
    header_trace_id: scrub(derived.traceId),
    search_text: '',
    cost_usd: null,
    cost_revision: 0,
  };
}

/** `{"refresh":true}` / `{"support_refresh":true}` control frames (exactly one key). */
export function classifyControlPayload(payload: string): 'refresh' | 'support_refresh' | null {
  const trimmed = payload.trim();
  if (!trimmed.startsWith('{') || trimmed.length > 64) return null;
  try {
    const record = JSON.parse(trimmed) as unknown;
    if (!isRecord(record)) return null;
    const keys = Object.keys(record);
    if (keys.length !== 1) return null;
    if (record.refresh === true) return 'refresh';
    if (record.support_refresh === true) return 'support_refresh';
  } catch {
    return null;
  }
  return null;
}
