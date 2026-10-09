
export type { CollectorMode, CollectorState, CollectorStatus, CollectorTransport } from '../../shared/session-types.ts';
import type { CollectorStatus } from '../../shared/session-types.ts';

export interface CollectorHandle {
  status(): CollectorStatus;
  /** Stops the transport and flushes buffered events to the DB. */
  stop(): Promise<void>;
}
