/**
 * Request/response types for the analytics query (`POST /api/analytics`), the single query endpoint
 * behind both the Usage and Request Monitor pages. Semantics ported from CPA Manager Plus (MIT).
 * Every list section is omitted when empty or not requested.
 *
 * Shared by the browser and the server: pure types, no runtime code.
 */

export interface AnalyticsRequest {
  from_ms: number;            // required, epoch ms, inclusive
  to_ms: number;              // required, epoch ms, exclusive; must be > from_ms
  now_ms?: number;            // optional; anchors the "rolling 30m" RPM/TPM window. Default: server now
  time_zone?: string;         // IANA name (e.g. "Asia/Kolkata"). Default "UTC". Controls day/hour bucket
                              // alignment, timeline labels, heatmap weekday/hour, hourly_distribution, active days.
                              // An invalid name gives HTTP 500 {"code":"invalid_time_zone"}.
  search_query?: string;      // case-insensitive substring LIKE over many columns
  search_api_key_hash?: string; // exact api_key_hash match; OR-ed into search_query if both present
  filters?: AnalyticsFilters;
  include?: AnalyticsInclude;
}

export interface AnalyticsFilters {
  models?: string[];          // matches the "analytics model" (requested_model ?? model, with CPA reasoning
                              // suffix like "(high)" stripped). Exact match.
  providers?: string[];       // lower-cased; matches provider OR auth_provider_snapshot (e.g. "claude","codex")
  accounts?: string[];        // lower-cased; matches account_snapshot OR auth_label_snapshot OR source OR auth_index
  credential_ids?: string[];  // matches coalesce(auth_file_snapshot, auth_index, source_hash, source, '-')
                              //  = the `id` of credential_stats rows
  auth_files?: string[];      // exact auth_file_snapshot (auth file name, e.g. "claude-<email>.json")
  auth_indices?: string[];    // exact auth_index (16-hex CPA auth index)
  api_key_hashes?: string[];  // exact api_key_hash (lower-case sha256 hex of the client API key)
  source_hashes?: string[];   // exact source_hash
  project_ids?: string[];     // auth project id snapshot
  request_types?: string[];   // executor_type, e.g. "ClaudeExecutor","CodexExecutor"
  header_error_kinds?: string[];
  header_error_codes?: string[];
  header_quota_plans?: string[]; // e.g. "plus"
  header_trace_ids?: string[];
  include_failed?: boolean;   // default true. false adds "failed = 0" (success only)
  failed_only?: boolean;      // true adds "failed = 1"
  min_latency_ms?: number;    // latency_ms >= N
  cache_status?: "hit" | "miss" | "read" | "creation" | ""; // hit = any cached/cache/read/creation tokens > 0;
                              // miss = none; read = cache_read_tokens > 0; creation = cache_creation_tokens > 0
}
// Arrays are OR within a field and AND across fields. Values are trimmed and de-duplicated. Empty arrays are ignored.

export interface AnalyticsInclude {
  summary?: boolean;
  summary_profile?: "full" | "compact";       // "compact" skips rolling-30m RPM/TPM, avg daily, sessions,
                                              // zero_token_models (they come back as 0/null). Any other value = full.
  summary_percentiles?: boolean;              // with compact: also compute p95_latency_ms / p95_ttft_ms
  summary_comparison?: boolean;               // needs summary; adds the previous equal-length window
  timeline?: boolean;
  granularity?: "hour" | "day";               // any other value (or missing) = auto: range <= 24h -> "hour", else "day"
  hourly_distribution?: boolean;
  heatmap?: boolean;
  anomaly_points?: boolean;
  model_stats?: boolean;
  model_tier_stats?: boolean;                 // per model x service tier, with TPS/TTFT/latency
  channel_share?: boolean;
  failure_sources?: boolean;
  credential_stats?: boolean;
  credential_timeline?: boolean;
  api_key_stats?: boolean;
  filter_options?: boolean;                   // heavier than filter_selectors
  filter_selectors?: boolean;                 // lighter selector lists; when set, it replaces filter_options
  events_page?: { limit?: number; before_ms?: number | null; before_id?: number | null }; // limit default 100, max 50000
  drilldown_preview?: { from_ms: number; to_ms: number; limit?: number };  // limit default 20, max 100
}


