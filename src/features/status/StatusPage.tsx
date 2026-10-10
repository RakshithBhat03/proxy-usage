import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader, PillButton, ProviderIcon, RefreshIcon, type MetaPart } from '@/components/kit';
import { IconBookOpen, IconDollarSign, IconExternalLink, IconGithub, IconKey, IconSlidersHorizontal } from '@/components/ui/icons';
import { IconActivity, IconLayers, IconServer, IconZap } from '@/components/ui/extraIcons';
import { Skeleton } from '@/components/ui/Skeleton';
import { useRevealGroup } from '@/hooks/motion';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { AUTH_FILES_QUERY_KEY, useAuthFiles } from '@/lib/api/authFiles';
import { formatBytes, formatClock, formatInt, formatRelative, formatStamp } from '@/lib/format';
import { providerLabel } from '@/lib/providers';
import { useNotificationStore } from '@/stores/notifications';
import { versionTag } from '@shared/version.ts';
import type { SystemResponse } from '@shared/system-types.ts';
import {
  collectorHealth,
  cpaHealth,
  credentialHealth,
  databaseHealth,
  pricingHealth,
  summarizeCredentials,
  updateHealth,
  type CredentialSummary,
  type Health,
  type ServiceHealth,
} from './health';
import { fetchSystem, SYSTEM_QUERY_KEY, useSystemStatus } from './useSystemStatus';
import styles from './StatusPage.module.scss';

const CPA_REPO = 'https://github.com/router-for-me/CLIProxyAPI';
const LINKS = [
  { href: CPA_REPO, label: 'CLIProxyAPI', meta: 'router-for-me/CLIProxyAPI', icon: <IconGithub size={15} /> },
  { href: `${CPA_REPO}/releases`, label: 'CLIProxyAPI releases', meta: 'Changelog and downloads', icon: <IconLayers size={15} /> },
  {
    href: 'https://github.com/router-for-me/Cli-Proxy-API-Management-Center',
    label: 'Management Center',
    meta: 'Official web UI',
    icon: <IconSlidersHorizontal size={15} />,
  },
  { href: 'https://help.router-for.me', label: 'Documentation', meta: 'help.router-for.me', icon: <IconBookOpen size={15} /> },
  { href: 'https://github.com/RakshithBhat03/proxy-usage', label: 'CPA Usage', meta: 'This dashboard', icon: <IconGithub size={15} /> },
];

/* ---------- Small pieces ---------- */

function HealthPill({ status }: { status: ServiceHealth }) {
  return (
    <span className={styles.pill} data-health={status.health}>
      <span className={styles.dot} aria-hidden="true" />
      {status.label}
    </span>
  );
}

function Row({ label, children, mono = true, tone }: { label: ReactNode; children: ReactNode; mono?: boolean; tone?: Health }) {
  return (
    <div className={styles.row}>
      <dt>{label}</dt>
      <dd className={mono ? 'kit-mono' : undefined} data-tone={tone}>
        {children}
      </dd>
    </div>
  );
}

function ServiceCard({
  title,
  icon,
  status,
  children,
  note,
}: {
  title: string;
  icon: ReactNode;
  status?: ServiceHealth;
  children: ReactNode;
  /** Error or advice line under the rows. */
  note?: { tone: Health; text: ReactNode } | null;
}) {
  return (
    <section className={styles.card} data-reveal>
      <header className={styles.cardHead}>
        <span className={styles.cardIcon}>{icon}</span>
        <h2 className={styles.cardTitle}>{title}</h2>
        {status && <HealthPill status={status} />}
      </header>
      <dl className={styles.rows}>{children}</dl>
      {note && (
        <p className={styles.note} data-tone={note.tone}>
          {note.text}
        </p>
      )}
    </section>
  );
}

const onOff = (value: boolean | null | undefined) => (value === null || value === undefined ? '--' : value ? 'On' : 'Off');

