import type { ReactNode } from 'react';

export interface MetaPart {
  text: ReactNode;
  tone?: 'default' | 'live' | 'muted' | 'attention';
}

interface PageHeaderProps {
  title: ReactNode;
  /** Mono telemetry line under the title, prefixed with the green ▍ cursor and joined by dots. */
  meta?: MetaPart[];
  actions?: ReactNode;
}

/** CPAMC page header: tight title, ▍ mono telemetry line, actions aligned to the bottom right. */
export function PageHeader({ title, meta, actions }: PageHeaderProps) {
  return (
    <header className="kit-page-header">
      <div className="kit-page-header__copy">
        <h1 className="kit-page-title" data-reveal>
          {title}
        </h1>
        {meta && meta.length > 0 && (
          <p className="kit-page-meta" data-reveal>
            {meta.map((part, index) => (
              <span key={index} className="kit-page-meta__part">
                {index > 0 && (
                  <span className="kit-page-meta__dot" aria-hidden="true">
                    ·
                  </span>
                )}
                <span className={`kit-tone-${part.tone ?? 'default'}`}>{part.text}</span>
              </span>
            ))}
          </p>
        )}
      </div>
      {actions && (
        <div className="kit-page-header__actions" data-reveal>
          {actions}
        </div>
      )}
    </header>
  );
}
