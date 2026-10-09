import { IconSidebarQuota } from '@/components/ui/icons';
import styles from './QuotaHistoryPage.module.scss';

/** Row action for the Usage page's Credentials table: opens this credential on the Quota history page. */
export function QuotaHistoryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={styles.rowButton} onClick={onClick} title="Quota history" aria-label="Quota history">
      <IconSidebarQuota size={14} />
    </button>
  );
}
