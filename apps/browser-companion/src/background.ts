import {
  CHATGPT_ORIGIN,
  HEARTBEAT_INTERVAL_MS,
  STORAGE_TOKEN_KEY,
  TASK_POLL_INTERVAL_MS,
  TASK_TIMEOUT_MS,
  hcrFetch,
  hcrFetchAuthed,
  type ChatgptState,
  type CompanionTask,
  type ContextMessage,
  type CurrentChatgptContext,
  type Stage,
  type SubmitMessage,
  type SubmitOutcome,
} from './shared.js';

/**
 * HCR Browser Companion - background service worker (Manifest V3).
 *
 * Responsibilities:
 *  - keep a local pairing secret (from the HCR pairing code) in storage
 *  - heartbeat to local HCR and pick up queued Web Handoff / discovery tasks
 *  - find/open ChatGPT Web, navigate to the SELECTED destination and drive
 *    the content script (the adapter owns all DOM work)
 *  - return ONLY the final assistant response / discovery metadata to HCR
 *
 * The companion never reads cookies, never automates login, never touches
 * unrelated tabs, and never sends the pairing secret anywhere but HCR.
 */

/** Max times the worker will navigate the tab on behalf of the adapter. */
const MAX_NAVIGATION_ROUNDS = 2;
const NAVIGATION_SETTLE_MS = 700;

interface CompanionState {
  token: string | null;
  busy: boolean;
  lastHeartbeatAt: string | null;
  chatgptState: ChatgptState;
  activeTask: CompanionTask | null;
}

const state: CompanionState = {
  token: null,
  busy: false,
  lastHeartbeatAt: null,
  chatgptState: 'unknown',
  activeTask: null,
};

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function loadToken(): Promise<string | null> {
  const stored = await chrome.storage.local.get(STORAGE_TOKEN_KEY);
  const token = stored[STORAGE_TOKEN_KEY];
  state.token = typeof token === 'string' && token.length > 0 ? token : null;
  return state.token;
}

function ensureTimers(): void {
  if (heartbeatTimer === null) {
    heartbeatTimer = setInterval(() => {
      void heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }
  if (pollTimer === null) {
    pollTimer = setInterval(() => {
      void pollTask();
    }, TASK_POLL_INTERVAL_MS);
  }
}

function stopTimers(): void {
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  if (pollTimer !== null) clearInterval(pollTimer);
  heartbeatTimer = null;
  pollTimer = null;
}

async function heartbeat(): Promise<void> {
  const token = state.token ?? (await loadToken());
  if (!token) return;
  try {
    const response = await hcrFetchAuthed('/api/browser-companion/heartbeat', token, {
      method: 'POST',
      body: JSON.stringify({
        chatgpt: { state: state.chatgptState, detail: null },
      }),
    });
    if (!response.ok) {
      // 401 = pairing no longer valid; drop the token so the popup re-pairs.
      if (response.status === 401) {
        await chrome.storage.local.remove(STORAGE_TOKEN_KEY);
        state.token = null;
        stopTimers();
      }
      return;
    }
    state.lastHeartbeatAt = new Date().toISOString();
    const payload = (await response.json()) as { task?: CompanionTask | null };
    if (payload.task) void processTask(payload.task);
  } catch {
    // HCR not running: stay quiet and retry on the next tick.
  }
}

async function pollTask(): Promise<void> {
  if (state.busy) return;
  const token = state.token ?? (await loadToken());
  if (!token) return;
  try {
    const response = await hcrFetchAuthed('/api/browser-companion/task', token);
    if (!response.ok) return;
    const payload = (await response.json()) as { task: CompanionTask | null };
    if (payload.task) void processTask(payload.task);
  } catch {
    // HCR unreachable.
  }
}

async function postStage(taskId: string, stage: Stage): Promise<void> {
  const token = state.token;
  if (!token) return;
  try {
    await hcrFetchAuthed(`/api/browser-companion/task/${taskId}/stage`, token, {
      method: 'POST',
      body: JSON.stringify({ stage }),
    });
  } catch {
    // Stage reporting is best effort.
  }
}

async function postResult(taskId: string, outcome: SubmitOutcome): Promise<void> {
  const token = state.token;
  if (!token) return;
  try {
    await hcrFetchAuthed(`/api/browser-companion/task/${taskId}/result`, token, {
      method: 'POST',
      body: JSON.stringify(outcome),
    });
  } catch {
    // HCR unreachable: HCR will expire the task on its own.
  }
}

/** Find an existing ChatGPT tab (never opens one). */
async function findChatGptTab(): Promise<number | null> {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => typeof tab.url === 'string' && tab.url.startsWith(CHATGPT_ORIGIN));
  return existing?.id !== undefined ? existing.id : null;
}

/** Find a ChatGPT tab, or open a new one. Never touches other sites. */
async function findOrOpenChatGptTab(): Promise<{ tabId: number } | { error: 'NO_TAB' }> {
  const existingId = await findChatGptTab();
  if (existingId !== null) {
    try {
      await chrome.tabs.update(existingId, { active: true });
    } catch {
      // Focus is best effort.
    }
    await waitForTabComplete(existingId, 15_000);
    return { tabId: existingId };
  }

  const created = await chrome.tabs.create({ url: `${CHATGPT_ORIGIN}/`, active: true });
  if (created.id === undefined) return { error: 'NO_TAB' };
  await waitForTabComplete(created.id, 25_000);
  return { tabId: created.id };
}

/** Load a specific URL in the tab and wait for it to settle. */
async function navigateTab(tabId: number, url: string): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { url });
  } catch {
    // The navigation itself is best effort; verification happens next.
  }
  await waitForTabComplete(tabId, 20_000);
  await new Promise((resolve) => setTimeout(resolve, NAVIGATION_SETTLE_MS));
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish();
    }).catch(finish);
    setTimeout(finish, timeoutMs);
  });
}

