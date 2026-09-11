import { useCallback, useEffect, useState } from 'react';
import { StatusCard } from './components/StatusCard';
import { RoutingCard, type RoutingState } from './components/RoutingCard';
import { ProjectCard } from './components/ProjectCard';
import type { ModelInfo, ProviderInfo, ProjectInfoLike, VsCodeCodexInfo } from './types';

interface CodexStatus {
  installed: boolean;
  path?: string;
  version?: string;
}

interface OllamaStatus {
  online: boolean;
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

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [verify, setVerify] = useState<RoutingVerify | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/status');
      if (!response.ok) throw new Error(`Server responded ${response.status}`);
      const data = (await response.json()) as StatusResponse;
      setStatus(data);
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
      if (response.ok) {
        setVerify((await response.json()) as RoutingVerify);
      }
    } catch {
      // Verification is best-effort; status card still renders.
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    void fetchVerify();
  }, [fetchStatus, fetchVerify]);

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
      await fetchStatus();
      return true;
    } catch {
      setError('Failed to set project directory');
      return false;
    }
  };

  if (loading) {
    return (
      <div className="container">
        <Header />
        <p className="muted">Loading...</p>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="container">
        <Header />
        <p className="error-text">Error: {error}</p>
        <button className="btn" onClick={() => void fetchStatus()}>
          Retry Connection
        </button>
      </div>
    );
  }

  return (
    <div className="container">
      <Header />

      {status && (
        <>
          <StatusCard
            title="Server"
            value={`${status.server.host}:${status.server.port}`}
            status="online"
          />

          <StatusCard
            title="Codex"
            value={status.codex.installed ? 'Installed' : 'Not Installed'}
            status={status.codex.installed ? 'installed' : 'not-installed'}
            details={
              status.codex.installed
                ? [status.codex.version, status.codex.path].filter(Boolean).join(' — ') || undefined
                : 'Install Codex CLI separately (npm install -g @openai/codex)'
            }
          />

          <StatusCard
            title="Ollama"
            value={status.ollama.online ? 'Online' : 'Offline'}
            status={status.ollama.online ? 'online' : 'offline'}
            details={
              status.ollama.online
                ? `${status.ollama.models.length} model(s) discovered` +
                  (status.ollama.version ? ` — version ${status.ollama.version}` : '')
                : 'Ollama not detected on localhost:11434'
            }
          />

          <RoutingCard
            routing={status.routing}
            providers={status.providers}
            ollamaModels={status.ollama.models}
            onRefresh={async () => {
              await fetchStatus();
              await fetchVerify();
            }}
          />

          <ProjectCard project={status.project} onSetProject={handleSetProject} />

          {verify && <VerifyCard verify={verify} />}
        </>
      )}

      <div className="footer">
        <p>Heisenberg Coder Router v0.2.0 — local routing control plane for Codex</p>
      </div>
    </div>
  );
}

function VerifyCard({ verify }: { verify: RoutingVerify }) {
  const { checks, vscodeCodex } = verify;
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Verification</span>
        <span className={`status-badge ${checks.providerMatches && checks.modelMatches ? 'online' : 'offline'}`}>
          {checks.providerMatches && checks.modelMatches ? '✓ Uses HCR Route' : '⚠ Route Not Verified'}
        </span>
      </div>
      <p className="muted">
        Codex CLI: {checks.codexInstalled ? 'installed' : 'not installed'} · config readable:{' '}
        {checks.configReadable ? 'yes' : 'no'} · valid TOML: {checks.configValidToml ? 'yes' : 'no'}
      </p>
      <p className="muted">
        VS Code Codex: {vscodeCodex.detected ? (vscodeCodex.confirmed ? '✓ Uses HCR Route' : '⚠ Route Not Verified') : 'Not Detected'}
      </p>
      <p className="muted small">{vscodeCodex.detail}</p>
    </div>
  );
}

function Header() {
  return (
    <div className="header">
      <h1>Heisenberg Coder Router</h1>
      <p>Local routing control plane for Codex — choose provider/model once, use Codex anywhere</p>
    </div>
  );
}
