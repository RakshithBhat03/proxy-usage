/**
 * The ported CPAMC components call `useTranslation()`. This UI is English-only, so a tiny shim
 * keeps those components verbatim instead of pulling in i18next.
 */
const STRINGS: Record<string, string> = {
  'common.close': 'Close',
  'notification.region_label': 'Notifications',
};

type Options = { defaultValue?: string } & Record<string, unknown>;

export function t(key: string, options?: Options): string {
  return STRINGS[key] ?? options?.defaultValue ?? key;
}

export function useTranslation() {
  return { t };
}
