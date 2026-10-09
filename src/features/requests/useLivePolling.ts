import { useCallback, useEffect, useRef, useState } from 'react';

export const POLL_INTERVALS: Array<{ ms: number; label: string }> = [
  { ms: 2_000, label: '2s' },
  { ms: 5_000, label: '5s' },
  { ms: 10_000, label: '10s' },
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '1m' },
];

const STORAGE_KEY = 'proxy-usage.requests.live';

interface LiveSettings {
  live: boolean;
  intervalMs: number;
}

function readSettings(): LiveSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<LiveSettings>;
    const intervalMs = POLL_INTERVALS.some((o) => o.ms === raw.intervalMs) ? Number(raw.intervalMs) : 5_000;
    return { live: raw.live !== false, intervalMs };
  } catch {
    return { live: true, intervalMs: 5_000 };
  }
}

/** Live/paused + interval, remembered across visits. */
export function useLiveSettings() {
  const [settings, setSettings] = useState(readSettings);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);
  const setLive = useCallback((live: boolean) => setSettings((s) => ({ ...s, live })), []);
  const setIntervalMs = useCallback((intervalMs: number) => setSettings((s) => ({ ...s, intervalMs })), []);
  return { ...settings, setLive, setIntervalMs };
}

function isHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * Interval loop that only runs while `active` and the tab is visible. Coming back to the tab fires
 * one tick immediately so the view catches up instead of waiting a full interval. `beat` counts ticks
 * so live indicators can pulse once per poll instead of animating continuously.
 */
export function usePollingLoop(active: boolean, intervalMs: number, onTick: () => void) {
  const callback = useRef(onTick);
  const [hidden, setHidden] = useState(isHidden);
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    callback.current = onTick;
  }, [onTick]);

  useEffect(() => {
    const onVisibility = () => setHidden(isHidden());
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const running = active && !hidden;
  const wasRunning = useRef(running);

  useEffect(() => {
    const fire = () => {
      setBeat((b) => b + 1);
      callback.current();
    };
    if (running && !wasRunning.current) fire();
    wasRunning.current = running;
    if (!running) return;
    const id = window.setInterval(fire, intervalMs);
    return () => window.clearInterval(id);
  }, [running, intervalMs]);

  return { running, hidden, beat };
}
