import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { IconRefreshCw } from '@/components/ui/icons';

interface KitButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  spinning?: boolean;
}

/** The ink pill ("Refresh all credentials"): inverts automatically in dark mode. */
export function InkButton({ icon, spinning, children, className = '', ...rest }: KitButtonProps) {
  return (
    <button type="button" className={`kit-ink-button ${className}`} {...rest}>
      {icon ? <span className={spinning ? 'kit-spin' : undefined}>{icon}</span> : null}
      {children}
    </button>
  );
}

/** Small outlined pill used for card-level actions ("Refresh quota"). */
export function PillButton({ icon, spinning, children, className = '', ...rest }: KitButtonProps) {
  return (
    <button type="button" className={`kit-pill-button ${className}`} {...rest}>
      {icon ? <span className={`kit-pill-button__icon ${spinning ? 'kit-spin' : ''}`}>{icon}</span> : null}
      {children}
    </button>
  );
}

export function RefreshIcon({ size = 14 }: { size?: number }) {
  return <IconRefreshCw size={size} />;
}
