import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { InkButton, PillButton, SearchField, SegmentedControl } from '@/components/kit';
import { Modal } from '@/components/ui/Modal';
import { Sheet } from '@/components/ui/Sheet';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconPencil, IconRefreshCw, IconTrash2, IconX } from '@/components/ui/icons';
import { ApiError } from '@/lib/api/client';
import { formatCompact, formatInt, formatRelative } from '@/lib/format';
import {
  MODEL_PRICES_QUERY_KEY,
  findPrice,
  saveModelPrices,
  syncModelPrices,
  useModelPrices,
  type ModelPrice,
  type PriceBook,
  type SyncCandidate,
  type SyncResult,
} from '@/lib/pricing';
import { notify } from '@/stores/notifications';
import { USAGE_QUERY_ROOT, useAllTimeModels } from '../useUsageData';
import styles from './ModelPricesSheet.module.scss';

type View = 'all' | 'missing' | 'priced' | 'manual';

const fmtPrice = (value: number | undefined, configured?: boolean) => {
  if (value === undefined || (!configured && value === 0)) return '--';
  const fixed = value >= 1 ? value.toFixed(2) : value.toFixed(value >= 0.1 ? 3 : 4);
  return `$${fixed.replace(/(\.\d\d\d*?)0+$/, '$1')}`;
};

const cacheReadOf = (p: ModelPrice) =>
  p.cacheReadConfigured || (p.cacheRead ?? 0) > 0 ? p.cacheRead : p.cache > 0 ? p.cache : p.prompt * 0.1;
const cacheWriteOf = (p: ModelPrice) => (p.cacheCreationConfigured || (p.cacheCreation ?? 0) > 0 ? p.cacheCreation : p.prompt);

function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'model_price_structure_locked_by_usage_archive')
      return 'The price structure is locked because archived raw usage was deleted. Only price values can change.';
    return error.message;
  }
  return error instanceof Error ? error.message : 'Request failed';
}

interface Draft {
  model: string;
  prompt: string;
  completion: string;
  cacheRead: string;
  cacheWrite: string;
  isNew: boolean;
}

type Pending =
  | { kind: 'sync'; models: string[] }
  | { kind: 'save'; model: string; price: ModelPrice; summary: string }
  | { kind: 'delete'; model: string };

interface ModelPricesSheetProps {
  open: boolean;
  onClose: () => void;
  /** Models with traffic in the current range (to highlight cost gaps right now). */
  rangeModels: string[];
}

/**
 * The price book behind every cost on the page. Sync, manual overrides and candidate picks all
 * replace data server-side, so each goes through an explicit confirmation.
 */
