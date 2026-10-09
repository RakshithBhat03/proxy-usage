import type { HTMLAttributes, ReactNode } from 'react';

interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Remove body padding (tables, charts that bleed to the edge). */
  flush?: boolean;
}

/** Card surface used for every section: 12px radius, hairline border, `--bg-primary`. */
export function Panel({ title, subtitle, actions, flush, className = '', children, ...rest }: PanelProps) {
  return (
    <section className={`kit-panel ${flush ? 'kit-panel--flush' : ''} ${className}`} {...rest}>
      {(title || actions) && (
        <div className="kit-panel__head">
          <div className="kit-panel__titles">
            {title && <h2 className="kit-panel__title">{title}</h2>}
            {subtitle && <p className="kit-panel__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="kit-panel__actions">{actions}</div>}
        </div>
      )}
      <div className="kit-panel__body">{children}</div>
    </section>
  );
}

/** Section heading outside a card ("Quota windows", "Claude 5"). */
export function SectionHeading({ title, count, subtitle, actions }: { title: ReactNode; count?: number; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="kit-section-heading">
      <div>
        <h2 className="kit-section-heading__title">
          {title}
          {count !== undefined && <span className="kit-section-heading__count">{count}</span>}
        </h2>
        {subtitle && <p className="kit-section-heading__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="kit-section-heading__actions">{actions}</div>}
    </div>
  );
}
