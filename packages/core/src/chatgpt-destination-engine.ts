import { AppError } from '@heisenberg/shared';
import type { ChatGptChat, ChatGptProject, ChatgptDestination } from '@heisenberg/contracts';
import type { DatabaseEngine, ChatgptDestinationRecord } from './database-engine.js';

/**
 * ChatGPT Destination Engine - the local mapping between a local HCR project
 * and the ChatGPT Project / chat-session last used for it.
 *
 * Rules encoded here:
 *  - identity is always the URL / stable id; names are presentation only
 *    (ChatGPT renames do not break the mapping)
 *  - a saved destination is restored ONLY when it still exists in the
 *    discovered list - nothing is ever auto-selected by name or at random
 *  - only destination metadata is stored: no cookies, no auth tokens, no
 *    conversation contents
 */

const PROJECT_URL_PATTERN = /\/projects?\/([A-Za-z0-9_-]+)/i;
const CHAT_URL_PATTERN = /\/(?:c|chat|conversation|p)\/([A-Za-z0-9_-]+)/i;

/** Canonical form used for comparisons: origin + path, no trailing slash. */
export function normalizeChatgptUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed, 'https://chatgpt.com');
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

/** Stable ChatGPT Project id parsed from a project URL (`/project/<id>`). */
export function chatgptProjectIdFromUrl(url: string | null | undefined): string | null {
  const normalized = normalizeChatgptUrl(url);
  if (!normalized) return null;
  const match = PROJECT_URL_PATTERN.exec(new URL(normalized).pathname);
  return match ? match[1] : null;
}

/** Stable chat/session id parsed from a chat URL (`/c/<id>`, `/chat/<id>`, ...). */
export function chatgptChatIdFromUrl(url: string | null | undefined): string | null {
  const normalized = normalizeChatgptUrl(url);
  if (!normalized) return null;
  const match = CHAT_URL_PATTERN.exec(new URL(normalized).pathname);
  return match ? match[1] : null;
}

/** True when a discovered project IS the given destination (URL/id first). */
export function projectMatchesDestination(project: ChatGptProject, destination: ChatgptDestination): boolean {
  if (destination.chatgptProjectId && project.id === destination.chatgptProjectId) return true;
  const wanted = normalizeChatgptUrl(destination.chatgptProjectUrl);
  const actual = normalizeChatgptUrl(project.url);
  if (wanted && actual && wanted === actual) return true;
  const wantedId = chatgptProjectIdFromUrl(destination.chatgptProjectUrl);
  return Boolean(wantedId && wantedId === project.id);
}

/** True when a discovered chat IS the given destination (URL/id first). */
export function chatMatchesDestination(chat: ChatGptChat, destination: ChatgptDestination): boolean {
  if (destination.chatId && chat.id === destination.chatId) return true;
  const wanted = normalizeChatgptUrl(destination.chatUrl);
  const actual = normalizeChatgptUrl(chat.url);
  if (wanted && actual && wanted === actual) return true;
  const wantedId = chatgptChatIdFromUrl(destination.chatUrl);
  return Boolean(wantedId && wantedId === chat.id);
}

/**
 * True when the browser is currently inside the selected destination.
 * Identity comes from the URL/id; the visible name is never compared.
 *
 * - continue: the current URL must be the selected chat/session itself
 * - create:   the current URL must be the selected Project
 */
export function destinationMatches(currentUrl: string | null | undefined, destination: ChatgptDestination): boolean {
  const current = normalizeChatgptUrl(currentUrl);
  if (!current) return false;
  const currentChatId = chatgptChatIdFromUrl(current);
  const currentProjectId = chatgptProjectIdFromUrl(current);
  const wantedProjectId = destination.chatgptProjectId || chatgptProjectIdFromUrl(destination.chatgptProjectUrl);
  const wantedProjectUrl = normalizeChatgptUrl(destination.chatgptProjectUrl);

  if (destination.chatMode === 'continue') {
    const wantedChatId = destination.chatId || chatgptChatIdFromUrl(destination.chatUrl);
    const wantedChatUrl = normalizeChatgptUrl(destination.chatUrl);
    if (!wantedChatId && !wantedChatUrl) return false;
    if (wantedChatId && currentChatId === wantedChatId) return true;
    if (wantedChatUrl && wantedChatUrl === current) return true;
    return false;
  }

  if (wantedProjectId && currentProjectId === wantedProjectId) return true;
  if (wantedProjectUrl && wantedProjectUrl === current) return true;
  return false;
}

/**
 * Restore the last-used destination for a local project.
 * Returns nulls (never a guess) when the saved project/chat is not in the
 * freshly discovered lists - ids/URLs decide, names never do.
 */
export function restoreChatgptSelection(
  projects: ChatGptProject[],
  chats: ChatGptChat[],
  saved: ChatgptDestination | null
): { project: ChatGptProject | null; chat: ChatGptChat | null } {
  if (!saved) return { project: null, chat: null };
  const project = projects.find((candidate) => projectMatchesDestination(candidate, saved)) ?? null;
  if (!project) return { project: null, chat: null };
  const chat = saved.chatMode === 'continue' ? (chats.find((candidate) => chatMatchesDestination(candidate, saved)) ?? null) : null;
  return { project, chat };
}

export class ChatgptDestinationEngine {
  constructor(private readonly db: DatabaseEngine) {}

  /** Last-used ChatGPT Project/session for one local HCR project (or null). */
  get(localProjectPath: string): ChatgptDestination | null {
    if (!localProjectPath) return null;
    const record = this.db.getChatgptDestination(localProjectPath);
    if (!record || record.chatgptProjectId.length === 0) return null;
    return toDestination(record);
  }

  /** Persist destination metadata for one local HCR project. */
  save(localProjectPath: string, destination: ChatgptDestination): void {
    if (!localProjectPath) {
      throw new AppError('Local project path is required to remember a ChatGPT destination.', 400);
    }
    if (!destination.chatgptProjectId && !destination.chatgptProjectUrl) {
      throw new AppError('A ChatGPT Project id or URL is required.', 400);
    }
    this.db.upsertChatgptDestination({
      localProjectPath,
      chatgptProjectId: destination.chatgptProjectId || chatgptProjectIdFromUrl(destination.chatgptProjectUrl) || '',
      chatgptProjectName: destination.chatgptProjectName ?? '',
      chatgptProjectUrl: destination.chatgptProjectUrl ?? '',
      preferredChatId: destination.chatId ?? '',
      preferredChatTitle: destination.chatTitle ?? '',
      preferredChatUrl: destination.chatUrl ?? '',
      chatMode: destination.chatMode === 'create' ? 'create' : 'continue',
      updatedAt: new Date().toISOString(),
    });
  }
}

function toDestination(record: ChatgptDestinationRecord): ChatgptDestination {
  return {
    chatgptProjectId: record.chatgptProjectId,
    chatgptProjectName: record.chatgptProjectName,
    chatgptProjectUrl: record.chatgptProjectUrl,
    chatId: record.preferredChatId.length > 0 ? record.preferredChatId : null,
    chatTitle: record.preferredChatTitle.length > 0 ? record.preferredChatTitle : null,
    chatUrl: record.preferredChatUrl.length > 0 ? record.preferredChatUrl : null,
    chatMode: record.chatMode,
  };
}