export interface AnalyticsResponse {
  generated_at_ms: number;
  granularity: "hour" | "day";              // the resolved granularity
  summary?: Summary;
  summary_comparison?: SummaryComparison;
  timeline?: TimelinePoint[];
  hourly_distribution?: HourlyPoint[];
  heatmap?: HeatmapPoint[];
  anomaly_points?: AnomalyPoint[];
  model_stats?: ModelStat[];
  model_tier_stats?: ModelTierStat[];
  channel_share?: ChannelShareRow[];
  failure_sources?: FailureSourceRow[];
  credential_stats?: CredentialStatRow[];
  credential_timeline?: CredentialTimelinePoint[];
  api_key_stats?: ApiKeyStatRow[];
  filter_options?: FilterOptions;
  events?: EventsResponse;
  drilldown_preview?: EventsResponse;
}

export interface Summary {
  total_calls: number;
  success_calls: number;                    // failed = 0
  failure_calls: number;                    // failed = 1
  success_rate: number;                     // 0..1 = success_calls / total_calls (0 if no calls)
  input_tokens: number;                     // NORMALIZED total input. INCLUDES cached + cache_read + cache_creation
  output_tokens: number;
  cached_tokens: number;                    // legacy/OpenAI-style cached input left after removing fine-grained buckets
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cache_hit_rate: number;                   // 0..1 = (cached + cache_read) / input_tokens
  reasoning_tokens: number;
  total_tokens: number;                     // sum of stored per-event total_tokens
  total_cost: number;                       // USD, server-priced
  average_cost_per_call: number;            // total_cost / total_calls
  average_latency_ms: number | null;        // avg(latency_ms) over events with latency > 0, failures included
  p95_latency_ms: number | null;            // only with full profile or summary_percentiles
  p95_ttft_ms: number | null;               // same
  zero_token_calls: number;                 // successful events with total_tokens = 0
  rpm_30m: number;                          // full only: calls in [now_ms-30m, now_ms) / 30, ignores from/to
  tpm_30m: number;                          // full only: tokens in that window / 30
  avg_daily_requests: number;               // full only: total_calls / (#distinct local days with traffic, min 1)
  avg_daily_tokens: number;                 // full only
  sessions: number;                         // full only: distinct non-empty session_id
  session_failures: number;                 // full only: sessions with >= 1 failed event
  session_success_rate: number;             // full only: (sessions - session_failures) / sessions
  zero_token_models: string[];              // full only (compact: null)
}

export interface SummaryComparison {        // previous window [from - (to-from), from), same filters
  from_ms: number; to_ms: number;
  total_calls: number; success_calls: number; failure_calls: number; success_rate: number;
  total_tokens: number; total_cost: number;
}

export interface TimelinePoint {            // one per NON-EMPTY bucket (empty buckets are omitted)
  bucket_ms: number;                        // bucket start, aligned to local hour/day in time_zone
  label: string;                            // server-formatted in time_zone: "15:04" (hour) / "01/02" (day)
  calls: number; tokens: number;            // tokens == total_tokens
  success: number; failure: number;
  input_tokens: number; output_tokens: number; cached_tokens: number;
  cache_read_tokens: number; cache_creation_tokens: number; cache_hit_rate: number;
  reasoning_tokens: number; total_tokens: number;
  cost: number;
  average_latency_ms: number | null;
  p95_latency_ms: number | null;            // raw-event percentile per bucket
  p95_ttft_ms: number | null;
  success_rate: number; failure_rate: number;
  // NOTE: no bucket_end_ms is returned. Use bucket_ms + bucket size (1h or local next-midnight).
}

export interface HourlyPoint { hour: number /* 0-23 local */; calls: number; tokens: number } // non-empty hours only

