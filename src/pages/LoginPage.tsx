import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { IconEye, IconEyeOff } from '@/components/ui/icons';
import { fetchSession, SESSION_QUERY_KEY, useServerStatus } from '@/features/session/useSession';
import { ApiError } from '@/lib/api/client';
import { useAuthStore } from '@/stores/auth';
import styles from './LoginPage.module.scss';

interface LoginError {
  message: string;
  hint?: string;
}

/**
 * Same split layout as the Management Center login. The key is checked by this app's server
 * (`GET /api/session`), which asks CLIProxyAPI, before it is stored, so a typo shows an error here
 * instead of a broken dashboard.
 */
export function LoginPage() {
  const queryClient = useQueryClient();
  const setManagementKey = useAuthStore((state) => state.setManagementKey);
  const storedRemember = useAuthStore((state) => state.remember);
  const status = useServerStatus();
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(storedRemember);
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LoginError | null>(null);
  const [pausedUntil, setPausedUntil] = useState<number | null>(null);

  // Lift the rate-limit pause once it has passed.
  useEffect(() => {
    if (pausedUntil === null) return;
    const timer = window.setTimeout(() => setPausedUntil(null), Math.max(0, pausedUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pausedUntil]);

  const cpaHost = status.data?.cpa.host;

  const describeError = (err: unknown): LoginError => {
    if (!(err instanceof ApiError)) {
      return { message: err instanceof Error ? `Could not reach this app's server: ${err.message}` : 'Sign-in failed.' };
    }
    switch (err.code) {
      case 'invalid_management_key':
        return { message: 'CLIProxyAPI rejected this management key.' };
      case 'login_rate_limited': {
        const minutes = Math.max(1, Math.ceil((err.retryAfterS ?? 60) / 60));
        return {
          message: `Too many failed attempts. CLIProxyAPI blocks an address for 30 minutes after 5 failures, so sign-in is paused for ${minutes} min.`,
        };
      }
      case 'cpa_forbidden':
        return {
          message: err.message,
          hint: 'Enable remote management in CLIProxyAPI (remote-management.allow-remote: true) or set MANAGEMENT_PASSWORD.',
        };
      case 'cpa_unreachable':
        return { message: `Can't reach CLIProxyAPI at ${cpaHost ?? 'its configured address'}.` };
      default:
        if (err.status === 401) return { message: 'CLIProxyAPI rejected this management key.' };
        return { message: `Sign-in failed: ${err.message}` };
    }
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (loading || pausedUntil !== null) return;
    const candidate = key.trim();
    if (!candidate) {
      setError({ message: 'Enter the CLIProxyAPI management key.' });
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const session = await fetchSession(undefined, candidate);
      queryClient.setQueryData(SESSION_QUERY_KEY, session);
      setManagementKey(candidate, remember);
    } catch (err) {
      setError(describeError(err));
      if (err instanceof ApiError && err.code === 'login_rate_limited') {
        setPausedUntil(Date.now() + (err.retryAfterS ?? 60) * 1000);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.brandPanel}>
        <div className={styles.brandContent}>
          <span className={styles.brandWord}>CLI</span>
          <span className={styles.brandWord}>PROXY</span>
          <span className={styles.brandWord}>USAGE</span>
        </div>
      </div>

      <div className={styles.formPanel}>
        <div className={styles.formContent}>
          <img src="/logo.jpg" alt="Logo" className={styles.logo} />
          <form className={styles.loginCard} onSubmit={(event) => void submit(event)} noValidate>
            <div className={styles.loginHeader}>
              <div className={styles.titleRow}>
                <h1 className={styles.title}>CPA Usage</h1>
              </div>
              <div className={styles.subtitle}>Usage, requests and quota for your CLIProxyAPI.</div>
            </div>

            <div className={styles.connectionBox}>
              <div className={styles.label}>CLIProxyAPI</div>
              {status.isPending ? (
                <div className={styles.valueMuted}>Checking connection…</div>
              ) : status.data ? (
                <>
                  <div className={styles.value}>{status.data.cpa.host}</div>
                  <div className={styles.statusRow}>
                    <span
                      className={`${styles.statusDot} ${status.data.cpa.reachable ? styles.statusDotOk : styles.statusDotDown}`}
                      aria-hidden="true"
                    />
                    <span>{status.data.cpa.reachable ? 'Reachable' : 'Not reachable'}</span>
                    {status.data.cpa.version && <span className={styles.version}>v{status.data.cpa.version.replace(/^v/i, '')}</span>}
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.valueMuted}>Connection status unavailable</div>
                  <div className={styles.hint}>You can still sign in; the key is checked when you do.</div>
                </>
              )}
            </div>

            {/* Lets password managers file the key under a stable account name. */}
            <input type="text" name="username" autoComplete="username" value="CLIProxyAPI" readOnly hidden />

            <Input
              autoFocus
              label="Management key"
              placeholder="CLIProxyAPI management key"
              type={showKey ? 'text' : 'password'}
              name="cpa-management-key"
              autoComplete="current-password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              hint="The same key you use for the CLIProxyAPI Management Center."
              rightElement={
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowKey((prev) => !prev)}
                  aria-label={showKey ? 'Hide key' : 'Show key'}
                  title={showKey ? 'Hide key' : 'Show key'}
                >
                  {showKey ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                </button>
              }
            />

            <div className={styles.toggleAdvanced}>
              <SelectionCheckbox
                checked={remember}
                onChange={setRemember}
                label="Remember me"
                labelClassName={styles.toggleLabel}
                title="Keep the key in this browser after the tab closes"
              />
            </div>

            <Button type="submit" fullWidth loading={loading} disabled={pausedUntil !== null}>
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>

            {error && (
              <div className={styles.errorBox} role="alert">
                {error.message}
                {error.hint && <div className={styles.errorHint}>{error.hint}</div>}
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
