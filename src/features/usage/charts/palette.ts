import { TOKEN_COLORS } from '@/lib/tokenColors';

/**
 * Chart colors. Emerald only ever means healthy traffic and terracotta failure. Token categories
 * use their own validated set (shared with the Request Monitor, see lib/tokenColors); everything
 * else is a single ink ramp so the page stays calm and themes flip for free.
 */
const ink = (pct: number) => `color-mix(in srgb, var(--text-primary) ${pct}%, transparent)`;

export const COLORS = {
  success: 'var(--viz-success)',
  failure: 'var(--viz-failure)',
  warn: 'var(--amber-color)',
  cacheRead: TOKEN_COLORS.cacheRead,
  cacheWrite: TOKEN_COLORS.cacheWrite,
  fresh: TOKEN_COLORS.fresh,
  output: TOKEN_COLORS.output,
  reasoning: TOKEN_COLORS.reasoning,
  cost: ink(72),
  line: 'var(--text-primary)',
  lineMuted: ink(42),
  ink,
} as const;
