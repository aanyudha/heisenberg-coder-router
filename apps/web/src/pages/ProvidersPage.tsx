import { Card, PageHeader, Badge, EmptyState } from '../components/ui';
import { useHcr } from '../hcr-context';
import type { PageId } from '../nav';

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'error' | 'neutral' | 'info'> = {
  online: 'ok',
  external: 'info',
  offline: 'warn',
  unknown: 'neutral',
};

export function ProvidersPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const { status } = useHcr();

  return (
    <>
      <PageHeader
        title="Providers"
        subtitle="Providers available to HCR routing. Selection is desired state until you apply it on the Routing page."
        actions={
          <button className="btn btn-sm" type="button" onClick={() => onNavigate('routing')}>
            Open Routing
          </button>
        }
      />

      <Card title="Configured Providers" bodyClassName="is-flush">
        {!status || status.providers.length === 0 ? (
          <EmptyState title="No providers reported" hint="HCR always exposes Ollama and OpenAI." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th>Notes</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {status.providers.map((provider) => (
                  <tr key={provider.type}>
                    <td className="cell-strong">{provider.name}</td>
                    <td className="mono">{provider.type}</td>
                    <td>
                      <Badge tone={STATUS_TONE[provider.status] ?? 'neutral'}>{provider.status}</Badge>
                    </td>
                    <td className="mono">{provider.version ?? '—'}</td>
                    <td className="muted">{provider.note ?? '—'}</td>
                    <td>
                      <button
                        className="btn btn-sm"
                        type="button"
                        onClick={() => onNavigate('routing')}
                        title="Select this provider in Routing"
                      >
                        Configure
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-2" style={{ marginTop: 14 }}>
        <Card title="Ollama">
          <p className="muted">
            Local models served by your Ollama instance. HCR writes the HCR gateway address into the Codex
            configuration so Ollama inference flows through HCR and can be observed live.
          </p>
          <div className="row" style={{ marginTop: 10 }}>
            <Badge tone={status?.ollama?.online ? 'ok' : 'warn'}>
              {status?.ollama?.online ? 'Online' : 'Offline'}
            </Badge>
            <span className="muted small mono">{status?.ollama?.endpoint}</span>
          </div>
        </Card>
        <Card title="OpenAI">
          <p className="muted">
            Control-plane routing only. HCR does not implement OpenAI authentication and never stores OpenAI
            credentials - Codex uses its existing login.
          </p>
          <div className="row" style={{ marginTop: 10 }}>
            <Badge tone={status?.codex?.installed ? 'ok' : 'error'}>
              Codex CLI {status?.codex?.installed ? 'Installed' : 'Not Installed'}
            </Badge>
            <span className="muted small mono">{status?.codex?.version ?? status?.codex?.path ?? ''}</span>
          </div>
        </Card>
      </div>
    </>
  );
}