/** "4d 3h", "5h 12m", "42m", "18s". */
function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** CPA build dates are UTC timestamps; `unknown` on local builds. */
function buildStamp(raw: string | null): string {
  if (!raw) return '--';
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? raw : formatStamp(ms);
}

const TRANSPORT_LABEL: Record<string, string> = { resp: 'RESP subscribe', http: 'HTTP polling', none: '--' };
const STRATEGY_LABEL: Record<string, string> = {
  'round-robin': 'Round robin',
  'weighted-round-robin': 'Weighted round robin',
  'fill-first': 'Fill first',
};

/* ---------- Version hero ---------- */

function VersionHero({ system, now, checking, onCheck }: { system: SystemResponse; now: number; checking: boolean; onCheck: () => void }) {
  const { cpa } = system;
  const update = updateHealth(system);
  const current = cpa.version ? versionTag(cpa.version) : null;
  const latest = cpa.latest_version ? versionTag(cpa.latest_version) : null;
  const checked = cpa.latest_checked_at_ms ? `checked ${formatRelative(cpa.latest_checked_at_ms, now)}` : 'not checked yet';

  let headline: ReactNode;
  let detail: ReactNode;
  if (cpa.update_available) {
    headline = <>{latest} is available</>;
    detail = <>You are running {current}. Update CLIProxyAPI to get the latest fixes.</>;
  } else if (cpa.update_available === false) {
    headline = <>You are up to date</>;
    detail = <>{latest} is the latest release.</>;
  } else if (cpa.latest_error) {
    headline = <>Could not check for updates</>;
    detail = <>{cpa.latest_error}</>;
  } else if (latest) {
    headline = <>Latest release is {latest}</>;
    detail = <>The running version ({cpa.version ?? 'unknown'}) cannot be compared, e.g. a dev build.</>;
  } else {
    headline = <>Update status unknown</>;
    detail = <>CLIProxyAPI has not reported a version yet.</>;
  }

  return (
    <section className={styles.hero} data-update={update.health} data-reveal>
      <div className={styles.heroMain}>
        <span className={styles.heroEyebrow}>CLIProxyAPI</span>
        <span className={styles.heroVersion}>{current ?? '--'}</span>
        <span className={styles.heroBuild}>
          {cpa.commit && cpa.commit !== 'none' ? <span>commit {cpa.commit}</span> : null}
          <span>built {buildStamp(cpa.build_date)}</span>
          <span>{cpa.host}</span>
        </span>
      </div>
      <div className={styles.heroUpdate}>
        <HealthPill status={update} />
        <p className={styles.heroHeadline}>{headline}</p>
        <p className={styles.heroDetail}>{detail}</p>
        <div className={styles.heroActions}>
          {cpa.update_available ? (
            <a className="kit-ink-button" href={cpa.release_url} target="_blank" rel="noreferrer noopener">
              Release notes <IconExternalLink size={13} />
            </a>
          ) : (
            <a className="kit-pill-button" href={cpa.release_url} target="_blank" rel="noreferrer noopener">
              Releases <IconExternalLink size={13} />
            </a>
          )}
          <PillButton icon={<RefreshIcon size={13} />} spinning={checking} disabled={checking} onClick={onCheck}>
            Check now
          </PillButton>
          <span className={styles.heroChecked}>{checked}</span>
        </div>
      </div>
    </section>
  );
}

/* ---------- Status board ---------- */

function Board({ items }: { items: Array<{ name: string; status: ServiceHealth }> }) {
  return (
    <div className={styles.board} data-reveal>
      {items.map((item) => (
        <div key={item.name} className={styles.boardItem} data-health={item.status.health}>
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.boardName}>{item.name}</span>
          <span className={styles.boardLabel}>{item.status.label}</span>
        </div>
      ))}
    </div>
  );
}

function PageSkeleton() {
  return (
    <>
      <Skeleton height={150} rounded={14} />
      <Skeleton height={48} rounded={12} />
      <div className={styles.grid}>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} height={260} rounded={14} />
        ))}
      </div>
    </>
  );
}

