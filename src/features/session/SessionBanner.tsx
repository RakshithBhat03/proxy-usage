import { formatStamp } from '@/lib/format';
import { sessionProblem, useHistoryStart, useSession } from './useSession';

/** App-wide notice, shown only while the server is not recording new requests. */
export function SessionBanner() {
  const session = useSession();
  const problem = sessionProblem(session.data);
  if (!problem) return null;
  return (
    <div className="kit-notice kit-notice--attention" role="status">
      {problem}
    </div>
  );
}

/**
 * Per-page notice for ranges that start before the first recorded request. Pass null for ranges
 * that already start at the data (such as "All time").
 */
export function HistoryStartNotice({ fromMs }: { fromMs: number | null }) {
  const start = useHistoryStart(fromMs);
  if (start === null) return null;
  return (
    <div className="kit-notice" role="note" data-reveal>
      History starts at {formatStamp(start)}; nothing before that was recorded by this server.
    </div>
  );
}
