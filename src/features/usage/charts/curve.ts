export interface CurvePoint {
  x: number;
  y: number;
}

/**
 * Catmull-Rom → cubic Bézier smoothing (CPAMC dashboard curve). Control-point y values are clamped
 * to [minY, maxY] so spikes never overshoot the baseline or the top edge.
 */
export function buildSmoothLinePath(points: CurvePoint[], minY: number, maxY: number): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  const clampY = (value: number) => Math.max(minY, Math.min(maxY, value));
  let path = `M${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(points.length - 1, index + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = clampY(p1.y + (p2.y - p0.y) / 6);
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = clampY(p2.y - (p3.y - p1.y) / 6);
    path += ` C${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return path;
}

/** Splits a series at nulls so missing buckets break the line instead of dropping to zero. */
export function segmentsOf(values: Array<number | null>): Array<Array<{ index: number; value: number }>> {
  const segments: Array<Array<{ index: number; value: number }>> = [];
  let current: Array<{ index: number; value: number }> = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push({ index, value });
  });
  if (current.length) segments.push(current);
  return segments;
}
