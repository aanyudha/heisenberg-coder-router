import {
  CHATGPT_ORIGIN,
  type ChatGptChat,
  type ChatGptProject,
  type ChatgptSessionRef,
  type CurrentChatgptContext,
  type SubmitOutcome,
  type TaskDestination,
} from './shared.js';

/**
 * ChatGPT DOM Adapter - the ONLY place that touches chatgpt.com's DOM.
 *
 * Every selector/URL shape lives in this file so a future ChatGPT UI change
 * can be fixed in one place. The adapter:
 *  - discovers Projects/sessions as METADATA ONLY (id/title/url), never reads
 *    conversation bodies
 *  - verifies the selected destination deterministically (URL/id) and reports
 *    PROJECT_NOT_FOUND / CHAT_NOT_FOUND / UI_UNSUPPORTED / AUTH_REQUIRED
 *  - never falls back to a generic/new chat, another project or another session
 *  - never automates login, never clicks arbitrary elements (only explicit
 *    "New chat" affordances inside the selected Project)
 */

// ---- URL identity (stable) -------------------------------------------- //

const PROJECT_PATH = /^\/projects?\/([A-Za-z0-9_-]+)/i;
const CHAT_PATH = /\/(?:c|chat|conversation|p)\/([A-Za-z0-9_-]+)/i;

