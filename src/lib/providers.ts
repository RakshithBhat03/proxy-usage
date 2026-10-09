import iconAntigravity from '@/assets/providers/antigravity.svg';
import iconClaude from '@/assets/providers/claude.svg';
import iconCodex from '@/assets/providers/codex.svg';
import iconDeepseek from '@/assets/providers/deepseek.svg';
import iconDevin from '@/assets/providers/devin.svg';
import iconDevinDark from '@/assets/providers/devin-dark.svg';
import iconGemini from '@/assets/providers/gemini.svg';
import iconGlm from '@/assets/providers/glm.svg';
import iconGrok from '@/assets/providers/grok.svg';
import iconGrokDark from '@/assets/providers/grok-dark.svg';
import iconIflow from '@/assets/providers/iflow.svg';
import iconKimiDark from '@/assets/providers/kimi-dark.svg';
import iconKimiLight from '@/assets/providers/kimi-light.svg';
import iconMeta from '@/assets/providers/meta.svg';
import iconMinimax from '@/assets/providers/minimax.svg';
import iconOpenaiDark from '@/assets/providers/openai-dark.svg';
import iconOpenaiLight from '@/assets/providers/openai-light.svg';
import iconQwen from '@/assets/providers/qwen.svg';
import iconVertex from '@/assets/providers/vertex.svg';

export type ResolvedTheme = 'light' | 'dark';
type IconAsset = string | { light: string; dark: string };

/** Provider icons and badge colors, mirrored from CPAMC's authFiles/quota constants. */
const ICONS: Record<string, IconAsset> = {
  antigravity: iconAntigravity,
  aistudio: iconGemini,
  claude: iconClaude,
  anthropic: iconClaude,
  codex: iconCodex,
  openai: { light: iconOpenaiLight, dark: iconOpenaiDark },
  deepseek: iconDeepseek,
  devin: { light: iconDevin, dark: iconDevinDark },
  gemini: iconGemini,
  'gemini-cli': iconGemini,
  glm: iconGlm,
  xai: { light: iconGrok, dark: iconGrokDark },
  grok: { light: iconGrok, dark: iconGrokDark },
  iflow: iconIflow,
  kimi: { light: iconKimiDark, dark: iconKimiLight },
  meta: iconMeta,
  minimax: iconMinimax,
  qwen: iconQwen,
  vertex: iconVertex,
};

const LABELS: Record<string, string> = {
  all: 'All',
  antigravity: 'Antigravity',
  aistudio: 'AI Studio',
  claude: 'Claude',
  anthropic: 'Anthropic',
  codex: 'Codex',
  openai: 'OpenAI',
  'openai-compatibility': 'OpenAI Compatible',
  deepseek: 'DeepSeek',
  devin: 'Devin',
  gemini: 'Gemini',
  'gemini-cli': 'Gemini CLI',
  glm: 'GLM',
  xai: 'xAI',
  iflow: 'iFlow',
  kimi: 'Kimi',
  meta: 'Muse (Meta)',
  minimax: 'MiniMax',
  qwen: 'Qwen',
  vertex: 'Vertex',
};

interface ColorSet {
  bg: string;
  text: string;
}

const COLORS: Record<string, { light: ColorSet; dark: ColorSet }> = {
  qwen: { light: { bg: '#ede5fd', text: '#5530c7' }, dark: { bg: '#36208a', text: '#b5a3f0' } },
  gemini: { light: { bg: '#e3f2fd', text: '#1565c0' }, dark: { bg: '#0d47a1', text: '#64b5f6' } },
  aistudio: { light: { bg: '#f0f2f5', text: '#2f343c' }, dark: { bg: '#373c42', text: '#cfd3db' } },
  claude: { light: { bg: '#fbece4', text: '#c05621' }, dark: { bg: '#5e2c14', text: '#e8a882' } },
  codex: { light: { bg: '#eae7ff', text: '#3538d4' }, dark: { bg: '#262395', text: '#b5b0ff' } },
  devin: { light: { bg: '#e8f4ff', text: '#155e9b' }, dark: { bg: '#123b5d', text: '#8dc9f5' } },
  meta: { light: { bg: '#e3f2fd', text: '#1565c0' }, dark: { bg: '#0d47a1', text: '#64b5f6' } },
  kimi: { light: { bg: '#dce8ff', text: '#0560cf' }, dark: { bg: '#003880', text: '#70b5ff' } },
  antigravity: { light: { bg: '#e0f7fa', text: '#006064' }, dark: { bg: '#004d40', text: '#80deea' } },
  xai: { light: { bg: '#f3f4f6', text: '#111827' }, dark: { bg: '#111827', text: '#f9fafb' } },
  iflow: { light: { bg: '#f5e3fc', text: '#9025c8' }, dark: { bg: '#521490', text: '#d49cf5' } },
  vertex: { light: { bg: '#e4edfd', text: '#2b5fbc' }, dark: { bg: '#1a3d80', text: '#89b3f7' } },
  unknown: { light: { bg: '#f0f0f0', text: '#666666' }, dark: { bg: '#3a3a3a', text: '#aaaaaa' } },
};

const ALIASES: Record<string, string> = {
  anthropic: 'claude',
  'claude-code': 'claude',
  grok: 'xai',
  'gemini-cli': 'gemini',
  'meta-ai': 'meta',
  muse: 'meta',
};

export function normalizeProvider(value: unknown): string {
  const key = String(value ?? '')
    .trim()
    .toLowerCase();
  return ALIASES[key] ?? key;
}

export function providerLabel(value: unknown): string {
  const key = normalizeProvider(value);
  if (!key) return 'Unknown';
  return LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

export function providerIcon(value: unknown, theme: ResolvedTheme): string | null {
  const entry = ICONS[normalizeProvider(value)];
  if (!entry) return null;
  return typeof entry === 'string' ? entry : entry[theme];
}

/** Kimi's mark sits on a plate that flips with the theme, as in CPAMC. */
export function providerIconPlate(value: unknown, theme: ResolvedTheme): string | undefined {
  return normalizeProvider(value) === 'kimi' ? (theme === 'dark' ? '#ffffff' : '#000000') : undefined;
}

export function providerColors(value: unknown, theme: ResolvedTheme): ColorSet {
  const set = COLORS[normalizeProvider(value)] ?? COLORS.unknown;
  return set[theme];
}

/** A saturated accent per provider for lanes, legend dots and chart series. */
export function providerAccent(value: unknown): string {
  const accents: Record<string, string> = {
    claude: '#d97757',
    codex: '#7c7cf5',
    gemini: '#4c8df6',
    antigravity: '#26a69a',
    xai: '#9ca3af',
    kimi: '#3b82f6',
    devin: '#38bdf8',
    meta: '#1877f2',
    qwen: '#8b5cf6',
    iflow: '#c084fc',
    vertex: '#5b8def',
  };
  return accents[normalizeProvider(value)] ?? '#8b8680';
}
