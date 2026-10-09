import type { QuotaData, QuotaEntry } from '../types';
import { fetchAntigravityQuota } from './antigravity';
import { fetchClaudeQuota } from './claude';
import { fetchCodexQuota } from './codex';
import { fetchDevinQuota } from './devin';
import { fetchKimiQuota } from './kimi';
import { fetchMetaQuota } from './meta';
import { fetchXaiQuota } from './xai';

export interface FetchQuotaOptions {
  signal?: AbortSignal;
  /** Allow side-effecting probes (xAI paid health sends a 1-token completion). Single-card clicks only. */
  allowProbe?: boolean;
}

/** Live quota for one credential through `api-call`; throws an Error carrying `status` on failure. */
export function fetchLiveQuota(entry: QuotaEntry, options: FetchQuotaOptions = {}): Promise<QuotaData> {
  const { signal } = options;
  switch (entry.provider) {
    case 'claude':
      return fetchClaudeQuota(entry.file, signal);
    case 'codex':
      return fetchCodexQuota(entry.file, signal);
    case 'antigravity':
      return fetchAntigravityQuota(entry.file, signal);
    case 'xai':
      return fetchXaiQuota(entry.file, options);
    case 'kimi':
      return fetchKimiQuota(entry.file, signal);
    case 'devin':
      return fetchDevinQuota(entry.file, signal);
    case 'meta':
      return fetchMetaQuota(entry.file, signal);
  }
}

export { consumeCodexResetCredit } from './codex';
export { claimClaudeResetGrant, claudeResetBlocker, pickResetGrant } from './claude';
