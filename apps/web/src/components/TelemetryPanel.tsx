import { TelemetryTile } from './TelemetryTile';
import { TelemetryEngineUnavailableReason } from '../telemetryReason';

export interface TelemetryLike {
  source: 'hcr' | 'ollama' | 'codex' | 'provider' | 'unavailable';
  provider: string | null;
  model: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  contextUsed?: number | null;
  contextLimit?: number | null;
  requestCount?: number | null;
  latencyMs?: number | null;
  averageLatencyMs?: number | null;
  tokensPerSecond?: number | null;
  uptimeSeconds?: number | null;
  observedAt?: string;
}

const SOURCE_LABEL: Record<TelemetryLike['source'], string> = {
  hcr: 'HCR observed',
  ollama: 'Ollama runtime',
  codex: 'Codex telemetry',
  provider: 'Provider metadata',
  unavailable: 'Not observed',
};

function fmt(n: number | null | undefined): string | null {
  return typeof n === 'number' ? n.toLocaleString('en-US') : null;
}

/**
 * Telemetry panel. Truthfulness rule: metrics without a reliable source render
 * as '--' (unknown is not zero). Only uptime is real in Phase 1.
 */
export function TelemetryPanel({ telemetry }: { telemetry: TelemetryLike | null }) {
  const t = telemetry;
  return (
    <section className="panel">
      <div className="panel-title">TELEMETRY</div>
      <div className="telemetry-grid">
        <TelemetryTile label="input tokens" value={fmt(t?.inputTokens)} unit="input tokens" help={TelemetryEngineUnavailableReason} />
        <TelemetryTile label="output tokens" value={fmt(t?.outputTokens)} unit="output tokens" help={TelemetryEngineUnavailableReason} />
        <TelemetryTile label="total tokens" value={fmt(t?.totalTokens)} unit="total tokens" help={TelemetryEngineUnavailableReason} />
        <TelemetryTile
          label="context"
          value={
            typeof t?.contextUsed === 'number' && typeof t?.contextLimit === 'number'
              ? `${t.contextUsed.toLocaleString('en-US')} / ${t.contextLimit.toLocaleString('en-US')}`
              : null
          }
          unit="context"
          help={TelemetryEngineUnavailableReason}
        />
        <TelemetryTile label="requests" value={fmt(t?.requestCount)} unit="requests" help={TelemetryEngineUnavailableReason} />
        <TelemetryTile
          label="latency"
          value={typeof t?.latencyMs === 'number' ? `${t.latencyMs}` : null}
          unit="ms last"
          help={TelemetryEngineUnavailableReason}
        />
        <TelemetryTile
          label="avg latency"
          value={typeof t?.averageLatencyMs === 'number' ? `${t.averageLatencyMs}` : null}
          unit="ms avg"
          help={TelemetryEngineUnavailableReason}
        />
        <TelemetryTile
          label="throughput"
          value={typeof t?.tokensPerSecond === 'number' ? `${t.tokensPerSecond}` : null}
          unit="tok/s"
          help={TelemetryEngineUnavailableReason}
        />
        <TelemetryTile
          label="uptime"
          value={typeof t?.uptimeSeconds === 'number' ? formatUptime(t.uptimeSeconds) : null}
          unit="HCR uptime"
        />
        <TelemetryTile
          label="provider/model"
          value={t?.provider ? `${t.provider}${t.model ? ` · ${t.model}` : ''}` : null}
          unit="route"
        />
      </div>
      <p className="telemetry-source">
        Telemetry source: <strong>{SOURCE_LABEL[t?.source ?? 'unavailable']}</strong>
        {t?.source === 'unavailable' && (
          <span className="muted small" title={TelemetryEngineUnavailableReason}>
            {' '}
            — {TelemetryEngineUnavailableReason}
          </span>
        )}
      </p>
    </section>
  );
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}
