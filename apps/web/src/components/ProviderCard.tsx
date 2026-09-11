import { useState } from 'react';
import type { ProviderInfo, ModelInfo } from '../App';

interface ProviderCardProps {
  providers: ProviderInfo[];
  activeProvider: 'ollama' | 'openai';
  activeModel: string | null;
  ollamaModels: ModelInfo[];
  onRefresh: () => Promise<void>;
}

export function ProviderCard({
  providers,
  activeProvider,
  activeModel,
  ollamaModels,
  onRefresh,
}: ProviderCardProps) {
  const [busy, setBusy] = useState(false);

  const handleProviderChange = async (provider: 'ollama' | 'openai') => {
    setBusy(true);
    try {
      await fetch('/api/providers/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleModelChange = async (model: string) => {
    if (!model) return;
    setBusy(true);
    try {
      await fetch('/api/providers/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const isOpenAI = activeProvider === 'openai';

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Provider & Model</span>
        <button
          className="btn btn-small"
          onClick={() => void onRefresh()}
          disabled={busy}
        >
          Refresh
        </button>
      </div>

      <div className="field-group">
        <label className="field-label">Provider</label>
        <select
          value={activeProvider}
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
            OpenAI models are chosen inside Codex CLI using your existing Codex/OpenAI login.
          </p>
        ) : ollamaModels.length > 0 ? (
          <select
            value={activeModel ?? ''}
            disabled={busy}
            onChange={(e) => void handleModelChange(e.target.value)}
          >
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
    </div>
  );
}
