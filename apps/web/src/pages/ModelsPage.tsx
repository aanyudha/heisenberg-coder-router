import { useState } from 'react';
import { Card, PageHeader, Badge, EmptyState } from '../components/ui';
import { useHcr } from '../hcr-context';
import { apiPost } from '../api';
import type { PageId } from '../nav';

export function ModelsPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const { status, refresh } = useHcr();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const models = status?.ollama?.models ?? [];
  const selected = status?.routing?.desired.model ?? '';
  const isOllama = status?.routing?.desired.provider === 'ollama';

  const selectModel = async (modelId: string) => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await apiPost('/api/providers/model', { model: modelId });
      setMessage(`Selected model ${modelId} (apply it on the Routing page).`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select model');
    } finally {
      setBusy(false);
    }
  };

  const refreshModels = async () => {
    setBusy(true);
    try {
      await apiPost('/api/ollama/refresh', undefined, { action: 'Could not refresh Ollama models.' });
      await refresh();
      setMessage('Ollama models refreshed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh Ollama');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Models"
        subtitle="Models discovered live from your local Ollama instance. Nothing here is hardcoded."
        actions={
          <>
            <button className="btn btn-sm" type="button" onClick={() => void refreshModels()} disabled={busy}>
              Refresh Ollama
            </button>
            <button className="btn btn-sm btn-primary" type="button" onClick={() => onNavigate('routing')}>
              Open Routing
            </button>
          </>
        }
      />

      {message ? <p className="ok-text">{message}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      <Card title={`Ollama Models (${models.length})`} bodyClassName="is-flush">
        {models.length === 0 ? (
          <EmptyState
            title="No Ollama models discovered"
            hint={
              status?.ollama?.online
                ? 'Ollama is online but reported no models.'
                : 'Ollama appears to be offline. Start Ollama, then refresh.'
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>ID</th>
                  <th>Size</th>
                  <th>Modified</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.id}>
                    <td className="cell-strong">{model.name}</td>
                    <td className="mono">{model.id}</td>
                    <td>{model.size ?? '—'}</td>
                    <td>{model.modified ?? '—'}</td>
                    <td>
                      {isOllama && selected === model.id ? (
                        <Badge tone="ok">Selected</Badge>
                      ) : (
                        <button
                          className="btn btn-sm"
                          type="button"
                          disabled={busy}
                          onClick={() => void selectModel(model.id)}
                        >
                          Select
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Selection">
        <p className="muted">
          Current desired route:{' '}
          <strong>
            {status?.routing?.desired.provider === 'openai'
              ? 'OpenAI / Codex Cloud'
              : `Ollama / ${selected || '(no model selected)'}`}
          </strong>
          . Selecting a model updates desired state only - use{' '}
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => onNavigate('routing')}>
            Routing
          </button>{' '}
          to apply it to the Codex configuration.
        </p>
      </Card>
    </>
  );
}