export interface HeatmapContributor {
  key: string; label?: string; calls: number; success: number; failure: number;
  tokens: number; cost: number; failure_rate: number; share: number /* calls share of cell */;
}
export interface HeatmapPoint {             // one per non-empty (weekday, hour) in time_zone
  weekday: number;                          // 0 = Sunday ... 6 = Saturday (Go time.Weekday)
  hour: number;                             // 0..23
  calls: number; success: number; failure: number; tokens: number; cost: number; failure_rate: number;
  model_contributors?: HeatmapContributor[];    // top 5 by calls
  api_key_contributors?: HeatmapContributor[];  // top 5 (key = api_key_hash; omitted when hash empty)
  provider_contributors?: HeatmapContributor[]; // top 5
}

export interface AnomalyPoint {
  bucket_ms: number; bucket_end_ms: number; label: string;
  severity: "low" | "medium" | "high";      // 1, 2, >= 3 triggered metrics
  metric_keys: Array<"request_spike" | "cost_spike" | "tokens_per_request_spike" |
                     "cache_hit_drop" | "failure_rate_spike" | "latency_spike">;
  calls: number; total_tokens: number; cost: number; failure_rate: number;
  request_change: number; cost_change: number; tokens_per_request_change: number; // fractional change vs previous bucket
  cache_hit_rate_change: number; failure_rate_change: number; latency_p95_change: number;
}
// Triggers (vs the previous non-empty bucket): request_change > 1, cost_change > 1,
// tokens_per_request_change > 0.5, cache_hit_rate_change < -0.2, failure_rate_change > 0.2,
// latency_p95_change > 0.5. percentChange(cur, prev) = prev <= 0 ? (cur > 0 ? 1 : 0) : (cur - prev) / prev.

export interface ModelShareRow { model: string; calls: number; tokens: number; cost: number }

export interface ModelStat {                // sorted by calls desc
  model: string; calls: number; success_calls: number; failure_calls: number; success_rate: number;
  input_tokens: number; output_tokens: number; cached_tokens: number;
  cache_read_tokens: number; cache_creation_tokens: number;
  cache_hit_tokens: number;                 // cached + cache_read
  cache_hit_input_tokens: number;           // = input_tokens (normalized)
  cache_hit_rate: number;
  total_tokens: number; cost: number;
}

export interface ModelTierStat extends ModelStat {
  service_tier: string;                     // normalized: "normal" (""|auto|default|standard|standard_only),
                                            // "fast" (priority|fast), else the raw lower-cased tier (e.g. "flex")
  output_tps: number | null;                // mean per-request output tokens/sec
  tps_samples: number;
  average_ttft_ms: number | null;           // successful requests with ttft_ms > 0
  average_latency_ms: number | null;        // successful requests with latency_ms > 0
}

export interface ChannelShareRow {          // one per auth_index (credential/channel)
  auth_index: string; source?: string; account_snapshot?: string; auth_label_snapshot?: string;
  auth_provider_snapshot?: string; auth_account_id_snapshot?: string;
  calls: number; success: number; failure: number; tokens: number; cost: number;
  average_latency_ms: number | null;
}

export interface FailureSourceRow {
  source?: string; source_hash: string; auth_index: string;
  account_snapshot?: string; auth_label_snapshot?: string; auth_provider_snapshot?: string;
  calls: number; failure: number; last_seen_ms: number; average_latency_ms: number | null;
}

export interface AccountModelStatRow {
  model: string; calls: number; success_calls: number; failure_calls: number; success_rate: number;
  input_tokens: number; output_tokens: number; cached_tokens: number; cache_read_tokens: number;
  cache_creation_tokens: number; cache_hit_tokens: number; cache_hit_input_tokens: number;
  cache_hit_rate: number; total_tokens: number; cost: number; last_seen_ms: number;
}


