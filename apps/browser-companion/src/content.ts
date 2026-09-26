import {
  ChatGptDomAdapter,
  chatgptChatIdFromUrl,
} from './chatgpt-dom-adapter.js';
import type {
  ContextMessage,
  CurrentChatgptContext,
  DiscoverChatsMessage,
  DiscoverProjectsMessage,
  SubmitMessage,
  SubmitOutcome,
} from './shared.js';

/**
 * HCR Browser Companion - content script for ChatGPT Web.
 *
 * A thin dispatcher: every DOM interaction happens inside ChatGptDomAdapter.
 *
 * Handles:
 *  - HCR_SUBMIT             : targeted Web Handoff prompt (optional destination)
 *  - HCR_DISCOVER_PROJECTS  : ChatGPT Project metadata
 *  - HCR_DISCOVER_CHATS     : session metadata for exactly one Project
 *  - HCR_GET_CONTEXT        : current Project/session (popup status)
 *
 * Explicitly NOT done here:
 *  - no login automation, no CAPTCHA handling, no auth bypass
 *  - no cookie/session reading or extraction
 *  - no reading of unrelated conversation contents (discovery = metadata only)
 *  - no fallback to a generic/new chat, another project or another session
 */

const adapter = new ChatGptDomAdapter();

/**
 * A reload between "click New chat" and the response is handled by remembering
 * the creation attempt in sessionStorage (project id + previous chat id). This
 * lets the re-injected content script continue with the session ChatGPT just
 * opened for THAT project instead of navigating away and starting over.
 */
const PENDING_CREATE_KEY = 'hcrPendingChatCreate';
const PENDING_CREATE_TTL_MS = 60_000;

interface PendingCreate {
  projectId: string;
  beforeId: string;
  at: number;
}

