import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { pickResetGrant } from '@/lib/quota/providers';
import { buildResetDisplay } from '@/lib/quota/parse';
import type { AccountQuota } from '@/lib/quota/types';
import styles from './QuotaPage.module.scss';

export interface ResetRequest {
  kind: 'codex' | 'claude';
  key: string;
  name: string;
  quota: AccountQuota | null;
}

interface ResetConfirmModalProps {
  request: ResetRequest | null;
  now: number;
  onClose: () => void;
  /** Performs the spend; resolves when done (errors are reported by the caller). */
  onConfirm: (request: ResetRequest) => Promise<void>;
}

/**
 * Confirmation for the two actions that spend something scarce: a Codex manual reset credit or a
 * banked Claude reset grant. Neither can be refunded, so the dialog states exactly what is spent.
 */
export function ResetConfirmModal({ request, now, onClose, onConfirm }: ResetConfirmModalProps) {
  const [busy, setBusy] = useState(false);
  const open = request !== null;
  const isCodex = request?.kind === 'codex';
  const resets = request?.quota?.codex?.manualResets;
  const grants = request?.quota?.claude?.resetGrants ?? null;
  const grant = grants ? pickResetGrant(grants) : null;
  const nextCredit = resets?.credits[0];
  const nextCreditDisplay = nextCredit ? buildResetDisplay(nextCredit.expiresAtMs, now) : null;

  const confirm = async () => {
    if (!request || busy) return;
    setBusy(true);
    try {
      await onConfirm(request);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={busy}
      width={460}
      title={isCodex ? 'Reset Codex quota' : 'Reset Claude limits'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void confirm()} loading={busy}>
            {isCodex ? 'Consume 1 reset' : 'Spend 1 reset'}
          </Button>
        </>
      }
    >
      {request && (
        <div className={styles.confirmBody}>
          {isCodex ? (
            <p>
              This will consume 1 manual reset to reset the Codex quota for <span className={styles.confirmName}>"{request.name}"</span>. Continue?
            </p>
          ) : (
            <p>
              This will spend 1 banked reset grant to clear the current Claude limits for <span className={styles.confirmName}>"{request.name}"</span>. Continue?
            </p>
          )}
          <ul className={styles.confirmList}>
            {isCodex ? (
              <>
                <li>
                  Manual resets available: <b>{resets?.available ?? '--'}</b>. A consumed reset cannot be refunded.
                </li>
                {nextCreditDisplay && (
                  <li>
                    Earliest-expiring reset: <b>{nextCreditDisplay.absolute}</b> ({nextCreditDisplay.relative}).
                  </li>
                )}
                <li>The 5-hour and weekly windows restart immediately; the quota is re-read afterwards.</li>
              </>
            ) : (
              <>
                <li>
                  Resets remaining: <b>{grants?.count ?? '--'}</b>
                  {grant ? (
                    <>
                      {' '}
                      (using <b>{grant.label || 'the next grant'}</b>)
                    </>
                  ) : null}
                  . A spent reset cannot be refunded.
                </li>
                <li>Anthropic only honours a reset while a limit is reached; otherwise nothing is spent.</li>
              </>
            )}
          </ul>
        </div>
      )}
    </Modal>
  );
}
