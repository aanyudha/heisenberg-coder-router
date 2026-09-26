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

/** A ChatGPT Project discovered from the signed-in ChatGPT Web UI. */
export interface ChatGptProject {
  id: string;
  name: string;
  url: string;
}

/** A chat/session inside exactly one ChatGPT Project. */
export interface ChatGptChat {
  id: string;
  title: string;
  url: string;
}

/** Delivery mode inside the selected ChatGPT Project. */
export type ChatgptSendMode = 'continue' | 'create';

/** Where a Web Handoff prompt must be delivered (identity = URL/id). */
export interface TaskDestination {
  chatgptProjectId: string;
  chatgptProjectName: string;
  chatgptProjectUrl: string;
  chatId: string | null;
  chatTitle: string | null;
  chatUrl: string | null;
  chatMode: ChatgptSendMode;
  newChatTitle?: string | null;
}

/** Session actually used/created, reported back to HCR with the response. */
export interface ChatgptSessionRef {
  chatgptProjectId: string | null;
  chatgptProjectName: string | null;
  chatgptProjectUrl: string | null;
  chatId: string;
  chatTitle: string;
  chatUrl: string;
  chatMode: ChatgptSendMode;
}

export interface CompanionTask {
  id: string;
  handoffId: string;
  prompt: string;
  createdAt: string;
  kind?: 'handoff' | 'discover_projects' | 'discover_chats';
  destination?: TaskDestination | null;
  /** Project to list sessions from (discover_chats). */
  projectId?: string;
  projectUrl?: string;
}

export type ChatgptState = 'ready' | 'auth_required' | 'tab_not_found' | 'unknown' | 'error';

/**
 * Task outcomes. The targeting codes are deterministic - the companion never
 * falls back to a generic/new chat, another project or another session.
 */
export type SubmitStatus =
  | 'OK'
  | 'AUTH_REQUIRED'
  | 'NO_TAB'
  | 'TIMEOUT'
  | 'ERROR'
  | 'PROJECT_NOT_FOUND'
  | 'CHAT_NOT_FOUND'
  | 'UI_UNSUPPORTED'
  /** Internal: the tab must be navigated to `message` before retrying. */
  | 'NAVIGATE';

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
  destination?: TaskDestination | null;
}

/** background -> content script: discover ChatGPT Projects (metadata only). */
export interface DiscoverProjectsMessage {
  type: 'HCR_DISCOVER_PROJECTS';
  taskId: string;
}

/** background -> content script: discover sessions of exactly one Project. */
export interface DiscoverChatsMessage {
  type: 'HCR_DISCOVER_CHATS';
  taskId: string;
  projectId: string;
  projectUrl: string;
}

/** popup -> background -> content script: where are we right now? */
export interface ContextMessage {
  type: 'HCR_GET_CONTEXT';
}

export interface CurrentChatgptContext {
  project: ChatGptProject | null;
  chat: ChatGptChat | null;
  uiSupported: boolean;
  authRequired: boolean;
}

/** content script -> background */
export interface SubmitOutcome {
  status: SubmitStatus;
  responseText?: string;
  message?: string;
  chatgptState?: ChatgptState;
  session?: ChatgptSessionRef;
  projects?: ChatGptProject[];
  chats?: ChatGptChat[];
}

/** background -> popup */
export interface PopupStatus {
  paired: boolean;
  connected: boolean;
  lastHeartbeatAt: string | null;
  chatgptState: ChatgptState;
  busy: boolean;
  /** Project the ChatGPT tab is currently inside (null = Unknown). */
  currentProject: string | null;
  /** Session the ChatGPT tab is currently inside (null = Unknown). */
  currentSession: string | null;
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
