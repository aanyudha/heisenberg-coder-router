/**
 * Shared message + configuration types for the HCR Browser Companion.
 *
 * Security rules encoded here:
 *  - the companion only talks to the local HCR origin
 *  - the pairing secret is only ever sent to HCR, never to ChatGPT Web
 *  - no cookies, session tokens or credentials are read or stored
 */

/** Local HCR origin (localhost-only server). */
export const HCR_ORIGIN = 'http://127.0.0.1:7876';

/** Only allowed browser automation target in Phase 1. */
export const CHATGPT_ORIGIN = 'https://chatgpt.com';

/** Local pairing secret storage key (chrome.storage.local). */
export const STORAGE_TOKEN_KEY = 'hcrPairingToken';

/** Heartbeat interval (spec: 5-15 seconds). */
export const HEARTBEAT_INTERVAL_MS = 8_000;

/** Task pickup interval while idle (local polling, cheap). */
export const TASK_POLL_INTERVAL_MS = 2_500;

/** Overall limit for one ChatGPT Web interaction. */
export const TASK_TIMEOUT_MS = 210_000;

export const TOKEN_HEADER = 'x-hcr-companion-token';

export interface CompanionTask {
  id: string;
  handoffId: string;
  prompt: string;
  createdAt: string;
}

export type ChatgptState = 'ready' | 'auth_required' | 'tab_not_found' | 'unknown' | 'error';

export type SubmitStatus = 'OK' | 'AUTH_REQUIRED' | 'NO_TAB' | 'TIMEOUT' | 'ERROR';

export type Stage =
  | 'waiting_for_browser'
  | 'opening_chatgpt'
  | 'sending_prompt'
  | 'waiting_for_response'
  | 'receiving_response';

/** background -> content script */
export interface SubmitMessage {
  type: 'HCR_SUBMIT';
  taskId: string;
  prompt: string;
}

/** content script -> background */
export interface SubmitOutcome {
  status: SubmitStatus;
  responseText?: string;
  message?: string;
  chatgptState?: ChatgptState;
}

/** background -> popup */
export interface PopupStatus {
  paired: boolean;
  connected: boolean;
  lastHeartbeatAt: string | null;
  chatgptState: ChatgptState;
  busy: boolean;
}

/** background -> popup acknowledgement for an action request. */
export interface PopupActionResult {
  ok: boolean;
  error?: string;
}

/** background -> popup response for HCR_POPUP_TEST (real HCR round trip). */
export interface PopupTestResult extends PopupActionResult {
  connected?: boolean;
  paired?: boolean;
  lastSeenAt?: string | null;
  queuedTasks?: number;
}

export async function hcrFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return fetch(`${HCR_ORIGIN}${path}`, { ...init, headers });
}

export async function hcrFetchAuthed(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  headers.set(TOKEN_HEADER, token);
  return fetch(`${HCR_ORIGIN}${path}`, { ...init, headers });
}
