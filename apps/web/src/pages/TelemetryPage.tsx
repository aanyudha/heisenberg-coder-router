import { Card, PageHeader, StatTile, KeyValue } from '../components/ui';
import { Gauge } from '../components/Gauge';
import { TelemetryPanel } from '../components/TelemetryPanel';
import { useHcr } from '../hcr-context';
import { formatTime } from '../api';

export function TelemetryPage() {
  const { telemetry, live, recent } = useHcr();

  const uptime = typeof telemetry?.uptimeSeconds === 'number' ? telemetry.uptimeSeconds : null;
  const uptimeText =
    uptime === null
      ? '—'
      : uptime >= 3600
        ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
        : `${Math.floor(uptime / 60)}m ${uptime % 60}s`;
  const uptimeFill = uptime === null ? null : Math.min(1, (uptime % 86400) / 86400);

  const latency = typeof live?.latencyMs === 'number' ? live.latencyMs : null;

  return (
    <>
      <PageHeader
        title="Telemetry"
        subtitle="Truthful metrics only: unknown values render as unknown, never as zero. Nothing is inferred."
      />

      <div className="grid grid-sidebar" style={{ marginTop: 14 }}>
        <div className="stack">
          <TelemetryPanel telemetry={telemetry} />

          <Card title="Gateway Totals">
            <div className="stat-grid">
              <StatTile
                label="Requests observed"
                value={typeof live?.requestCount === 'number' ? live.requestCount.toLocaleString('en-US') : '—'}
                tone={typeof live?.requestCount === 'number' && live.requestCount > 0 ? 'ok' : 'neutral'}
                hint="through the HCR gateway this session"
              />
              <StatTile
                label="In log"
                value={String(recent.length)}
                hint="bounded in-memory ring buffer"
              />
              <StatTile
                label="Last latency"
                value={latency === null ? '—' : `${latency} ms`}
                tone={latency === null ? 'neutral' : latency < 1000 ? 'ok' : 'warn'}
                hint={typeof live?.timeToFirstByteMs === 'number' ? `TTFB ${live.timeToFirstByteMs} ms` : 'TTFB not observed'}
              />
              <StatTile
                label="Total tokens"
                value={typeof live?.totalTokens === 'number' ? live.totalTokens.toLocaleString('en-US') : '—'}
                hint="observed this session"
              />
              <StatTile
                label="Throughput"
                value={typeof live?.tokensPerSecond === 'number' ? `${live.tokensPerSecond} tok/s` : '—'}
                hint="last observed"
              />
              <StatTile
                label="Source"
                value={telemetry?.source ?? 'unavailable'}
                tone={telemetry?.source === 'unavailable' ? 'warn' : 'info'}
                hint="where the metrics came from"
              />
            </div>
          </Card>
        </div>

        <div className="stack">
          <Card title="Uptime">
            <div className="gauge-bay" style={{ justifyContent: 'center' }}>
              <Gauge
                label="HCR UPTIME"
                value={uptimeText}
                sub="THIS PROCESS"
                state={uptime === null ? 'NOT OBSERVED' : 'RUNNING'}
                status={uptime === null ? 'neutral' : 'ok'}
                fill={uptimeFill}
                size={240}
              />
            </div>
            <KeyValue label="Observed at" value={telemetry?.observedAt ? formatTime(telemetry.observedAt) : '—'} />
          </Card>

          <Card title="Latency">
            <div className="gauge-bay" style={{ justifyContent: 'center' }}>
              <Gauge
                label="LAST LATENCY"
                value={latency === null ? '—' : `${latency}`}
                sub={latency === null ? 'NOT OBSERVED' : 'MILLISECONDS'}
                state={live?.active ? '● GENERATING' : '○ IDLE'}
                status={latency === null ? 'neutral' : latency < 1000 ? 'ok' : latency < 3000 ? 'warn' : 'error'}
                fill={latency === null ? null : Math.min(1, latency / 5000)}
                size={220}
              />
            </div>
            <KeyValue
              label="Average"
              value={typeof telemetry?.averageLatencyMs === 'number' ? `${telemetry.averageLatencyMs} ms` : 'unknown'}
            />
          </Card>

          <Card title="Truthfulness Rules">
            <ul className="steps-list">
              <li>No sample traffic is ever generated to fill a chart.</li>
              <li>Metrics without a reliable source render as <strong>unknown</strong>, not zero.</li>
              <li>Token counts come from observed gateway responses only.</li>
              <li>Request bodies and completions are never persisted.</li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