export interface CredentialStatRow {        // grouped by credential id (= auth file name when known)
  id: string;  // coalesce(auth_file_snapshot, auth_index, source_hash, source, "-")
  auth_file_snapshot?: string; auth_index?: string; source?: string; source_hash?: string;
  account_snapshot?: string; auth_label_snapshot?: string; auth_provider_snapshot?: string;
  auth_account_id_snapshot?: string; auth_project_id_snapshot?: string;
  calls: number; success_calls: number; failure_calls: number; success_rate: number;
  input_tokens: number; output_tokens: number; cached_tokens: number; cache_read_tokens: number;
  cache_creation_tokens: number; total_tokens: number; cost: number;
  average_latency_ms: number | null; last_seen_ms: number;
  models?: AccountModelStatRow[];
}

export interface CredentialTimelinePoint {  // one per (credential, non-empty bucket)
  id: string; label: string;
  auth_file_snapshot?: string; auth_index?: string; source?: string; source_hash?: string;
  account_snapshot?: string; auth_label_snapshot?: string; auth_provider_snapshot?: string;
  auth_account_id_snapshot?: string; auth_project_id_snapshot?: string;
  bucket_ms: number; bucket_label: string;
  calls: number; tokens: number; success: number; failure: number;
  input_tokens: number; output_tokens: number; cached_tokens: number; cache_read_tokens: number;
  cache_creation_tokens: number; reasoning_tokens: number; total_tokens: number; cost: number;
  average_latency_ms: number | null; success_rate: number; failure_rate: number;
}


export interface ApiKeyStatRow {
  id: string;            // the api_key_hash, or "unknown-client-api-key:<source_hash>:<auth_index>:<source>:<provider>"
                         // when the event has no api_key_hash
  api_key_hash: string;  // "" when unknown
  account_snapshot?: string; auth_label_snapshot?: string; auth_provider_snapshot?: string;
  auth_indices?: string[]; sources?: string[]; source_hashes?: string[];
  calls: number; success_calls: number; failure_calls: number; success_rate: number;
  input_tokens: number; output_tokens: number; cached_tokens: number; cache_read_tokens: number;
  cache_creation_tokens: number; total_tokens: number; cost: number;
  average_latency_ms: number | null; last_seen_ms: number;
  models?: AccountModelStatRow[];
}


export interface EventRow {
  request_id?: string; event_hash: string; timestamp_ms: number;
  model: string; analytics_model?: string; requested_model?: string; resolved_model?: string; response_model?: string;
  session_id?: string; parent_session_id?: string; access_token_sha256?: string;
  generate?: boolean; stream?: boolean;
  endpoint: string; method: string; path: string;
  client_ip?: string; x_forwarded_for?: string; user_agent?: string;
  auth_index: string; source: string; source_hash: string; api_key_hash: string;
  account_snapshot: string; auth_label_snapshot: string; auth_file_snapshot?: string; auth_provider_snapshot: string;
  auth_account_id_snapshot?: string; auth_project_id_snapshot?: string;
  reasoning_effort?: string; service_tier?: string /* raw: "auto","priority",... */; executor_type?: string;
  input_tokens: number; output_tokens: number; cached_tokens: number; cache_read_tokens: number;
  cache_creation_tokens: number; reasoning_tokens: number; total_tokens: number;
  latency_ms: number | null; ttft_ms: number | null;
  failed: boolean; fail_status_code?: number /* 200 on success */; fail_summary?: string;
  response_metadata?: ResponseHeaderMetadata;
  header_quota_recover_at_ms?: number; header_quota_used_percent?: number; header_quota_plan_type?: string;
  header_error_kind?: string; header_error_code?: string; header_trace_id?: string;
}

export interface EventsResponse {
  items: EventRow[];           // newest first: ORDER BY timestamp_ms DESC, id DESC
  next_before_ms: number;      // cursor for the next (older) page
  next_before_id: number;
  has_more: boolean;
  total_count: number;         // total events matching filters (for drilldown_preview: = items.length)
}


// Parsed upstream response headers (copied from CPAMP web usageService.ts).
export interface ResponseHeaderQuotaWindow {
  used_percent?: number;
  reset_at_ms?: number;
  reset_after_seconds?: number;
  window_minutes?: number;
}

