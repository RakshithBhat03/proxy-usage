import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconCheck, IconChevronDown, IconSearch } from '@/components/ui/icons';
import styles from './MultiSelect.module.scss';

export interface MultiOption {
  value: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
}

interface MultiSelectProps {
  label: string;
  options: MultiOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchPlaceholder?: string;
  icon?: ReactNode;
}

/** Filter pill that opens a searchable checklist; selected values stay listed even if they vanish from the range. */
export function MultiSelect({ label, options, selected, onChange, searchPlaceholder = 'Search', icon }: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

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

  const merged = useMemo<MultiOption[]>(() => {
    const known = new Set(options.map((o) => o.value));
    return [...options, ...selected.filter((v) => !known.has(v)).map((value) => ({ value, label: value, hint: 'not in range' }))];
  }, [options, selected]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? merged.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) : merged;
  }, [merged, query]);

  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={`${styles.trigger} ${selected.length ? styles.triggerActive : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {icon && <span className={styles.triggerIcon}>{icon}</span>}
        {label}
        {selected.length > 0 && <span className={styles.count}>{selected.length}</span>}
        <IconChevronDown size={13} className={open ? styles.caretOpen : styles.caret} />
      </button>
      {open && (
        <div className={styles.popover} role="listbox" aria-multiselectable="true" aria-label={label}>
          {merged.length > 6 && (
            <label className={styles.search}>
              <IconSearch size={13} />
              <input autoFocus value={query} placeholder={searchPlaceholder} onChange={(e) => setQuery(e.target.value)} />
            </label>
          )}
          <div className={styles.list}>
            {visible.length === 0 && <div className={styles.empty}>No matches</div>}
            {visible.map((option) => {
              const checked = selected.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  className={styles.option}
                  onClick={() => toggle(option.value)}
                  title={option.label}
                >
                  <span className={`${styles.box} ${checked ? styles.boxChecked : ''}`} aria-hidden="true">
                    {checked && <IconCheck size={11} />}
                  </span>
                  {option.icon}
                  <span className={styles.optionLabel}>{option.label}</span>
                  {option.hint && <span className={styles.optionHint}>{option.hint}</span>}
                </button>
              );
            })}
          </div>
          <div className={styles.footer}>
            <button type="button" className={styles.footerLink} disabled={!selected.length} onClick={() => onChange([])}>
              Clear
            </button>
            <button type="button" className={styles.footerDone} onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