function readPendingCreate(projectId: string): PendingCreate | null {
  try {
    const raw = sessionStorage.getItem(PENDING_CREATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingCreate;
    if (!parsed || parsed.projectId !== projectId) return null;
    if (Date.now() - Number(parsed.at) > PENDING_CREATE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearPendingCreate(): void {
  try {
    sessionStorage.removeItem(PENDING_CREATE_KEY);
  } catch {
    // Storage is best effort.
  }
}

function notePendingCreate(projectId: string, beforeId: string): void {
  try {
    sessionStorage.setItem(
      PENDING_CREATE_KEY,
      JSON.stringify({ projectId, beforeId, at: Date.now() } satisfies PendingCreate)
    );
  } catch {
    // Storage is best effort.
  }
}

function authOutcome(): SubmitOutcome | null {
  if (!adapter.isLoggedOut()) return null;
  return {
    status: 'AUTH_REQUIRED',
    message: 'Open ChatGPT and sign in, then retry.',
    chatgptState: 'auth_required',
  };
}

/** Internal signal: the tab must be loaded at `message` before retrying. */
function navigateTo(url: string): SubmitOutcome {
  return { status: 'NAVIGATE', message: url };
}

async function handleSubmit(message: SubmitMessage): Promise<SubmitOutcome> {
  const auth = authOutcome();
  if (auth) return auth;

  const destination = message.destination ?? null;

  if (destination?.chatMode === 'create') {
    // Continue a session that was opened just before a page reload?
    const pending = readPendingCreate(destination.chatgptProjectId);
    const currentChatId = chatgptChatIdFromUrl(window.location.href);
    if (pending && currentChatId && currentChatId !== pending.beforeId) {
      clearPendingCreate();
    } else {
      clearPendingCreate();
      const nav = adapter.navigateToProject({
        id: destination.chatgptProjectId,
        url: destination.chatgptProjectUrl,
      });
      if (nav.action === 'navigate') return navigateTo(nav.url);
      if (nav.action === 'error') return { status: nav.code, message: nav.message };

      const verify = adapter.verifyDestination(destination);
      if (!verify.ok) return { status: verify.code, message: verify.message };

      const beforeId = chatgptChatIdFromUrl(window.location.href) ?? '';
      notePendingCreate(destination.chatgptProjectId, beforeId);
      const created = await adapter.createChatInProject(
        { id: destination.chatgptProjectId, url: destination.chatgptProjectUrl },
        destination.newChatTitle
      );
      if (!created.ok) {
        clearPendingCreate();
        return { status: created.code, message: created.message };
      }
      clearPendingCreate();
    }
  } else if (destination) {
    const nav = adapter.navigateToChat({ id: destination.chatId, url: destination.chatUrl });
    if (nav.action === 'navigate') return navigateTo(nav.url);
    if (nav.action === 'error') return { status: nav.code, message: nav.message };

    const verify = adapter.verifyDestination(destination);
    if (!verify.ok) return { status: verify.code, message: verify.message };
  }

  const outcome = await adapter.sendPrompt(message.prompt);
  if (outcome.status !== 'OK') return outcome;
  if (destination) return { ...outcome, session: adapter.currentSession(destination) };
  return outcome;
}

async function handleDiscoverProjects(_message: DiscoverProjectsMessage): Promise<SubmitOutcome> {
  const auth = authOutcome();
  if (auth) return auth;
  const result = adapter.discoverProjects();
  if (result.status !== 'ok') return { status: result.status, message: result.message };
  // Metadata only: id/name/url, never conversation contents.
  return { status: 'OK', projects: result.projects ?? [] };
}

async function handleDiscoverChats(message: DiscoverChatsMessage): Promise<SubmitOutcome> {
  const auth = authOutcome();
  if (auth) return auth;

  const project = {
    id: message.projectId,
    url: message.projectUrl || (message.projectId ? `https://chatgpt.com/project/${message.projectId}` : ''),
  };
  if (!project.id && !project.url) {
    return { status: 'PROJECT_NOT_FOUND', message: 'The selected ChatGPT Project has no usable id.' };
  }

  // Chats can only be listed from inside the selected Project page.
  const nav = adapter.navigateToProject(project);
  if (nav.action === 'navigate') return navigateTo(nav.url);
  if (nav.action === 'error') return { status: nav.code, message: nav.message };

  const result = adapter.discoverChats(project);
  if (result.status !== 'ok') return { status: result.status, message: result.message };
  // Metadata only: id/title/url of sessions inside THIS project.
  return { status: 'OK', chats: result.chats ?? [] };
}

function handleContext(_message: ContextMessage): CurrentChatgptContext {
  return adapter.getCurrentContext();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const payload = message as SubmitMessage | DiscoverProjectsMessage | DiscoverChatsMessage | ContextMessage | undefined;
  if (!payload || typeof payload.type !== 'string') return false;

  switch (payload.type) {
    case 'HCR_SUBMIT':
      void handleSubmit(payload as SubmitMessage)
        .then((outcome) => sendResponse(outcome))
        .catch((error: unknown) =>
          sendResponse({
            status: 'ERROR',
            message: error instanceof Error ? error.message : 'Content script failure.',
            chatgptState: 'error',
          } satisfies SubmitOutcome)
        );
      return true; // keep the message channel open for the async response
    case 'HCR_DISCOVER_PROJECTS':
      void handleDiscoverProjects(payload as DiscoverProjectsMessage)
        .then((outcome) => sendResponse(outcome))
        .catch((error: unknown) =>
          sendResponse({
            status: 'ERROR',
            message: error instanceof Error ? error.message : 'Discovery failure.',
          } satisfies SubmitOutcome)
        );
      return true;
    case 'HCR_DISCOVER_CHATS':
      void handleDiscoverChats(payload as DiscoverChatsMessage)
        .then((outcome) => sendResponse(outcome))
        .catch((error: unknown) =>
          sendResponse({
            status: 'ERROR',
            message: error instanceof Error ? error.message : 'Discovery failure.',
          } satisfies SubmitOutcome)
        );
      return true;
    case 'HCR_GET_CONTEXT':
      sendResponse(handleContext(payload as ContextMessage));
      return false;
    default:
      return false;
  }
});
