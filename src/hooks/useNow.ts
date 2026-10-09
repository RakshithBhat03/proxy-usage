import { useEffect, useState } from 'react';

/** Current instant, re-rendering every `intervalMs` (default one minute) for relative labels. */
export function useNow(intervalMs = 60_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}
