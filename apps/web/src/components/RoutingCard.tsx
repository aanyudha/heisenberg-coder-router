import { useState } from 'react';
import type { ModelInfo, ProviderInfo } from '../types';

export interface RoutingState {
  desired: { provider: 'ollama' | 'openai'; model: string | null; projectDir: string | null };
  applied: { provider: 'ollama' | 'openai' | null; model: string | null };
  status: 'applied' | 'drift' | 'not_configured' | 'error';
  detail?: string;
  configPath: string;
  backupPath?: string;
}

interface RoutingCardProps {
  routing: RoutingState | null;
  providers: ProviderInfo[];
  ollamaModels: ModelInfo[];
  onRefresh: () => Promise<void>;
}

export function RoutingCard({ routing, providers, ollamaModels, onRefresh }: RoutingCardProps) {
  const [provider, setProvider] = useState<'ollama' | 'openai'>(
    (routing?.desired.provider ?? 'ollama') as 'ollama' | 'openai'
  );
  const [model, setModel] = useState<string>(routing?.desired.model ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  const isOpenAI = provider === 'openai';

  const refreshModels = async (nextProvider: 'ollama' | 'openai') => {
    if (nextProvider !== 'ollama') return;
    await fetch('/api/ollama/refresh', { method: 'POST' }).catch(() => undefined);
  };

  const handleProviderChange = async (next: 'ollama' | 'openai') => {
    setBusy(true);
    setMessage(null);
    try {
      await fetch('/api/providers/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: next }),
      });
      setProvider(next);
      setModel('');
      await refreshModels(next);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const applyRouting = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/routing/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model: isOpenAI ? null : model || null }),
      });
      const data = (await response.json()) as { routing?: RoutingState; error?: string };
      if (!response.ok) {
        setIsError(true);
        setMessage(data.error ?? 'Failed to apply routing');
      } else {
        setIsError(false);
        setMessage(
          data.routing?.status === 'applied'
            ? `Route applied to Codex config (${data.routing.configPath})`
            : (data.routing?.detail ?? `Routing status: ${data.routing?.status}`)
        );
      }
      await onRefresh();
    } catch {
      setIsError(true);
      setMessage('Failed to apply routing');
    } finally {
      setBusy(false);
    }
  };

  const reapply = async () => {
    await applyRouting();
  };

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Routing</span>
        <button className="btn btn-small" onClick={() => void onRefresh()} disabled={busy}>
          Refresh
        </button>
      </div>

      <div className="field-group">
        <label className="field-label">Provider</label>
        <select
          value={provider}
          disabled={busy}
          onChange={(e) => void handleProviderChange(e.target.value as 'ollama' | 'openai')}
        >
          {providers.map((p) => (
            <option key={p.type} value={p.type}>
              {p.name} ({p.status})
            </option>
          ))}
        </select>
      </div>

      <div className="field-group">
        <label className="field-label">Model</label>
        {isOpenAI ? (
          <p className="muted">
            OpenAI/Codex cloud uses your existing Codex login. Model is chosen by Codex defaults.
          </p>
        ) : ollamaModels.length > 0 ? (
          <select value={model} disabled={busy} onChange={(e) => setModel(e.target.value)}>
            <option value="">Select a model...</option>
            {ollamaModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.size ? ` (${m.size})` : ''}
              </option>
            ))}
          </select>
        ) : (
          <p className="muted">No Ollama models installed (or Ollama is offline).</p>
        )}
      </div>

      <button className="btn btn-primary" onClick={() => void applyRouting()} disabled={busy}>
        Apply Routing
      </button>

      {message && <p className={isError ? 'error-text' : 'muted'}>{message}</p>}

      {routing && (
        <div className="route-status">
          <div className="field-group">
            <label className="field-label">Route Status</label>
            <span className={`status-badge ${statusBadgeClass(routing.status)}`}>
              {statusLabel(routing.status)}
            </span>
            {routing.detail && <p className="muted">{routing.detail}</p>}
          </div>

          <div className="route-pair">
            <div>
              <label className="field-label">HCR Selected</label>
              <p className="mono">
                {routing.desired.provider}
                {routing.desired.model ? ` / ${routing.desired.model}` : ''}
              </p>
            </div>
            <div>
              <label className="field-label">Codex Config</label>
              <p className="mono">
                {routing.applied.provider ?? '(default openai)'}
                {routing.applied.model ? ` / ${routing.applied.model}` : ''}
              </p>
            </div>
          </div>

          {routing.status === 'drift' && (
            <button className="btn" onClick={() => void reapply()} disabled={busy}>
              Reapply HCR Route
            </button>
          )}

          <p className="muted mono small">Codex config: {routing.configPath}</p>
          {routing.backupPath && (
            <p className="muted mono small">Backup: {routing.backupPath}</p>
          )}
        </div>
      )}
    </div>
  );
}

function statusBadgeClass(status: RoutingState['status']): string {
  switch (status) {
    case 'applied':
      return 'online';
    case 'drift':
      return 'unknown';
    case 'error':
      return 'offline';
    default:
      return 'offline';
  }
}

function statusLabel(status: RoutingState['status']): string {
  switch (status) {
    case 'applied':
      return '✓ Applied';
    case 'drift':
      return '⚠ Routing Drift';
    case 'error':
      return '✗ Config Error';
    default:
      return 'Not Configured';
  }
}