async function sendToContent(tabId: number, task: CompanionTask): Promise<SubmitOutcome> {
  const message: SubmitMessage = {
    type: 'HCR_SUBMIT',
    taskId: task.id,
    prompt: task.prompt,
    destination: task.destination ?? null,
  };
  return await sendToTab(tabId, message);
}

async function sendToTab(tabId: number, message: object): Promise<SubmitOutcome> {
  // The content script may still be injecting (or reloading); retry a few times.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const outcome = (await chrome.tabs.sendMessage(tabId, message)) as SubmitOutcome | undefined;
      if (outcome) return outcome;
      lastError = new Error('Empty response from content script');
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  return {
    status: 'ERROR',
    message: `Could not reach the ChatGPT tab: ${lastError instanceof Error ? lastError.message : 'unknown error'}`,
    chatgptState: 'tab_not_found',
  };
}

async function raceWithTimeout(work: Promise<SubmitOutcome>, timeoutMs: number): Promise<SubmitOutcome> {
  return await Promise.race([
    work,
    new Promise<SubmitOutcome>((resolve) =>
      setTimeout(
        () => resolve({ status: 'TIMEOUT', message: 'ChatGPT Web did not finish in time.' }),
        timeoutMs
      )
    ),
  ]);
}

/**
 * Drive one Web Handoff task: navigate to the SELECTED destination, verify it,
 * send the prompt and wait for the assistant. No navigation happens without a
 * selected destination, and a failed verification is reported as
 * PROJECT_NOT_FOUND / CHAT_NOT_FOUND - never silently retargeted.
 */
async function runHandoffTask(task: CompanionTask): Promise<void> {
  await postStage(task.id, 'opening_chatgpt');
  const tab = await findOrOpenChatGptTab();
  if ('error' in tab) {
    state.chatgptState = 'tab_not_found';
    await postResult(task.id, {
      status: 'NO_TAB',
      message: 'Open ChatGPT Web in this browser, then retry.',
      chatgptState: 'tab_not_found',
    });
    return;
  }

  await postStage(task.id, 'sending_prompt');
  let outcome = await raceWithTimeout(sendToContent(tab.tabId, task), TASK_TIMEOUT_MS);

  // The adapter asks the worker to load the destination first (a reload would
  // otherwise destroy the message channel mid-flight).
  let rounds = 0;
  while (outcome.status === 'NAVIGATE' && typeof outcome.message === 'string' && rounds < MAX_NAVIGATION_ROUNDS) {
    rounds += 1;
    await navigateTab(tab.tabId, outcome.message);
    outcome = await raceWithTimeout(sendToContent(tab.tabId, task), TASK_TIMEOUT_MS);
  }
  if (outcome.status === 'NAVIGATE') {
    outcome =
      task.destination?.chatMode === 'create'
        ? {
            status: 'PROJECT_NOT_FOUND',
            message: 'PROJECT_NOT_FOUND: the selected ChatGPT Project could not be opened.',
          }
        : {
            status: 'CHAT_NOT_FOUND',
            message: 'CHAT_NOT_FOUND: the selected chat session could not be opened.',
          };
  }

  if (outcome.chatgptState) state.chatgptState = outcome.chatgptState;
  await postStage(task.id, 'receiving_response');
  await postResult(task.id, outcome);
}

/** Discover ChatGPT Projects (metadata only) or sessions of one Project. */
async function runDiscoveryTask(task: CompanionTask): Promise<void> {
  await postStage(task.id, 'opening_chatgpt');
  const tab = await findOrOpenChatGptTab();
  if ('error' in tab) {
    state.chatgptState = 'tab_not_found';
    await postResult(task.id, {
      status: 'NO_TAB',
      message: 'Open ChatGPT Web in this browser, then refresh.',
      chatgptState: 'tab_not_found',
    });
    return;
  }

  if (task.kind === 'discover_chats') {
    // Sessions can only be listed from inside the selected Project page.
    const projectUrl =
      task.projectUrl || (task.projectId ? `${CHATGPT_ORIGIN}/project/${task.projectId}` : '');
    if (projectUrl) await navigateTab(tab.tabId, projectUrl);
    const chatsOutcome = await raceWithTimeout(
      sendToTab(tab.tabId, {
        type: 'HCR_DISCOVER_CHATS',
        taskId: task.id,
        projectId: task.projectId ?? '',
        projectUrl: task.projectUrl ?? projectUrl,
      }),
      30_000
    );
    await postStage(task.id, 'receiving_response');
    await postResult(task.id, chatsOutcome);
    return;
  }

  const projectsOutcome = await raceWithTimeout(
    sendToTab(tab.tabId, { type: 'HCR_DISCOVER_PROJECTS', taskId: task.id }),
    30_000
  );
  await postStage(task.id, 'receiving_response');
  await postResult(task.id, projectsOutcome);
}

