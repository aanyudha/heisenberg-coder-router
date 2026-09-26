/** Error carrying the raw server detail alongside the action-specific message. */
export class ApiError extends Error {
  readonly detail: string;
  readonly status: number;

  constructor(message: string, detail: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.detail = detail;
    this.status = status;
  }
}

export interface RequestOptions {
  /**
   * Action label used to build a useful error message, e.g.
   * "Could not generate pairing code." The raw server error stays available
   * as `ApiError.detail` for diagnostics.
   */
  action?: string;
}

function failure(status: number, serverError: string | undefined, action?: string): ApiError {
  const detail = serverError ?? `Request failed (${status})`;
  const message = action ? `${action.replace(/[.\s]+$/, '')}. (${detail})` : detail;
  return new ApiError(message, detail, status);
}

/** Tiny API helper: JSON in/out, throws the server error message. */
export async function apiGet<T>(path: string, options?: RequestOptions): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw failure(response.status, body.error, options?.action);
  }
  return (await response.json()) as T;
}

export async function apiPost<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Fastify rejects `Content-Type: application/json` with an empty body, so
    // payload-less POSTs send a valid `{}` instead of nothing.
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw failure(response.status, payload.error, options?.action);
  }
  return (await response.json()) as T;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value).getTime();
  if (Number.isNaN(date)) return '—';
  const delta = Math.round((Date.now() - date) / 1000);
  if (delta < 5) return 'just now';
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export function shortId(value: string, length = 8): string {
  return value.length <= length ? value : value.slice(0, length);
}
