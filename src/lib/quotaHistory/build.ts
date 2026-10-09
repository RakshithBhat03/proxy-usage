import { MINUTE_MS } from '@/lib/quota/parse';
import { windowKindOf, windowLabel } from './sources';
import type { BoundaryBasis, CycleBoundary, HistoryWindow, ObservationSource, QuotaObservation, UsagePoint } from './types';

/**
 * Turns scattered quota readings into windows. A reading belongs to the window whose scheduled
 * reset it reports, so readings are clustered per window id by reset time. Manager cycles add exact
 * boundaries (and windows nobody observed a percentage for), and overlapping windows reveal early
 * (manual) resets: Codex reset credits start a fresh window before the old one was due.
 */

const SOURCE_ORDER: ObservationSource[] = ['headers', 'snapshot', 'live', 'signals', 'log'];
const MAX_POINTS_PER_WINDOW = 160;

/** Reset times jitter by a second or two between responses; cycles drift by milliseconds. */
function resetTolerance(durationMs: number | null): number {
  if (durationMs === null) return 10 * MINUTE_MS;
  return Math.min(15 * MINUTE_MS, Math.max(3 * MINUTE_MS, durationMs * 0.01));
}

interface Cluster {
  windowId: string;
  label?: string;
  durationMs: number | null;
  resetAtMs: number;
  observations: QuotaObservation[];
  cycle: CycleBoundary | null;
}

function downsample(points: UsagePoint[]): UsagePoint[] {
  if (points.length <= MAX_POINTS_PER_WINDOW) return points;
  // Keep the peak and both ends; thin the rest evenly so long weekly windows stay cheap to draw.
  const step = points.length / MAX_POINTS_PER_WINDOW;
  const keep = new Set<number>([0, points.length - 1]);
  let peak = 0;
  points.forEach((p, i) => {
    if (p.used > points[peak].used) peak = i;
  });
  keep.add(peak);
  for (let i = 0; i < MAX_POINTS_PER_WINDOW; i++) keep.add(Math.floor(i * step));
  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}

export interface BuildOptions {
  provider: string;
  now: number;
  /** Extrapolate earlier weekly windows on the fixed schedule back to this instant (no headers needed). */
  scheduleBackToMs?: number;
}

export function buildWindows(observations: QuotaObservation[], cycles: CycleBoundary[], options: BuildOptions): HistoryWindow[] {
  const { provider, now } = options;
  const byId = new Map<string, Cluster[]>();
  const clusterFor = (windowId: string, durationMs: number | null, resetAtMs: number): Cluster => {
    const list = byId.get(windowId) ?? [];
    if (!byId.has(windowId)) byId.set(windowId, list);
    const tol = resetTolerance(durationMs);
    let best: Cluster | null = null;
    for (const cluster of list) {
      const delta = Math.abs(cluster.resetAtMs - resetAtMs);
      if (delta <= tol && (!best || delta < Math.abs(best.resetAtMs - resetAtMs))) best = cluster;
    }
    if (best) {
      if (best.durationMs === null && durationMs !== null) best.durationMs = durationMs;
      return best;
    }
    const created: Cluster = { windowId, durationMs, resetAtMs, observations: [], cycle: null };
    list.push(created);
    return created;
  };

  const sorted = observations
    .filter((o) => Number.isFinite(o.usedPercent) && o.resetAtMs > o.observedAtMs - MINUTE_MS)
    .sort((a, b) => a.observedAtMs - b.observedAtMs);
  for (const obs of sorted) {
    const cluster = clusterFor(obs.windowId, obs.durationMs, obs.resetAtMs);
    cluster.observations.push(obs);
    // Track the newest reported reset (the provider may correct it slightly over time).
    cluster.resetAtMs = obs.resetAtMs;
    if (obs.label && !cluster.label) cluster.label = obs.label;
  }
  for (const cycle of cycles) {
    const cluster = clusterFor(cycle.windowId, cycle.durationMs, cycle.state === 'active' ? cycle.endMs : cycle.endMs);
    cluster.cycle = cycle;
    if (cycle.state === 'active') cluster.resetAtMs = cycle.endMs;
  }

  const windows: HistoryWindow[] = [];
  for (const [windowId, clusters] of byId) {
    const durationMs = clusters.find((c) => c.durationMs !== null)?.durationMs ?? null;
    const label = windowLabel(provider, windowId, clusters.find((c) => c.label)?.label);
    const kind = windowKindOf(windowId, durationMs);
    const list = clusters
      .map((cluster) => toWindow(cluster, durationMs, label, kind))
      .filter((w): w is HistoryWindow => w !== null)
      .sort((a, b) => a.scheduledEndMs - b.scheduledEndMs);

    resolveOverlaps(list);

    const hasHeaderHistory = list.some((w) => w.sources.includes('headers'));
    if (options.scheduleBackToMs !== undefined && kind === 'weekly' && durationMs !== null && !hasHeaderHistory && list.length > 0) {
      list.unshift(...scheduleBackfill(list[0], options.scheduleBackToMs));
    }

    for (const window of list) {
      window.status = !window.endedEarly && window.startMs <= now && now < window.endMs ? 'current' : 'past';
      windows.push(window);
    }
  }
  return windows.filter((w) => w.endMs > w.startMs && w.startMs <= now);
}

