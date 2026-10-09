// Importing the values here (not from a page stylesheet) guarantees the variables exist on every
// page that renders token colors, whichever route loads first.
import './tokenColors.scss';

export type TokenCategory = 'cacheRead' | 'cacheWrite' | 'fresh' | 'output' | 'reasoning';

/** Single source of truth for token category colors; per-theme values live in tokenColors.scss. */
export const TOKEN_COLORS: Record<TokenCategory, string> = {
  cacheRead: 'var(--viz-token-cache-read)',
  cacheWrite: 'var(--viz-token-cache-write)',
  fresh: 'var(--viz-token-fresh)',
  output: 'var(--viz-token-output)',
  // Reasoning is billed inside output, so it is a tint of output rather than a fifth hue.
  reasoning: 'color-mix(in srgb, var(--viz-token-output) 50%, transparent)',
};
