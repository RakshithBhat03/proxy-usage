import { useEffect, useRef, type ReactNode } from 'react';
import { IconFilterAll } from '@/components/ui/icons';
import { providerIcon, providerIconPlate, providerLabel } from '@/lib/providers';
import { useThemeStore } from '@/stores/theme';
import { scrollProviderTabs } from './providerTabsWheel';
import styles from './ProviderTabs.module.scss';

export interface TabItem {
  id: string;
  label?: string;
  count?: number;
  /** Custom glyph; provider ids get their brand icon automatically. */
  icon?: ReactNode;
}

interface ProviderTabsProps {
  items: TabItem[];
  active: string;
  onChange: (id: string) => void;
  /** Treat ids as provider keys (brand icons + labels). */
  providers?: boolean;
  ariaLabel?: string;
}

/**
 * CPAMC's quiet underline tabs: brand color only on the icon, the active tab gets ink text and a
 * 2px ink underline. Vertical wheel scrolls the strip horizontally.
 */
export function ProviderTabs({ items, active, onChange, providers = true, ariaLabel = 'Filter' }: ProviderTabsProps) {
  const theme = useThemeStore((state) => state.resolvedTheme);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => scrollProviderTabs(strip, event);
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div ref={ref} className={styles.tabs} role="group" aria-label={ariaLabel}>
      {items.map((item) => {
        const isActive = item.id === active;
        const label = item.label ?? (providers ? providerLabel(item.id) : item.id);
        const iconSrc = providers && item.id !== 'all' && !item.icon ? providerIcon(item.id, theme) : null;
        const plate = providers ? providerIconPlate(item.id, theme) : undefined;
        return (
          <button
            key={item.id}
            type="button"
            className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
            aria-pressed={isActive}
            onClick={() => onChange(item.id)}
          >
            {item.icon ? (
              <span className={styles.tabGlyph}>{item.icon}</span>
            ) : item.id === 'all' ? (
              <IconFilterAll className={styles.tabGlyph} size={15} />
            ) : providers ? (
              <span className={styles.tabIconWrap} style={plate ? { background: plate } : undefined}>
                {iconSrc ? (
                  <img src={iconSrc} alt="" className={styles.tabIcon} />
                ) : (
                  <span className={styles.tabIconFallback}>{label.slice(0, 1).toUpperCase()}</span>
                )}
              </span>
            ) : null}
            <span className={styles.tabLabel}>{label}</span>
            {item.count !== undefined && <span className={styles.tabCount}>{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
