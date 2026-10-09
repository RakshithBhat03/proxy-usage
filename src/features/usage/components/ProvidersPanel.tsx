import { Panel, ProviderIcon } from '@/components/kit';
import type { CredentialStatRow } from '@/lib/api/analytics';
import { formatCost, formatInt, formatRatio, formatTokens } from '@/lib/format';
import { normalizeProvider, providerLabel } from '@/lib/providers';
import { credentialProvider } from './CredentialsPanel';
import { ShareBar } from './sortable';
import styles from './panels.module.scss';

interface ProviderRow {
  provider: string;
  calls: number;
  success: number;
  tokens: number;
  cost: number;
  cacheHit: number;
  input: number;
  topModel: { model: string; cost: number } | null;
}

/** Provider roll-up derived from credential rows (each credential belongs to one provider). */
export function ProvidersPanel({ rows, onPick }: { rows: CredentialStatRow[]; onPick: (provider: string) => void }) {
  const map = new Map<string, ProviderRow & { models: Map<string, number> }>();
  for (const r of rows) {
    const provider = normalizeProvider(credentialProvider(r)) || 'unknown';
    const acc = map.get(provider) ?? { provider, calls: 0, success: 0, tokens: 0, cost: 0, cacheHit: 0, input: 0, topModel: null, models: new Map() };
    acc.calls += r.calls;
    acc.success += r.success_calls;
    acc.tokens += r.total_tokens;
    acc.cost += r.cost;
    acc.cacheHit += r.cached_tokens + r.cache_read_tokens;
    acc.input += r.input_tokens;
    for (const m of r.models ?? []) acc.models.set(m.model, (acc.models.get(m.model) ?? 0) + m.cost);
    map.set(provider, acc);
  }
  const list = Array.from(map.values())
    .map((p) => {
      const top = [...p.models.entries()].sort((a, b) => b[1] - a[1])[0];
      return { ...p, topModel: top ? { model: top[0], cost: top[1] } : null };
    })
    .sort((a, b) => b.cost - a.cost || b.calls - a.calls);
  const totalCalls = list.reduce((s, p) => s + p.calls, 0);
  const totalCost = list.reduce((s, p) => s + p.cost, 0);

  return (
    <Panel flush title="Providers" subtitle="Click a provider to focus the page" data-reveal>
      <div className="kit-table-wrap">
        <table className={`kit-table ${styles.table}`}>
          <thead>
            <tr>
              <th>Provider</th>
              <th data-align="right">Requests</th>
              <th className={styles.shareCol}>Share</th>
              <th data-align="right">Cost</th>
              <th data-align="right">Tokens</th>
              <th data-align="right">Success</th>
              <th data-align="right">Cache hit</th>
              <th>Top model</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.provider}>
                <td>
                  <button type="button" className={styles.entity} onClick={() => onPick(p.provider)}>
                    <ProviderIcon provider={p.provider} size={13} />
                    <span className={styles.entityName}>{providerLabel(p.provider)}</span>
                  </button>
                </td>
                <td data-align="right" data-mono="true">{formatInt(p.calls)}</td>
                <td className={styles.shareCol}>
                  <span className={styles.shareCell}>
                    <ShareBar value={totalCalls > 0 ? p.calls / totalCalls : 0} />
                    <span>{formatRatio(totalCalls > 0 ? p.calls / totalCalls : 0, 0)}</span>
                  </span>
                </td>
                <td data-align="right" data-mono="true" className={styles.strong}>
                  {formatCost(p.cost)} <span className={styles.dim}>{totalCost > 0 ? formatRatio(p.cost / totalCost, 0) : ''}</span>
                </td>
                <td data-align="right" data-mono="true">{formatTokens(p.tokens)}</td>
                <td data-align="right" data-mono="true" className={p.calls > 0 && p.success / p.calls < 0.97 ? styles.warnText : undefined}>
                  {p.calls > 0 ? formatRatio(p.success / p.calls) : '--'}
                </td>
                <td data-align="right" data-mono="true">{p.input > 0 ? formatRatio(Math.min(1, p.cacheHit / p.input)) : '--'}</td>
                <td className={styles.dim}>{p.topModel ? `${p.topModel.model} · ${formatCost(p.topModel.cost)}` : '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
