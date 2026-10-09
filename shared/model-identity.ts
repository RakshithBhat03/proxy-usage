/**
 * Model and service-tier identity helpers shared by the browser and the server. Semantics ported
 * from CPA Manager Plus (MIT). Pure functions, no runtime dependencies.
 */

/** Trimmed, lower-cased key used for case-insensitive model / tier comparisons. */
export function normalizeKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

const REASONING_SUFFIXES = new Set(['none', 'auto', '-1', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function isReasoningSuffix(value: string): boolean {
  if (REASONING_SUFFIXES.has(value.toLowerCase())) return true;
  // A non-negative integer thinking budget (Go strconv.Atoi semantics: optional sign).
  return /^[+-]?\d+$/.test(value) && Number(value) >= 0;
}

/**
 * The model identity used for aggregation and price discovery. Removes only suffixes that CPA
 * recognizes as thinking configuration ("gpt-5(high)", "claude(8192)"); unknown parenthesized
 * aliases stay untouched.
 */
export function analyticsModel(model: string | null | undefined): string {
  if (!model) return '';
  const open = model.lastIndexOf('(');
  if (open <= 0 || !model.endsWith(')')) return model;
  const suffix = model.slice(open + 1, -1);
  if (!isReasoningSuffix(suffix)) return model;
  return model.slice(0, open);
}

/** The authoritative request-side model: `requested_model` when present, else `model`. */
export function effectiveRequestedModel(model: string | null | undefined, requestedModel: string | null | undefined): string {
  return requestedModel || model || '';
}

/** `analyticsModel(effectiveRequestedModel(model, requestedModel))`. */
export function analyticsModelForRequest(
  model: string | null | undefined,
  requestedModel: string | null | undefined,
): string {
  return analyticsModel(effectiveRequestedModel(model, requestedModel));
}

/**
 * Strips any trailing parenthesized suffix ("model (high)", "model(foo)"). Looser than
 * `analyticsModel`; used only when looking a model up in the price book.
 */
export function stripParenSuffix(model: string): string {
  return model.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Maps provider tier names onto user-facing speed classes. OpenAI "auto"/"default" and Anthropic
 * "standard" mean regular capacity; "priority" is what Codex sends for fast mode. Unknown tiers
 * (e.g. "flex") pass through lower-cased.
 */
export function normalizeServiceTier(tier: string | null | undefined): string {
  const value = normalizeKey(tier);
  if (!value || value === 'auto' || value === 'default' || value === 'standard' || value === 'standard_only') {
    return 'normal';
  }
  if (value === 'priority' || value === 'fast') return 'fast';
  return value;
}
