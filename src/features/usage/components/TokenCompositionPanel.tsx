import { useState } from 'react';
import { Panel } from '@/components/kit';
import type { Summary } from '@/lib/api/analytics';
import { formatCost, formatRatio, formatTokens } from '@/lib/format';
import { COLORS } from '../charts/palette';
import { tokenSlices } from '../model/derive';
import styles from './panels.module.scss';

const SLICE_COLORS = {
  cacheRead: COLORS.cacheRead,
  cacheWrite: COLORS.cacheWrite,
  fresh: COLORS.fresh,
  output: COLORS.output,
  reasoning: COLORS.reasoning,
} as const;

/** 100% stacked bar of where tokens went, with a legend table that carries the numbers. */
export function TokenCompositionPanel({ summary }: { summary: Summary }) {
  const { stack, reasoning, total } = tokenSlices(summary);
  const [hover, setHover] = useState<string | null>(null);
  const perRequest = summary.total_calls > 0 ? summary.total_tokens / summary.total_calls : 0;

  return (
    <Panel title="Token composition" subtitle={`${formatTokens(total)} tokens · ${formatTokens(perRequest)} per request`} data-reveal>
      {total === 0 ? (
        <div className="kit-empty">No tokens in this range</div>
      ) : (
        <div className={styles.composition}>
          <div className={styles.stackBar} role="img" aria-label="Token composition">
            {stack.map((slice) =>
              slice.value > 0 ? (
                <span
                  key={slice.key}
                  className={`${styles.stackSeg} ${hover && hover !== slice.key ? styles.stackSegDim : ''}`}
                  style={{ flexGrow: slice.value, background: SLICE_COLORS[slice.key] }}
                  onMouseEnter={() => setHover(slice.key)}
                  onMouseLeave={() => setHover(null)}
                  title={`${slice.label}: ${formatRatio(slice.value / total)}`}
                />
              ) : null,
            )}
          </div>
          <ul className={styles.legendTable}>
            {[...stack].reverse().map((slice) => (
              <li
                key={slice.key}
                className={hover === slice.key ? styles.legendRowActive : undefined}
                onMouseEnter={() => setHover(slice.key)}
                onMouseLeave={() => setHover(null)}
              >
                <span className={styles.legendSwatch} style={{ background: SLICE_COLORS[slice.key] }} aria-hidden="true" />
                <span className={styles.legendName}>{slice.label}</span>
                <span className={styles.legendNum}>{formatTokens(slice.value)}</span>
                <span className={styles.legendPct}>{formatRatio(slice.value / total)}</span>
              </li>
            ))}
            <li className={styles.legendSub}>
              <span className={styles.legendSwatch} style={{ background: SLICE_COLORS.reasoning }} aria-hidden="true" />
              <span className={styles.legendName}>of output: reasoning</span>
              <span className={styles.legendNum}>{formatTokens(reasoning)}</span>
              <span className={styles.legendPct}>{summary.output_tokens > 0 ? formatRatio(reasoning / summary.output_tokens) : '--'}</span>
            </li>
          </ul>
          <p className={styles.note}>
            Cache hit rate {formatRatio(summary.cache_hit_rate)} · avg {formatCost(summary.average_cost_per_call)} per request. Input already
            includes cache reads and writes; fresh input is what was billed at the full prompt rate.
          </p>
        </div>
      )}
    </Panel>
  );
}
