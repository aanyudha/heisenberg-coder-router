import { Card, PageHeader, Badge, KeyValue, StatTile, StatusDot } from '../components/ui';
import { RoutingControls } from '../components/RoutingControls';
import { useHcr } from '../hcr-context';

const ROUTE_LABEL: Record<string, string> = {
  applied: 'Applied',
  drift: 'Drift',
  not_configured: 'Not Configured',
  error: 'Config Error',
};

function tone(status: string): 'ok' | 'warn' | 'error' {
  if (status === 'applied') return 'ok';
  if (status === 'not_configured') return 'warn';
  return 'error';
}

export function RoutingPage() {
  const { status, verify, refresh } = useHcr();
  const routing = status?.routing;
  const ollama = status?.ollama;

  if (!status || !routing) return null;

  const desiredLabel = `${routing.desired.provider === 'openai' ? 'OpenAI' : 'Ollama'}${
    routing.desired.model ? ` / ${routing.desired.model}` : ''
  }`;
  const appliedLabel = `${routing.applied.provider === 'openai' ? 'OpenAI' : (routing.applied.provider ?? 'OpenAI (default)')}${
    routing.applied.model ? ` / ${routing.applied.model}` : ''
  }`;

  return (
    <>
      <PageHeader
        title="Routing"
        subtitle="Desired route versus the route applied to the Codex configuration, with layered verification."
      />

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

      <div className="grid grid-3" style={{ marginTop: 14 }}>
        <Card title="Desired Route">
          <KeyValue label="Provider" value={routing.desired.provider === 'openai' ? 'OpenAI' : 'Ollama'} />
          <KeyValue
            label="Model"
            value={routing.desired.provider === 'openai' ? 'Codex Cloud' : (routing.desired.model ?? '—')}
            mono
          />
          <KeyValue label="Project" value={status.project?.name ?? '—'} />
        </Card>

        <Card title="Applied Route">
          <KeyValue label="Provider" value={routing.applied.provider === 'ollama' ? 'Ollama' : 'OpenAI (default)'} />
          <KeyValue label="Model" value={routing.applied.model ?? '—'} mono />
          <KeyValue label="Config" value={routing.configPath} mono />
        </Card>

        <Card title="Verification">
          <div className="stat-grid">
            <StatTile label="Route" value={ROUTE_LABEL[routing.status]} tone={tone(routing.status)} />
            <StatTile
              label="Runtime"
              value={verify?.layers?.runtimeAvailable ? 'Available' : 'Unavailable'}
              tone={verify?.layers?.runtimeAvailable ? 'ok' : 'error'}
            />
            <StatTile
              label="Live Traffic"
              value={verify?.layers?.trafficObserved ? 'Verified' : 'Not Observed'}
              tone={verify?.layers?.trafficObserved ? 'ok' : 'neutral'}
            />
          </div>
        </Card>
      </div>

      <Card title="Route Controls">
        <RoutingControls routing={routing} providers={status.providers} ollamaModels={ollama?.models ?? []} onRefresh={refresh} />
      </Card>

      <Card title="Verification Detail">
        <div className="grid grid-2">
          <div>
            <div className="live-row">
              <span className="live-row-label">Codex Config</span>
              <span className="live-row-value">
                <StatusDot tone={verify?.layers?.configSynced ? 'ok' : 'warn'} />
                {verify?.layers?.configSynced ? 'HCR Route Configured' : 'Not Pointing at HCR'}
              </span>
            </div>
            <div className="live-row">
              <span className="live-row-label">Runtime</span>
              <span className="live-row-value">
                <StatusDot tone={verify?.layers?.runtimeAvailable ? 'ok' : 'error'} />
                {routing.desired.provider === 'openai'
                  ? verify?.checks.codexInstalled
                    ? 'Codex Installed'
                    : 'Codex Missing'
                  : ollama?.online
                    ? 'Ollama Available'
                    : 'Ollama Offline'}
              </span>
            </div>
            <div className="live-row">
              <span className="live-row-label">Live Traffic</span>
              <span className="live-row-value">
                <StatusDot tone={verify?.layers?.trafficObserved ? 'ok' : 'neutral'} />
                {verify?.layers?.trafficObserved ? 'HCR ROUTE VERIFIED' : 'Not Observed'}
              </span>
            </div>
            <div className="live-row">
              <span className="live-row-label">VS Code Codex</span>
              <span className="live-row-value">
                <StatusDot tone={verify?.vscodeCodex.detected && verify?.vscodeCodex.confirmed ? 'ok' : 'warn'} />
                {verify
                  ? verify.vscodeCodex.detected
                    ? verify.vscodeCodex.confirmed
                      ? 'Uses HCR Route'
                      : 'Route Not Verified'
                    : 'Not Detected'
                  : '—'}
              </span>
            </div>
            {verify?.layers ? <p className="muted small" style={{ marginTop: 10 }}>{verify.layers.detail}</p> : null}
          </div>

          <div>
            <KeyValue label="Config readable" value={verify?.checks.configReadable ? 'Yes' : 'No'} />
            <KeyValue label="Valid TOML" value={verify?.checks.configValidToml ? 'Yes' : 'No'} />
            <KeyValue label="Provider matches" value={verify?.checks.providerMatches ? 'Yes' : 'No'} />
            <KeyValue label="Model matches" value={verify?.checks.modelMatches ? 'Yes' : 'No'} />
            <KeyValue label="Config path" value={routing.configPath} mono />
            {routing.backupPath ? <KeyValue label="Backup" value={routing.backupPath} mono /> : null}
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <Badge tone={routing.status === 'applied' ? 'ok' : 'warn'}>{ROUTE_LABEL[routing.status]}</Badge>
          <span className="muted small">
            Applying routing writes the Codex configuration only. It never launches Codex and never commits anything.
          </span>
        </div>
      </Card>
    </>
  );
}
