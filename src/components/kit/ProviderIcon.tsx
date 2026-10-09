import { providerIcon, providerIconPlate, providerLabel } from '@/lib/providers';
import { useThemeStore } from '@/stores/theme';

/** Brand mark for a provider key, with a letter fallback for unknown providers. */
export function ProviderIcon({ provider, size = 16 }: { provider: string; size?: number }) {
  const theme = useThemeStore((state) => state.resolvedTheme);
  const src = providerIcon(provider, theme);
  const plate = providerIconPlate(provider, theme);
  return (
    <span
      className="kit-provider-icon"
      style={{ width: size + 4, height: size + 4, background: plate }}
      aria-hidden="true"
    >
      {src ? (
        <img src={src} alt="" style={{ width: size, height: size }} />
      ) : (
        <span style={{ fontSize: Math.max(9, size * 0.62) }}>{providerLabel(provider).slice(0, 1)}</span>
      )}
    </span>
  );
}
