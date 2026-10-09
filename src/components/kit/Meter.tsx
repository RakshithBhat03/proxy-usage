interface MeterProps {
  /** 0–100 */
  percent: number | null | undefined;
  tone?: 'auto-remaining' | 'auto-used' | 'neutral' | 'live' | 'attention';
  height?: number;
}

/**
 * Thin quota bar. `auto-remaining` colors by how much is left (green ≥ 50, amber ≥ 20, red below),
 * which is how CPAMC reads quota windows.
 */
export function Meter({ percent, tone = 'auto-remaining', height = 4 }: MeterProps) {
  const value = typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  let color = 'var(--text-tertiary)';
  if (value !== null) {
    if (tone === 'auto-remaining') color = value >= 50 ? 'var(--viz-success)' : value >= 20 ? 'var(--quota-medium-color)' : 'var(--viz-failure)';
    else if (tone === 'auto-used') color = value <= 50 ? 'var(--viz-success)' : value <= 80 ? 'var(--quota-medium-color)' : 'var(--viz-failure)';
    else if (tone === 'live') color = 'var(--viz-success)';
    else if (tone === 'attention') color = 'var(--viz-failure)';
    else color = 'var(--text-secondary)';
  }
  return (
    <div className="kit-meter" style={{ height }} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}>
      <div className="kit-meter__fill" style={{ width: `${value ?? 0}%`, background: color }} />
    </div>
  );
}
