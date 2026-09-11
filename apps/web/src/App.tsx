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
  configPath: string;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, telemetryRes] = await Promise.all([fetch('/api/status'), fetch('/api/telemetry')]);
      if (!statusRes.ok) throw new Error(`Server responded ${statusRes.status}`);
      setStatus((await statusRes.json()) as StatusResponse);
      if (telemetryRes.ok) setTelemetry((await telemetryRes.json()) as TelemetryLike);
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
              value={routing.desired.provider === 'openai' ? 'Codex Cloud' : (routing.desired.model ?? 'NO MODEL')}
              sub={routing.desired.provider === 'openai' ? 'OpenAI' : 'Ollama'}
              state={ROUTE_STATE_LABEL[routing.status]}
              status={routeGaugeStatus[routing.status]}
              fill={routing.status === 'applied' ? 1 : routing.status === 'drift' ? 0.5 : null}
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
              value={vscodeLabel(verify?.vscodeCodex)}
              status={vscodeStatusGauge(verify?.vscodeCodex)}
              detail={verify?.vscodeCodex.detected ? undefined : 'not detected on this machine'}
            />
            <Readout label="Project" value={status.project?.name ?? '—'} detail={status.project?.path} />
          </div>

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

function vscodeLabel(vscode?: VsCodeCodexInfo): string {
  if (!vscode) return '…';
  if (!vscode.detected) return 'NOT DETECTED';
  if (vscode.confirmed) return 'USES HCR ROUTE';
  return 'ROUTE NOT VERIFIED';
}

function vscodeStatusGauge(vscode?: VsCodeCodexInfo): GaugeStatus {
  if (!vscode) return 'neutral';
  if (!vscode.detected) return 'neutral';
  if (vscode.confirmed) return 'ok';
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