/* ---------- Page ---------- */

export default function StatusPage() {
  const queryClient = useQueryClient();
  const revealRef = useRevealGroup<HTMLDivElement>();
  const tick = useNow(5_000);
  const system = useSystemStatus();
  // The clock ticks every 5 s, so a fresh response can be newer than it ("checked in 1 second").
  const now = Math.max(tick, system.data?.checked_at_ms ?? 0);
  const authFiles = useAuthFiles();
  const notify = useNotificationStore((state) => state.showNotification);
  const [checking, setChecking] = useState(false);

  const headerRefresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: SYSTEM_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: AUTH_FILES_QUERY_KEY }),
    ]);
  }, [queryClient]);
  useHeaderRefresh(headerRefresh);

  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    try {
      const fresh = await fetchSystem(undefined, true);
      queryClient.setQueryData(SYSTEM_QUERY_KEY, fresh);
      const { cpa } = fresh;
      if (cpa.update_available) notify(`CLIProxyAPI ${versionTag(cpa.latest_version ?? '')} is available`, 'warning');
      else if (cpa.update_available === false) notify('CLIProxyAPI is up to date', 'success');
      else notify(cpa.latest_error ? `Update check failed: ${cpa.latest_error}` : 'Cannot compare versions', 'error');
    } catch (err) {
      notify(`Update check failed: ${(err as Error).message}`, 'error');
    } finally {
      setChecking(false);
    }
  }, [queryClient, notify]);

  const credentials = useMemo<CredentialSummary | null>(
    () => (authFiles.data ? summarizeCredentials(authFiles.data) : null),
    [authFiles.data],
  );

  const data = system.data;
  const statuses = data
    ? {
        cpa: cpaHealth(data),
        collector: collectorHealth(data),
        db: databaseHealth(data),
        pricing: pricingHealth(data),
        credentials: credentialHealth(credentials),
      }
    : null;
  const issues = statuses ? Object.values(statuses).filter((s) => s.health === 'warn' || s.health === 'down').length : 0;

  const meta: MetaPart[] = data
    ? [
        issues === 0
          ? { text: 'All systems normal', tone: 'live' }
          : { text: `${issues} need${issues === 1 ? 's' : ''} attention`, tone: 'attention' },
        { text: `CLIProxyAPI ${data.cpa.version ? versionTag(data.cpa.version) : 'unknown'}` },
        ...(data.cpa.update_available ? [{ text: 'update available', tone: 'attention' as const }] : []),
        { text: `checked ${formatClock(data.checked_at_ms)}`, tone: 'muted' },
      ]
    : [{ text: system.isError ? 'status unavailable' : 'checking…', tone: 'muted' }];

  return (
    <div className={`kit-page ${styles.page}`} ref={revealRef}>
      <PageHeader title="Status" meta={meta} />

      {system.error && <div className="kit-error-banner">Could not load the server status: {system.error.message}</div>}

      {!data && !system.error && <PageSkeleton />}

      {data && statuses && (
        <>
          <VersionHero system={data} now={now} checking={checking} onCheck={checkForUpdates} />

          <Board
            items={[
              { name: 'CLIProxyAPI', status: statuses.cpa },
              { name: 'Collector', status: statuses.collector },
              { name: 'Credentials', status: statuses.credentials },
              { name: 'Database', status: statuses.db },
              { name: 'Price book', status: statuses.pricing },
            ]}
          />

          <div className={styles.grid}>
            <CpaCard data={data} status={statuses.cpa} />
            <CollectorCard data={data} status={statuses.collector} now={now} />
            <CredentialsCard summary={credentials} status={statuses.credentials} error={authFiles.error} />
            <DatabaseCard data={data} status={statuses.db} now={now} />
            <SettingsCard data={data} />
            <PricingCard data={data} status={statuses.pricing} now={now} />
            <ServerCard data={data} now={now} />
            <LinksCard />
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- Cards ---------- */

function CpaCard({ data, status }: { data: SystemResponse; status: ServiceHealth }) {
  const { cpa, collector } = data;
  const stats = cpa.runtime?.flags.usage_statistics ?? collector.usage_statistics_enabled;
  return (
    <ServiceCard
      title="CLIProxyAPI"
      icon={<IconZap size={15} />}
      status={status}
      note={!cpa.reachable ? { tone: 'down', text: `Cannot reach ${cpa.host}. Check that CLIProxyAPI is running and CPA_URL is right.` } : null}
    >
      <Row label="Address">{cpa.host}</Row>
      <Row label="Response time">{cpa.latency_ms === null ? '--' : `${cpa.latency_ms} ms`}</Row>
      <Row label="Version">{cpa.version ? versionTag(cpa.version) : '--'}</Row>
      <Row label="Latest release" tone={cpa.update_available ? 'warn' : undefined}>
        {cpa.latest_version ? versionTag(cpa.latest_version) : '--'}
      </Row>
      <Row label="Commit">{cpa.commit && cpa.commit !== 'none' ? cpa.commit : '--'}</Row>
      <Row label="Built">{buildStamp(cpa.build_date)}</Row>
      <Row label="Usage statistics" tone={stats === false ? 'down' : stats ? 'ok' : undefined}>
        {onOff(stats)}
        {collector.usage_statistics_auto_enabled ? ' (turned on by CPA Usage)' : ''}
      </Row>
    </ServiceCard>
  );
}

function CollectorCard({ data, status, now }: { data: SystemResponse; status: ServiceHealth; now: number }) {
  const { collector } = data;
  const { counts } = collector;
  let note: { tone: Health; text: ReactNode } | null = null;
  if (collector.state === 'disabled') note = { tone: 'off', text: collector.disabled_reason ?? 'The collector is disabled.' };
  else if (collector.last_error) {
    const retry = collector.next_retry_at_ms ? ` Next attempt ${formatRelative(collector.next_retry_at_ms, now)}.` : '';
    note = {
      tone: collector.state === 'running' ? 'warn' : 'down',
      text: `Last error ${formatRelative(collector.last_error_at_ms, now)}: ${collector.last_error}.${retry}`,
    };
  }
  return (
    <ServiceCard title="Collector" icon={<IconActivity size={15} />} status={status} note={note}>
      <Row label="Mode">{collector.mode}</Row>
      <Row label="Transport">{TRANSPORT_LABEL[collector.transport] ?? collector.transport}</Row>
      <Row label="Connected">
        {collector.connected_since_ms ? `${formatRelative(collector.connected_since_ms, now)} · ${formatStamp(collector.connected_since_ms)}` : '--'}
      </Row>
      <Row label="Last request">{collector.last_event_at_ms ? formatRelative(collector.last_event_at_ms, now) : 'none since start'}</Row>
      <Row label="Received / stored">
        {formatInt(counts.received)} / {formatInt(counts.inserted)}
      </Row>
      <Row label="Duplicates skipped">{formatInt(counts.duplicates)}</Row>
      <Row label="Unreadable records" tone={counts.dead_letters > 0 ? 'warn' : undefined}>
        {formatInt(counts.dead_letters)}
      </Row>
      <Row label="Reconnects">{formatInt(counts.reconnects)}</Row>
    </ServiceCard>
  );
}

function CredentialsCard({ summary, status, error }: { summary: CredentialSummary | null; status: ServiceHealth; error: Error | null }) {
  return (
    <ServiceCard
      title="Credentials"
      icon={<IconKey size={15} />}
      status={status}
      note={error ? { tone: 'down', text: `Could not read credentials: ${error.message}` } : null}
    >
      <Row label="Total">{summary ? formatInt(summary.total) : '--'}</Row>
      <Row label="Active" tone={summary && summary.active > 0 ? 'ok' : undefined}>
        {summary ? formatInt(summary.active) : '--'}
      </Row>
      <Row label="Disabled">{summary ? formatInt(summary.disabled) : '--'}</Row>
      <Row label="Unavailable" tone={summary && summary.unavailable > 0 ? 'warn' : undefined}>
        {summary ? formatInt(summary.unavailable) : '--'}
      </Row>
      <Row label="Cooling down" tone={summary && summary.cooling > 0 ? 'warn' : undefined}>
        {summary ? formatInt(summary.cooling) : '--'}
      </Row>
      {summary && summary.providers.length > 0 && (
        <div className={styles.providers}>
          {summary.providers.map((p) => (
            <span key={p.provider} className={styles.provider} title={`${providerLabel(p.provider)}: ${p.active} of ${p.total} active`}>
              <ProviderIcon provider={p.provider} size={14} />
              {providerLabel(p.provider)}
              <span className="kit-mono">
                {p.active}/{p.total}
              </span>
            </span>
          ))}
        </div>
      )}
    </ServiceCard>
  );
}

function DatabaseCard({ data, status, now }: { data: SystemResponse; status: ServiceHealth; now: number }) {
  const { db, retention } = data;
  const days = retention?.retention_days ?? 0;
  return (
    <ServiceCard
      title="Database"
      icon={<IconLayers size={15} />}
      status={status}
      note={retention?.last_error ? { tone: 'warn', text: `Last maintenance failed: ${retention.last_error}` } : null}
    >
      <Row label="Requests stored">{formatInt(db.events)}</Row>
      <Row label="Last hour / 24 hours">
        {formatInt(db.events_last_hour)} / {formatInt(db.events_last_day)}
      </Row>
      <Row label="History">{db.oldest_event_ms ? `since ${formatStamp(db.oldest_event_ms)}` : 'empty'}</Row>
      <Row label="Size">
        {formatBytes(db.size_bytes)}
        {db.wal_bytes > 0 ? ` + ${formatBytes(db.wal_bytes)} WAL` : ''}
      </Row>
      <Row label="Retention">{days > 0 ? `${days} days` : 'Keep everything'}</Row>
      <Row label="Maintenance">
        {retention?.last_run_at_ms ? `ran ${formatRelative(retention.last_run_at_ms, now)}` : 'not run yet'}
        {retention?.next_run_at_ms ? ` · next ${formatRelative(retention.next_run_at_ms, now)}` : ''}
      </Row>
      <Row label="Unreadable records" tone={db.dead_letters > 0 ? 'warn' : undefined}>
        {formatInt(db.dead_letters)}
      </Row>
      <Row label="Schema">v{db.schema_version}</Row>
    </ServiceCard>
  );
}

function SettingsCard({ data }: { data: SystemResponse }) {
  const { runtime, runtime_error: error, error_log_files: errorLogs } = data.cpa;
  const flags = runtime?.flags;
  const flagItems: Array<[string, boolean | null | undefined]> = [
    ['Usage statistics', flags?.usage_statistics],
    ['Request log', flags?.request_log],
    ['File logging', flags?.logging_to_file],
    ['Debug', flags?.debug],
    ['WebSocket auth', flags?.ws_auth],
    ['TLS', flags?.tls],
    ['Plugins', flags?.plugins],
    ['Cooldowns', flags?.cooling_disabled === null || flags?.cooling_disabled === undefined ? null : !flags.cooling_disabled],
  ];
  return (
    <ServiceCard
      title="CLIProxyAPI settings"
      icon={<IconSlidersHorizontal size={15} />}
      note={error ? { tone: 'off', text: `Settings unavailable: ${error}` } : null}
    >
      <Row label="Routing">{runtime?.routing_strategy ? (STRATEGY_LABEL[runtime.routing_strategy] ?? runtime.routing_strategy) : runtime ? 'Round robin (default)' : '--'}</Row>
      <Row label="Request retry">
        {runtime?.request_retry ?? '--'}
        {runtime?.max_retry_interval_s ? ` · max wait ${runtime.max_retry_interval_s}s` : ''}
      </Row>
      <Row label="Upstream proxy">{runtime ? (runtime.proxy_configured ? 'Configured' : 'None') : '--'}</Row>
      <Row label="Client API keys">{runtime?.api_keys ?? '--'}</Row>
      <Row label="Usage queue retention">{runtime?.usage_queue_retention_s ? `${runtime.usage_queue_retention_s}s` : '--'}</Row>
      <Row label="Error log files" tone={errorLogs ? 'warn' : undefined}>
        {errorLogs ?? '--'}
      </Row>
      {runtime && (
        <div className={styles.flags}>
          {flagItems.map(([label, value]) => (
            <span key={label} className={styles.flag} data-on={value === null || value === undefined ? undefined : String(value)}>
              <span className={styles.dot} aria-hidden="true" />
              {label}
              <span className={styles.flagValue}>{onOff(value)}</span>
            </span>
          ))}
        </div>
      )}
    </ServiceCard>
  );
}

function PricingCard({ data, status, now }: { data: SystemResponse; status: ServiceHealth; now: number }) {
  const { pricing } = data;
  return (
    <ServiceCard
      title="Price book"
      icon={<IconDollarSign size={15} />}
      status={status}
      note={pricing?.last_sync_error ? { tone: 'warn', text: `Last sync failed: ${pricing.last_sync_error}` } : null}
    >
      <Row label="Models priced">{pricing ? formatInt(pricing.models) : '--'}</Row>
      <Row label="Synced / manual">{pricing ? `${formatInt(pricing.synced_models)} / ${formatInt(pricing.manual_models)}` : '--'}</Row>
      <Row label="Last sync">{pricing?.last_sync_at_ms ? formatRelative(pricing.last_sync_at_ms, now) : 'never'}</Row>
      <Row label="Auto sync">{pricing ? (pricing.sync_interval_hours > 0 ? `every ${pricing.sync_interval_hours}h` : 'Off') : '--'}</Row>
      <Row label="Requests without a price" tone={pricing?.unpriced_events ? 'warn' : undefined}>
        {pricing?.unpriced_events === null || pricing?.unpriced_events === undefined ? '--' : formatInt(pricing.unpriced_events)}
      </Row>
    </ServiceCard>
  );
}

function ServerCard({ data, now }: { data: SystemResponse; now: number }) {
  const { app } = data;
  return (
    <ServiceCard title="CPA Usage server" icon={<IconServer size={15} />} status={{ health: 'ok', label: 'Running' }}>
      <Row label="Version">v{app.version}</Row>
      <Row label="Uptime">
        {formatUptime(now - app.started_at_ms)} · since {formatStamp(app.started_at_ms)}
      </Row>
      <Row label="Runtime">
        Node {app.node_version} · {app.platform}/{app.arch}
      </Row>
      <Row label="Memory">
        {formatBytes(app.memory.rss_bytes)} RSS · {formatBytes(app.memory.heap_used_bytes)} heap
      </Row>
      <Row label="Analytics workers">{app.analytics_workers}</Row>
      <Row label="Mode">
        {app.mode} · log {app.log_level}
      </Row>
    </ServiceCard>
  );
}

function LinksCard() {
  return (
    <section className={styles.card} data-reveal>
      <header className={styles.cardHead}>
        <span className={styles.cardIcon}>
          <IconExternalLink size={15} />
        </span>
        <h2 className={styles.cardTitle}>Links</h2>
      </header>
      <ul className={styles.links}>
        {LINKS.map((link) => (
          <li key={link.href}>
            <a href={link.href} target="_blank" rel="noreferrer noopener" className={styles.link}>
              <span className={styles.linkIcon}>{link.icon}</span>
              <span className={styles.linkText}>
                <span className={styles.linkLabel}>{link.label}</span>
                <span className={styles.linkMeta}>{link.meta}</span>
              </span>
              <IconExternalLink size={13} className={styles.linkArrow} />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
