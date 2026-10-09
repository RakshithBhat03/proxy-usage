import { useQuery } from '@tanstack/react-query';
import { api } from './client';

/**
 * CPA auth files (credentials), read from CLIProxyAPI through this app's server. Used to turn
 * auth indexes into names/emails/providers. Only the commonly needed fields are typed here; the
 * rest (quota signals etc.) is read defensively.
 */
export interface AuthFile {
  id?: string;
  name: string;
  type?: string;
  provider?: string;
  email?: string;
  label?: string;
  auth_index?: string;
  authIndex?: string;
  disabled?: boolean;
  status?: string;
  [key: string]: unknown;
}

export const AUTH_FILES_QUERY_KEY = ['auth-files'] as const;

export async function fetchAuthFiles(signal?: AbortSignal): Promise<AuthFile[]> {
  const data = await api<{ files?: AuthFile[] } | AuthFile[]>('/v0/management/auth-files', { signal });
  return Array.isArray(data) ? data : (data.files ?? []);
}

export function useAuthFiles() {
  return useQuery({ queryKey: AUTH_FILES_QUERY_KEY, queryFn: ({ signal }) => fetchAuthFiles(signal), staleTime: 60_000 });
}

export const authIndexOf = (file: AuthFile) => String(file.auth_index ?? file.authIndex ?? '');
