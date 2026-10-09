import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

/**
 * The CLIProxyAPI management key is the only credential this UI holds. It is sent as a Bearer token
 * to this app's own server, which checks it against CLIProxyAPI. With "Remember me" on, the key is
 * kept in localStorage (like the Management Center does); otherwise only in sessionStorage, so it is
 * gone when the tab closes.
 */
interface AuthState {
  managementKey: string | null;
  remember: boolean;
  setManagementKey: (key: string, remember: boolean) => void;
  logout: () => void;
}

const STORAGE_KEY = 'cpa-usage.auth';
const LEGACY_STORAGE_KEY = 'proxy-usage.auth';

function safeStorage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Reads from whichever store holds the entry; writes to the one `remember` selects and clears the other. */
const authStorage: StateStorage = {
  getItem: (name) => {
    safeStorage('local')?.removeItem(LEGACY_STORAGE_KEY);
    return safeStorage('local')?.getItem(name) ?? safeStorage('session')?.getItem(name) ?? null;
  },
  setItem: (name, value) => {
    let remember = true;
    try {
      remember = (JSON.parse(value) as { state?: { remember?: boolean } }).state?.remember !== false;
    } catch {
      // keep the default
    }
    const [target, other] = remember ? (['local', 'session'] as const) : (['session', 'local'] as const);
    safeStorage(other)?.removeItem(name);
    safeStorage(target)?.setItem(name, value);
  },
  removeItem: (name) => {
    safeStorage('local')?.removeItem(name);
    safeStorage('session')?.removeItem(name);
  },
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      managementKey: null,
      remember: true,
      setManagementKey: (managementKey, remember) => set({ managementKey, remember }),
      logout: () => set({ managementKey: null }),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => authStorage),
      partialize: (state) => ({ managementKey: state.managementKey, remember: state.remember }),
    },
  ),
);
