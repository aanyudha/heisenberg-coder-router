import { randomUUID } from 'crypto';
import type { GatewayRequestState, RecentRequest, RouteProvider, TelemetrySnapshot } from '@heisenberg/contracts';

/** Bounded in-memory history of observed gateway requests (metadata only). */
const RING_CAPACITY = 25;

export interface ObservedUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * Live state of a single request passing through the HCR Ollama gateway.
 * NEVER holds prompt or response content — metadata only (privacy rule).
 */
interface LiveRequest {
  requestId: string;
  provider: 'ollama';
  model: string | null;
  client: string | null;
  startedAtMs: number;
  firstResponseAtMs: number | null;
  completedAtMs: number | null;
  state: GatewayRequestState;
  responseStatus: number | null;
  streaming: boolean;
  usage: ObservedUsage | null;
  error: string | null;
}

/**
 * Gateway Engine - Live request tracking for the transparent Ollama gateway.
 *
 * The gateway plugin reports observable lifecycle events here; this engine
 * keeps (a) the single in-flight request for live UI state and (b) a bounded
 * ring buffer of recent requests for verification. Storage is in-memory only;
 * no prompt/response content is ever recorded.
 */
export class GatewayEngine {
  private live: LiveRequest | null = null;
  private ring: RecentRequest[] = [];
  private totalObserved = 0;
  private lastCompleted: RecentRequest | null = null;

  /** Called by the gateway when a request arrives (before upstream connect). */
  begin(info: { model: string | null; client: string | null; streaming: boolean }): string {
    const requestId = randomUUID();
    this.live = {
      requestId,
      provider: 'ollama',
      model: info.model,
      client: info.client,
      startedAtMs: Date.now(),
      firstResponseAtMs: null,
      completedAtMs: null,
      // A body with a JSON payload is being received; forwarding starts when
      // the upstream connection is established.
      state: 'receiving',
      responseStatus: null,
      streaming: info.streaming,
      usage: null,
      error: null,
    };
    return requestId;
  }

  /** Upstream connection established; request bytes are being sent. */
  forwarding(requestId: string): void {
    if (this.live?.requestId === requestId) this.live.state = 'forwarding';
  }

  /** First upstream response byte observed. */
  firstResponse(requestId: string, status: number): void {
    if (this.live?.requestId === requestId) {
      this.live.firstResponseAtMs = Date.now();
      this.live.responseStatus = status;
      this.live.state = this.live.streaming ? 'streaming' : 'forwarding';
    }
  }

