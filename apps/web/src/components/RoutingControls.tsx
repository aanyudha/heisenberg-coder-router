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

interface RoutingControlsProps {
  routing: RoutingState;
  providers: ProviderInfo[];
  ollamaModels: ModelInfo[];
  onRefresh: () => Promise<void>;
}

/**
 * Routing controls in cockpit arrangement: provider + model selects above a
 * single APPLY ROUTE action. Reapply appears when drift is detected.
 */
export function RoutingControls({ routing, providers, ollamaModels, onRefresh }: RoutingControlsProps) {
  const [provider, setProvider] = useState<'ollama' | 'openai'>(
    (routing.desired.provider ?? 'ollama') as 'ollama' | 'openai'
  );
  const [model, setModel] = useState<string>(routing.desired.model ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  const isOpenAI = provider === 'openai';

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
      if (next === 'ollama') {
        await fetch('/api/ollama/refresh', { method: 'POST' }).catch(() => undefined);
      }
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
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
        setMessage(data.routing?.status === 'applied' ? 'Route applied to Codex config' : (data.routing?.detail ?? `Status: ${data.routing?.status}`));
      }
      await onRefresh();
    } catch {
      setIsError(true);
      setMessage('Failed to apply routing');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="routing-controls">
      <div className="control-row">
        <div className="field-group">
          <label className="field-label">Provider</label>
          <select
            value={provider}
            disabled={busy}
            onChange={(e) => void handleProviderChange(e.target.value as 'ollama' | 'openai')}
          >
            {providers.map((p) => (
              <option key={p.type} value={p.type}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field-group">
          <label className="field-label">Model</label>
          {isOpenAI ? (
            <p className="muted control-note">Codex Cloud — existing Codex login</p>
          ) : ollamaModels.length > 0 ? (
            <select value={model} disabled={busy} onChange={(e) => setModel(e.target.value)}>
              <option value="">Select a model...</option>
              {ollamaModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="muted control-note">No models found (Ollama offline?)</p>
          )}
        </div>
      </div>

      <button className="btn btn-primary" onClick={() => void apply()} disabled={busy}>
        Apply Routing
      </button>

      {routing.status === 'drift' && (
        <button className="btn btn-warn" onClick={() => void apply()} disabled={busy}>
          Reapply HCR Route
        </button>
      )}

      {message && <p className={isError ? 'error-text' : 'muted'}>{message}</p>}
    </div>
  );
}
