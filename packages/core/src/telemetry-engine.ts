import type { RouteProvider, TelemetrySnapshot } from '@heisenberg/contracts';

/**
 * Telemetry Engine - Truthful observability for HCR.
 *
 * Phase 1 HCR is a routing control plane: it writes the Codex route and is
 * NOT in the inference data path. Therefore token usage, context usage,
 * request counts, latency, and throughput have no reliable source and are
 * reported as null/unavailable — never estimated, never faked to zero.
 *
 * Real metrics currently available:
 *   - HCR server process uptime (this process)
 *   - current provider/model of the desired route (context, not usage)
 *
 * Future reliable sources (NOT implemented in this phase): provider response
 * usage metadata via an HCR proxy/data-path component, a supported Codex
 * telemetry API, or Ollama runtime metrics.
 */
export class TelemetryEngine {
  /** HCR server start time. */
  private readonly startedAt = Date.now();
  private getDesiredProviderModel: () => { provider: RouteProvider | null; model: string | null };

  constructor(getDesiredProviderModel: () => { provider: RouteProvider | null; model: string | null }) {
    this.getDesiredProviderModel = getDesiredProviderModel;
  }

  /**
   * Build the current telemetry snapshot. Unknown metrics stay null.
   */
  getSnapshot(): TelemetrySnapshot {
    const { provider, model } = this.getDesiredProviderModel();

    return {
      source: 'unavailable',
      provider,
      model,

      inputTokens: null,
      outputTokens: null,
      totalTokens: null,

      contextUsed: null,
      contextLimit: null,

      requestCount: null,

      latencyMs: null,
      averageLatencyMs: null,

      tokensPerSecond: null,

      // Real, observed metric: this HCR process's uptime.
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),

      observedAt: new Date().toISOString(),
    };
  }

  /**
   * Why inference telemetry is unavailable — surfaced in the UI help text.
   */
  static readonly unavailableReason =
    'HCR currently manages routing but is not in the inference data path, so token usage, latency, and throughput are unavailable for this session.';
}
