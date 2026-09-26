import { Card, PageHeader, Badge, StatTile, EmptyState, KeyValue, StatusDot } from '../components/ui';
import { Gauge } from '../components/Gauge';
import { useHcr } from '../hcr-context';
import { formatTime, relativeTime, shortId } from '../api';

export function LiveTrafficPage() {
  const { live, recent, telemetry, verify } = useHcr();

  const latency = typeof live?.latencyMs === 'number' ? live.latencyMs : null;
  const fill = latency === null ? null : Math.min(1, latency / 5000);

  return (
    <>
      <PageHeader
        title="Live Traffic"
        subtitle="Requests observed through the HCR gateway. Metadata only — prompts and completions are never stored."
      />

      <div className="grid grid-sidebar" style={{ marginTop: 14 }}>
        <div className="stack">
          <Card title="Live Readout">
            <div className="gauge-bay">
              <Gauge
                label="LATENCY"
                value={latency === null ? '—' : `${latency}`}
                sub={latency === null ? 'NOT OBSERVED' : 'MILLISECONDS'}
                state={live?.active ? '● GENERATING' : recent.length > 0 ? '○ IDLE' : '○ NO TRAFFIC'}
                status={live?.active ? 'ok' : latency === null ? 'neutral' : latency < 1000 ? 'ok' : 'warn'}
                fill={fill}
                size={240}
              />
              <Gauge
                label="ROUTE"
                value={verify?.layers?.trafficObserved ? 'VERIFIED' : 'UNVERIFIED'}
                sub="HCR GATEWAY"
                state={verify?.layers?.trafficObserved ? 'TRAFFIC OBSERVED' : 'NOT OBSERVED'}
                status={verify?.layers?.trafficObserved ? 'ok' : 'neutral'}
                fill={verify?.layers?.trafficObserved ? 1 : null}
                size={200}
              />
            </div>
          </Card>

          <div className="stat-grid">
            <StatTile
              label="State"
              value={live?.active ? 'Generating' : 'Idle'}
              tone={live?.active ? 'ok' : 'neutral'}
              hint={live ? live.state : 'no gateway state'}
            />
            <StatTile
              label="Requests"
              value={typeof live?.requestCount === 'number' ? String(live.requestCount) : '—'}
              hint="observed this session"
            />
            <StatTile
              label="TTFB"
              value={typeof live?.timeToFirstByteMs === 'number' ? `${live.timeToFirstByteMs} ms` : '—'}
              hint="time to first byte"
            />
            <StatTile
              label="Throughput"
              value={typeof live?.tokensPerSecond === 'number' ? `${live.tokensPerSecond}` : '—'}
              hint={typeof live?.tokensPerSecond === 'number' ? 'tokens/second' : 'not observed'}
            />
            <StatTile
              label="Model"
              value={live?.model ?? '—'}
              mono
              hint={live?.provider ?? 'provider unknown'}
            />
            <StatTile
              label="Last seen"
              value={recent.length > 0 ? relativeTime(recent[recent.length - 1].startedAt) : '—'}
              hint={recent.length > 0 ? formatTime(recent[recent.length - 1].startedAt) : 'no traffic yet'}
            />
          </div>

          <Card title="Current Request" bodyClassName="is-flush">
            {!live || (!live.active && !live.requestId) ? (
              <EmptyState
                title="No in-flight request"
                hint="Route a request through the HCR gateway to see it here."
              />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    <tr>
                      <td className="cell-strong">Request ID</td>
                      <td className="mono">{live.requestId ? shortId(live.requestId) : '—'}</td>
                    </tr>
                    <tr>
                      <td className="cell-strong">State</td>
                      <td>
                        <Badge tone={live.active ? 'ok' : 'info'}>{live.state}</Badge>
                      </td>
                    </tr>
                    <tr>
                      <td className="cell-strong">Provider / Model</td>
                      <td className="mono">
                        {live.provider ?? '—'} / {live.model ?? '—'}
                      </td>
                    </tr>
                    <tr>
                      <td className="cell-strong">Client</td>
                      <td>{live.client ?? 'Codex / Unknown Client'}</td>
                    </tr>
                    <tr>
                      <td className="cell-strong">Latency</td>
                      <td>{live.latencyMs !== null ? `${live.latencyMs} ms` : '—'}</td>
                    </tr>
                    <tr>
                      <td className="cell-strong">Tokens</td>
                      <td>
                        {live.totalTokens !== null
                          ? `${live.totalTokens} total (${live.inputTokens ?? '?'} in / ${live.outputTokens ?? '?'} out)`
                          : '—'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="Recent Requests" bodyClassName="is-flush">
            {recent.length === 0 ? (
              <EmptyState title="Nothing observed yet" hint="The gateway log fills as traffic flows." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Model</th>
                      <th>State</th>
                      <th>Duration</th>
                      <th>Tokens</th>
                      <th>HTTP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...recent]
                      .reverse()
                      .map((entry) => (
                        <tr key={entry.requestId}>
                          <td className="mono">{shortId(entry.requestId)}</td>
                          <td className="mono">{entry.model ?? '—'}</td>
                          <td>
                            <Badge
                              tone={entry.state === 'completed' ? 'ok' : entry.state === 'error' ? 'error' : 'info'}
                            >
                              {entry.state}
                            </Badge>
                            {entry.error ? <div className="muted small">{entry.error}</div> : null}
                          </td>
                          <td className="num">{entry.durationMs !== null ? `${entry.durationMs} ms` : '—'}</td>
                          <td className="num">{entry.totalTokens !== null ? entry.totalTokens : '—'}</td>
                          <td className="num">{entry.responseStatus ?? '—'}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Observation Notes">
            <div className="live-grid">
              <div className="live-row">
                <span className="live-row-label">Config layer</span>
                <span className="live-row-value">
                  <StatusDot tone={verify?.layers?.configSynced ? 'ok' : 'warn'} />
                  {verify?.layers?.configSynced ? 'Pointing at HCR' : 'Not pointing at HCR'}
                </span>
              </div>
              <div className="live-row">
                <span className="live-row-label">Runtime layer</span>
                <span className="live-row-value">
                  <StatusDot tone={verify?.layers?.runtimeAvailable ? 'ok' : 'error'} />
                  {verify?.layers?.runtimeAvailable ? 'Runtime available' : 'Runtime unavailable'}
                </span>
              </div>
              <div className="live-row">
                <span className="live-row-label">Traffic layer</span>
                <span className="live-row-value">
                  <StatusDot tone={verify?.layers?.trafficObserved ? 'ok' : 'neutral'} />
                  {verify?.layers?.trafficObserved ? 'HCR route verified' : 'Not observed'}
                </span>
              </div>
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              {verify?.layers?.detail ?? 'Verification pending.'}
            </p>
            <KeyValue
              label="Telemetry source"
              value={telemetry ? telemetry.source : 'unavailable'}
              mono
            />
          </Card>
        </div>
      </div>
    </>
  );
}
