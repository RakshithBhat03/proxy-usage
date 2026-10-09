import { useLayoutEffect, useRef } from 'react';
import { animate } from 'motion/mini';
import { prefersReducedMotion } from './motion';

const easeOutQuart = (p: number) => 1 - (1 - p) ** 4;

/**
 * Replays a short "enter" (fade + 8px rise, same curve as page transitions) on the element each
 * time `key` changes, e.g. when the displayed time range changes. Data swaps then feel like the
 * smooth route changes instead of numbers silently flipping. Skipped on first mount, where the
 * page transition already animates the content in.
 */
export function useSwapAnimation<T extends HTMLElement>(key: string | null | undefined) {
  const ref = useRef<T | null>(null);
  const previous = useRef<string | null | undefined>(key);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || key === undefined || key === null) return;
    if (previous.current === key) return;
    const first = previous.current === undefined || previous.current === null;
    previous.current = key;
    if (first || prefersReducedMotion()) return;

    const animation = animate(
      element,
      { opacity: [0.35, 1], transform: ['translate3d(0, 8px, 0)', 'translate3d(0, 0, 0)'] },
      { duration: 0.34, ease: easeOutQuart },
    );
    const clear = () => {
      element.style.removeProperty('opacity');
      element.style.removeProperty('transform');
    };
    void animation.finished.then(clear).catch(() => undefined);
    return () => {
      animation.stop();
      clear();
    };
  }, [key]);

  return ref;
}
