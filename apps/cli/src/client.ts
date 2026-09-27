import type { HcoderStatusResponse, HcoderTurnRequest, HcoderTurnResponse } from '@heisenberg/contracts';
import { HCR_DEFAULT_ORIGIN } from '@heisenberg/shared';

/** Deterministic client-side failure (never a stack trace, always a code). */
export class HcrError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 0
  ) {
    super(message);
    this.name = 'HcrError';
  }
}

/** Fallback code extraction from messages shaped like "CODE: detail". */
const CODE_FROM_MESSAGE = /^([A-Z][A-Z0-9_]{2,}):\s/;

function fallbackCode(status: number): string {
  if (status === 404 || status === 0) return 'HCR_UNAVAILABLE';
  if (status === 401 || status === 403) return 'AUTH_REQUIRED';
  if (status >= 500) return 'ROUTE_UNAVAILABLE';
  return 'HCR_UNAVAILABLE';
}

/**
 * HTTP client for HCR's local control plane (fixed origin, port 7876 by
 * default). HCoder never talks to a provider directly: every agent turn,
 * route decision and status check goes through HCR.
 */
export class HcrClient {
  readonly origin: string;

  constructor(origin?: string, private readonly timeoutMs: number = 300_000) {
    const raw = (origin ?? process.env.HCR_ORIGIN ?? '').trim().replace(/\/+$/, '');
    this.origin = raw.length > 0 ? raw : HCR_DEFAULT_ORIGIN;
  }

  async status(projectRoot?: string): Promise<HcoderStatusResponse> {
    const query = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : '';
    return await this.request<HcoderStatusResponse>('GET', `/api/hcoder/status${query}`);
  }

  async turn(body: HcoderTurnRequest): Promise<HcoderTurnResponse> {
    return await this.request<HcoderTurnResponse>('POST', '/api/hcoder/turn', body);
  }

  async setRoute(route: string): Promise<{ route: string; routeLabel: string }> {
    return await this.request<{ route: string; routeLabel: string }>('POST', '/api/hcoder/route', { route });
  }

  async download(): Promise<{ url: string; filename: string; available: boolean; bytes: number }> {
    return await this.request('GET', '/api/hcoder/download');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.origin}${path}`, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new HcrError(
        `HCR_UNAVAILABLE: HCR is not reachable at ${this.origin}. Start HCR (npm start) and retry.`,
        'HCR_UNAVAILABLE'
      );
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const record = (payload ?? {}) as { error?: unknown; code?: unknown };
      const message =
        typeof record.error === 'string' && record.error.length > 0
          ? record.error
          : `HCR request failed (${response.status} ${response.statusText}).`;
      let code = typeof record.code === 'string' && record.code.length > 0 ? record.code : '';
      if (!code) {
        const match = message.match(CODE_FROM_MESSAGE);
        code = match?.[1] ?? fallbackCode(response.status);
      }
      throw new HcrError(message, code, response.status);
    }

    if (payload === null) {
      throw new HcrError(
        'HCR_UNAVAILABLE: HCR returned a non-JSON response. Is this really an HCR instance?',
        'HCR_UNAVAILABLE',
        response.status
      );
    }
    return payload as T;
  }
}
