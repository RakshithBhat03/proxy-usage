import { useCallback, useEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react';
import { NavLink, type Location } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { IconSidebarQuota } from '@/components/ui/icons';
import { IconActivity, IconChartColumn, IconClock } from '@/components/ui/extraIcons';
import { PageTransition } from '@/components/common/PageTransition';
import { SessionBanner } from '@/features/session/SessionBanner';
import { triggerHeaderRefresh, hasHeaderRefreshHandler } from '@/hooks/useHeaderRefresh';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore, type Theme } from '@/stores/theme';

const headerIconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': 'true' as const,
  focusable: 'false' as const,
};

const headerIcons = {
  refresh: (
    <svg {...headerIconProps}>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  ),
  menu: (
    <svg {...headerIconProps}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </svg>
  ),
  close: (
    <svg {...headerIconProps}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  ),
  chevronLeft: (
    <svg {...headerIconProps}>
      <path d="m14 18-6-6 6-6" />
    </svg>
  ),
  chevronRight: (
    <svg {...headerIconProps}>
      <path d="m10 6 6 6-6 6" />
    </svg>
  ),
  sun: (
    <svg {...headerIconProps}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  ),
  moon: (
    <svg {...headerIconProps}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
    </svg>
  ),
  whiteTheme: (
    <svg {...headerIconProps}>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </svg>
  ),
  autoTheme: (
    <svg {...headerIconProps}>
      <defs>
        <clipPath id="mainLayoutAutoThemeSunLeftHalf">
          <rect x="0" y="0" width="12" height="24" />
        </clipPath>
      </defs>
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="4" clipPath="url(#mainLayoutAutoThemeSunLeftHalf)" fill="currentColor" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="M4.93 4.93l1.41 1.41" />
      <path d="M17.66 17.66l1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="M6.34 17.66l-1.41 1.41" />
      <path d="M19.07 4.93l-1.41 1.41" />
    </svg>
  ),
  logout: (
    <svg {...headerIconProps}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  ),
};

const THEME_CARDS: Array<{
  key: Theme;
  label: string;
  colors: { bg: string; card: string; border: string; textMuted: string };
}> = [
  {
    key: 'auto',
    label: 'Auto',
    colors: {
      bg: 'linear-gradient(135deg, #ffffff 0 50%, #111111 50% 100%)',
      card: 'linear-gradient(135deg, #ffffff 0 50%, #1a1a1a 50% 100%)',
      border: '#bdbdbd',
      textMuted: 'linear-gradient(135deg, #c9c9c9 0 50%, #5a5a5a 50% 100%)',
    },
  },
  { key: 'white', label: 'White', colors: { bg: '#ffffff', card: '#ffffff', border: '#e5e5e5', textMuted: '#a29c95' } },
  { key: 'light', label: 'Wool Paper', colors: { bg: '#faf9f5', card: '#f0eee8', border: '#e3e1db', textMuted: '#a29c95' } },
  { key: 'dark', label: 'Dark', colors: { bg: '#151412', card: '#1d1b18', border: '#3a3530', textMuted: '#9c958d' } },
];

interface NavItem {
  path: string;
  label: string;
  meta: string;
  icon: ReactNode;
}

const NAV_GROUPS: Array<{ id: string; label: string; items: NavItem[] }> = [
  {
    id: 'observe',
    label: 'Observe',
    items: [
      { path: '/usage', label: 'Usage', meta: 'Tokens, cost & speed', icon: <IconChartColumn size={16} /> },
      { path: '/requests', label: 'Request Monitor', meta: 'Live request stream', icon: <IconActivity size={16} /> },
    ],
  },
  {
    id: 'accounts',
    label: 'Accounts',
    items: [
      { path: '/quota', label: 'Quota', meta: 'Credential windows', icon: <IconSidebarQuota size={16} /> },
      { path: '/quota-history', label: 'Quota history', meta: 'Previous, current & forecast', icon: <IconClock size={16} /> },
    ],
  },
];

const ROUTE_ORDER = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.path));
const getRouteOrder = (pathname: string) => {
  const index = ROUTE_ORDER.findIndex((path) => pathname === path || pathname.startsWith(`${path}/`));
  return index === -1 ? null : index;
};

const SIDEBAR_COLLAPSED_KEY = 'proxy-usage.sidebarCollapsed';
const TAB_RETURN_REFRESH_COOLDOWN_MS = 10_000;
const NAV_TOOLTIP_ID = 'nav-rail-tooltip';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const shortcutText = isMac ? '⌘B' : 'Ctrl+B';

