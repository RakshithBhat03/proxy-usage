import { useEffect, useRef, useState } from 'react';

export type AutoRefresh = 'off' | '30s' | '1m' | '5m';
const MS: Record<Exclude<AutoRefresh, 'off'>, number> = { '30s': 30_000, '1m': 60_000, '5m': 300_000 };
const STORAGE_KEY = 'proxy-usage.usage.autoRefresh';

export const AUTO_REFRESH_CHOICES: Array<{ value: AutoRefresh; label: string }> = [
  { value: 'off', label: 'Auto refresh off' },
  { value: '30s', label: 'Every 30 seconds' },
  { value: '1m', label: 'Every minute' },
  { value: '5m', label: 'Every 5 minutes' },
];

/**
 * Interval refresh that pauses while the tab is hidden and catches up once when it returns
 * (if a tick was missed), so a background tab never polls the server.
 */
export function useAutoRefresh(refresh: () => void) {
  const [mode, setMode] = useState<AutoRefresh>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    return stored === '30s' || stored === '1m' || stored === '5m' ? stored : 'off';
  });

  // The latest callback, without restarting the interval every render.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    if (mode === 'off') return;
    const interval = MS[mode];
    let last = Date.now();
    let missed = false;
    const run = () => {
      last = Date.now();
      missed = false;
      refreshRef.current();
    };
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') run();
      else missed = true;
    }, interval);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && (missed || Date.now() - last >= interval)) run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [mode]);

  return [mode, setMode] as const;
}
