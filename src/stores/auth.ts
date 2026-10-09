import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * The CPA Manager Plus admin key is the only credential this UI holds. It is kept in localStorage
 * (like the official panels do) and sent as a Bearer token through the same-origin proxy.
 */
interface AuthState {
  adminKey: string | null;
  setAdminKey: (key: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      adminKey: null,
      setAdminKey: (adminKey) => set({ adminKey }),
      logout: () => set({ adminKey: null }),
    }),
    { name: 'proxy-usage.auth' },
  ),
);