function toWindow(cluster: Cluster, durationMs: number | null, label: string, kind: HistoryWindow['kind']): HistoryWindow | null {
  const obs = cluster.observations;
  const points: UsagePoint[] = [];
  let lastT = -Infinity;
  for (const o of obs) {
    if (o.observedAtMs === lastT) {
      points[points.length - 1].used = Math.max(points[points.length - 1].used, o.usedPercent);
      continue;
    }
    points.push({ t: o.observedAtMs, used: Math.max(0, o.usedPercent) });
    lastT = o.observedAtMs;
  }
  const cycle = cluster.cycle;
  const duration = cycle?.durationMs ?? durationMs;
  const scheduledEnd = cycle ? (cycle.state === 'active' ? cycle.endMs : Math.max(cycle.endMs, cluster.resetAtMs)) : cluster.resetAtMs;
  let start: number;
  let boundary: BoundaryBasis;
  if (cycle) {
    start = cycle.startMs;
    boundary = 'exact';
  } else if (duration !== null) {
    start = cluster.resetAtMs - duration;
    boundary = 'observed';
  } else if (points.length > 0) {
    start = points[0].t;
    boundary = 'observed';
  } else {
    return null;
  }
  const end = cycle && cycle.state === 'closed' ? cycle.endMs : scheduledEnd;
  const sources = SOURCE_ORDER.filter((s) => obs.some((o) => o.source === s));
  if (cycle) sources.push('snapshot');
  const used = points.map((p) => p.used);
  return {
    uid: `${cluster.windowId}@${Math.round(scheduledEnd / MINUTE_MS)}`,
    windowId: cluster.windowId,
    label,
    kind,
    durationMs: duration,
    startMs: start,
    endMs: end,
    scheduledEndMs: scheduledEnd,
    status: 'past',
    endedEarly: Boolean(cycle && cycle.state === 'closed' && cycle.endReason && cycle.endReason !== 'scheduled'),
    boundary,
    peakUsed: used.length ? Math.max(...used) : null,
    lastUsed: used.length ? used[used.length - 1] : null,
    lastObservedAtMs: points.length ? points[points.length - 1].t : null,
    firstObservedAtMs: points.length ? points[0].t : null,
    points: downsample(points),
    sources: [...new Set(sources)],
  };
}

/**
 * A window that starts before its predecessor was due means the predecessor was reset early. The
 * exact moment is unknown; it lies between the last reading of the old window and the first of the
 * new one, so the cut goes at the new window's first reading. Zero-usage "phantom" windows
 * (providers sometimes report a sliding reset before a window starts) are dropped when overlapped.
 */
function resolveOverlaps(list: HistoryWindow[]) {
  for (let i = 0; i < list.length - 1; i++) {
    const current = list[i];
    const next = list[i + 1];
    const tol = resetTolerance(current.durationMs);
    if (next.startMs >= current.endMs - tol) continue;
    if ((current.peakUsed ?? 0) === 0 && current.boundary !== 'exact') {
      list.splice(i, 1);
      i -= 1;
      continue;
    }
    const floor = current.lastObservedAtMs ?? current.startMs;
    const cut = Math.min(current.endMs, Math.max(floor, next.firstObservedAtMs ?? next.startMs));
    current.endMs = cut;
    current.endedEarly = cut < current.scheduledEndMs - tol;
    next.startMs = Math.max(next.startMs, cut);
  }
}

/** Earlier windows on a fixed weekly schedule: boundaries are certain enough to total usage. */
function scheduleBackfill(earliest: HistoryWindow, backToMs: number): HistoryWindow[] {
  const duration = earliest.durationMs as number;
  const out: HistoryWindow[] = [];
  for (let k = 1; k <= 26; k++) {
    const end = earliest.startMs - (k - 1) * duration;
    const start = end - duration;
    if (end <= backToMs) break;
    out.unshift({
      ...earliest,
      uid: `${earliest.windowId}@${Math.round(end / MINUTE_MS)}`,
      startMs: start,
      endMs: end,
      scheduledEndMs: end,
      status: 'past',
      endedEarly: false,
      boundary: 'schedule',
      peakUsed: null,
      lastUsed: null,
      lastObservedAtMs: null,
      firstObservedAtMs: null,
      points: [],
      sources: [],
    });
  }
  return out;
}
