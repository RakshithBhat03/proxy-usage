import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconChevronDown, IconChevronLeft } from '@/components/ui/icons';
import { IconCalendar } from '@/components/ui/extraIcons';
import {
  BUCKET_LABELS,
  QUICK_PRESETS,
  RANGE_PRESETS,
  allowedBuckets,
  describeSpan,
  presetLabel,
  shiftRange,
  type BucketSize,
  type ConcreteBucket,
  type PresetDef,
  type TimeRangeValue,
} from '@/lib/timeRange';
import type { TimeRangeState } from '@/hooks/useTimeRange';
import styles from './TimeRangePicker.module.scss';

const GROUPS: Array<{ id: PresetDef['group']; label: string }> = [
  { id: 'minutes', label: 'Minutes' },
  { id: 'hours', label: 'Hours' },
  { id: 'days', label: 'Rolling days' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'other', label: 'Everything' },
];

const pad = (n: number) => String(n).padStart(2, '0');
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (value: string) => {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/** Horizontal box the popover must fit in: the nearest ancestor that clips overflow, else the viewport. */
const clipBounds = (from: HTMLElement | null) => {
  for (let el = from; el && el !== document.body; el = el.parentElement) {
    if (getComputedStyle(el).overflowX !== 'visible') {
      const rect = el.getBoundingClientRect();
      return { left: Math.max(rect.left, 0), right: Math.min(rect.right, window.innerWidth) };
    }
  }
  return { left: 0, right: window.innerWidth };
};

interface TimeRangePickerProps {
  state: TimeRangeState;
  /** Show the bucket-size selector (charts). */
  showBucket?: boolean;
  /** Show the inline quick chips (24h, 7d…) next to the trigger. */
  showQuick?: boolean;
  /** Hover/focus intent on a preset, so the page can prefetch it before the click lands. */
  onPreview?: (value: TimeRangeValue) => void;
}

/**
 * Range control: quick chips, a popover with every preset plus a custom from/to (minute precision),
 * back/forward stepping by the current span, and an optional bucket-size selector.
 */
export function TimeRangePicker({ state, showBucket = true, showQuick = true, onPreview }: TimeRangePickerProps) {
  const { value, range, bucket, plan, setValue, setBucket } = state;
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(() => toLocalInput(range.fromMs));
  const [draftTo, setDraftTo] = useState(() => toLocalInput(range.toMs));
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const quickRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraftFrom(toLocalInput(range.fromMs));
    setDraftTo(toLocalInput(range.toMs));
    setError(null);
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
    // Re-seed drafts only when the popover opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The popover is wider than the picker row, so anchor it to the row's left edge and slide it back
  // only as far as needed to stay inside whatever clips it (page container or viewport).
  useLayoutEffect(() => {
    const popover = popoverRef.current;
    const root = rootRef.current;
    if (!open || !popover || !root) return;
    const place = () => {
      popover.style.left = '';
      // Mobile pins the popover to the viewport in CSS.
      if (getComputedStyle(popover).position === 'fixed') return;
      const gutter = 8;
      const rootLeft = root.getBoundingClientRect().left;
      const bounds = clipBounds(root.parentElement);
      const overflow = rootLeft + popover.offsetWidth - (bounds.right - gutter);
      const room = Math.max(0, rootLeft - (bounds.left + gutter));
      popover.style.left = `${-Math.min(Math.max(0, overflow), room)}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  // Sliding thumb under the active quick chip: rapid toggling reads as one continuous control.
  useLayoutEffect(() => {
    const group = quickRef.current;
    if (!group) return;
    const measure = () => {
      const active = group.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      setThumb(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(group);
    return () => observer?.disconnect();
  }, [value.preset]);

  const preview = (next: TimeRangeValue) => onPreview?.(next);

  const span = range.toMs - range.fromMs;
  const bucketOptions = useMemo(() => allowedBuckets(span), [span]);
  const atPresent = Date.now() - range.toMs < 60_000;

  const applyCustom = () => {
    const fromMs = fromLocalInput(draftFrom);
    const toMs = fromLocalInput(draftTo);
    if (fromMs === null || toMs === null) return setError('Enter both dates.');
    if (fromMs >= toMs) return setError('Start must be before end.');
    setValue({ preset: 'custom', fromMs, toMs });
    setOpen(false);
  };

  const applyQuickSpan = (minutesBack: number) => {
    const toMs = Date.now();
    setDraftFrom(toLocalInput(toMs - minutesBack * 60_000));
    setDraftTo(toLocalInput(toMs));
  };

  return (
    <div className={styles.root} ref={rootRef}>
      {showQuick && (
        <div className={styles.quick} role="group" aria-label="Quick ranges" ref={quickRef}>
          {thumb && <span className={styles.thumb} style={{ transform: `translateX(${thumb.left}px)`, width: thumb.width }} aria-hidden="true" />}
          {QUICK_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={value.preset === preset}
              onPointerEnter={() => preview({ preset })}
              onFocus={() => preview({ preset })}
              onClick={() => setValue({ preset })}
              title={presetLabel(preset)}
            >
              {RANGE_PRESETS.find((p) => p.id === preset)?.short}
            </button>
          ))}
        </div>
      )}

      <div className={styles.stepper}>
        <button
          type="button"
          className={styles.stepButton}
          onClick={() => setValue(shiftRange(range, -1))}
          aria-label="Previous period"
          title="Previous period"
        >
          <IconChevronLeft size={14} />
        </button>
        <button
          type="button"
          className={styles.trigger}
          onClick={() => setOpen((prev) => !prev)}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <IconCalendar size={14} />
          <span className={styles.triggerLabel}>{value.preset === 'custom' ? describeSpan(range.fromMs, range.toMs) : range.label}</span>
          <IconChevronDown size={14} className={open ? styles.caretOpen : styles.caret} />
        </button>
        <button
          type="button"
          className={styles.stepButton}
          onClick={() => setValue(shiftRange(range, 1))}
          disabled={atPresent}
          aria-label="Next period"
          title="Next period"
        >
          <IconChevronLeft size={14} style={{ transform: 'rotate(180deg)' }} />
        </button>
      </div>

      {showBucket && (
        <label className={styles.bucket} title="Chart bucket size">
          <span className={styles.bucketLabel}>Bucket</span>
          <select
            value={bucket === 'auto' || bucketOptions.includes(bucket as ConcreteBucket) ? bucket : 'auto'}
            onChange={(event) => setBucket(event.target.value as BucketSize)}
          >
            <option value="auto">Auto · {BUCKET_LABELS[plan.size]}</option>
            {bucketOptions.map((size) => (
              <option key={size} value={size}>
                {BUCKET_LABELS[size]}
              </option>
            ))}
          </select>
        </label>
      )}

      {open && (
        <div className={styles.popover} ref={popoverRef} role="dialog" aria-label="Choose time range">
          <div className={styles.presets}>
            {GROUPS.map((group) => (
              <div key={group.id} className={styles.group}>
                <div className={styles.groupLabel}>{group.label}</div>
                <div className={styles.groupItems}>
                  {RANGE_PRESETS.filter((p) => p.group === group.id).map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      aria-pressed={value.preset === preset.id}
                      onPointerEnter={() => preview({ preset: preset.id })}
                      onClick={() => {
                        setValue({ preset: preset.id });
                        setOpen(false);
                      }}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className={styles.custom}>
            <div className={styles.groupLabel}>Custom range</div>
            <label className={styles.field}>
              <span>From</span>
              <input type="datetime-local" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span>To</span>
              <input type="datetime-local" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} />
            </label>
            <div className={styles.spanChips}>
              {[
                ['5m', 5],
                ['45m', 45],
                ['2h', 120],
                ['8h', 480],
                ['48h', 2880],
              ].map(([label, minutes]) => (
                <button key={label} type="button" onClick={() => applyQuickSpan(Number(minutes))}>
                  {label}
                </button>
              ))}
            </div>
            {error && <div className={styles.error}>{error}</div>}
            <button type="button" className={styles.apply} onClick={applyCustom}>
              Apply range
            </button>
            <div className={styles.span}>{describeSpan(range.fromMs, range.toMs)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
