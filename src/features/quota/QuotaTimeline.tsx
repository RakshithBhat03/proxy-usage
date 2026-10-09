import { useMemo, useState, type CSSProperties } from 'react';
import { SegmentedControl } from '@/components/kit';
import { formatDay, formatRelativeInstant, formatTime } from '@/lib/quota/parse';
import {
  DAY_MS,
  buildTimelineLane,
  laneHasWindow,
  projectLane,
  projectResetCredits,
  timelineSpan,
  type TimelineLane,
  type TimelineLaneInput,
  type TimelineMode,
} from '@/lib/quota/timeline';
import { providerColors } from '@/lib/providers';
import { useThemeStore } from '@/stores/theme';
import styles from './QuotaTimeline.module.scss';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (value: number) => String(value).padStart(2, '0');

interface QuotaTimelineProps {
  lanes: Array<Omit<TimelineLaneInput, 'maxPeriodHours'>>;
  now: number;
}

/**
 * "Quota windows": the cards say how much is left; this says when it comes back and whether
 * several credentials come back at the same moment. Projection maths lives in lib/quota/timeline.
 */
export function QuotaTimeline({ lanes: inputs, now }: QuotaTimelineProps) {
  const [mode, setMode] = useState<TimelineMode>('weekly');
  const [offset, setOffset] = useState(0);
  const theme = useThemeStore((state) => state.resolvedTheme);

  const span = useMemo(() => timelineSpan(mode, offset, now), [mode, offset, now]);
  const hasAnyLane = useMemo(() => inputs.some((input) => laneHasWindow(buildTimelineLane(input))), [inputs]);
  const lanes = useMemo(
    () =>
      inputs
        .map((input) => buildTimelineLane({ ...input, maxPeriodHours: mode === 'session' ? 5 : span.days * 24 }))
        .filter((lane) => laneHasWindow(lane) && (mode !== 'session' || lane.periodHours === 5)),
    [inputs, mode, span.days],
  );

  const cells = useMemo(() => {
    const zoomed = mode === 'session';
    const count = zoomed ? span.days * 4 : span.days;
    const cellMs = (span.endMs - span.startMs) / count;
    const todayStart = new Date(now).setHours(0, 0, 0, 0);
    return Array.from({ length: count }, (_, index) => {
      const at = span.startMs + index * cellMs;
      const date = new Date(at);
      const isDayStart = !zoomed || date.getHours() === 0;
      return {
        at,
        isDayStart,
        isToday: new Date(at).setHours(0, 0, 0, 0) === todayStart,
        isWeekend: date.getDay() === 0 || date.getDay() === 6,
        weekday: WEEKDAYS[date.getDay()],
        label: isDayStart ? formatDay(at) : `${pad(date.getHours())}:00`,
      };
    });
  }, [mode, span, now]);

  const nowPercent = now >= span.startMs && now < span.endMs ? ((now - span.startMs) / (span.endMs - span.startMs)) * 100 : null;

  if (!hasAnyLane) return null;

  return (
    <section className={`${styles.timeline} kit-enter`}>
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>Quota windows</h2>
          <p className={styles.range}>
            {formatDay(span.startMs)} – {formatDay(span.endMs - DAY_MS)} · {mode === 'weekly' ? 'two weeks' : 'three days'}
            {offset === 0 && ' · current'}
          </p>
        </div>
        <div className={styles.controls}>
          <div className="kit-segmented" role="group" aria-label="Navigate period">
            <button type="button" onClick={() => setOffset((v) => v - 1)} aria-label="Previous">
              ‹
            </button>
            <button type="button" onClick={() => setOffset(0)} disabled={offset === 0} title={offset === 0 ? undefined : 'Back to today'}>
              {offset === 0 ? 'Today' : formatDay(span.startMs)}
            </button>
            <button type="button" onClick={() => setOffset((v) => v + 1)} aria-label="Next">
              ›
            </button>
          </div>
          <SegmentedControl
            value={mode}
            ariaLabel="Timeline zoom"
            options={[
              { value: 'weekly', label: 'Weekly' },
              { value: 'session', label: '5-hour' },
            ]}
            onChange={(next) => {
              setMode(next);
              setOffset(0); // spans differ in size, so an old offset means nothing
            }}
          />
        </div>
      </header>

      <div className={styles.chart}>
        {lanes.length === 0 ? (
          <div className={styles.empty} role="status">
            No credentials on this page report a 5-hour quota window.
          </div>
        ) : (
          <div className={styles.scroller}>
            <div className={styles.axis}>
              <div className={styles.axisLabel}>Credential</div>
              <div className={styles.axisCells}>
                {cells.map((cell) => (
                  <div key={cell.at} className={styles.axisCell} data-today={cell.isToday ? 1 : 0} data-weekend={cell.isWeekend ? 1 : 0}>
                    <span className={styles.axisWeekday}>{cell.isDayStart ? cell.weekday : ''}</span>
                    <span className={styles.axisDate}>{cell.label}</span>
                  </div>
                ))}
              </div>
            </div>
            {lanes.map((lane) => (
              <Lane
                key={lane.name}
                lane={lane}
                span={span}
                now={now}
                mode={mode}
                cells={cells}
                nowPercent={nowPercent}
                accent={providerColors(lane.provider, theme).text}
              />
            ))}
          </div>
        )}
      </div>

      {lanes.length > 0 && (
        <footer className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles.swatchLive}`} />
            current window
          </span>
          <span className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles.swatchNext}`} />
            upcoming
          </span>
          <span className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles.swatchPast}`} />
            elapsed
          </span>
          <span className={styles.legendItem}>
            <span className={styles.swatchCredit} />
            manual reset expiry
          </span>
          <span className={styles.legendNote}>
            {mode === 'weekly'
              ? 'Each bar is one full quota window, drawn from when it opened to when it resets. Lanes ending together compete for the same days.'
              : 'Each bar is one 5-hour window. Only credentials with a window counting down can be projected; the rest stay empty rather than invented.'}
          </span>
        </footer>
      )}
    </section>
  );
}

interface LaneProps {
  lane: TimelineLane;
  span: { startMs: number; endMs: number; days: number };
  now: number;
  mode: TimelineMode;
  cells: Array<{ at: number; isWeekend: boolean; isDayStart: boolean }>;
  nowPercent: number | null;
  accent: string;
}

function Lane({ lane, span, now, mode, cells, nowPercent, accent }: LaneProps) {
  const windows = useMemo(() => projectLane(lane, span.startMs, span.endMs, now, mode), [lane, span, now, mode]);
  const credits = useMemo(() => projectResetCredits(lane, span.startMs, span.endMs, now), [lane, span, now]);
  // Sub-day windows are labelled in hours: rounding 5h to days would read "0d".
  const periodLabel =
    mode === 'session' ? '5h' : !lane.periodHours ? '' : lane.periodHours < 24 ? `${Math.round(lane.periodHours)}h` : `${Math.round(lane.periodHours / 24)}d`;

  return (
    <div className={styles.lane} style={{ '--provider-accent': accent } as CSSProperties}>
      <div className={styles.laneHead}>
        <div className={styles.laneTop}>
          <span className={styles.laneDot} />
          <span className={styles.laneName} title={lane.displayName}>
            {lane.displayName}
          </span>
          {periodLabel && <span className={styles.lanePeriod}>{periodLabel}</span>}
        </div>
        <div className={styles.laneLimits}>
          {lane.limits.map((limit) => (
            <span key={limit.label} className={styles.laneLimit}>
              {limit.label} <b>{limit.remaining}%</b>
            </span>
          ))}
        </div>
      </div>

      <div className={styles.track}>
        <div className={styles.trackGrid}>
          {cells.map((cell) => (
            <span key={cell.at} data-weekend={cell.isWeekend ? 1 : 0} data-daystart={cell.isDayStart ? 1 : 0} />
          ))}
        </div>
        {nowPercent !== null && <div className={styles.nowLine} style={{ left: `${nowPercent}%` }} />}
        {windows.length === 0 ? (
          <span className={styles.laneIdle}>no window counting down</span>
        ) : (
          windows.map((window) => {
            const showLabel = window.widthPercent > (mode === 'session' ? 4.5 : 9);
            const endText = mode === 'session' ? formatTime(window.endMs) : `${formatDay(window.endMs)} ${formatTime(window.endMs)}`;
            const stateClass = window.state === 'live' ? styles.windowLive : window.state === 'next' ? styles.windowNext : styles.windowPast;
            return (
              <div
                key={window.startMs}
                className={`${styles.window} ${stateClass}`}
                style={{ left: `${window.leftPercent}%`, width: `${window.widthPercent}%` }}
                title={`${lane.displayName}\n${formatDay(window.startMs)} ${formatTime(window.startMs)} → ${formatDay(window.endMs)} ${formatTime(window.endMs)}${
                  window.remaining !== null ? `\n${window.remaining}% remaining` : ''
                }`}
              >
                {window.remaining !== null && <span className={styles.windowFill} style={{ width: `${100 - window.remaining}%` }} />}
                {showLabel && (
                  <span className={styles.windowLabel}>
                    {window.remaining !== null ? `${window.remaining}% · ` : ''}
                    {endText}
                  </span>
                )}
              </div>
            );
          })
        )}
        {credits.map((credit, index) => {
          const title = [
            'Manual reset',
            credit.grantedAtMs !== null ? `Granted: ${formatDay(credit.grantedAtMs)} ${formatTime(credit.grantedAtMs)}` : null,
            `Expires: ${formatDay(credit.expiresAtMs)} ${formatTime(credit.expiresAtMs)}`,
            formatRelativeInstant(credit.expiresAtMs, now),
          ]
            .filter((line): line is string => line !== null)
            .join('\n');
          return (
            <span
              key={credit.id || `${credit.expiresAtMs}-${index}`}
              className={styles.creditTick}
              style={{ left: `${credit.leftPercent}%` }}
              title={title}
              role="img"
              aria-label={title.split('\n').join(', ')}
            />
          );
        })}
      </div>
    </div>
  );
}
