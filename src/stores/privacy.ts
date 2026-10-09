import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { maskIdentifier } from '@/lib/format';

/**
 * One app-wide "Show emails" switch. Credentials are emails or email-bearing filenames, so every
 * page masks them by default (screenshots, screen shares) and unmasks together.
 */
interface PrivacyState {
  showEmails: boolean;
  setShowEmails: (show: boolean) => void;
  toggle: () => void;
}

export const usePrivacyStore = create<PrivacyState>()(
  persist(
    (set) => ({
      showEmails: false,
      setShowEmails: (showEmails) => set({ showEmails }),
      toggle: () => set((state) => ({ showEmails: !state.showEmails })),
    }),
    { name: 'proxy-usage.privacy' },
  ),
);

/** Hook form: returns a function that masks identifiers unless emails are shown. */
export function useIdentity(): (value: string | null | undefined) => string {
  const show = usePrivacyStore((state) => state.showEmails);
  return (value) => (value ? (show ? value : maskIdentifier(value)) : '');
}
