import { useMemo, useState } from 'react';
import { Panel, ProviderIcon, SegmentedControl } from '@/components/kit';
import type { ModelTierStat } from '@/lib/api/analytics';
import { formatCost, formatDuration, formatInt, formatRatio, formatTokens, formatTps } from '@/lib/format';
import { modelProvider } from '../model/derive';
import { tierLabel } from '../model/filters';
import { ShareBar, SortTh, useSorted } from './sortable';
import styles from './panels.module.scss';

type ModelKey = 'model' | 'calls' | 'success' | 'input' | 'output' | 'cache' | 'cost' | 'tps' | 'ttft' | 'latency';

const ACCESSORS: Record<ModelKey, (r: ModelTierStat) => number | string | null> = {
  model: (r) => r.model,
  calls: (r) => r.calls,
  success: (r) => (r.calls > 0 ? r.success_rate : null),
  input: (r) => r.input_tokens,
  output: (r) => r.output_tokens,
  cache: (r) => (r.input_tokens > 0 ? r.cache_hit_rate : null),
  cost: (r) => r.cost,
  tps: (r) => r.output_tps,
  ttft: (r) => r.average_ttft_ms,
  latency: (r) => r.average_latency_ms,
};

const LIMIT = 8;

/** True when a model burned tokens but the price book gave it no cost. */
export const isUnpriced = (r: { cost: number; total_tokens: number; calls: number }) => r.calls > 0 && r.total_tokens > 0 && r.cost <= 0;

interface ModelsPanelProps {
  rows: ModelTierStat[];
  selected: string[];
  onToggleModel: (model: string) => void;
  onOpenPrices: () => void;
  tierScoped: boolean;
}