async function processTask(task: CompanionTask): Promise<void> {
  if (state.busy || state.activeTask) return;
  state.busy = true;
  state.activeTask = task;

  try {
    if (task.kind === 'discover_projects' || task.kind === 'discover_chats') {
      await runDiscoveryTask(task);
      return;
    }
    await runHandoffTask(task);
  } catch (error) {
    await postResult(task.id, {
      status: 'ERROR',
      message: error instanceof Error ? error.message : 'Unknown companion error',
    });
  } finally {
    state.busy = false;
    state.activeTask = null;
  }
}

/** Where the ChatGPT tab is right now (popup status; never guessed). */
async function readCurrentContext(): Promise<{ project: string | null; session: string | null }> {
  try {
    const tabId = await findChatGptTab();
    if (tabId === null) return { project: null, session: null };
    const context = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'HCR_GET_CONTEXT' } satisfies ContextMessage),
      new Promise<CurrentChatgptContext | null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    if (!context || context.authRequired || !context.uiSupported) {
      return { project: null, session: null };
    }
    return {
      project: context.project?.name || context.project?.id || null,
      session: context.chat?.title || context.chat?.id || null,
    };
  } catch {
    // No content script / no tab: report Unknown instead of guessing.
    return { project: null, session: null };
  }
}

// ---- lifecycle ----------------------------------------------------------- //

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const kind = (message as { type?: string } | undefined)?.type;
  if (kind === 'HCR_POPUP_STATUS') {
    void (async () => {
      await loadToken();
      const context = await readCurrentContext();
      sendResponse({
        paired: state.token !== null,
        connected: state.lastHeartbeatAt !== null,
        lastHeartbeatAt: state.lastHeartbeatAt,
        chatgptState: state.chatgptState,
        busy: state.busy,
        currentProject: context.project,
        currentSession: context.session,
      });
    })();
    return true;
  }
  if (kind === 'HCR_POPUP_PAIR') {
    void (async () => {
      const code = String((message as { code?: string }).code ?? '').trim();
      const response = await hcrFetch('/api/browser-companion/pair', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        sendResponse({ ok: false, error: body.error ?? `Pairing failed (${response.status})` });
        return;
      }
      const payload = (await response.json()) as { token?: string };
      if (typeof payload.token === 'string') {
        await chrome.storage.local.set({ [STORAGE_TOKEN_KEY]: payload.token });
        state.token = payload.token;
        ensureTimers();
        void heartbeat();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'HCR did not return a pairing token.' });
      }
    })();
    return true;
  }
  if (kind === 'HCR_POPUP_TEST') {
    void (async () => {
      const token = state.token ?? (await loadToken());
      if (!token) {
        sendResponse({
          ok: false,
          error: 'Not paired with HCR. Generate a pairing code in HCR and pair first.',
        });
        return;
      }
      try {
        const response = await hcrFetchAuthed('/api/browser-companion/test', token, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          sendResponse({ ok: false, error: body.error ?? `Connection test failed (${response.status})` });
          return;
        }
        const payload = (await response.json()) as {
          connected?: boolean;
          paired?: boolean;
          lastSeenAt?: string | null;
          queuedTasks?: number;
        };
        sendResponse({
          ok: true,
          connected: payload.connected,
          paired: payload.paired,
          lastSeenAt: payload.lastSeenAt,
          queuedTasks: payload.queuedTasks,
        });
      } catch {
        sendResponse({ ok: false, error: 'Could not reach HCR at 127.0.0.1:7876. Is the HCR server running?' });
      }
    })();
    return true;
  }
  if (kind === 'HCR_POPUP_UNPAIR') {
    void (async () => {
      await chrome.storage.local.remove(STORAGE_TOKEN_KEY);
      state.token = null;
      state.lastHeartbeatAt = null;
      stopTimers();
      sendResponse({ ok: true });
    })();
    return true;
  }
  return false;
});

// Keep-alive: MV3 workers can be suspended; restart timers on the alarm tick.
chrome.alarms?.create('hcr-companion-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'hcr-companion-keepalive') {
    void bootstrap();
  }
});

async function bootstrap(): Promise<void> {
  const token = await loadToken();
  if (!token) return;
  ensureTimers();
  void heartbeat();
}

void bootstrap();
