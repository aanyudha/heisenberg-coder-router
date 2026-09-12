import { useCallback, useEffect, useState } from 'react';
import { Gauge, type GaugeStatus } from './components/Gauge';
import { RoutingControls, type RoutingState } from './components/RoutingControls';
import { ProjectControl } from './components/ProjectControl';
import { SystemPanel } from './components/SystemPanel';
import { TelemetryPanel, type TelemetryLike } from './components/TelemetryPanel';
import type { ModelInfo, ProviderInfo, ProjectInfoLike, VsCodeCodexInfo } from './types';

interface CodexStatus {
  installed: boolean;
  path?: string;
  version?: string;
}

interface OllamaStatus {
  online: boolean;
  endpoint: string;
  version?: string;
  models: ModelInfo[];
}

interface RoutingVerify {
  status: RoutingState['status'];
  checks: {
    codexInstalled: boolean;
    configReadable: boolean;
    configValidToml: boolean;
    providerMatches: boolean;
    modelMatches: boolean;
  };
  vscodeCodex: VsCodeCodexInfo;
  layers?: {
    configSynced: boolean;
    runtimeAvailable: boolean;
    trafficObserved: boolean;
    detail: string;
  };
  configPath: string;
}

interface TelemetryLive {
  source: string;
  active: boolean;
  state: string;
  provider: string | null;
  model: string | null;
  client: string | null;
  requestId: string | null;
  latencyMs: number | null;
  timeToFirstByteMs: number | null;
  requestCount: number | null;
}

interface StatusResponse {
  server: { host: string; port: number };
  codex: CodexStatus;
  ollama: OllamaStatus;
  providers: ProviderInfo[];
  routing: RoutingState;
  project: ProjectInfoLike | null;
}

const ROUTE_STATE_LABEL: Record<RoutingState['status'], string> = {
  applied: 'APPLIED',
  drift: 'ROUTING DRIFT',
  not_configured: 'NOT CONFIGURED',
  error: 'CONFIG ERROR',
};

/** Live gateway state line for the ACTIVE ROUTE gauge. */
function liveState(telemetry: TelemetryLive | null): { active: boolean; label: string } {
  if (telemetry?.active) {
    return { active: true, label: '● GENERATING' };
  }
  return { active: false, label: '○ IDLE' };
}

/** One metadata row inside the live-traffic / verification panels. */
function LiveRow({ label, value, led }: { label: string; value: string; led?: GaugeStatus }) {
  return (
    <div className="live-row">
      <span className="live-row-label">{label}</span>
      <span className="live-row-value">
        {led && <span className={`led ${led}`} aria-hidden="true" />} {value}
      </span>
    </div>
  );
}

