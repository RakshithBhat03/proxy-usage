import type { ReactNode } from 'react';
import { useCountUp } from '@/hooks/motion';

interface StatTileProps {
  label: ReactNode;
  /** Raw number for the count-up animation; `format` turns it into display text. */
  value: number | null | undefined;
  format: (value: number) => string;
  hint?: ReactNode;
  tone?: 'default' | 'live' | 'attention' | 'amber';
  /** Optional inline sparkline or bar. */
  children?: ReactNode;
}

/** KPI tile: small label, large mono figure that counts up, muted hint line. */
export function StatTile({ label, value, format, hint, tone = 'default', children }: StatTileProps) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null;
  // Count up on integers scaled by 100 so fractional values (cost, TPS) animate smoothly too.
  const animated = useCountUp(numeric === null ? 0 : Math.round(numeric * 100), numeric !== null);
  return (
    <div className={`kit-stat kit-stat--${tone}`} data-reveal>
      <div className="kit-stat__label">{label}</div>
      <div className="kit-stat__value">{numeric === null ? '--' : format(animated / 100)}</div>
      {hint && <div className="kit-stat__hint">{hint}</div>}
      {children && <div className="kit-stat__extra">{children}</div>}
    </div>
  );
}
