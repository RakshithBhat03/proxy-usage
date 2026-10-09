import { Skeleton } from '@/components/ui/Skeleton';
import styles from '../UsagePage.module.scss';

/** Mirrors the loaded layout (tiles, timeline, tables) so the first paint does not jump. */
export function UsageSkeleton() {
  return (
    <div className={styles.body} aria-busy="true" aria-label="Loading usage">
      <div className={`kit-stat-grid ${styles.skeletonTiles}`}>
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="kit-stat">
            <Skeleton width="45%" height={11} />
            <Skeleton width="70%" height={24} />
            <Skeleton width="60%" height={10} />
          </div>
        ))}
      </div>
      <div className="kit-panel">
        <div className="kit-panel__body">
          <div className={styles.skeletonHead}>
            <Skeleton width={120} height={14} />
            <Skeleton width={320} height={26} rounded={999} />
          </div>
          <div className={styles.skeletonBars}>
            {Array.from({ length: 24 }, (_, i) => (
              <Skeleton key={i} height={`${28 + ((i * 37) % 60)}%`} rounded="4px 4px 0 0" />
            ))}
          </div>
        </div>
      </div>
      <div className="kit-panel">
        <div className="kit-panel__body">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={18} style={{ marginBottom: 12 }} />
          ))}
        </div>
      </div>
      <div className={styles.twoCol}>
        {[0, 1].map((i) => (
          <div key={i} className="kit-panel">
            <div className="kit-panel__body">
              <Skeleton width="40%" height={14} style={{ marginBottom: 16 }} />
              <Skeleton height={140} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