interface MainLayoutProps {
  renderRoutes: (location: Location) => ReactNode;
}

export function MainLayout({ renderRoutes }: MainLayoutProps) {
  const queryClient = useQueryClient();
  const logout = useAuthStore((state) => state.logout);
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1',
  );
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [railTooltip, setRailTooltip] = useState<{ id: string; label: string; meta?: string; top: number } | null>(
    null,
  );

  const contentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const themeMenuRef = useRef<HTMLDivElement>(null);

  const showSidebarLabels = !sidebarCollapsed || sidebarOpen;

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  // The header height is measured live (as CPAMC does) so page content clears the floating pill.
  useEffect(() => {
    const header = headerRef.current;
    if (!header || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--header-height', `${header.offsetHeight}px`);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  // The header blur exists for content passing under the pill; at scroll-top it would only soften
  // the page title, so it fades in once the content scrolls.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const onScroll = () => setScrolled(content.scrollTop > 4);
    onScroll();
    content.addEventListener('scroll', onScroll, { passive: true });
    return () => content.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest('input, textarea, select, [contenteditable="true"]');
      if (!typing && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setRailTooltip(null);
        setSidebarCollapsed((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!themeMenuOpen) return;
    const handlePointer = (event: PointerEvent) => {
      if (!themeMenuRef.current?.contains(event.target as Node)) setThemeMenuOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setThemeMenuOpen(false);
    };
    document.addEventListener('pointerdown', handlePointer);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handlePointer);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [themeMenuOpen]);

  const refreshInFlight = useRef(false);
  const lastRefreshAt = useRef(0);
  const handleRefreshAll = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    lastRefreshAt.current = Date.now();
    setRefreshing(true);
    try {
      if (hasHeaderRefreshHandler()) await triggerHeaderRefresh();
      else await queryClient.invalidateQueries();
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }, [queryClient]);

  // Returning to the tab runs the same refresh as the header button, so every page catches up
  // without a click. The cooldown keeps rapid tab-flipping from re-asking providers (Quota page).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRefreshAt.current < TAB_RETURN_REFRESH_COOLDOWN_MS) return;
      void handleRefreshAll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [handleRefreshAll]);

  const showRailTooltip = (element: HTMLElement, id: string, label: string, meta?: string) => {
    if (showSidebarLabels && id !== 'sidebar-toggle') return;
    const rect = element.getBoundingClientRect();
    const top = Math.min(Math.max(rect.top + rect.height / 2, 24), window.innerHeight - 24);
    setRailTooltip({ id, label, meta, top });
  };
  const hideRailTooltip = () => setRailTooltip(null);

  const railHandlers = (id: string, label: string, meta?: string) => ({
    onMouseEnter: (event: MouseEvent<HTMLElement>) => showRailTooltip(event.currentTarget, id, label, meta),
    onMouseLeave: hideRailTooltip,
    onFocus: (event: FocusEvent<HTMLElement>) => showRailTooltip(event.currentTarget, id, label, meta),
    onBlur: hideRailTooltip,
  });

  const sidebarToggleLabel = sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
  const mobileToggleLabel = sidebarOpen ? 'Close navigation' : 'Open navigation';
  const themeIcon =
    theme === 'auto'
      ? headerIcons.autoTheme
      : theme === 'dark'
        ? headerIcons.moon
        : theme === 'white'
          ? headerIcons.whiteTheme
          : headerIcons.sun;

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''} ${scrolled ? 'is-scrolled' : ''}`}>
      <div className="top-gradient-blur" aria-hidden="true" />

      <header className="main-header" ref={headerRef}>
        <button
          type="button"
          className="sidebar-toggle-floating"
          onClick={() => {
            hideRailTooltip();
            setSidebarCollapsed((prev) => !prev);
          }}
          {...railHandlers('sidebar-toggle', sidebarToggleLabel, shortcutText)}
          aria-label={`${sidebarToggleLabel} (${shortcutText})`}
          aria-describedby={railTooltip?.id === 'sidebar-toggle' ? NAV_TOOLTIP_ID : undefined}
        >
          {sidebarCollapsed ? headerIcons.chevronRight : headerIcons.chevronLeft}
        </button>

        <div className="mobile-sidebar-actions">
          <Button
            className="mobile-menu-btn"
            variant="ghost"
            size="sm"
            onClick={() => setSidebarOpen((prev) => !prev)}
            title={mobileToggleLabel}
            aria-label={mobileToggleLabel}
          >
            {sidebarOpen ? headerIcons.close : headerIcons.menu}
          </Button>
        </div>

        <div className="header-actions floating-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefreshAll}
            title="Refresh"
            aria-label="Refresh"
            className={refreshing ? 'is-refreshing' : ''}
          >
            {headerIcons.refresh}
          </Button>
          <div className={`theme-menu ${themeMenuOpen ? 'open' : ''}`} ref={themeMenuRef}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setThemeMenuOpen((prev) => !prev)}
              title="Switch theme"
              aria-label="Switch theme"
              aria-haspopup="menu"
              aria-expanded={themeMenuOpen}
            >
              {themeIcon}
            </Button>
            {themeMenuOpen && (
              <div className="notification entering theme-menu-popover" role="menu" aria-label="Switch theme">
                {THEME_CARDS.map((card) => (
                  <button
                    key={card.key}
                    type="button"
                    className={`theme-card ${theme === card.key ? 'active' : ''}`}
                    onClick={() => {
                      setTheme(card.key);
                      setThemeMenuOpen(false);
                    }}
                    role="menuitemradio"
                    aria-checked={theme === card.key}
                  >
                    <div
                      className="theme-card-preview"
                      style={{ background: card.colors.bg, border: `1px solid ${card.colors.border}` }}
                    >
                      <div
                        className="theme-card-header"
                        style={{ background: card.colors.card, borderBottom: `1px solid ${card.colors.border}` }}
                      />
                      <div className="theme-card-body">
                        <div
                          className="theme-card-sidebar"
                          style={{ background: card.colors.card, borderRight: `1px solid ${card.colors.border}` }}
                        />
                        <div className="theme-card-content" style={{ background: card.colors.bg }}>
                          <div className="theme-card-line" style={{ background: card.colors.textMuted }} />
                          <div className="theme-card-line short" style={{ background: card.colors.textMuted }} />
                        </div>
                      </div>
                    </div>
                    <span className="theme-card-label">{card.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={logout} title="Log out" aria-label="Log out">
            {headerIcons.logout}
          </Button>
        </div>
      </header>

      <div className="main-body">
        <button
          type="button"
          className={`sidebar-backdrop ${sidebarOpen ? 'visible' : ''}`}
          onClick={() => setSidebarOpen(false)}
          aria-label="Close"
          aria-hidden={!sidebarOpen}
          tabIndex={sidebarOpen ? 0 : -1}
        />

        <aside className={`sidebar ${sidebarOpen ? 'open' : ''} ${sidebarCollapsed ? 'collapsed' : ''}`}>
          <div className="sidebar-header">
            <div className="sidebar-brand" title="CPA Usage · CLI Proxy API Console">
              <img src="/logo.jpg" alt="" className="sidebar-brand-logo" />
              {showSidebarLabels && (
                <span className="sidebar-brand-text">
                  <span className="sidebar-brand-title">CPA Usage</span>
                  <span className="sidebar-brand-subtitle">CLI Proxy API Console</span>
                </span>
              )}
            </div>
          </div>

          <div className="nav-section">
            {NAV_GROUPS.map((group, index) => (
              <div className="nav-group" key={group.id}>
                {showSidebarLabels ? (
                  <div className="nav-group-label">{group.label}</div>
                ) : (
                  index > 0 && <div className="nav-group-divider" aria-hidden="true" />
                )}
                {group.items.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      setSidebarOpen(false);
                      hideRailTooltip();
                    }}
                    aria-label={showSidebarLabels ? undefined : item.label}
                    aria-describedby={!showSidebarLabels && railTooltip?.id === item.path ? NAV_TOOLTIP_ID : undefined}
                    {...(showSidebarLabels ? {} : railHandlers(item.path, item.label, item.meta))}
                  >
                    <span className="nav-icon">{item.icon}</span>
                    {showSidebarLabels && (
                      <span className="nav-text">
                        <span className="nav-label">{item.label}</span>
                      </span>
                    )}
                  </NavLink>
                ))}
              </div>
            ))}
          </div>
        </aside>

        {railTooltip && (
          <div id={NAV_TOOLTIP_ID} className="nav-tooltip" role="tooltip" style={{ top: railTooltip.top }}>
            <span className="nav-tooltip-label" aria-hidden="true">
              {railTooltip.label}
            </span>
            {railTooltip.meta ? <span className="nav-tooltip-meta">{railTooltip.meta}</span> : null}
          </div>
        )}

        <div className="content" ref={contentRef}>
          <main className="main-content">
            <SessionBanner />
            <PageTransition render={renderRoutes} getRouteOrder={getRouteOrder} scrollContainerRef={contentRef} />
          </main>
        </div>
      </div>
    </div>
  );
}
