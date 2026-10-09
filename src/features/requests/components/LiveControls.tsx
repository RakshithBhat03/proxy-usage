import { IconPause, IconPlay } from '@/components/ui/extraIcons';
import { POLL_INTERVALS } from '../useLivePolling';
import styles from './LiveControls.module.scss';

interface LiveControlsProps {
  live: boolean;
  /** Polling actually running (live, rolling range, tab visible). */
  running: boolean;
  /** Increments on every poll; re-keys the dot so its ring plays once per poll. */
  beat: number;
  /** The selected range is fixed (yesterday, custom…), so there is nothing to poll. */
  fixedRange: boolean;
  intervalMs: number;
  onLiveChange: (live: boolean) => void;
  onIntervalChange: (ms: number) => void;
}

export function LiveControls({ live, running, beat, fixedRange, intervalMs, onLiveChange, onIntervalChange }: LiveControlsProps) {
  const label = fixedRange ? 'Fixed range' : live ? 'Live' : 'Paused';
  return (
    <div className={styles.group} role="group" aria-label="Live updates">
      <button
        type="button"
        className={styles.toggle}
        aria-pressed={live && !fixedRange}
        disabled={fixedRange}
        onClick={() => onLiveChange(!live)}
        title={fixedRange ? 'Pick a rolling range (e.g. Last hour) to follow live traffic' : live ? 'Pause live updates' : 'Resume live updates'}
      >
        <span key={beat} className={`${styles.dot} ${running ? styles.dotLive : ''} ${!live || fixedRange ? styles.dotOff : ''}`} aria-hidden="true" />
        <span>{label}</span>
        {!fixedRange && <span className={styles.toggleIcon}>{live ? <IconPause size={12} /> : <IconPlay size={12} />}</span>}
      </button>
      <select
        className={styles.select}
        value={intervalMs}
        onChange={(event) => onIntervalChange(Number(event.target.value))}
        aria-label="Polling interval"
        title="Polling interval"
        disabled={fixedRange}
      >
        {POLL_INTERVALS.map((option) => (
          <option key={option.ms} value={option.ms}>
            every {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