/** Canonical form used for comparisons: origin + path, no query/trailing slash. */
export function normalizeChatgptUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed, CHATGPT_ORIGIN);
    return `${parsed.origin.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Resolve any href to an absolute chatgpt.com URL (query/hash stripped). */
export function absoluteChatgptUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const parsed = new URL(href, window.location.origin);
    if (parsed.origin !== CHATGPT_ORIGIN) return null;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function chatgptProjectIdFromUrl(url: string | null | undefined): string | null {
  const normalized = normalizeChatgptUrl(url);
  if (!normalized) return null;
  try {
    const match = PROJECT_PATH.exec(new URL(normalized).pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function chatgptChatIdFromUrl(url: string | null | undefined): string | null {
  const normalized = normalizeChatgptUrl(url);
  if (!normalized) return null;
  try {
    const match = CHAT_PATH.exec(new URL(normalized).pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ---- selectors (isolated: fix here when ChatGPT changes its UI) -------- //

const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  'textarea[data-id="root"]',
  'div[contenteditable="true"][data-lexical-editor="true"]',
  'form textarea',
];

const SEND_BUTTON_SELECTORS = [
  '[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[data-testid="composer-send-button"]',
];

const STOP_BUTTON_SELECTORS = ['[data-testid="stop-button"]', 'button[aria-label="Stop generating"]'];
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';

/** Container of a Project page's conversation list (chat links must be scoped). */
const MAIN_SCOPE_SELECTORS = ['main', '[role="main"]', '#main', 'article'];

/** Explicit "new chat" affordances only - never arbitrary DOM elements. */
const NEW_CHAT_PATTERNS = [/^new chat$/i, /^new chat in/i, /^new conversation$/i, /start a new chat/i];

const COMPOSER_WAIT_MS = 15_000;
const RESPONSE_WAIT_MS = 180_000;
const CHAT_CREATION_WAIT_MS = 20_000;
const POLL_MS = 700;

// ---- results ------------------------------------------------------------ //

export type NavigationResult =
  | { action: 'ready' }
  | { action: 'navigate'; url: string }
  | {
      action: 'error';
      code: 'PROJECT_NOT_FOUND' | 'CHAT_NOT_FOUND' | 'UI_UNSUPPORTED' | 'AUTH_REQUIRED';
      message: string;
    };

export type VerifyResult =
  | { ok: true }
  | { ok: false; code: 'PROJECT_NOT_FOUND' | 'CHAT_NOT_FOUND'; message: string };

export type DiscoveryResult =
  | { status: 'ok'; projects?: ChatGptProject[]; chats?: ChatGptChat[] }
  | { status: 'AUTH_REQUIRED' | 'UI_UNSUPPORTED' | 'PROJECT_NOT_FOUND' | 'ERROR'; message: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ChatGptDomAdapter {
  // ---- auth / structure --------------------------------------------- //

  /** Detect the logged-out state without attempting to automate sign-in. */
  isLoggedOut(): boolean {
    const { pathname } = window.location;
    if (pathname.startsWith('/auth/') || pathname.includes('login') || pathname.includes('sign-in')) return true;
    const loginLink = document.querySelector('a[href*="/auth/login"], button[data-testid="login-button"]');
    if (loginLink) return true;
    const bodyText = (document.body?.innerText ?? '').slice(0, 4000);
    if (/log in or sign up|sign up for free|welcome back/i.test(bodyText)) {
      if (!this.composer()) return true;
    }
    return false;
  }

  /**
   * UI_UNSUPPORTED gate: we only act when the page still looks like ChatGPT
   * (a recognizable landmark exists). If ChatGPT restructures completely the
   * companion reports UI_UNSUPPORTED instead of clicking around blindly.
   */
  private isRecognizablePage(): boolean {
    if (this.composer()) return true;
    if (this.mainScope()) return true;
    return document.querySelectorAll('a[href]').length > 0;
  }

  private mainScope(): Element | null {
    for (const selector of MAIN_SCOPE_SELECTORS) {
      const found = document.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  private composer(): Element | null {
    for (const selector of COMPOSER_SELECTORS) {
      const found = document.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  // ---- current location (metadata only) ------------------------------ //

  getCurrentProject(): ChatGptProject | null {
    const id = chatgptProjectIdFromUrl(window.location.href);
    if (!id) return null;
    return {
      id,
      name: this.projectNameOnPage(id),
      url: absoluteChatgptUrl(`/project/${id}`) ?? window.location.origin + window.location.pathname,
    };
  }

  getCurrentChat(): ChatGptChat | null {
    const id = chatgptChatIdFromUrl(window.location.href);
    if (!id) return null;
    return { id, title: this.chatTitleOnPage(id), url: window.location.pathname };
  }

  getCurrentContext(): CurrentChatgptContext {
    return {
      project: this.getCurrentProject(),
      chat: this.getCurrentChat(),
      uiSupported: this.isRecognizablePage(),
      authRequired: this.isLoggedOut(),
    };
  }

  /** Visible title of a project (sidebar/heading text) - presentation only. */
  private projectNameOnPage(projectId: string): string {
    const candidates = document.querySelectorAll<HTMLAnchorElement>(`a[href*="${projectId}"]`);
    for (const anchor of candidates) {
      const text = (anchor.textContent ?? '').trim().replace(/\s+/g, ' ');
      if (text.length > 0 && text.length < 120) return text;
    }
    const heading = document.querySelector('main h1, [role="main"] h1, #main h1');
    const headingText = (heading?.textContent ?? '').trim();
    return headingText.length > 0 && headingText.length < 120 ? headingText : '';
  }

  /** Visible title of a chat (its link text) - presentation only. */
  private chatTitleOnPage(chatId: string): string {
    const anchors = document.querySelectorAll<HTMLAnchorElement>(`a[href*="${chatId}"]`);
    for (const anchor of anchors) {
      const text = (anchor.textContent ?? '').trim().replace(/\s+/g, ' ');
      if (text.length > 0 && text.length < 200) return text;
    }
    const title = (document.title ?? '').replace(/\s*[|-]\s*ChatGPT\s*$/i, '').trim();
    return title.length > 0 && title.length < 200 ? title : '';
  }

  // ---- discovery: Projects (metadata only) --------------------------- //

  discoverProjects(): DiscoveryResult {
    if (this.isLoggedOut()) return { status: 'AUTH_REQUIRED', message: 'Open ChatGPT and sign in, then refresh.' };
    if (!this.isRecognizablePage()) {
      return { status: 'UI_UNSUPPORTED', message: 'The ChatGPT page could not be understood (UI changed).' };
    }

    const seen = new Map<string, ChatGptProject>();
    const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href]');
    for (const anchor of Array.from(anchors)) {
      const href = anchor.getAttribute('href') ?? '';
      const id = chatgptProjectIdFromUrl(href);
      if (!id) continue;
      const url = absoluteChatgptUrl(href);
      if (!url) continue;
      if (seen.has(id)) continue;
      // Identity first: aria-label/title/text are only the visible name.
      const name = (
        anchor.getAttribute('aria-label') ||
        anchor.getAttribute('title') ||
        anchor.textContent ||
        ''
      )
        .trim()
        .replace(/\s+/g, ' ');
      seen.set(id, { id, name, url });
    }

    // Metadata only: no conversation contents are ever read here.
    return { status: 'ok', projects: Array.from(seen.values()) };
  }

  // ---- discovery: sessions of ONE project (metadata only) ------------ //

  discoverChats(project: { id: string; url: string }): DiscoveryResult {
    if (this.isLoggedOut()) return { status: 'AUTH_REQUIRED', message: 'Open ChatGPT and sign in, then refresh.' };

    const currentProjectId = chatgptProjectIdFromUrl(window.location.href);
    const wantedId = project.id || chatgptProjectIdFromUrl(project.url) || '';
    if (!wantedId) {
      return { status: 'PROJECT_NOT_FOUND', message: 'The selected ChatGPT Project has no usable id.' };
    }
    if (currentProjectId !== wantedId) {
      return {
        status: 'PROJECT_NOT_FOUND',
        message: 'The browser is not inside the selected ChatGPT Project.',
      };
    }

    const scope = this.mainScope();
    if (!scope) {
      // Cannot scope by container -> refuse rather than risk returning chats
      // from unrelated projects.
      return { status: 'UI_UNSUPPORTED', message: 'Could not locate the project conversation list (UI changed).' };
    }

    const seen = new Map<string, ChatGptChat>();

    // 1) Project-scoped URLs anywhere on the page (inherently safe).
    for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      const href = anchor.getAttribute('href') ?? '';
      if (!href.includes(`/project/${wantedId}/`) && !href.includes(`/projects/${wantedId}/`)) continue;
      this.collectChat(anchor, href, seen);
    }

    // 2) Chat links inside the project's main content area.
    for (const anchor of Array.from(scope.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      const href = anchor.getAttribute('href') ?? '';
      if (!chatgptChatIdFromUrl(href)) continue;
      this.collectChat(anchor, href, seen);
    }

    // Metadata only: titles/urls, never conversation bodies.
    return { status: 'ok', chats: Array.from(seen.values()) };
  }

  private collectChat(anchor: HTMLAnchorElement, href: string, seen: Map<string, ChatGptChat>): void {
    const id = chatgptChatIdFromUrl(href);
    const url = absoluteChatgptUrl(href);
    if (!id || !url || seen.has(id)) return;
    const title = (
      anchor.getAttribute('aria-label') || anchor.getAttribute('title') || anchor.textContent || ''
    )
      .trim()
      .replace(/\s+/g, ' ');
    seen.set(id, { id, title, url });
  }

  // ---- navigation decisions (the worker performs the actual load) ---- //

  navigateToProject(project: { id: string; url: string }): NavigationResult {
    const wantedId = project.id || chatgptProjectIdFromUrl(project.url) || '';
    const wantedUrl = absoluteChatgptUrl(project.url) || (wantedId ? `${CHATGPT_ORIGIN}/project/${wantedId}` : null);
    if (!wantedUrl) {
      return { action: 'error', code: 'PROJECT_NOT_FOUND', message: 'The selected ChatGPT Project has no usable URL.' };
    }
    if (this.isLoggedOut()) {
      return { action: 'error', code: 'AUTH_REQUIRED', message: 'Open ChatGPT and sign in, then retry.' };
    }
    const currentId = chatgptProjectIdFromUrl(window.location.href);
    if (wantedId && currentId === wantedId) return { action: 'ready' };
    if (normalizeChatgptUrl(window.location.href) === normalizeChatgptUrl(wantedUrl)) return { action: 'ready' };
    return { action: 'navigate', url: wantedUrl };
  }

  navigateToChat(chat: { id: string | null; url: string | null }): NavigationResult {
    const wantedId = chat.id || chatgptChatIdFromUrl(chat.url) || '';
    const wantedUrl = absoluteChatgptUrl(chat.url) || (wantedId ? `${CHATGPT_ORIGIN}/c/${wantedId}` : null);
    if (!wantedUrl) {
      return { action: 'error', code: 'CHAT_NOT_FOUND', message: 'The selected chat session has no usable URL.' };
    }
    if (this.isLoggedOut()) {
      return { action: 'error', code: 'AUTH_REQUIRED', message: 'Open ChatGPT and sign in, then retry.' };
    }
    const currentId = chatgptChatIdFromUrl(window.location.href);
    if (wantedId && currentId === wantedId) return { action: 'ready' };
    if (normalizeChatgptUrl(window.location.href) === normalizeChatgptUrl(wantedUrl)) return { action: 'ready' };
    return { action: 'navigate', url: wantedUrl };
  }

  /** Strict destination verification - URL/id only, names are ignored. */
  verifyDestination(destination: TaskDestination): VerifyResult {
    const currentUrl = window.location.href;
    const currentProjectId = chatgptProjectIdFromUrl(currentUrl);
    const currentChatId = chatgptChatIdFromUrl(currentUrl);
    const wantedProjectId = destination.chatgptProjectId || chatgptProjectIdFromUrl(destination.chatgptProjectUrl);
    const wantedProjectUrl = normalizeChatgptUrl(destination.chatgptProjectUrl);

    if (destination.chatMode === 'create') {
      const projectOk =
        (Boolean(wantedProjectId) && currentProjectId === wantedProjectId) ||
        (Boolean(wantedProjectUrl) && wantedProjectUrl === normalizeChatgptUrl(currentUrl));
      if (!projectOk) {
        return {
          ok: false,
          code: 'PROJECT_NOT_FOUND',
          message: 'PROJECT_NOT_FOUND: not inside the selected ChatGPT Project.',
        };
      }
      return { ok: true };
    }

    const wantedChatId = destination.chatId || chatgptChatIdFromUrl(destination.chatUrl);
    const wantedChatUrl = normalizeChatgptUrl(destination.chatUrl);
    const chatOk =
      (Boolean(wantedChatId) && currentChatId === wantedChatId) ||
      (Boolean(wantedChatUrl) && wantedChatUrl === normalizeChatgptUrl(currentUrl));

    if (chatOk) {
      // A chat URL may be project-scoped: also require the right project.
      if (currentProjectId && wantedProjectId && currentProjectId !== wantedProjectId) {
        return {
          ok: false,
          code: 'PROJECT_NOT_FOUND',
          message: 'PROJECT_NOT_FOUND: the chat belongs to another ChatGPT Project.',
        };
      }
      return { ok: true };
    }

    if (wantedProjectId && currentProjectId && currentProjectId !== wantedProjectId) {
      return {
        ok: false,
        code: 'PROJECT_NOT_FOUND',
        message: 'PROJECT_NOT_FOUND: not inside the selected ChatGPT Project.',
      };
    }
    return {
      ok: false,
      code: 'CHAT_NOT_FOUND',
      message: 'CHAT_NOT_FOUND: the selected chat session is not open.',
    };
  }

  /** Session actually open right now (authoritative URL/id). */
  currentSession(destination: TaskDestination): ChatgptSessionRef {
    const chat = this.getCurrentChat();
    const project = this.getCurrentProject();
    return {
      chatgptProjectId: destination.chatgptProjectId || project?.id || null,
      chatgptProjectName: destination.chatgptProjectName || project?.name || null,
      chatgptProjectUrl: destination.chatgptProjectUrl || project?.url || null,
      chatId: chat?.id ?? destination.chatId ?? '',
      chatTitle: chat?.title ?? destination.chatTitle ?? '',
      chatUrl: chat ? absoluteChatgptUrl(chat.url) ?? chat.url : (destination.chatUrl ?? ''),
      chatMode: destination.chatMode,
    };
  }

  // ---- create a new session inside the selected Project -------------- //

  async createChatInProject(
    project: { id: string; url: string },
    title: string | null | undefined
  ): Promise<{ ok: true } | { ok: false; code: 'PROJECT_NOT_FOUND' | 'CHAT_NOT_FOUND' | 'UI_UNSUPPORTED'; message: string }> {
    const verify = this.verifyDestination({
      chatgptProjectId: project.id,
      chatgptProjectName: '',
      chatgptProjectUrl: project.url,
      chatId: null,
      chatTitle: null,
      chatUrl: null,
      chatMode: 'create',
    });
    if (!verify.ok) return verify;

    const beforeId = chatgptChatIdFromUrl(window.location.href);
    const control = this.findNewChatControl(project.id);
    if (!control) {
      return {
        ok: false,
        code: 'UI_UNSUPPORTED',
        message:
          'UI_UNSUPPORTED: no "New chat" control was found inside this ChatGPT Project. ' +
          'Create the session manually, then use Continue Existing Session.',
      };
    }

    control.click();
    const deadline = Date.now() + CHAT_CREATION_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(500);
      const nowId = chatgptChatIdFromUrl(window.location.href);
      if (nowId && nowId !== beforeId) return { ok: true };
    }

    // The optional title is never trusted: the URL/ID is the identifier.
    void title;
    return {
      ok: false,
      code: 'UI_UNSUPPORTED',
      message: 'UI_UNSUPPORTED: ChatGPT did not open a new session inside the project.',
    };
  }

  /**
   * An explicit "New chat" affordance that belongs to THIS project
   * (project-scoped href, or inside the project's main content). Global
   * sidebar "New chat" buttons are deliberately ignored - they would create a
   * session outside the selected Project.
   */
  private findNewChatControl(projectId: string): HTMLElement | null {
    const scope = this.mainScope();
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('a[href], button, [role="button"]')
    );
    for (const element of candidates) {
      const href = element.getAttribute('href') ?? '';
      const label = (
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.textContent ||
        ''
      )
        .trim()
        .replace(/\s+/g, ' ');
      if (!NEW_CHAT_PATTERNS.some((pattern) => pattern.test(label))) continue;
      const inProjectScope =
        href.includes(`/project/${projectId}/`) || href.includes(`/projects/${projectId}/`) ||
        (scope !== null && scope.contains(element));
      if (!inProjectScope) continue;
      if (element instanceof HTMLButtonElement && element.disabled) continue;
      return element;
    }
    return null;
  }

  // ---- prompt submission --------------------------------------------- //

  async sendPrompt(prompt: string): Promise<SubmitOutcome> {
    const composer = await this.waitForComposer();
    if (!composer) {
      if (this.isLoggedOut()) {
        return {
          status: 'AUTH_REQUIRED',
          message: 'Open ChatGPT and sign in, then retry.',
          chatgptState: 'auth_required',
        };
      }
      return { status: 'ERROR', message: 'Could not find the ChatGPT composer.', chatgptState: 'unknown' };
    }

    const startCount = this.assistantCount();

    if (!this.setComposerText(composer, prompt)) {
      return {
        status: 'ERROR',
        message: 'Could not insert the HCR prompt into the ChatGPT composer.',
        chatgptState: 'unknown',
      };
    }

    // Give React a tick to enable the send button.
    await sleep(400);

    if (!this.clickSend(composer)) {
      return { status: 'ERROR', message: 'Could not submit the prompt to ChatGPT.', chatgptState: 'unknown' };
    }

    // Confirm the request actually started; otherwise retry submission once.
    await sleep(2_500);
    if (!this.isGenerating() && this.assistantCount() === startCount) {
      this.clickSend(composer);
      await sleep(2_500);
    }

    try {
      const responseText = await this.waitForCompletion(startCount);
      return { status: 'OK', responseText, chatgptState: 'ready' };
    } catch (error) {
      return {
        status: 'ERROR',
        message: error instanceof Error ? error.message : 'No response received.',
        chatgptState: this.isLoggedOut() ? 'auth_required' : 'unknown',
      };
    }
  }

  async waitForAssistantResponse(startCount: number): Promise<string> {
    return await this.waitForCompletion(startCount);
  }

  private async waitForComposer(): Promise<Element | null> {
    const deadline = Date.now() + COMPOSER_WAIT_MS;
    while (Date.now() < deadline) {
      const composer = this.composer();
      if (composer) return composer;
      if (this.isLoggedOut()) return null;
      await sleep(250);
    }
    return this.composer();
  }

  private setComposerText(composer: Element, text: string): boolean {
    try {
      composer.scrollIntoView({ block: 'center' });
      if (composer instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(composer, text);
        else composer.value = text;
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        return composer.value.length > 0;
      }

      if (composer instanceof HTMLElement && composer.isContentEditable) {
        composer.focus();
        // execCommand keeps the editor's own state (ProseMirror/React) in sync.
        document.execCommand('selectAll', false, undefined);
        const inserted = document.execCommand('insertText', false, text);
        if (inserted && (composer.textContent ?? '').length > 0) return true;

        composer.textContent = text;
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
        return (composer.textContent ?? '').length > 0;
      }
    } catch {
      return false;
    }
    return false;
  }

  private clickSend(composer: Element): boolean {
    for (const selector of SEND_BUTTON_SELECTORS) {
      const button = document.querySelector<HTMLButtonElement>(selector);
      if (button && !button.disabled) {
        button.click();
        return true;
      }
    }
    // Fallback: Enter in the composer (ChatGPT submits on Enter).
    try {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      });
      composer.dispatchEvent(event);
      return true;
    } catch {
      return false;
    }
  }

  private assistantCount(): number {
    return document.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR).length;
  }

  private isGenerating(): boolean {
    for (const selector of STOP_BUTTON_SELECTORS) {
      if (document.querySelector(selector)) return true;
    }
    return false;
  }

  private lastAssistantText(): string {
    const messages = document.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR);
    const last = messages[messages.length - 1];
    return (last?.textContent ?? '').trim();
  }

  private async waitForCompletion(startCount: number): Promise<string> {
    const deadline = Date.now() + RESPONSE_WAIT_MS;
    let sawGeneration = this.isGenerating();

    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      if (this.isGenerating()) sawGeneration = true;
      if (sawGeneration && !this.isGenerating()) break;

      // No stop button (layout change): fall back to message-count growth.
      if (!sawGeneration && this.assistantCount() > startCount) {
        await sleep(1_500);
        break;
      }
    }

    const text = this.lastAssistantText();
    if (text.length > 0) return text;
    const messages = document.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR);
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = (messages[i].textContent ?? '').trim();
      if (content.length > 0) return content;
    }
    throw new Error('ChatGPT finished without a readable assistant response.');
  }
}
