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
  type Stage,
  type SubmitMessage,
  type SubmitOutcome,
} from './shared.js';

/**
 * HCR Browser Companion - background service worker (Manifest V3).
 *
 * Responsibilities:
 *  - keep a local pairing secret (from the HCR pairing code) in storage
 *  - heartbeat to local HCR and pick up queued Web Handoff tasks
 *  - find/open ChatGPT Web and drive the content script
 *  - return ONLY the final assistant response to HCR
 *
 * The companion never reads cookies, never automates login, never touches
 * unrelated tabs, and never sends the pairing secret anywhere but HCR.
 */

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

/** Find a ChatGPT tab, or open a new one. Never touches other sites. */
async function findOrOpenChatGptTab(): Promise<{ tabId: number } | { error: 'NO_TAB' }> {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => typeof tab.url === 'string' && tab.url.startsWith(CHATGPT_ORIGIN));
  if (existing?.id !== undefined) {
    try {
      await chrome.tabs.update(existing.id, { active: true });
    } catch {
      // Focus is best effort.
    }
    await waitForTabComplete(existing.id, 15_000);
    return { tabId: existing.id };
  }

  const created = await chrome.tabs.create({ url: `${CHATGPT_ORIGIN}/`, active: true });
  if (created.id === undefined) return { error: 'NO_TAB' };
  await waitForTabComplete(created.id, 25_000);
  return { tabId: created.id };
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
  const message: SubmitMessage = { type: 'HCR_SUBMIT', taskId: task.id, prompt: task.prompt };

  // The content script may still be injecting; retry a few times.
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

async function processTask(task: CompanionTask): Promise<void> {
  if (state.busy || state.activeTask) return;
  state.busy = true;
  state.activeTask = task;

  try {
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
    const outcome = await Promise.race([
      sendToContent(tab.tabId, task),
      new Promise<SubmitOutcome>((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: 'TIMEOUT',
              message: 'ChatGPT Web did not finish in time.',
            }),
          TASK_TIMEOUT_MS
        )
      ),
    ]);

    if (outcome.chatgptState) state.chatgptState = outcome.chatgptState;
    await postStage(task.id, 'receiving_response');
    await postResult(task.id, outcome);
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
      sendResponse({
        paired: state.token !== null,
        connected: state.lastHeartbeatAt !== null,
        lastHeartbeatAt: state.lastHeartbeatAt,
        chatgptState: state.chatgptState,
        busy: state.busy,
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
