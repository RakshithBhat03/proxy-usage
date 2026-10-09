import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { normalizeProvider } from '@/lib/providers';

/**
 * Quota windows hidden on the Quota history page. A window is hidden for every credential of its
 * provider ("gpt-reserve weekly" on all Codex accounts), keyed by provider + window id.
 */
interface HiddenWindowsState {
  /** key → window label, so the page can list what is hidden without the window being loaded. */
  hidden: Record<string, string>;
  hide: (key: string, label: string) => void;
  show: (key: string) => void;
}

export const hiddenWindowKey = (provider: string, windowId: string) => `${normalizeProvider(provider)}|${windowId}`;

export const useHiddenWindowsStore = create<HiddenWindowsState>()(
  persist(
    (set) => ({
      hidden: {},
      hide: (key, label) => set((state) => ({ hidden: { ...state.hidden, [key]: label } })),
      show: (key) =>
        set((state) => {
          const { [key]: _removed, ...rest } = state.hidden;
          return { hidden: rest };
        }),
    }),
    { name: 'proxy-usage.hidden-windows' },
  ),
);