const routeGaugeStatus: Record<RoutingState['status'], GaugeStatus> = {
  applied: 'ok',
  drift: 'error',
  not_configured: 'warn',
  error: 'error',
};

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [verify, setVerify] = useState<RoutingVerify | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryLike | null>(null);
  const [live, setLive] = useState<TelemetryLive | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, telemetryRes] = await Promise.all([fetch('/api/status'), fetch('/api/telemetry')]);
      if (!statusRes.ok) throw new Error(`Server responded ${statusRes.status}`);
      setStatus((await statusRes.json()) as StatusResponse);
      if (telemetryRes.ok) {
        const t = (await telemetryRes.json()) as TelemetryLike & TelemetryLive;
        setTelemetry(t);
        setLive({
          source: t.source,
          active: t.active,
          state: t.state,
          provider: t.provider,
          model: t.model,
          client: t.client,
          requestId: t.requestId,
          latencyMs: t.latencyMs,
          timeToFirstByteMs: t.timeToFirstByteMs,
          requestCount: t.requestCount,
        });
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to server');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchVerify = useCallback(async () => {
    try {
      const response = await fetch('/api/routing/verify');
      if (response.ok) setVerify((await response.json()) as RoutingVerify);
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    void fetchAll();
    void fetchVerify();
    const interval = window.setInterval(() => {
      void fetchAll();
      void fetchVerify();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [fetchAll, fetchVerify]);

  const handleSetProject = async (projectDir: string): Promise<boolean> => {
    try {
      const response = await fetch('/api/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setError(data.error ?? 'Invalid project directory');
        return false;
      }
      await fetchAll();
      return true;
    } catch {
      setError('Failed to set project directory');
      return false;
    }
  };

  if (loading) {
    return (
      <div className="cockpit">
        <TopBar online />
        <p className="muted boot-line">Initializing instrument cluster…</p>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="cockpit">
        <TopBar online={false} />
        <p className="error-text boot-line">Signal lost: {error}</p>
        <button className="btn" onClick={() => void fetchAll()}>
          Reconnect
        </button>
      </div>
    );
  }

  if (!status) return null;

  const { routing, codex, ollama } = status;
  const liveRoute = liveState(live);
  const desiredLabel = `${routing.desired.provider}${routing.desired.model ? ` / ${routing.desired.model}` : ''}`;
  const appliedLabel = `${routing.applied.provider ?? 'openai (default)'}${routing.applied.model ? ` / ${routing.applied.model}` : ''}`;

  return (
    <div className="cockpit">
      <TopBar online />

      <main className="cluster">
        {/* ---- Primary cluster: route gauge + provider gauge ---- */}
        <section className="cluster-main">
          <div className="gauge-bay">
            <Gauge
              label="ACTIVE ROUTE"
              value={liveRoute.active ? (live?.model ?? routing.desired.model ?? '—') : routing.desired.provider === 'openai' ? 'Codex Cloud' : (routing.desired.model ?? 'NO MODEL')}
              sub={liveRoute.active ? 'OLLAMA' : routing.desired.provider === 'openai' ? 'OpenAI' : 'Ollama'}
              state={liveRoute.label}
              status={liveRoute.active ? 'ok' : routeGaugeStatus[routing.status]}
              fill={liveRoute.active ? 0.6 : routing.status === 'applied' ? 1 : routing.status === 'drift' ? 0.5 : null}
              size={260}
            />
            <Gauge
              label="RUNTIME"
              value={ollama.online ? 'ONLINE' : 'OFFLINE'}
              sub="OLLAMA"
              state={ollama.online ? `${ollama.models.length} MODELS` : 'NOT DETECTED'}
              status={ollama.online ? 'ok' : 'neutral'}
              fill={ollama.online ? 1 : 0}
              size={220}
            />
          </div>

          {/* Readout strip */}
          <div className="readouts">
            <Readout label="Provider" value={routing.desired.provider === 'openai' ? 'OpenAI' : 'Ollama'} />
            <Readout label="Model" value={routing.desired.provider === 'openai' ? 'Codex Cloud' : (routing.desired.model ?? '—')} />
            <Readout label="Route Status" value={ROUTE_STATE_LABEL[routing.status]} status={routeGaugeStatus[routing.status]} />
            <Readout label="Codex" value={codex.installed ? 'INSTALLED' : 'NOT INSTALLED'} status={codex.installed ? 'ok' : 'error'} detail={codex.version} />
            <Readout
              label="VS Code"
              value={vscodeLabel(verify?.vscodeCodex, verify?.layers?.trafficObserved)}
              status={vscodeStatusGauge(verify?.vscodeCodex, verify?.layers?.trafficObserved)}
              detail={verify?.vscodeCodex.detected ? undefined : 'not detected on this machine'}
            />
            <Readout label="Project" value={status.project?.name ?? '—'} detail={status.project?.path} />
          </div>

          {/* LIVE TRAFFIC panel — only real gateway observations */}
          {live && (live.active || live.requestCount !== null) && (
            <div className="live-panel">
              <div className="panel-title">LIVE TRAFFIC</div>
              <div className="live-grid">
                <LiveRow label="State" value={live.active ? 'GENERATING' : 'IDLE'} led={live.active ? 'ok' : 'neutral'} />
                <LiveRow label="Provider" value={live.provider === 'openai' ? 'OpenAI' : 'Ollama'} />
                <LiveRow label="Model" value={live.model ?? '—'} />
                <LiveRow label="Client" value={live.client ?? 'Codex / Unknown Client'} />
                <LiveRow
                  label="Elapsed"
                  value={live.active && live.latencyMs !== null ? `${(live.latencyMs / 1000).toFixed(1)}s` : '—'}
                />
                <LiveRow label="Requests observed" value={live.requestCount !== null ? String(live.requestCount) : '0 (not yet observed)'} />
              </div>
            </div>
          )}

          {/* Drift banner: visible but not disruptive */}
          {routing.status === 'drift' && (
            <div className="drift-banner" role="alert">
              <span className="drift-title">ROUTING DRIFT</span>
              <span className="drift-detail">
                HCR Desired: <strong>{desiredLabel}</strong> · Codex Applied: <strong>{appliedLabel}</strong>
                {routing.detail ? ` — ${routing.detail}` : ''}
              </span>
            </div>
          )}
          {routing.status === 'error' && (
            <div className="drift-banner error" role="alert">
              <span className="drift-title">CONFIG ERROR</span>
              <span className="drift-detail">{routing.detail ?? 'Codex config could not be parsed.'}</span>
            </div>
          )}

          {/* Layered route verification: config / runtime / live traffic */}
          {verify?.layers && (
            <div className="verify-layers">
              <div className="panel-title">ROUTE VERIFICATION</div>
              <div className="verify-grid">
                <LiveRow
                  label="Codex Config"
                  value={verify.layers.configSynced ? 'HCR Route Configured' : 'Not Pointing at HCR'}
                  led={verify.layers.configSynced ? 'ok' : 'warn'}
                />
                <LiveRow
                  label="Runtime"
                  value={
                    routing.desired.provider === 'openai'
                      ? verify.checks.codexInstalled
                        ? 'Codex Installed'
                        : 'Codex Missing'
                      : ollama.online
                        ? 'Ollama Available'
                        : 'Ollama Offline'
                  }
                  led={verify.layers.runtimeAvailable ? 'ok' : 'error'}
                />
                <LiveRow
                  label="Live Traffic"
                  value={
                    verify.layers.trafficObserved
                      ? 'HCR ROUTE VERIFIED'
                      : 'Not Observed'
                  }
                  led={verify.layers.trafficObserved ? 'ok' : 'neutral'}
                />
              </div>
              <p className="muted small">{verify.layers.detail}</p>
            </div>
          )}

          {/* Routing controls */}
          <RoutingControls
            routing={routing}
            providers={status.providers}
            ollamaModels={ollama.models}
            onRefresh={async () => {
              await fetchAll();
              await fetchVerify();
            }}
          />

          <ProjectControl project={status.project} onSetProject={handleSetProject} />
        </section>

        {/* ---- Side rail: system LEDs ---- */}
        <aside className="cluster-side">
          <SystemPanel
            codex={{ installed: codex.installed, version: codex.version, path: codex.path }}
            ollama={{
              online: ollama.online,
              endpoint: ollama.endpoint,
              modelCount: ollama.models.length,
              version: ollama.version,
            }}
            route={{ status: routing.status, detail: routing.detail }}
            config={{
              synced: routing.status === 'applied',
              detail:
                routing.status === 'applied'
                  ? routing.configPath
                  : `drift vs ${routing.configPath}`,
            }}
            vscode={
              verify?.vscodeCodex ?? { detected: false, confirmed: false, detail: 'verification pending' }
            }
          />
        </aside>
      </main>

      <TelemetryPanel telemetry={telemetry} />

      <footer className="footer">
        <p>Heisenberg Coder Router v0.2.0 · {status.server.host}:{status.server.port} · routing control plane for Codex</p>
      </footer>
    </div>
  );
}

function Readout({
  label,
  value,
  status,
  detail,
}: {
  label: string;
  value: string;
  status?: GaugeStatus;
  detail?: string;
}) {
  return (
    <div className="readout" title={detail}>
      <span className="readout-label">{label}</span>
      <span className={`readout-value ${status ?? ''}`}>{value}</span>
      {detail && <span className="readout-detail">{detail}</span>}
    </div>
  );
}

/** VS Code status label follows the strict layered truthfulness rules. */
function vscodeLabel(
  vscode: VsCodeCodexInfo | undefined,
  trafficObserved: boolean | undefined
): string {
  if (!vscode) return '…';
  if (!vscode.detected) return 'NOT DETECTED';
  // "Uses HCR Route" requires the shared config route AND observed traffic.
  if (vscode.confirmed && trafficObserved) return 'USES HCR ROUTE';
  if (vscode.confirmed) return 'CONFIG ROUTE AVAILABLE';
  return 'ROUTE NOT VERIFIED';
}

function vscodeStatusGauge(
  vscode: VsCodeCodexInfo | undefined,
  trafficObserved: boolean | undefined
): GaugeStatus {
  if (!vscode) return 'neutral';
  if (!vscode.detected) return 'neutral';
  if (vscode.confirmed && trafficObserved) return 'ok';
  return 'warn';
}

function TopBar({ online }: { online: boolean }) {
  return (
    <header className="topbar">
      <span className="topbar-title">HEISENBERG CODER ROUTER</span>
      <span className="topbar-right">
        HCR <span className={`led ${online ? 'ok' : 'error'}`} aria-hidden="true" />{' '}
        {online ? 'ONLINE' : 'OFFLINE'}
      </span>
    </header>
  );
}
