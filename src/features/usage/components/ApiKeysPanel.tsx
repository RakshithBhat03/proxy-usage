import { Panel } from '@/components/kit';
import type { ApiKeyStatRow } from '@/lib/api/analytics';
import { formatCost, formatInt, formatRatio, formatRelative, formatTokens } from '@/lib/format';
import { useIdentity } from '@/stores/privacy';
import { ShareBar } from './sortable';
import styles from './panels.module.scss';

/**
 * Short label for a client API key. Only the key's SHA-256 is stored, so the label is built from the
 * hash (never from the key itself) and makes no pretence of showing the key's own characters.
 */
const apiKeyLabel = (hash: string) => (hash ? `key ••${hash.slice(0, 6)}` : 'unknown key');

/** Client API keys. Rendered only when at least one event carried a key hash. */
export function ApiKeysPanel({ rows, now }: { rows: ApiKeyStatRow[]; now: number }) {
  const identity = useIdentity();
  const known = rows.filter((r) => r.api_key_hash);
  const unknownCalls = rows.filter((r) => !r.api_key_hash).reduce((s, r) => s + r.calls, 0);
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const sorted = [...known].sort((a, b) => b.cost - a.cost);
  return (
    <Panel
      flush
      title="Client API keys"
      subtitle={`${known.length} keys${unknownCalls > 0 ? ` · ${formatInt(unknownCalls)} requests without a key hash` : ''}`}
      data-reveal
    >
      <div className="kit-table-wrap">
        <table className={`kit-table ${styles.table}`}>
          <thead>
            <tr>
              <th>Key</th>
              <th>Credential</th>
              <th data-align="right">Requests</th>
              <th data-align="right">Success</th>
              <th data-align="right">Tokens</th>
              <th data-align="right">Cost</th>
              <th className={styles.shareCol}>Share</th>
              <th data-align="right">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                <td data-mono="true" title={`SHA-256 of the client API key: ${r.api_key_hash}`}>
                  {apiKeyLabel(r.api_key_hash)}
                </td>
                <td className={styles.dim}>{identity(r.auth_label_snapshot || r.account_snapshot || '') || '--'}</td>
                <td data-align="right" data-mono="true">{formatInt(r.calls)}</td>
                <td data-align="right" data-mono="true">{formatRatio(r.success_rate)}</td>
                <td data-align="right" data-mono="true">{formatTokens(r.total_tokens)}</td>
                <td data-align="right" data-mono="true" className={styles.strong}>{formatCost(r.cost)}</td>
                <td className={styles.shareCol}>
                  <ShareBar value={totalCost > 0 ? r.cost / totalCost : 0} />
                </td>
                <td data-align="right" data-mono="true">{r.last_seen_ms ? formatRelative(r.last_seen_ms, now) : '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
