import { useLayoutEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '@/hooks/motion';

const easeOutQuart = (p: number) => 1 - (1 - p) ** 4;

export interface TweenFrame {
  /** Column identities (bucket starts) so a rolling refresh that adds a bucket morphs instead of regrowing. */
  keys: number[];
  /** rows[series][column] in data units; null = gap. */
  rows: Array<Array<number | null>>;
  /**
   * Axis maximum, tweened together with the rows. Morphing in data units against a moving axis
   * keeps bars consistent with the grid mid-animation; tweening ratios against an axis that
   * snapped would draw old bars on the new scale.
   */
  max: number;
}

/**
 * Interpolates chart geometry toward the latest frame with a one-off rAF loop per data change
 * (never a continuous repaint). Columns are matched by key; a different `kind` (bars vs lines,
 * series count) grows in from zero instead of morphing.
 */
export function useTweenedFrame(target: TweenFrame, kind: string, duration = 280): TweenFrame {
  const [value, setValue] = useState<TweenFrame>(() => ({
    keys: target.keys,
    rows: target.rows.map((row) => row.map((v) => (v === null ? null : 0))),
    max: target.max,
  }));
  const currentRef = useRef(value);
  const kindRef = useRef<string | null>(null);

  // Layout effect so a stale frame (other metric/kind) is never painted before the tween starts.
  useLayoutEffect(() => {
    const previous = currentRef.current;
    const sameKind = kindRef.current === kind && previous.rows.length === target.rows.length;
    kindRef.current = kind;

    if (prefersReducedMotion()) {
      currentRef.current = target;
      setValue(target);
      return;
    }

    const prevIndex = new Map(previous.keys.map((key, i) => [key, i]));
    const matched = target.keys.filter((key) => prevIndex.has(key)).length;
    // A new range/bucket size shares few columns with the old frame: morphing would be noise, so
    // the chart re-enters instead, columns growing from the baseline in a quick left-to-right wave.
    // Same shape (live refresh shifting one bucket, filter change) morphs; anything that moves
    // the columns themselves re-enters, since bars sliding sideways while resizing reads as jitter.
    const entrance = !sameKind || previous.keys.length !== target.keys.length || matched < target.keys.length * 0.9;
    const columns = target.keys.length;
    const stagger = entrance && columns > 1 ? Math.min(12, 260 / columns) : 0;
    const columnDuration = entrance ? 420 : duration;
    const total = columnDuration + stagger * Math.max(0, columns - 1);

    const start = target.rows.map((row, s) =>
      row.map((v, j) => {
        if (entrance) return v === null ? null : 0;
        const i = prevIndex.get(target.keys[j]);
        const old = i === undefined ? undefined : previous.rows[s]?.[i];
        // New columns: bars grow from the baseline; lines start in place so their ends do not dip.
        if (old === undefined || old === null) return v === null ? null : kind.startsWith('bars') ? 0 : v;
        return old;
      }),
    );

    // On entrance the axis lands immediately so the growing bars are already on their final scale.
    const startMax = !entrance && sameKind && previous.max > 0 ? previous.max : target.max;
    currentRef.current = { keys: target.keys, rows: start, max: startMax };
    setValue(currentRef.current);

    let frame = 0;
    let t0: number | null = null;
    const step = (now: number) => {
      if (t0 === null) t0 = now;
      const elapsed = now - t0;
      const rows = target.rows.map((row, s) =>
        row.map((v, j) => {
          const a = start[s][j];
          if (v === null) return null;
          if (a === null) return v;
          const p = easeOutQuart(Math.min(1, Math.max(0, (elapsed - j * stagger) / columnDuration)));
          return a + (v - a) * p;
        }),
      );
      const pMax = easeOutQuart(Math.min(1, elapsed / columnDuration));
      const next = { keys: target.keys, rows, max: startMax + (target.max - startMax) * pMax };
      currentRef.current = next;
      setValue(next);
      if (elapsed < total) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, kind, duration]);

  return value;
}