  /** Reliable usage metadata observed in the response stream (if any). */
  usage(requestId: string, usage: ObservedUsage): void {
    if (this.live?.requestId === requestId) {
      this.live.usage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens ?? sumTokens(usage),
      };
    }
  }

  /** Request finished successfully. */
  complete(requestId: string): void {
    if (this.live?.requestId !== requestId) return;
    const req = this.live;
    req.state = 'completed';
    req.completedAtMs = Date.now();
    this.pushHistory(req);
    this.lastCompleted = toRecent(req);
    this.live = null;
  }

  /** Request failed (upstream error, abort, malformed proxying). */
  fail(requestId: string, error: string, status?: number): void {
    if (this.live?.requestId !== requestId) return;
    const req = this.live;
    req.state = 'error';
    req.error = error;
    if (status !== undefined) req.responseStatus = status;
    req.completedAtMs = Date.now();
    this.pushHistory(req);
    this.live = null;
  }

  /** Whether a request is currently passing through the gateway. */
  isActive(): boolean {
    return this.live !== null;
  }

  /** Number of inference requests observed since server start. */
  totalRequests(): number {
    return this.totalObserved;
  }

  /**
   * Truthful telemetry snapshot merged with gateway observations. Inference
   * metrics are null unless reliably observed in the response stream.
   */
  snapshot(
    desired: { provider: RouteProvider | null; model: string | null },
    uptimeSeconds: number
  ): TelemetrySnapshot {
    const live = this.live;
    const last = this.lastCompleted;
    const source = this.totalObserved > 0 ? 'hcr-gateway' : 'unavailable';

    // Live metrics prefer the in-flight request; otherwise the last completed.
    const metrics: { startedAtMs: number; firstResponseAtMs: number | null; completedAtMs: number | null; usage: ObservedUsage | null } | null =
      live ?? (last ? toMetricsView(last) : null);

    const latencyMs = metrics
      ? metrics.completedAtMs
        ? metrics.completedAtMs - metrics.startedAtMs
        : Date.now() - metrics.startedAtMs
      : null;
    const ttfb =
      metrics && metrics.firstResponseAtMs !== null
        ? metrics.firstResponseAtMs - metrics.startedAtMs
        : null;
    const tokensPerSecond =
      metrics?.usage?.outputTokens && latencyMs && latencyMs > 0
        ? round2((metrics.usage.outputTokens / latencyMs) * 1000)
        : null;

    return {
      source,
      active: live !== null,
      state: live?.state ?? 'idle',
      provider: live?.provider ?? (last ? 'ollama' : desired.provider),
      // Prefer the actually observed model from gateway traffic; desired model
      // is only the fallback when nothing has been observed yet.
      model: live?.model ?? last?.model ?? desired.model,
      client: live?.client ?? null,
      requestId: live?.requestId ?? last?.requestId ?? null,

      inputTokens: metrics?.usage?.inputTokens ?? null,
      outputTokens: metrics?.usage?.outputTokens ?? null,
      totalTokens: metrics?.usage?.totalTokens ?? null,

      contextUsed: null,
      contextLimit: null,

      requestCount: this.totalObserved > 0 ? this.totalObserved : null,

      latencyMs,
      timeToFirstByteMs: ttfb,
      averageLatencyMs: null,

      tokensPerSecond,

      uptimeSeconds,
      observedAt: new Date().toISOString(),
    };
  }

  /** Recent request metadata (bounded, newest last). */
  recent(): RecentRequest[] {
    return [...this.ring];
  }

  // ------------------------------------------------------------------ //

  private pushHistory(req: LiveRequest): void {
    this.totalObserved++;
    this.ring.push(toRecent(req));
    if (this.ring.length > RING_CAPACITY) {
      this.ring.splice(0, this.ring.length - RING_CAPACITY);
    }
  }
}

function toRecent(req: LiveRequest): RecentRequest {
  return {
    requestId: req.requestId,
    provider: req.provider,
    model: req.model,
    startedAt: new Date(req.startedAtMs).toISOString(),
    completedAt: req.completedAtMs ? new Date(req.completedAtMs).toISOString() : null,
    durationMs: req.completedAtMs ? req.completedAtMs - req.startedAtMs : null,
    state: req.state,
    responseStatus: req.responseStatus,
    streaming: req.streaming,
    inputTokens: req.usage?.inputTokens ?? null,
    outputTokens: req.usage?.outputTokens ?? null,
    totalTokens: req.usage?.totalTokens ?? null,
    error: req.error,
  };
}

function sumTokens(usage: ObservedUsage): number | undefined {
  if (typeof usage.totalTokens === 'number') return usage.totalTokens;
  if (typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number') {
    return usage.inputTokens + usage.outputTokens;
  }
  return undefined;
}

/** Uniform metric view over a completed (RecentRequest) record. */
function toMetricsView(req: RecentRequest): {
  startedAtMs: number;
  firstResponseAtMs: number | null;
  completedAtMs: number | null;
  usage: ObservedUsage | null;
} {
  const startedAtMs = Date.parse(req.startedAt);
  const completedAtMs = req.completedAt ? Date.parse(req.completedAt) : null;
  const usage: ObservedUsage | null =
    req.inputTokens !== null || req.outputTokens !== null || req.totalTokens !== null
      ? {
          inputTokens: req.inputTokens ?? undefined,
          outputTokens: req.outputTokens ?? undefined,
          totalTokens: req.totalTokens ?? undefined,
        }
      : null;
  return { startedAtMs, firstResponseAtMs: null, completedAtMs, usage };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
