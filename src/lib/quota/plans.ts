import { normalizePlanType } from './parse';
import type { PlanInfo, PlanTier } from './types';

/**
 * Plan labels and badge tiers. Codex uses ChatGPT's own "Pro 20x / Pro 5x" naming (the fork's
 * ledger); CPAMC's "Pro 200 / Pro 100" spellings are aliases.
 */

const PREMIUM_CODEX = new Set(['prolite', 'pro-lite', 'pro_lite', 'self_serve_business_prolite']);

export function codexPlanTier(planType: string | null | undefined): PlanTier {
  const normalized = normalizePlanType(planType);
  if (!normalized) return 'plain';
  // 'pro' must be checked before the premium set or Pro 20x silently falls back to gold.
  if (normalized === 'pro') return 'elite';
  if (PREMIUM_CODEX.has(normalized)) return 'premium';
  return 'plain';
}

export function codexPlanLabel(planType: string | null | undefined): string | null {
  const normalized = normalizePlanType(planType);
  if (!normalized) return null;
  if (normalized === 'self_serve_business_prolite') return 'Business Premium';
  if (normalized === 'pro') return 'Pro 20x';
  if (PREMIUM_CODEX.has(normalized)) return 'Pro 5x';
  const known: Record<string, string> = { plus: 'Plus', team: 'Team', free: 'Free', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
  return known[normalized] ?? normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function codexPlan(planType: string | null | undefined): PlanInfo | null {
  const label = codexPlanLabel(planType);
  const id = normalizePlanType(planType);
  return label && id ? { id, label, tier: codexPlanTier(id) } : null;
}

const CLAUDE_PLAN_LABELS: Record<string, string> = {
  plan_free: 'Free',
  plan_pro: 'Pro',
  plan_max: 'Max',
  plan_max5: 'Max 5x',
  plan_max20: 'Max 20x',
  plan_team: 'Team',
};

export function claudePlan(planId: string | null | undefined): PlanInfo | null {
  if (!planId) return null;
  const label = CLAUDE_PLAN_LABELS[planId];
  if (!label) return null;
  return { id: planId, label, tier: planId.startsWith('plan_max') ? 'premium' : 'plain' };
}

const ANTIGRAVITY_PLAN_BY_TIER: Record<string, { id: string; label: string; tier: PlanTier }> = {
  'free-tier': { id: 'free', label: 'Free', tier: 'plain' },
  'g1-pro-tier': { id: 'pro', label: 'Pro', tier: 'plain' },
  'g1-ultra-tier': { id: 'ultra', label: 'Ultra', tier: 'premium' },
  'g1-ultra-lite-tier': { id: 'ultra-lite', label: 'Ultra Lite', tier: 'plain' },
};

export function antigravityPlan(tierId: string | null, tierName: string | null): PlanInfo | null {
  if (tierId && ANTIGRAVITY_PLAN_BY_TIER[tierId]) return ANTIGRAVITY_PLAN_BY_TIER[tierId];
  if (tierName) return { id: tierId ?? tierName, label: tierName, tier: 'plain' };
  return null;
}

export function xaiPlan(tier: string | null, display: string | null): PlanInfo | null {
  const label = display ?? tier;
  if (!label) return null;
  const key = `${display ?? ''} ${tier ?? ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const planTier: PlanTier = key.includes('heavy') ? 'elite' : key.includes('supergrok') || key.includes('premium') ? 'premium' : 'plain';
  return { id: tier ?? label, label, tier: planTier };
}

export function genericPlan(label: string | null | undefined): PlanInfo | null {
  const trimmed = typeof label === 'string' ? label.trim() : '';
  return trimmed ? { id: trimmed.toLowerCase(), label: trimmed, tier: 'plain' } : null;
}
