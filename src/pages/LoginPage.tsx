import { useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { IconEye, IconEyeOff } from '@/components/ui/icons';
import { api, ApiError } from '@/lib/api/client';
import { useAuthStore } from '@/stores/auth';
import styles from './LoginPage.module.scss';

/**
 * Same split layout as the CPAMC login. The key is checked against an admin-only Manager endpoint
 * before it is stored, so a typo shows an error here instead of a broken dashboard.
 */
export function LoginPage() {
  const setAdminKey = useAuthStore((state) => state.setAdminKey);
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const candidate = key.trim();
    if (!candidate) {
      setError('Enter the CPA Manager Plus admin key.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api('/usage-service/config', { adminKey: candidate });
      setAdminKey(candidate);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError('That admin key was rejected by the Manager Server.');
      else setError(err instanceof Error ? `Could not reach the Manager Server: ${err.message}` : 'Login failed.');
    } finally {
      setLoading(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') void submit();
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
          <div className={styles.loginCard}>
            <div className={styles.loginHeader}>
              <div className={styles.titleRow}>
                <div className={styles.title}>Sign in</div>
              </div>
              <div className={styles.subtitle}>Usage, requests and quota for your CLIProxyAPI.</div>
            </div>

            <div className={styles.connectionBox}>
              <div className={styles.label}>Manager Server</div>
              <div className={styles.value}>{window.location.host}</div>
              <div className={styles.hint}>Proxied to the CPA Manager Plus server configured for this host.</div>
            </div>

            <Input
              autoFocus
              label="Admin key"
              placeholder="CPA Manager Plus admin key"
              type={showKey ? 'text' : 'password'}
              name="cpamp-admin-key"
              autoComplete="current-password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={onKeyDown}
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

            <Button fullWidth onClick={() => void submit()} loading={loading}>
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>

            {error && <div className={styles.errorBox}>{error}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
