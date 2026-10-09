/** A "nice" axis maximum (1, 2, 2.5, 5 × 10^n) so `ticks` intervals land on round numbers. */
export function niceMax(value: number, ticks = 4): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const raw = value / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  return step * ticks;
}
