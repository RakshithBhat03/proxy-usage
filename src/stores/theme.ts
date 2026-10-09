import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Same four themes as CPAMC: auto resolves to white or dark from the OS preference. */
export type Theme = 'auto' | 'white' | 'light' | 'dark';
type AppliedTheme = 'light' | 'white' | 'dark';

interface ThemeState {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
  initializeTheme: () => () => void;
}

const systemIsDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

const resolveTheme = (theme: Theme): AppliedTheme =>
  theme === 'auto' ? (systemIsDark() ? 'dark' : 'white') : theme;

const applyTheme = (resolved: AppliedTheme) => {
  if (resolved === 'light') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', resolved);
};

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      resolvedTheme: 'dark',
      setTheme: (theme) => {
        const resolved = resolveTheme(theme);
        applyTheme(resolved);
        set({ theme, resolvedTheme: resolved === 'dark' ? 'dark' : 'light' });
      },
      initializeTheme: () => {
        get().setTheme(get().theme);
        const media = window.matchMedia?.('(prefers-color-scheme: dark)');
        if (!media) return () => {};
        const listener = () => {
          if (get().theme === 'auto') get().setTheme('auto');
        };
        media.addEventListener('change', listener);
        return () => media.removeEventListener('change', listener);
      },
    }),
    { name: 'proxy-usage.theme', partialize: (state) => ({ theme: state.theme }) },
  ),
);
