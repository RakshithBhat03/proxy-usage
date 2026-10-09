import { useMemo, useState, type ReactNode } from 'react';
import { IconChevronDown } from '@/components/ui/icons';
import styles from './panels.module.scss';

export type SortDir = 'asc' | 'desc';

export function useSorted<T, K extends string>(
  rows: T[],
  accessors: Record<K, (row: T) => number | string | null>,
  initial: NoInfer<K>,
) {
  const [key, setKey] = useState<K>(initial);
  const [dir, setDir] = useState<SortDir>('desc');
  const sorted = useMemo(() => {
    const get = accessors[key];
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va === vb) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      const cmp = typeof va === 'string' && typeof vb === 'string' ? va.localeCompare(vb) : Number(va) - Number(vb);
      return dir === 'asc' ? cmp : -cmp;
    });
    // accessors are module-level or memoized by callers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, key, dir]);
  const toggle = (next: K) => {
    if (next === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setKey(next);
      setDir(rows.length > 0 && typeof accessors[next](rows[0]) === 'string' ? 'asc' : 'desc');
    }
  };
  return { sorted, key, dir, toggle };
}

export function SortTh<K extends string>({
  id,
  label,
  sort,
  align = 'right',
  title,
}: {
  id: K;
  label: ReactNode;
  sort: { key: K; dir: SortDir; toggle: (k: K) => void };
  align?: 'left' | 'right';
  title?: string;
}) {
  const active = sort.key === id;
  return (
    <th
      data-sortable="true"
      data-align={align}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => sort.toggle(id)}
      title={title}
    >
      <span className={`${styles.th} ${active ? styles.thActive : ''}`}>
        {label}
        <IconChevronDown size={11} className={`${styles.sortIcon} ${active && sort.dir === 'asc' ? styles.sortAsc : ''}`} />
      </span>
    </th>
  );
}

/** Thin inline share bar used in table cells. */
export function ShareBar({ value, tone = 'ink' }: { value: number; tone?: 'ink' | 'live' | 'attention' }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span className={styles.shareBar} aria-hidden="true">
      <span className={`${styles.shareFill} ${styles[`share_${tone}`]}`} style={{ width: `${pct}%` }} />
    </span>
  );
}
