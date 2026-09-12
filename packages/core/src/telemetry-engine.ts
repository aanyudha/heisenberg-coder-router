import type { RouteProvider, TelemetrySnapshot } from '@heisenberg/contracts';
import type { GatewayEngine } from './gateway-engine.js';

/**
 * Telemetry Engine - Truthful observability for HCR.
 *
 * Two sources, strictly truth-separated:
 *   1. This HCR process (uptime) — always real.
 *   2. The transparent Ollama gateway (GatewayEngine) — real only when
 *      inference traffic has actually been observed in the data path.
 *
 * Inference metrics (tokens/latency/throughput) are null unless the gateway
 * reliably observed them. Unknown is NOT the same as zero.
 */
export class TelemetryEngine {
  /** HCR server start time. */
  private readonly startedAt = Date.now();
  private getDesiredProviderModel: () => { provider: RouteProvider | null; model: string | null };
  private gateway: GatewayEngine | null = null;

  constructor(getDesiredProviderModel: () => { provider: RouteProvider | null; model: string | null }) {
    this.getDesiredProviderModel = getDesiredProviderModel;
  }

  /** Attach the gateway once it exists (context wiring order). */
  setGateway(gateway: GatewayEngine): void {
    this.gateway = gateway;
  }

  /**
   * Build the current telemetry snapshot. Unknown metrics stay null.
   */
  getSnapshot(): TelemetrySnapshot {
    const uptimeSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
    if (this.gateway) {
      return this.gateway.snapshot(this.getDesiredProviderModel(), uptimeSeconds);
    }
    const { provider, model } = this.getDesiredProviderModel();
    return {
      source: 'unavailable',
      active: false,
      state: 'idle',
      provider,
      model,
      client: null,
      requestId: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      contextUsed: null,
      contextLimit: null,
      requestCount: null,
      latencyMs: null,
      timeToFirstByteMs: null,
      averageLatencyMs: null,
      tokensPerSecond: null,
      uptimeSeconds,
      observedAt: new Date().toISOString(),
    };
  }

  /**
   * Why inference telemetry may be unavailable — surfaced in the UI help text.
   */
  static readonly unavailableReason =
    'HCR observes token usage, latency, and throughput only when inference traffic passes through the HCR Ollama gateway. OpenAI traffic is not monitored in this phase.';
}
