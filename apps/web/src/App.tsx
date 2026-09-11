import { useCallback, useEffect, useState } from 'react';
import { StatusCard } from './components/StatusCard';
import { ProviderCard } from './components/ProviderCard';
import { ProjectCard } from './components/ProjectCard';
import { RunCard } from './components/RunCard';

interface CodexStatus {
  installed: boolean;
  path?: string;
  version?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: 'ollama' | 'openai';
  size?: string;
  modified?: string;
}

interface OllamaStatus {
  online: boolean;
  version?: string;
  models: ModelInfo[];
}

export interface ProviderInfo {
  type: 'ollama' | 'openai';
  name: string;
  status: 'online' | 'offline' | 'unknown';
}

interface ProjectInfo {
  name: string;
  path: string;
}

export interface RunStatus {
  state: 'idle' | 'starting' | 'running' | 'stopped' | 'exited';
  pid?: number;
  command?: string;
  provider?: 'ollama' | 'openai';
  model?: string;
  projectDir?: string;
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  error?: string;
}

interface StatusResponse {
  server: { host: string; port: number };
  codex: CodexStatus;
  ollama: OllamaStatus;
  providers: ProviderInfo[];
  activeProvider: 'ollama' | 'openai';
  activeModel: string | null;
  project: ProjectInfo | null;
  run: RunStatus;
}

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

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

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const handleStart = async () => {
    setActionMessage(null);
    try {
      const response = await fetch('/api/codex/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = (await response.json()) as { run?: RunStatus; error?: string };
      if (!response.ok) {
        setActionMessage(data.error ?? 'Failed to start Codex');
      } else {
        setActionMessage('Codex started.');
      }
      await fetchStatus();
    } catch {
      setActionMessage('Failed to start Codex');
    }
  };

  const handleStop = async () => {
    setActionMessage(null);
    try {
      await fetch('/api/codex/stop', { method: 'POST' });
      setActionMessage('Codex stopped.');
      await fetchStatus();
    } catch {
      setActionMessage('Failed to stop Codex');
    }
  };

  const handleSetProject = async (projectDir: string): Promise<boolean> => {
    setActionMessage(null);
    try {
      const response = await fetch('/api/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setActionMessage(data.error ?? 'Invalid project directory');
        return false;
      }
      await fetchStatus();
      return true;
    } catch {
      setActionMessage('Failed to set project directory');
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

          <ProviderCard
            providers={status.providers}
            activeProvider={status.activeProvider}
            activeModel={status.activeModel}
            ollamaModels={status.ollama.models}
            onRefresh={fetchStatus}
          />

          <ProjectCard project={status.project} onSetProject={handleSetProject} />

          <RunCard run={status.run} onStart={handleStart} onStop={handleStop} />

          {actionMessage && <p className={error ? 'error-text' : 'muted'}>{actionMessage}</p>}
        </>
      )}

      <div className="footer">
        <p>Heisenberg Coder Router v0.1.0</p>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="header">
      <h1>Heisenberg Coder Router</h1>
      <p>Local Codex Provider/Model Router</p>
    </div>
  );
}
