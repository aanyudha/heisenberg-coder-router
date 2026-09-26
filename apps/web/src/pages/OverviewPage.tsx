import { Card, PageHeader, Badge, StatTile, EmptyState, KeyValue, StatusDot } from '../components/ui';
import { useHcr } from '../hcr-context';
import { formatTime, relativeTime } from '../api';
import type { PageId } from '../nav';

const ROUTE_LABEL: Record<string, string> = {
  applied: 'Applied',
  drift: 'Drift',
  not_configured: 'Not Configured',
  error: 'Config Error',
};

function routeTone(status: string): 'ok' | 'warn' | 'error' {
  if (status === 'applied') return 'ok';
  if (status === 'not_configured') return 'warn';
  return 'error';
}

export function OverviewPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const { status, telemetry, live, verify, companion, handoffs, recent, online } = useHcr();

  const codex = status?.codex;
  const ollama = status?.ollama;
  const routing = status?.routing;

  const browserConnected = companion?.connected ?? false;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="System health, the active route, live activity and the most recent Web Handoffs."
        actions={
          <button className="btn btn-sm" type="button" onClick={() => onNavigate('web-handoff')}>
            New Web Handoff
          </button>
        }
      />

      <div className="stack">
        <Card title="System Status">
          <div className="stat-grid">
            <StatTile
              label="HCR"
              value={online ? 'Online' : 'Offline'}
              tone={online ? 'ok' : 'error'}
              hint={status ? `${status.server.host}:${status.server.port}` : 'connecting'}
            />
            <StatTile
              label="Codex CLI"
              value={codex?.installed ? 'Installed' : 'Not Installed'}
              tone={codex?.installed ? 'ok' : 'error'}
              hint={codex?.version ?? codex?.path}
            />
            <StatTile
              label="Ollama"
              value={ollama?.online ? 'Online' : 'Offline'}
              tone={ollama?.online ? 'ok' : 'neutral'}
              hint={ollama?.online ? `${ollama.models.length} model(s) · ${ollama.endpoint}` : ollama?.endpoint}
            />
            <StatTile
              label="Browser Companion"
              value={browserConnected ? 'Connected' : 'Not Connected'}
              tone={browserConnected ? 'ok' : 'neutral'}
              hint={companion?.paired ? 'paired · chatgpt-web' : 'not paired'}
            />
          </div>
        </Card>

        <div className="grid grid-2">
          <Card
            title="Active Route"
            actions={
              <button className="btn btn-sm" type="button" onClick={() => onNavigate('routing')}>
                Open Routing
              </button>
            }
          >
            <div className="stack">
              <div className="stat-grid">
                <StatTile
                  label="Provider"
                  value={routing ? (routing.desired.provider === 'openai' ? 'OpenAI' : 'Ollama') : '—'}
                  tone={routing?.status === 'applied' ? 'ok' : 'warn'}
                />
                <StatTile
                  label="Model"
                  value={
                    routing
                      ? routing.desired.provider === 'openai'
                        ? 'Codex Cloud'
                        : (routing.desired.model ?? '—')
                      : '—'
                  }
                  mono
                />
                <StatTile
                  label="Status"
                  value={routing ? ROUTE_LABEL[routing.status] : '—'}
                  tone={routing ? routeTone(routing.status) : 'neutral'}
                />
              </div>

              {verify?.layers ? (
                <div className="live-grid">
                  <div className="live-row">
                    <span className="live-row-label">Config</span>
                    <span className="live-row-value">
                      <StatusDot tone={verify.layers.configSynced ? 'ok' : 'warn'} />
                      {verify.layers.configSynced ? 'HCR Route Configured' : 'Not Pointing at HCR'}
                    </span>
                  </div>
                  <div className="live-row">
                    <span className="live-row-label">Runtime</span>
                    <span className="live-row-value">
                      <StatusDot tone={verify.layers.runtimeAvailable ? 'ok' : 'error'} />
                      {verify.layers.runtimeAvailable ? 'Runtime Available' : 'Runtime Unavailable'}
                    </span>
                  </div>
                  <div className="live-row">
                    <span className="live-row-label">Traffic</span>
                    <span className="live-row-value">
                      <StatusDot tone={verify.layers.trafficObserved ? 'ok' : 'neutral'} />
                      {verify.layers.trafficObserved ? 'HCR Route Verified' : 'Not Observed'}
                    </span>
                  </div>
                </div>
              ) : null}
              {routing?.detail ? <p className="muted small">{routing.detail}</p> : null}
            </div>
          </Card>

          <Card
            title="Live Activity"
            actions={
              <button className="btn btn-sm" type="button" onClick={() => onNavigate('live-traffic')}>
                Live Traffic
              </button>
            }
          >
            <div className="stat-grid">
              <StatTile
                label="State"
                value={live?.active ? 'Generating' : 'Idle'}
                tone={live?.active ? 'ok' : 'neutral'}
                hint={live ? `gateway · ${live.state}` : 'no gateway state'}
              />
              <StatTile
                label="Requests (session)"
                value={typeof live?.requestCount === 'number' ? String(live.requestCount) : '—'}
                hint="Observed through the HCR gateway"
              />
              <StatTile
                label="Last latency"
                value={typeof live?.latencyMs === 'number' ? `${live.latencyMs} ms` : '—'}
                hint={
                  typeof live?.timeToFirstByteMs === 'number' ? `TTFB ${live.timeToFirstByteMs} ms` : 'TTFB not observed'
                }
              />
              <StatTile
                label="Tokens"
                value={typeof live?.totalTokens === 'number' ? live.totalTokens.toLocaleString('en-US') : '—'}
                hint={typeof live?.tokensPerSecond === 'number' ? `${live.tokensPerSecond} tok/s` : 'throughput not observed'}
              />
              <StatTile
                label="Last request"
                value={recent.length > 0 ? relativeTime(recent[recent.length - 1].startedAt) : '—'}
                hint={recent.length > 0 ? formatTime(recent[recent.length - 1].startedAt) : 'no gateway traffic yet'}
              />
              <StatTile
                label="HCR uptime"
                value={
                  typeof telemetry?.uptimeSeconds === 'number'
                    ? telemetry.uptimeSeconds >= 3600
                      ? `${Math.floor(telemetry.uptimeSeconds / 3600)}h ${Math.floor((telemetry.uptimeSeconds % 3600) / 60)}m`
                      : `${Math.floor(telemetry.uptimeSeconds / 60)}m ${telemetry.uptimeSeconds % 60}s`
                    : '—'
                }
                tone="info"
              />
            </div>
          </Card>
        </div>

        <div className="grid grid-2">
          <Card
            title="Recent Handoffs"
            actions={
              <button className="btn btn-sm" type="button" onClick={() => onNavigate('activity')}>
                View all
              </button>
            }
            bodyClassName="is-flush"
          >
            {handoffs.length === 0 ? (
              <EmptyState
                title="No Web Handoffs yet"
                hint="Send a coding task through ChatGPT Web from the Web Handoff page."
              />
            ) : (
              <ul className="handoff-list">
                {handoffs.slice(0, 6).map((handoff) => (
                  <li key={handoff.id} onClick={() => onNavigate('web-handoff')}>
                    <span className="handoff-title" title={handoff.taskTitle}>
                      {handoff.taskTitle}
                    </span>
                    <Badge
                      tone={
                        handoff.status === 'ready_for_review' || handoff.status === 'applied'
                          ? 'ok'
                          : handoff.status === 'invalid_patch_response' || handoff.status === 'error'
                            ? 'error'
                            : handoff.status === 'rejected' || handoff.status === 'reverted'
                              ? 'neutral'
                              : 'info'
                      }
                    >
                      {handoff.status.replace(/_/g, ' ')}
                    </Badge>
                    <span className="handoff-time">{relativeTime(handoff.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="Recent Traffic"
            actions={
              <button className="btn btn-sm" type="button" onClick={() => onNavigate('live-traffic')}>
                Live Traffic
              </button>
            }
            bodyClassName="is-flush"
          >
            {recent.length === 0 ? (
              <EmptyState
                title="No gateway traffic observed"
                hint="Requests routed through the HCR Ollama gateway appear here (metadata only)."
              />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>State</th>
                      <th>Duration</th>
                      <th>Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent
                      .slice(-6)
                      .reverse()
                      .map((entry) => (
                        <tr key={entry.requestId}>
                          <td className="cell-strong mono">{entry.model ?? '—'}</td>
                          <td>
                            <Badge tone={entry.state === 'completed' ? 'ok' : entry.state === 'error' ? 'error' : 'info'}>
                              {entry.state}
                            </Badge>
                          </td>
                          <td className="num">{entry.durationMs !== null ? `${entry.durationMs} ms` : '—'}</td>
                          <td className="num">{entry.totalTokens !== null ? entry.totalTokens : '—'}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <Card title="Project & Verification">
          <div className="grid grid-2">
            <div>
              <KeyValue label="Project" value={status?.project?.name ?? '—'} />
              <KeyValue label="Path" value={status?.project?.path ?? '—'} mono />
              <KeyValue label="Config" value={routing?.configPath ?? '—'} mono />
            </div>
            <div>
              <KeyValue
                label="VS Code Codex"
                value={
                  verify
                    ? verify.vscodeCodex.detected
                      ? verify.vscodeCodex.confirmed
                        ? 'Uses HCR Route'
                        : 'Route Not Verified'
                      : 'Not Detected'
                    : '—'
                }
              />
              <KeyValue label="Companion" value={companion ? (companion.connected ? 'Connected' : 'Not Connected') : '—'} />
              <KeyValue
                label="ChatGPT Web"
                value={companion ? companion.chatgpt.state.replace(/_/g, ' ') : 'unknown'}
              />
            </div>
          </div>
        </Card>

        <footer className="footer">
          Heisenberg Coder Router · local control plane at {status ? `${status.server.host}:${status.server.port}` : '127.0.0.1:7876'}
        </footer>
      </div>
    </>
  );
}
