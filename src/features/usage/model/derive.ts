import type {
  AnomalyPoint,
  CredentialStatRow,
  ModelTierStat,
  Summary,
} from '@/lib/api/analytics';
import { normalizeProvider } from '@/lib/providers';

/** Fractional change, CPAMP's definition: no baseline → +100% if anything appeared. */
export function pctChange(current: number, previous: number): number {
  return previous <= 0 ? (current > 0 ? 1 : 0) : (current - previous) / previous;
}

export interface TierAggregate {
  /** Mean of per-request output TPS (output ÷ total latency), weighted by each row's samples. */
  outputTps: number | null;
  tpsSamples: number;
  /** Successful requests only; weighted by successful calls (the server does not expose sample counts). */
  avgTtft: number | null;
}

export function aggregateTiers(rows: ModelTierStat[]): TierAggregate {
  let tpsSum = 0;
  let tpsSamples = 0;
  let ttftSum = 0;
  let ttftWeight = 0;
  for (const row of rows) {
    if (row.output_tps !== null && row.tps_samples > 0) {
      tpsSum += row.output_tps * row.tps_samples;
      tpsSamples += row.tps_samples;
    }
    if (row.average_ttft_ms !== null && row.success_calls > 0) {
      ttftSum += row.average_ttft_ms * row.success_calls;
      ttftWeight += row.success_calls;
    }
  }
  return {
    outputTps: tpsSamples > 0 ? tpsSum / tpsSamples : null,
    tpsSamples,
    avgTtft: ttftWeight > 0 ? ttftSum / ttftWeight : null,
  };
}

export function freshInput(t: { input_tokens: number; cached_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }) {
  return Math.max(t.input_tokens - t.cached_tokens - t.cache_read_tokens - t.cache_creation_tokens, 0);
}

export interface TokenSlice {
  key: 'fresh' | 'cacheRead' | 'cacheWrite' | 'output' | 'reasoning';
  label: string;
  value: number;
}

/** Token composition. Reasoning is part of output, so it is reported separately, not stacked. */
export function tokenSlices(summary: Summary): { stack: TokenSlice[]; reasoning: number; total: number } {
  const stack: TokenSlice[] = [
    { key: 'cacheRead', label: 'Cache read', value: summary.cached_tokens + summary.cache_read_tokens },
    { key: 'cacheWrite', label: 'Cache write', value: summary.cache_creation_tokens },
    { key: 'fresh', label: 'Fresh input', value: freshInput(summary) },
    { key: 'output', label: 'Output', value: summary.output_tokens },
  ];
  return { stack, reasoning: summary.reasoning_tokens, total: stack.reduce((s, x) => s + x.value, 0) };
}

/** Best-effort provider for a model id, only used to pick an icon. */
export function modelProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('claude')) return 'claude';
  if (m.startsWith('gpt') || m.includes('codex') || /^o\d/.test(m)) return 'codex';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('grok')) return 'xai';
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('kimi')) return 'kimi';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('glm')) return 'glm';
  return '';
}

/** Provider of an auth file name such as `claude-user@x.json` or `codex-user@x-plus.json`. */
export function fileProvider(file: string): string {
  const head = file.split(/[-_]/)[0] ?? '';
  return normalizeProvider(head);
}

export function credentialLabel(row: Pick<CredentialStatRow, 'auth_label_snapshot' | 'account_snapshot' | 'auth_file_snapshot' | 'source' | 'auth_index' | 'id'>): string {
  return (
    row.auth_label_snapshot ||
    row.account_snapshot ||
    row.auth_file_snapshot ||
    row.source ||
    row.auth_index ||
    row.id ||
    '-'
  );
}

export const ANOMALY_LABELS: Record<AnomalyPoint['metric_keys'][number], string> = {
  request_spike: 'Request spike',
  cost_spike: 'Cost increase',
  tokens_per_request_spike: 'Tokens / request up',
  cache_hit_drop: 'Cache hit dropped',
  failure_rate_spike: 'Failure rate up',
  latency_spike: 'Latency up',
};

/** The change value that backs each anomaly metric. */
export function anomalyChange(point: AnomalyPoint, key: AnomalyPoint['metric_keys'][number]): number {
  switch (key) {
    case 'request_spike':
      return point.request_change;
    case 'cost_spike':
      return point.cost_change;
    case 'tokens_per_request_spike':
      return point.tokens_per_request_change;
    case 'cache_hit_drop':
      return point.cache_hit_rate_change;
    case 'failure_rate_spike':
      return point.failure_rate_change;
    case 'latency_spike':
      return point.latency_p95_change;
  }
}

/** Rate-like changes are absolute deltas of a 0..1 rate (shown as points); the rest are relative. */
export function formatAnomalyChange(key: AnomalyPoint['metric_keys'][number], value: number): string {
  const sign = value >= 0 ? '+' : '−';
  if (key === 'cache_hit_drop' || key === 'failure_rate_spike') return `${sign}${Math.abs(value * 100).toFixed(1)} pts`;
  return `${sign}${Math.abs(value * 100).toFixed(0)}%`;
}

export function successTone(rate: number, calls: number): 'default' | 'amber' | 'attention' {
  if (calls === 0) return 'default';
  if (rate >= 0.95) return 'default';
  if (rate >= 0.85) return 'amber';
  return 'attention';
}