export function ModelPricesSheet({ open, onClose, rangeModels }: ModelPricesSheetProps) {
  const queryClient = useQueryClient();
  const pricesQuery = useModelPrices();
  const seenQuery = useAllTimeModels(open);
  const book = useMemo(() => pricesQuery.data ?? {}, [pricesQuery.data]);
  const [view, setView] = useState<View>('all');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [candidatePick, setCandidatePick] = useState<Record<string, string>>({});

  const calls = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of seenQuery.data?.model_tier_stats ?? []) map.set(row.model, (map.get(row.model) ?? 0) + row.calls);
    return map;
  }, [seenQuery.data]);

  const seenModels = useMemo(
    () => Array.from(new Set([...(seenQuery.data?.filter_options?.models ?? []), ...calls.keys(), ...rangeModels])).sort(),
    [seenQuery.data, calls, rangeModels],
  );

  const rows = useMemo(() => {
    const names = Array.from(new Set([...Object.keys(book), ...seenModels]));
    return names
      .map((model) => {
        const own = book[model];
        const resolved = own ? { key: model, price: own } : findPrice(book, [model]);
        return {
          model,
          price: own ?? null,
          /** Priced through an alias key (provider prefix, case) rather than its own entry. */
          via: !own && resolved ? resolved.key : null,
          calls: calls.get(model) ?? 0,
          seen: seenModels.includes(model),
          inRange: rangeModels.includes(model),
          missing: !own && !resolved,
        };
      })
      .sort((a, b) => Number(b.missing && b.seen) - Number(a.missing && a.seen) || b.calls - a.calls || a.model.localeCompare(b.model));
  }, [book, seenModels, calls, rangeModels]);

  const missingSeen = rows.filter((r) => r.missing && r.seen);
  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    Object.values(book).forEach((p) => counts.set(p.source || 'unknown', (counts.get(p.source || 'unknown') ?? 0) + 1));
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [book]);
  const lastSynced = Math.max(0, ...Object.values(book).map((p) => p.syncedAtMs ?? 0));

  const visible = rows.filter((r) => {
    if (view === 'missing' && !r.missing) return false;
    if (view === 'priced' && !r.price) return false;
    if (view === 'manual' && r.price?.source !== 'manual') return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.model.toLowerCase().includes(q) || (r.price?.sourceModelId ?? '').toLowerCase().includes(q) || (r.price?.source ?? '').toLowerCase().includes(q);
  });

  const refreshAfterWrite = async (next?: PriceBook) => {
    if (next) queryClient.setQueryData(MODEL_PRICES_QUERY_KEY, next);
    await queryClient.invalidateQueries({ queryKey: MODEL_PRICES_QUERY_KEY });
    // Server-side costs are recomputed from the new book on the next query.
    await queryClient.invalidateQueries({ queryKey: [USAGE_QUERY_ROOT] });
  };

  const startEdit = (model: string, price: ModelPrice | null) =>
    setDraft({
      model,
      isNew: !price,
      prompt: price ? String(price.prompt) : '',
      completion: price ? String(price.completion) : '',
      cacheRead: price && (price.cacheReadConfigured || (price.cacheRead ?? 0) > 0) ? String(price.cacheRead ?? '') : '',
      cacheWrite: price && (price.cacheCreationConfigured || (price.cacheCreation ?? 0) > 0) ? String(price.cacheCreation ?? '') : '',
    });

  const draftError = (() => {
    if (!draft) return null;
    if (!draft.model.trim()) return 'Model id is required.';
    const nums = [draft.prompt, draft.completion].map(Number);
    if (draft.prompt.trim() === '' || draft.completion.trim() === '') return 'Input and output prices are required.';
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) return 'Prices must be non-negative numbers.';
    for (const v of [draft.cacheRead, draft.cacheWrite]) if (v.trim() && (!Number.isFinite(Number(v)) || Number(v) < 0)) return 'Cache prices must be non-negative numbers.';
    return null;
  })();

  const requestSaveDraft = () => {
    if (!draft || draftError) return;
    const existing = book[draft.model.trim()];
    const cacheRead = draft.cacheRead.trim() ? Number(draft.cacheRead) : undefined;
    const cacheWrite = draft.cacheWrite.trim() ? Number(draft.cacheWrite) : undefined;
    const prompt = Number(draft.prompt);
    const price: ModelPrice = {
      ...existing,
      prompt,
      completion: Number(draft.completion),
      cache: cacheRead ?? existing?.cache ?? prompt,
      cacheRead,
      cacheCreation: cacheWrite,
      promptConfigured: true,
      completionConfigured: true,
      cacheReadConfigured: cacheRead !== undefined,
      cacheCreationConfigured: cacheWrite !== undefined,
      source: 'manual',
      rawJson: undefined,
      updatedAtMs: Date.now(),
    };
    setPending({
      kind: 'save',
      model: draft.model.trim(),
      price,
      summary: `${fmtPrice(price.prompt, true)} in · ${fmtPrice(price.completion, true)} out per 1M, marked manual (sync will never overwrite it).`,
    });
  };

  const applyCandidate = (model: string, candidate: SyncCandidate) =>
    setPending({
      kind: 'save',
      model,
      price: { ...candidate.price, source: candidate.price.source || 'sync', sourceModelId: candidate.sourceModelId },
      summary: `Use ${candidate.sourceModelId} (${Math.round(candidate.score * 100)}% match): ${fmtPrice(candidate.price.prompt, true)} in · ${fmtPrice(candidate.price.completion, true)} out per 1M.`,
    });

  const runPending = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === 'sync') {
        const result = await syncModelPrices(pending.models, true);
        setSyncResult(result);
        await refreshAfterWrite(result.prices);
        notify(`Prices synced: ${result.imported} imported, ${result.unmatched?.length ?? 0} unmatched`, (result.preserved?.length ?? 0) > 0 || result.runtimeModelDiscoveryError ? 'warning' : 'success');
      } else if (pending.kind === 'save') {
        const next = await saveModelPrices({ ...book, [pending.model]: pending.price });
        await refreshAfterWrite(next);
        setDraft(null);
        if (syncResult) {
          setSyncResult({
            ...syncResult,
            candidates: syncResult.candidates?.filter((c) => c.model !== pending.model),
            unmatched: syncResult.unmatched?.filter((m) => m !== pending.model),
          });
        }
        notify(`Saved price for ${pending.model}`, 'success');
      } else {
        const next = { ...book };
        delete next[pending.model];
        const saved = await saveModelPrices(next);
        await refreshAfterWrite(saved);
        notify(`Removed price for ${pending.model}`, 'success');
      }
      setPending(null);
    } catch (error) {
      notify(saveErrorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const syncModels = Array.from(new Set([...Object.keys(book), ...seenModels])).sort();

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        size="xl"
        eyebrow="Pricing"
        title="Model prices"
        description="USD per 1M tokens. Every cost on this page is computed from this book; unpriced models count as $0."
        footer={
          <div className={styles.footer}>
            <span className={styles.footerNote}>
              {lastSynced > 0 ? `Last synced ${formatRelative(lastSynced)}` : 'Never synced'} · manual prices are never overwritten by sync
            </span>
            <InkButton
              icon={<IconRefreshCw size={14} />}
              spinning={busy && pending?.kind === 'sync'}
              disabled={busy || pricesQuery.isPending}
              onClick={() => setPending({ kind: 'sync', models: syncModels })}
            >
              Sync prices
            </InkButton>
          </div>
        }
      >
        <div className={styles.body}>
          <div className={styles.summary}>
            <span className={styles.summaryItem}>
              <b>{formatInt(Object.keys(book).length)}</b> priced
            </span>
            {sourceCounts.map(([source, count]) => (
              <span key={source} className={styles.summaryItem}>
                <SourceBadge source={source} /> {count}
              </span>
            ))}
            {missingSeen.length > 0 && (
              <button type="button" className="kit-badge kit-badge--amber" style={{ border: 0, cursor: 'pointer' }} onClick={() => setView('missing')}>
                {missingSeen.length} used but unpriced
              </button>
            )}
          </div>

          {syncResult && <SyncSummary result={syncResult} picks={candidatePick} setPick={(m, id) => setCandidatePick((p) => ({ ...p, [m]: id }))} onApply={applyCandidate} onDismiss={() => setSyncResult(null)} />}

          {draft && (
            <div className={styles.editor}>
              <div className={styles.editorHead}>
                <b>{draft.isNew ? 'Add manual price' : `Edit ${draft.model}`}</b>
                <button type="button" className={styles.iconButton} onClick={() => setDraft(null)} aria-label="Cancel editing">
                  <IconX size={14} />
                </button>
              </div>
              <div className={styles.fields}>
                {draft.isNew && (
                  <label className={styles.field} style={{ gridColumn: '1 / -1' }}>
                    <span>Model id</span>
                    <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="claude-opus-5-5" />
                  </label>
                )}
                {(
                  [
                    ['prompt', 'Input / 1M', 'required'],
                    ['completion', 'Output / 1M', 'required'],
                    ['cacheRead', 'Cache read / 1M', 'auto: 10% of input'],
                    ['cacheWrite', 'Cache write / 1M', 'auto: input price'],
                  ] as const
                ).map(([key, label, placeholder]) => (
                  <label key={key} className={styles.field}>
                    <span>{label}</span>
                    <input inputMode="decimal" value={draft[key]} placeholder={placeholder} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
                  </label>
                ))}
              </div>
              {(book[draft.model]?.contextTiers?.length || book[draft.model]?.serviceTiers?.length) ? (
                <p className={styles.hint}>Existing long-context and service-tier rules are kept as they are.</p>
              ) : null}
              <div className={styles.editorFoot}>
                {draftError ? <span className={styles.error}>{draftError}</span> : <span className={styles.hint}>Saved as a manual override.</span>}
                <InkButton disabled={!!draftError || busy} onClick={requestSaveDraft}>
                  Review & save
                </InkButton>
              </div>
            </div>
          )}

          <div className={styles.controls}>
            <SegmentedControl
              size="sm"
              value={view}
              onChange={setView}
              options={[
                { value: 'all', label: `All ${rows.length}` },
                { value: 'missing', label: `Missing ${rows.filter((r) => r.missing).length}` },
                { value: 'priced', label: 'Priced' },
                { value: 'manual', label: 'Manual' },
              ]}
              ariaLabel="Price filter"
            />
            <SearchField value={search} onChange={setSearch} placeholder="Search models or sources" className={styles.search} />
            <PillButton onClick={() => startEdit('', null)}>Add manually</PillButton>
          </div>

          {pricesQuery.error ? (
            <div className="kit-error-banner">Could not load prices: {pricesQuery.error.message}</div>
          ) : pricesQuery.isPending ? (
            <div className={styles.skeleton}>
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} height={22} />
              ))}
            </div>
          ) : (
            <div className="kit-table-wrap">
              <table className={`kit-table ${styles.table}`}>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th data-align="right">Calls</th>
                    <th data-align="right">Input</th>
                    <th data-align="right">Output</th>
                    <th data-align="right">Cache read</th>
                    <th data-align="right">Cache write</th>
                    <th>Rules</th>
                    <th>Source</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={9} className="kit-empty">
                        No models match
                      </td>
                    </tr>
                  )}
                  {visible.map((r) => (
                    <tr key={r.model} className={r.missing && r.seen ? styles.rowMissing : undefined}>
                      <td>
                        <div className={styles.modelCell}>
                          <span className={styles.modelName}>{r.model}</span>
                          {r.missing && r.seen && <span className="kit-badge kit-badge--amber">{r.inRange ? 'unpriced · in range' : 'unpriced'}</span>}
                          {r.via && <span className={styles.dim}>via {r.via}</span>}
                          {!r.seen && <span className={styles.dim}>no usage</span>}
                        </div>
                      </td>
                      <td data-align="right" data-mono="true">{r.calls ? formatCompact(r.calls) : '--'}</td>
                      <td data-align="right" data-mono="true">{r.price ? fmtPrice(r.price.prompt, r.price.promptConfigured ?? true) : '--'}</td>
                      <td data-align="right" data-mono="true">{r.price ? fmtPrice(r.price.completion, r.price.completionConfigured ?? true) : '--'}</td>
                      <td data-align="right" data-mono="true" title={r.price && !r.price.cacheReadConfigured ? 'Derived' : undefined}>
                        {r.price ? fmtPrice(cacheReadOf(r.price), true) : '--'}
                      </td>
                      <td data-align="right" data-mono="true" title={r.price && !r.price.cacheCreationConfigured ? 'Derived from input' : undefined}>
                        {r.price ? fmtPrice(cacheWriteOf(r.price), true) : '--'}
                      </td>
                      <td>
                        <span className={styles.rules}>
                          {r.price?.contextTiers?.map((t) => (
                            <span key={`c${t.thresholdTokens}`} className="kit-badge" title={`Above ${formatInt(t.thresholdTokens)} input tokens: ${fmtPrice(t.prompt, true)} in · ${fmtPrice(t.completion, true)} out`}>
                              &gt;{formatCompact(t.thresholdTokens)}
                            </span>
                          ))}
                          {r.price?.serviceTiers?.map((t) => (
                            <span key={`s${t.mode}${t.serviceTier}`} className="kit-badge" title={`${fmtPrice(t.prompt, true)} in · ${fmtPrice(t.completion, true)} out`}>
                              {t.mode}/{t.serviceTier}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td>
                        {r.price ? (
                          <span className={styles.sourceCell} title={r.price.syncedAtMs ? `Synced ${new Date(r.price.syncedAtMs).toLocaleString()}` : undefined}>
                            <SourceBadge source={r.price.source || 'unknown'} />
                            {r.price.sourceModelId && <span className={styles.dim}>{r.price.sourceModelId}</span>}
                          </span>
                        ) : (
                          '--'
                        )}
                      </td>
                      <td data-align="right">
                        <span className={styles.actions}>
                          <button type="button" className={styles.iconButton} onClick={() => startEdit(r.model, r.price)} aria-label={`Edit ${r.model}`} title={r.price ? 'Edit (manual override)' : 'Add manual price'}>
                            <IconPencil size={13} />
                          </button>
                          {r.price && (
                            <button type="button" className={styles.iconButton} onClick={() => setPending({ kind: 'delete', model: r.model })} aria-label={`Delete ${r.model}`} title="Delete price">
                              <IconTrash2 size={13} />
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Sheet>

      <Modal
        open={pending !== null}
        onClose={() => !busy && setPending(null)}
        title={pending?.kind === 'sync' ? 'Sync model prices?' : pending?.kind === 'delete' ? 'Delete price?' : 'Save price?'}
        closeDisabled={busy}
        footer={
          <div className={styles.modalFoot}>
            <PillButton className="kit-pill-button--lg" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </PillButton>
            <InkButton disabled={busy} spinning={busy} icon={busy ? <IconRefreshCw size={14} /> : undefined} onClick={runPending}>
              {pending?.kind === 'sync' ? 'Sync now' : pending?.kind === 'delete' ? 'Delete' : 'Save'}
            </InkButton>
          </div>
        }
      >
        {pending?.kind === 'sync' && (
          <p className={styles.modalText}>
            Fetches models.dev, then LiteLLM and OpenRouter as needed, for {pending.models.length} models plus every model CPA currently serves.
            Matched prices are written to the book; manual prices stay untouched. Can take up to 45 seconds.
          </p>
        )}
        {pending?.kind === 'save' && (
          <p className={styles.modalText}>
            <b>{pending.model}</b>: {pending.summary} This replaces the whole price book on the server, and costs are recomputed on the next refresh.
          </p>
        )}
        {pending?.kind === 'delete' && (
          <p className={styles.modalText}>
            <b>{pending.model}</b> will be removed from the price book and its usage will cost $0 until it is priced again.
          </p>
        )}
      </Modal>
    </>
  );
}

function SourceBadge({ source }: { source: string }) {
  const tone = source === 'manual' ? 'kit-badge kit-badge--amber' : 'kit-badge';
  return <span className={tone}>{source}</span>;
}

function SyncSummary({
  result,
  picks,
  setPick,
  onApply,
  onDismiss,
}: {
  result: SyncResult;
  picks: Record<string, string>;
  setPick: (model: string, id: string) => void;
  onApply: (model: string, candidate: SyncCandidate) => void;
  onDismiss: () => void;
}) {
  const candidates = result.candidates ?? [];
  const unmatched = (result.unmatched ?? []).filter((m) => !candidates.some((c) => c.model === m));
  return (
    <div className={styles.syncCard}>
      <div className={styles.editorHead}>
        <b>
          Sync result · {result.imported} imported · {result.skipped} skipped
          {result.preserved?.length ? ` · ${result.preserved.length} preserved` : ''}
        </b>
        <button type="button" className={styles.iconButton} onClick={onDismiss} aria-label="Dismiss sync result">
          <IconX size={14} />
        </button>
      </div>
      <div className={styles.sourceChips}>
        {(result.sourceResults ?? []).map((s) => (
          <span key={s.source} className={s.error ? 'kit-badge kit-badge--failure' : 'kit-badge'} title={s.error}>
            {s.source}: {s.error ? 'fetch failed' : `${s.models} models, ${s.skipped} skipped`}
          </span>
        ))}
        {result.proxyUsed && <span className="kit-badge">via CPA proxy</span>}
        {result.runtimeModelDiscoveryError && (
          <span className="kit-badge kit-badge--amber" title={result.runtimeModelDiscoveryError}>
            runtime model discovery failed
          </span>
        )}
      </div>
      {candidates.length > 0 && (
        <div className={styles.candidates}>
          <div className={styles.hint}>Needs confirmation: pick the closest source entry.</div>
          {candidates.map((c) => {
            const chosen = c.candidates.find((x) => x.sourceModelId === picks[c.model]) ?? c.candidates[0];
            return (
              <div key={c.model} className={styles.candidateRow}>
                <span className={styles.modelName}>{c.model}</span>
                <select value={chosen?.sourceModelId ?? ''} onChange={(e) => setPick(c.model, e.target.value)} className={styles.select}>
                  {c.candidates.map((x) => (
                    <option key={x.sourceModelId} value={x.sourceModelId}>
                      {x.sourceModelId} · {Math.round(x.score * 100)}% · {x.price.source ?? ''}
                    </option>
                  ))}
                </select>
                <PillButton disabled={!chosen} onClick={() => chosen && onApply(c.model, chosen)}>
                  Apply
                </PillButton>
              </div>
            );
          })}
        </div>
      )}
      {unmatched.length > 0 && <div className={styles.hint}>Unmatched: {unmatched.join(', ')}. Add them manually.</div>}
    </div>
  );
}
