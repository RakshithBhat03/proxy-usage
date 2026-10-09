import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  planBuckets,
  readBucketFromParams,
  readRangeFromParams,
  resolveRange,
  writeRangeToParams,
  type BucketPlan,
  type BucketSize,
  type RangePreset,
  type ResolvedRange,
  type TimeRangeValue,
} from '@/lib/timeRange';

export interface TimeRangeState {
  value: TimeRangeValue;
  range: ResolvedRange;
  bucket: BucketSize;
  plan: BucketPlan;
  setValue: (value: TimeRangeValue) => void;
  setBucket: (bucket: BucketSize) => void;
  /** Re-anchor rolling ranges ("last 1h") to the current clock, e.g. on refresh or poll. */
  tick: () => void;
}

/**
 * Range + bucket state kept in the URL (`?range=&from=&to=&bucket=`) so a view can be bookmarked
 * or shared. Rolling ranges are resolved against a `now` that only advances on `tick()`, which
 * keeps query keys stable between refreshes.
 */
export function useTimeRange(defaultPreset: RangePreset, dataFloorMs?: number): TimeRangeState {
  const [params, setParams] = useSearchParams();
  const [now, setNow] = useState(() => Date.now());

  const value = useMemo(() => readRangeFromParams(params, defaultPreset), [params, defaultPreset]);
  const bucket = useMemo(() => readBucketFromParams(params), [params]);
  const range = useMemo(() => resolveRange(value, now, dataFloorMs), [value, now, dataFloorMs]);
  const plan = useMemo(() => planBuckets(range, bucket), [range, bucket]);

  const setValue = useCallback(
    (next: TimeRangeValue) => {
      setNow(Date.now());
      setParams((current) => writeRangeToParams(current, next), { replace: true });
    },
    [setParams],
  );

  const setBucket = useCallback(
    (next: BucketSize) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          if (next === 'auto') updated.delete('bucket');
          else updated.set('bucket', next);
          return updated;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const tick = useCallback(() => setNow(Date.now()), []);

  return { value, range, bucket, plan, setValue, setBucket, tick };
}
