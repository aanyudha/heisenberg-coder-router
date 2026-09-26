import type { SubmitMessage, SubmitOutcome, ChatgptState } from './shared.js';

/**
 * HCR Browser Companion - content script for ChatGPT Web.
 *
 * Handles exactly one job: take an HCR-provided prompt, put it into the
 * ChatGPT composer, submit it, wait for the assistant to finish, and return
 * the final assistant text to the background worker.
 *
 * Explicitly NOT done here:
 *  - no login automation, no CAPTCHA handling, no auth bypass
 *  - no cookie/session reading or extraction
 *  - no interaction with unrelated page content
 *
 * NOTE: ChatGPT Web's DOM changes frequently. Every selector below is a
 * best-effort probe with fallbacks; failures surface as AUTH_REQUIRED /
 * ERROR rather than silently doing the wrong thing.
 */

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

const COMPOSER_WAIT_MS = 15_000;
const RESPONSE_WAIT_MS = 180_000;
const POLL_MS = 700;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryFirst<T extends Element>(selectors: string[], root: ParentNode = document): T | null {
  for (const selector of selectors) {
    const found = root.querySelector<T>(selector);
    if (found) return found;
  }
  return null;
}

/** Detect the logged-out state without attempting to automate sign-in. */
function isLoggedOut(): boolean {
  const { pathname } = window.location;
  if (pathname.startsWith('/auth/') || pathname.includes('login') || pathname.includes('sign-in')) {
    return true;
  }
  const loginLink = document.querySelector('a[href*="/auth/login"], button[data-testid="login-button"]');
  if (loginLink) return true;
  const bodyText = (document.body?.innerText ?? '').slice(0, 4000);
  if (/log in or sign up|sign up for free|welcome back/i.test(bodyText)) {
    const composer = queryFirst(COMPOSER_SELECTORS);
    if (!composer) return true;
  }
  return false;
}

async function waitForComposer(): Promise<Element | null> {
  const deadline = Date.now() + COMPOSER_WAIT_MS;
  while (Date.now() < deadline) {
    const composer = queryFirst(COMPOSER_SELECTORS);
    if (composer) return composer;
    if (isLoggedOut()) return null;
    await sleep(250);
  }
  return queryFirst(COMPOSER_SELECTORS);
}

function detectState(): ChatgptState {
  if (isLoggedOut()) return 'auth_required';
  return queryFirst(COMPOSER_SELECTORS) ? 'ready' : 'unknown';
}

/** Put text into the composer (textarea or ProseMirror contenteditable). */
function setComposerText(composer: Element, text: string): boolean {
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

function clickSend(composer: Element): boolean {
  const button = queryFirst<HTMLButtonElement>(SEND_BUTTON_SELECTORS);
  if (button && !button.disabled) {
    button.click();
    return true;
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

function assistantCount(): number {
  return document.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR).length;
}

function isGenerating(): boolean {
  return queryFirst(STOP_BUTTON_SELECTORS) !== null;
}

function lastAssistantText(): string {
  const messages = document.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR);
  const last = messages[messages.length - 1];
  return (last?.textContent ?? '').trim();
}

async function waitForCompletion(startCount: number): Promise<string> {
  const deadline = Date.now() + RESPONSE_WAIT_MS;
  let sawGeneration = isGenerating();

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (isGenerating()) sawGeneration = true;
    if (sawGeneration && !isGenerating()) break;

    // No stop button (layout change): fall back to message-count growth.
    if (!sawGeneration && assistantCount() > startCount) {
      // Wait for the newest message to settle.
      await sleep(1_500);
      break;
    }
  }

  const text = lastAssistantText();
  if (text.length > 0) return text;
  // Last resort: any non-empty assistant message after submission.
  const messages = document.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR);
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = (messages[i].textContent ?? '').trim();
    if (content.length > 0) return content;
  }
  throw new Error('ChatGPT finished without a readable assistant response.');
}

async function runSubmit(prompt: string): Promise<SubmitOutcome> {
  const composer = await waitForComposer();
  if (!composer) {
    const state = detectState();
    if (state === 'auth_required') {
      return {
        status: 'AUTH_REQUIRED',
        message: 'Open ChatGPT and sign in, then retry.',
        chatgptState: 'auth_required',
      };
    }
    return {
      status: 'ERROR',
      message: 'Could not find the ChatGPT composer.',
      chatgptState: state,
    };
  }

  const startCount = assistantCount();

  if (!setComposerText(composer, prompt)) {
    return {
      status: 'ERROR',
      message: 'Could not insert the HCR prompt into the ChatGPT composer.',
      chatgptState: detectState(),
    };
  }

  // Give React a tick to enable the send button.
  await sleep(400);

  if (!clickSend(composer)) {
    return {
      status: 'ERROR',
      message: 'Could not submit the prompt to ChatGPT.',
      chatgptState: detectState(),
    };
  }

  // Confirm the request actually started; otherwise retry submission once.
  await sleep(2_500);
  if (!isGenerating() && assistantCount() === startCount) {
    clickSend(composer);
    await sleep(2_500);
  }

  try {
    const responseText = await waitForCompletion(startCount);
    return { status: 'OK', responseText, chatgptState: 'ready' };
  } catch (error) {
    return {
      status: 'ERROR',
      message: error instanceof Error ? error.message : 'No response received.',
      chatgptState: detectState(),
    };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const payload = message as SubmitMessage | undefined;
  if (!payload || payload.type !== 'HCR_SUBMIT') return false;
  void runSubmit(payload.prompt)
    .then((outcome) => sendResponse(outcome))
    .catch((error: unknown) =>
      sendResponse({
        status: 'ERROR',
        message: error instanceof Error ? error.message : 'Content script failure.',
        chatgptState: 'error',
      } satisfies SubmitOutcome)
    );
  return true; // keep the message channel open for the async response
});
