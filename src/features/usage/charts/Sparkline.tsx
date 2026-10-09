import { useId, useMemo } from 'react';
import { buildSmoothLinePath } from './curve';
import styles from './Sparkline.module.scss';

const W = 100;
const H = 28;
const TOP = 3;

interface SparklineProps {
  points: number[];
  color?: string;
  ariaLabel: string;
  className?: string;
}

/** CPAMC mini line: 2px non-scaling stroke over a 16%→1% area; flat data reads as a quiet rule. */
export function Sparkline({ points, color = 'var(--text-secondary)', ariaLabel, className }: SparklineProps) {
  const gradientId = useId();
  const geometry = useMemo(() => {
    const values = points.filter((v) => Number.isFinite(v));
    if (values.length === 0) return null;
    const max = Math.max(...values);
    const stepX = values.length > 1 ? W / (values.length - 1) : 0;
    const coords = values.map((value, index) => ({
      x: values.length > 1 ? index * stepX : W / 2,
      y: H - (max > 0 ? value / max : 0) * (H - TOP),
    }));
    const line = buildSmoothLinePath(coords, TOP, H);
    const first = coords[0];
    const last = coords[coords.length - 1];
    return { line, area: `${line} L${last.x} ${H} L${first.x} ${H} Z`, flat: max <= 0 };
  }, [points]);

  if (!geometry) return <div className={[styles.empty, className].filter(Boolean).join(' ')} aria-hidden="true" />;
  const stroke = geometry.flat ? 'var(--text-quaternary)' : color;
  return (
    <svg className={[styles.sparkline, className].filter(Boolean).join(' ')} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.16" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0.01" />
        </linearGradient>
      </defs>
      {!geometry.flat && <path d={geometry.area} fill={`url(#${gradientId})`} stroke="none" />}
      <path d={geometry.line} fill="none" stroke={stroke} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
