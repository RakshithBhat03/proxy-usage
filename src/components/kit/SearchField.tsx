import { IconSearch, IconX } from '@/components/ui/icons';

interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

/** CPAMC's borderless search box: tinted well, focus ring, clear button. */
export function SearchField({ value, onChange, placeholder = 'Search', className = '' }: SearchFieldProps) {
  return (
    <label className={`kit-search ${className}`}>
      <IconSearch size={15} className="kit-search__icon" />
      <input
        type="search"
        className="kit-search__input"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <button type="button" className="kit-search__clear" onClick={() => onChange('')} aria-label="Clear search">
          <IconX size={14} />
        </button>
      )}
    </label>
  );
}
