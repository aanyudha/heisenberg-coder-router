import { useCallback, useEffect, useMemo, useState } from 'react';
import { HcrContext, type HcrState } from './hcr-context';
import { Sidebar } from './components/Sidebar';
import { usePage, PAGE_TITLE, PAGE_SECTION } from './nav';
import { apiGet } from './api';
import type {
  CompanionStatus,
  RecentTraffic,
  RoutingVerify,
  StatusResponse,
  TelemetryLike,
  TelemetryLive,
  WebHandoffSummary,
} from './types';

import { OverviewPage } from './pages/OverviewPage';
import { RoutingPage } from './pages/RoutingPage';
import { ProvidersPage } from './pages/ProvidersPage';
import { ModelsPage } from './pages/ModelsPage';
import { WebHandoffPage } from './pages/WebHandoffPage';
import { BrowserCompanionPage } from './pages/BrowserCompanionPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { ActivityPage } from './pages/ActivityPage';
import { LiveTrafficPage } from './pages/LiveTrafficPage';
import { TelemetryPage } from './pages/TelemetryPage';
import { SettingsPage } from './pages/SettingsPage';
import { AboutPage } from './pages/AboutPage';

const COLLAPSE_KEY = 'hcr.sidebar.collapsed';
const POLL_MS = 5000;

export default function App() {
  const [page, navigate] = usePage();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryLike | null>(null);
  const [live, setLive] = useState<TelemetryLive | null>(null);
  const [verify, setVerify] = useState<RoutingVerify | null>(null);
  const [companion, setCompanion] = useState<CompanionStatus | null>(null);
  const [handoffs, setHandoffs] = useState<WebHandoffSummary[]>([]);
  const [recent, setRecent] = useState<RecentTraffic[]>([]);

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      apiGet<StatusResponse>('/api/status'),
      apiGet<TelemetryLike & TelemetryLive>('/api/telemetry'),
      apiGet<RoutingVerify>('/api/routing/verify'),
      apiGet<CompanionStatus>('/api/browser-companion/status'),
      apiGet<{ handoffs: WebHandoffSummary[] }>('/api/web-handoff?limit=5'),
      apiGet<{ requests: RecentTraffic[] }>('/api/telemetry/recent'),
    ]);

    const [statusRes, telemetryRes, verifyRes, companionRes, handoffRes, recentRes] = results;

    if (statusRes.status === 'fulfilled') {
      setStatus(statusRes.value);
      setOnline(true);
      setError(null);
    } else {
      setOnline(false);
      setError(statusRes.reason instanceof Error ? statusRes.reason.message : 'Failed to reach the HCR server');
    }

    if (telemetryRes.status === 'fulfilled') {
      setTelemetry(telemetryRes.value);
      setLive(telemetryRes.value as TelemetryLive);
    }
    if (verifyRes.status === 'fulfilled') setVerify(verifyRes.value);
    if (companionRes.status === 'fulfilled') setCompanion(companionRes.value);
    if (handoffRes.status === 'fulfilled') setHandoffs(handoffRes.value.handoffs ?? []);
    if (recentRes.status === 'fulfilled') setRecent(recentRes.value.requests ?? []);

    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const toggleCollapse = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // storage may be unavailable; state still toggles
      }
      return next;
    });
  };

  const value = useMemo<HcrState>(
    () => ({ online, loading, error, status, telemetry, live, verify, companion, handoffs, recent, refresh }),
    [online, loading, error, status, telemetry, live, verify, companion, handoffs, recent, refresh]
  );

  const body = (() => {
    switch (page) {
      case 'routing':
        return <RoutingPage />;
      case 'providers':
        return <ProvidersPage onNavigate={navigate} />;
      case 'models':
        return <ModelsPage onNavigate={navigate} />;
      case 'web-handoff':
        return <WebHandoffPage onNavigate={navigate} />;
      case 'browser-companion':
        return <BrowserCompanionPage />;
      case 'projects':
        return <ProjectsPage onNavigate={navigate} />;
      case 'activity':
        return <ActivityPage onNavigate={navigate} />;
      case 'live-traffic':
        return <LiveTrafficPage />;
      case 'telemetry':
        return <TelemetryPage />;
      case 'settings':
        return <SettingsPage onNavigate={navigate} />;
      case 'about':
        return <AboutPage onNavigate={navigate} />;
      case 'overview':
      default:
        return <OverviewPage onNavigate={navigate} />;
    }
  })();

  return (
    <HcrContext.Provider value={value}>
      <div className={`shell ${collapsed ? 'is-collapsed' : ''}`}>
        <Sidebar page={page} collapsed={collapsed} onNavigate={navigate} onToggleCollapse={toggleCollapse} />

        <div className="main">
          <header className="topbar">
            <div className="topbar-left">
              <span className="topbar-section">{PAGE_SECTION[page]}</span>
              <span className="topbar-page">{PAGE_TITLE[page]}</span>
            </div>
            <div className="topbar-right">
              <span className="topbar-meta" title={status?.project?.path ?? undefined}>
                {status?.project?.name ?? 'No project'}
              </span>
              <span className={`status-dot dot-${online ? 'ok' : 'error'}`} aria-hidden="true" />
              <span className="topbar-meta">{online ? 'Online' : 'Offline'}</span>
              <button className="btn btn-sm" type="button" onClick={() => void refresh()}>
                Refresh
              </button>
            </div>
          </header>

          {!online ? (
            <div className="notice notice-error shell-notice">
              <strong>HCR server unreachable.</strong> {error ?? ''}{' '}
              <button className="btn btn-sm" type="button" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          ) : null}

          <main className="content">
            {loading && !status ? <p className="muted boot-line">Initializing workspace…</p> : body}
          </main>
        </div>
      </div>
    </HcrContext.Provider>
  );
}