export function ModelsPanel({ rows, selected, onToggleModel, onOpenPrices, tierScoped }: ModelsPanelProps) {
  const [showAll, setShowAll] = useState(false);
  const sort = useSorted(rows, ACCESSORS, 'cost');
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const totalTokens = rows.reduce((s, r) => s + r.total_tokens, 0);
  const share = (r: ModelTierStat) => (totalCost > 0 ? r.cost / totalCost : totalTokens > 0 ? r.total_tokens / totalTokens : 0);
  const visible = showAll ? sort.sorted : sort.sorted.slice(0, LIMIT);
  const unpricedCount = new Set(rows.filter(isUnpriced).map((r) => r.model)).size;

  return (
    <Panel
      flush
      title="Models"
      subtitle={`${new Set(rows.map((r) => r.model)).size} models · per service tier${tierScoped ? ' · tier filter applied' : ''} · click a model to filter`}
      actions={
        unpricedCount > 0 ? (
          <button type="button" className="kit-badge kit-badge--amber" onClick={onOpenPrices} style={{ border: 0, cursor: 'pointer' }}>
            {unpricedCount} unpriced
          </button>
        ) : undefined
      }
      data-reveal
    >
      {rows.length === 0 ? (
        <div className="kit-empty">No model traffic in this range</div>
      ) : (
        <>
          <div className="kit-table-wrap">
            <table className={`kit-table ${styles.table}`}>
              <thead>
                <tr>
                  <SortTh id="model" label="Model" sort={sort} align="left" />
                  <SortTh id="calls" label="Requests" sort={sort} />
                  <SortTh id="success" label="Success" sort={sort} />
                  <SortTh id="input" label="Input" sort={sort} />
                  <SortTh id="output" label="Output" sort={sort} />
                  <SortTh id="cache" label="Cache hit" sort={sort} />
                  <SortTh id="cost" label="Cost" sort={sort} />
                  <th className={styles.shareCol}>Share</th>
                  <SortTh id="tps" label="Speed" sort={sort} title="Mean of each request's output tokens ÷ latency" />
                  <SortTh id="ttft" label="TTFT" sort={sort} title="Average time to first token, successful requests" />
                  <SortTh id="latency" label="Latency" sort={sort} title="Average latency, successful requests" />
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const active = selected.includes(r.model);
                  return (
                    <tr key={`${r.model}|${r.service_tier}`} className={active ? styles.rowActive : undefined}>
                      <td>
                        <button type="button" className={styles.entity} onClick={() => onToggleModel(r.model)} title={active ? 'Remove model filter' : 'Filter to this model'}>
                          {modelProvider(r.model) && <ProviderIcon provider={modelProvider(r.model)} size={13} />}
                          <span className={styles.entityName}>{r.model}</span>
                          {r.service_tier && r.service_tier !== 'normal' && <span className="kit-badge">{tierLabel(r.service_tier)}</span>}
                          {isUnpriced(r) && <span className="kit-badge kit-badge--amber">unpriced</span>}
                        </button>
                      </td>
                      <td data-align="right" data-mono="true">{formatInt(r.calls)}</td>
                      <td data-align="right" data-mono="true" className={r.calls > 0 && r.success_rate < 0.97 ? styles.warnText : undefined}>
                        {r.calls > 0 ? formatRatio(r.success_rate) : '--'}
                      </td>
                      <td data-align="right" data-mono="true">{formatTokens(r.input_tokens)}</td>
                      <td data-align="right" data-mono="true">{formatTokens(r.output_tokens)}</td>
                      <td data-align="right" data-mono="true">{r.input_tokens > 0 ? formatRatio(r.cache_hit_rate) : '--'}</td>
                      <td data-align="right" data-mono="true" className={styles.strong}>{formatCost(r.cost)}</td>
                      <td className={styles.shareCol}>
                        <span className={styles.shareCell}>
                          <ShareBar value={share(r)} />
                          <span>{formatRatio(share(r), 0)}</span>
                        </span>
                      </td>
                      <td data-align="right" data-mono="true">{formatTps(r.output_tps)}</td>
                      <td data-align="right" data-mono="true">{formatDuration(r.average_ttft_ms)}</td>
                      <td data-align="right" data-mono="true">{formatDuration(r.average_latency_ms)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > LIMIT && (
            <button type="button" className={styles.more} onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${rows.length}`}
            </button>
          )}
        </>
      )}
    </Panel>
  );
}

type ShareMetric = 'cost' | 'calls' | 'tokens';

/** Model share as a calm bar list (no categorical colors needed): top 7 + other. */
export function ModelSharePanel({ rows }: { rows: ModelTierStat[] }) {
  const [metric, setMetric] = useState<ShareMetric>('cost');
  const items = useMemo(() => {
    const byModel = new Map<string, { model: string; cost: number; calls: number; tokens: number }>();
    for (const r of rows) {
      const acc = byModel.get(r.model) ?? { model: r.model, cost: 0, calls: 0, tokens: 0 };
      acc.cost += r.cost;
      acc.calls += r.calls;
      acc.tokens += r.total_tokens;
      byModel.set(r.model, acc);
    }
    const list = Array.from(byModel.values()).sort((a, b) => b[metric] - a[metric]);
    const total = list.reduce((s, x) => s + x[metric], 0);
    const top = list.slice(0, 7);
    const rest = list.slice(7);
    const restValue = rest.reduce((s, x) => s + x[metric], 0);
    const out = top.map((x) => ({ label: x.model, value: x[metric], share: total > 0 ? x[metric] / total : 0 }));
    if (rest.length) out.push({ label: `${rest.length} others`, value: restValue, share: total > 0 ? restValue / total : 0 });
    return out;
  }, [rows, metric]);
  const fmt = metric === 'cost' ? formatCost : metric === 'calls' ? formatInt : formatTokens;
  const max = Math.max(0, ...items.map((i) => i.share));

  return (
    <Panel
      title="Model share"
      actions={
        <SegmentedControl
          size="sm"
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'cost', label: 'Cost' },
            { value: 'calls', label: 'Requests' },
            { value: 'tokens', label: 'Tokens' },
          ]}
          ariaLabel="Share metric"
        />
      }
      data-reveal
    >
      {items.length === 0 ? (
        <div className="kit-empty">No data</div>
      ) : (
        <ul className={styles.barList}>
          {items.map((item) => (
            <li key={item.label} className={styles.barItem}>
              <div className={styles.barHead}>
                <span className={styles.barLabel}>
                  {modelProvider(item.label) && <ProviderIcon provider={modelProvider(item.label)} size={12} />}
                  {item.label}
                </span>
                <span className={styles.barValue}>
                  {fmt(item.value)} <span className={styles.barPct}>{formatRatio(item.share)}</span>
                </span>
              </div>
              <span className={styles.barTrack}>
                <span className={styles.barFill} style={{ width: `${max > 0 ? (item.share / max) * 100 : 0}%` }} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
