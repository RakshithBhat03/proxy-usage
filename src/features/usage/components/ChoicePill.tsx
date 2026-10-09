import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconCheck, IconChevronDown } from '@/components/ui/icons';
import styles from './MultiSelect.module.scss';

export interface Choice<T extends string> {
  value: T;
  label: string;
}

interface ChoicePillProps<T extends string> {
  /** Shown when the default (first) choice is active. */
  label: string;
  value: T;
  choices: Array<Choice<T>>;
  onChange: (value: T) => void;
  icon?: ReactNode;
  /** The neutral value; anything else renders the pill as active. */
  neutral?: T;
  /** Anchor the popover to the right edge (header actions). */
  align?: 'left' | 'right';
}

/** Single-choice twin of MultiSelect, same pill + popover look. */
export function ChoicePill<T extends string>({ label, value, choices, onChange, icon, neutral, align = 'left' }: ChoicePillProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = value !== (neutral ?? choices[0]?.value);
  const current = choices.find((c) => c.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={`${styles.trigger} ${active ? styles.triggerActive : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {icon && <span className={styles.triggerIcon}>{icon}</span>}
        {active && current ? current.label : label}
        <IconChevronDown size={13} className={open ? styles.caretOpen : styles.caret} />
      </button>
      {open && (
        <div className={styles.popover} role="listbox" aria-label={label} style={align === 'right' ? { width: 220, left: 'auto', right: 0 } : { width: 220 }}>
          <div className={styles.list}>
            {choices.map((choice) => (
              <button
                key={choice.value}
                type="button"
                role="option"
                aria-selected={choice.value === value}
                className={styles.option}
                onClick={() => {
                  onChange(choice.value);
                  setOpen(false);
                }}
              >
                <span className={styles.optionLabel}>{choice.label}</span>
                {choice.value === value && <IconCheck size={13} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