export interface ResponseHeaderQuotaMetadata {
  plan_type?: string;
  active_limit?: string;
  rate_limit_reached_type?: string;
  summary_window_kind?: string;
  summary_window_source?: string;
  reached_window_kind?: string;
  reached_window_source?: string;
  credits_balance?: string;
  credits_has_credits?: boolean;
  credits_unlimited?: boolean;
  primary_over_secondary_limit_percent?: number;
  primary?: ResponseHeaderQuotaWindow;
  secondary?: ResponseHeaderQuotaWindow;
  recover_at_ms?: number;
  used_percent?: number;
}

export interface ResponseHeaderErrorMetadata {
  kind?: string;
  code?: string;
  authorization_error?: string;
  ide_error_code?: string;
  ide_root_error_code?: string;
  retry_after_seconds?: number;
  retry_after_recover_at_ms?: number;
  rate_limit_bypass?: string;
  should_retry?: boolean;
}

export interface ResponseHeaderTraceMetadata {
  primary_trace_id?: string;
  openai_request_id?: string;
  request_id?: string;
  oneapi_request_id?: string;
  cf_ray?: string;
  eagle_id?: string;
  cloud_ai_companion_trace_id?: string;
  client_request_id?: string;
  zeabur_request_id?: string;
  traceparent?: string;
}

export interface ResponseHeaderRoutingMetadata {
  openai_proxy_wasm?: string;
  models_etag?: string;
  new_api_version?: string;
  server?: string;
  via?: string;
  cf_cache_status?: string;
  site_cache_status?: string;
  served_by?: string;
  mife_upstream_status?: string;
}

export interface ResponseHeaderResponseMetadata {
  content_type?: string;
  content_length?: number;
  content_disposition?: string;
  server_timing?: string;
}

export interface ResponseHeaderProviderMetadata {
  antigravity_trace_id?: string;
  antigravity_server_timing?: string;
  mife_upstream_status?: string;
  oneapi_request_id?: string;
  cloudflare_ray?: string;
  cloudflare_cache_status?: string;
}

export interface ResponseHeaderRateLimitBucket {
  limit?: number;
  remaining?: number;
}

export interface ResponseHeaderRateLimitMetadata {
  requests?: ResponseHeaderRateLimitBucket;
  tokens?: ResponseHeaderRateLimitBucket;
}

export interface ResponseHeaderDataPolicyMetadata {
  retention_mode?: string;
  zero_retention?: boolean;
}

export interface ProviderUsageMetadata {
  provider?: string;
  kind?: string;
  state?: string;
  code?: string;
  model?: string;
  unit?: string;
  actual?: number;
  limit?: number;
  remaining?: number;
  overage?: number;
  window_kind?: string;
  observed_at_ms?: number;
  recover_at_ms?: number;
  recover_at_estimated?: boolean;
  source?: string;
}

export interface ResponseHeaderMetadata {
  quota?: ResponseHeaderQuotaMetadata;
  errors?: ResponseHeaderErrorMetadata;
  trace?: ResponseHeaderTraceMetadata;
  routing?: ResponseHeaderRoutingMetadata;
  response?: ResponseHeaderResponseMetadata;
  providers?: ResponseHeaderProviderMetadata;
  rate_limit?: ResponseHeaderRateLimitMetadata;
  data_policy?: ResponseHeaderDataPolicyMetadata;
  provider_usage?: ProviderUsageMetadata;
}

/** `include.filter_selectors` (+ `filter_options`) response; option values ignore request filters. */
export interface FilterOptions {
  models?: string[];
  api_key_hashes?: string[];
  providers?: string[];
  auth_files?: string[];
  accounts?: string[];
  account_count?: number;
  api_key_count?: number;
  api_key_stats?: ApiKeyStatRow[];
  // Only with plain filter_options (no selectors); heavy (thousands of trace ids per day).
  channel_share?: ChannelShareRow[];
  model_stats?: ModelStat[];
  project_ids?: string[];
  request_types?: string[];
  header_error_kinds?: string[];
  header_error_codes?: string[];
  header_quota_plans?: string[];
  header_trace_ids?: string[];
}
