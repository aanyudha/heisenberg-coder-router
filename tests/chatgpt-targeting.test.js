import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DatabaseEngine,
  ProjectContextEngine,
  PatchValidationEngine,
  WorkspaceApplyEngine,
  BrowserCompanionEngine,
  WebHandoffEngine,
  destinationMatches,
  restoreChatgptSelection,
  projectMatchesDestination,
  chatMatchesDestination,
  normalizeChatgptUrl,
  chatgptProjectIdFromUrl,
  chatgptChatIdFromUrl,
} from '../packages/core/dist/index.js';

/**
 * ChatGPT Project + Chat Session targeting.
 *
 * Everything browser-side is MOCKED: these tests exercise HCR's deterministic
 * destination logic (discovery, selection, restore, error codes) and never
 * touch a real ChatGPT account.
 */

const dirs = [];

function cleanup(dir) {
  // SQLite WAL files can stay briefly locked on Windows; never fail the run.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // retry
    }
  }
}

function makeDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hcr-targeting-db-'));
  dirs.push(dir);
  process.env.HCR_DATA_DIR = dir;
  return dir;
}

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'hcr-targeting-project-'));
  dirs.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'README.md'), '# Fixture\n');
  writeFileSync(join(root, 'src', 'menu.ts'), "export const menu = ['sales'];\n");
  return root;
}

after(() => {
  delete process.env.HCR_DATA_DIR;
  for (const dir of dirs) cleanup(dir);
});

function buildEngine() {
  makeDataDir();
  const db = new DatabaseEngine();
  db.initialize();
  const contextEngine = new ProjectContextEngine();
  const applyEngine = new WorkspaceApplyEngine(new PatchValidationEngine());
  const companion = new BrowserCompanionEngine(db);
  const handoff = new WebHandoffEngine(db, contextEngine, applyEngine, companion);
  companion.setResultHandler((handoffId, taskId, result) => handoff.handleResult(handoffId, taskId, result));
  return { db, companion, handoff, applyEngine };
}

/** Simulates the extension picking up the queued task and posting its result. */
async function respond(companion, result) {
  const task = companion.takeTask();
  assert.ok(task, 'expected a queued companion task');
  await companion.resolveTask(task.id, result);
  return task;
}

/**
 * Simulates a connected companion answering one discovery request.
 * `answer` is the mocked extension payload (projects / chats / failure).
 */
async function discover(companion, call, answer) {
  const pending = call();
  const task = companion.takeTask();
  assert.ok(task, 'expected a queued discovery task');
  assert.equal(task.handoffId, '', 'discovery never belongs to a handoff');
  await companion.resolveTask(task.id, answer);
  return { answer: await pending, task };
}

const patchJson = (files, summary = 'Add the Inventory menu') =>
  JSON.stringify({ version: 'HCR_PATCH_V1', summary, files });

const PROJECT_URL = 'https://chatgpt.com/project/proj-1';
const CHAT_URL = 'https://chatgpt.com/c/chat-1';

function continueDestination(overrides = {}) {
  return {
    chatgptProjectId: 'proj-1',
    chatgptProjectName: 'HCR Development',
    chatgptProjectUrl: PROJECT_URL,
    chatId: 'chat-1',
    chatTitle: 'Browser Companion Work',
    chatUrl: CHAT_URL,
    chatMode: 'continue',
    newChatTitle: null,
    ...overrides,
  };
}

const PROJECTS_PAYLOAD = [
  { id: 'proj-1', name: 'HCR Development', url: PROJECT_URL },
  { id: 'proj-2', name: 'Docs', url: 'https://chatgpt.com/project/proj-2' },
];

const CHATS_PAYLOAD = [
  { id: 'chat-1', title: 'Browser Companion Work', url: CHAT_URL },
  { id: 'chat-2', title: 'Routing notes', url: 'https://chatgpt.com/c/chat-2' },
];

// ---- discovery (metadata only, mocked companion) ---------------------- //

test('project discovery returns metadata only and queues no handoff', async () => {
  const { companion, handoff } = buildEngine();
  companion.heartbeat();

  const { answer, task } = await discover(companion, () => companion.discoverProjects(), {
    status: 'OK',
    projects: PROJECTS_PAYLOAD,
  });

  assert.equal(task.kind, 'discover_projects');
  assert.equal(answer.status, 'ok');
  assert.equal(answer.error, null);
  assert.deepEqual(answer.projects, PROJECTS_PAYLOAD);
  assert.equal(companion.queuedTaskCount(), 0, 'the answered task is consumed');
  assert.equal(handoff.list().length, 0, 'discovery never creates a handoff');
});

test('discovery strips everything except id/name/url and derives ids from URLs', async () => {
  const { companion } = buildEngine();
  companion.heartbeat();

  const { answer } = await discover(companion, () => companion.discoverProjects(), {
    status: 'OK',
    projects: [
      // No id: derived from the URL.
      { name: 'HCR Development', url: `${PROJECT_URL}/`, snippet: 'secret excerpt', unread: 3 },
      // Duplicate of the first project (same derived id): dropped.
      { id: 'proj-1', name: 'Duplicate', url: PROJECT_URL, messages: ['hi'] },
      { id: 'proj-2', name: 'Docs', url: 'https://chatgpt.com/project/proj-2', lastMessage: 'private' },
      // No URL at all: dropped (an item without identity is useless).
      { id: 'proj-3', name: 'No url' },
      'not-an-object',
    ],
  });

  assert.equal(answer.status, 'ok');
  assert.deepEqual(answer.projects, [
    { id: 'proj-1', name: 'HCR Development', url: `${PROJECT_URL}/` },
    { id: 'proj-2', name: 'Docs', url: 'https://chatgpt.com/project/proj-2' },
  ]);
  const [first] = answer.projects;
  assert.deepEqual(Object.keys(first).sort(), ['id', 'name', 'url'], 'metadata only');
});

test('session discovery targets exactly one project and returns only its sessions', async () => {
  const { companion } = buildEngine();
  companion.heartbeat();

  const { answer, task } = await discover(
    companion,
    () => companion.discoverChats('proj-1', PROJECT_URL),
    { status: 'OK', chats: CHATS_PAYLOAD }
  );

  assert.equal(task.kind, 'discover_chats');
  assert.equal(task.projectId, 'proj-1');
  assert.equal(task.projectUrl, PROJECT_URL);
  assert.equal(answer.status, 'ok');
  assert.deepEqual(answer.chats, CHATS_PAYLOAD);
});

test('empty discovery is an empty list, not an error', async () => {
  const { companion } = buildEngine();
  companion.heartbeat();

  const projects = await discover(companion, () => companion.discoverProjects(), {
    status: 'OK',
    projects: [],
  });
  assert.equal(projects.answer.status, 'ok');
  assert.deepEqual(projects.answer.projects, []);

  const chats = await discover(companion, () => companion.discoverChats('proj-1', PROJECT_URL), {
    status: 'OK',
    chats: [],
  });
  assert.equal(chats.answer.status, 'ok');
  assert.deepEqual(chats.answer.chats, []);
});

test('discovery failures map to explicit statuses and stay retryable', async () => {
  const { companion } = buildEngine();
  companion.heartbeat();

  const auth = await discover(companion, () => companion.discoverProjects(), {
    status: 'AUTH_REQUIRED',
    message: 'sign-in page is open',
  });
  assert.equal(auth.answer.status, 'auth_required');
  assert.match(auth.answer.error, /sign-in/);

  const ui = await discover(companion, () => companion.discoverChats('proj-1', PROJECT_URL), {
    status: 'UI_UNSUPPORTED',
  });
  assert.equal(ui.answer.status, 'ui_unsupported');
  assert.match(ui.answer.error, /could not be understood/);

  const noTab = await discover(companion, () => companion.discoverProjects(), { status: 'NO_TAB' });
  assert.equal(noTab.answer.status, 'no_tab');

  // Failures are never cached: the next call queues a fresh task.
  assert.equal(companion.queuedTaskCount(), 0);
  const retry = companion.discoverProjects();
  assert.ok(companion.takeTask(), 'a failed discovery can be retried');
  await companion.resolveTask(companion.takeTask().id, { status: 'OK', projects: PROJECTS_PAYLOAD });
  assert.equal((await retry).status, 'ok');
});

test('discovery without a connected companion does not queue anything', async () => {
  const { companion } = buildEngine();

  const answer = await companion.discoverProjects();
  assert.equal(answer.status, 'not_connected');
  assert.match(answer.error, /not connected/i);
  assert.equal(companion.queuedTaskCount(), 0);
  assert.equal(companion.takeTask(), null);
});

test('successful discovery is cached briefly and refresh bypasses the cache', async () => {
  const { companion } = buildEngine();
  companion.heartbeat();

  const first = await discover(companion, () => companion.discoverProjects(), {
    status: 'OK',
    projects: PROJECTS_PAYLOAD,
  });
  assert.equal(first.answer.status, 'ok');

  // Within the cache window: answered from memory, no second task.
  const cached = await companion.discoverProjects();
  assert.deepEqual(cached.projects, PROJECTS_PAYLOAD);
  assert.equal(companion.takeTask(), null, 'cached answer does not queue a task');

  // Refresh: a real discovery round trip happens again.
  const refreshed = companion.discoverProjects({ refresh: true });
  const task = companion.takeTask();
  assert.ok(task, 'refresh queues a new discovery task');
  await companion.resolveTask(task.id, { status: 'OK', projects: [PROJECTS_PAYLOAD[0]] });
  assert.deepEqual((await refreshed).projects, [PROJECTS_PAYLOAD[0]]);
});

// ---- destination validation on send ----------------------------------- //

test('send refuses a destination without a ChatGPT Project', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });

  await assert.rejects(
    () => handoff.send(prepared.id, { destination: continueDestination({ chatgptProjectId: '', chatgptProjectUrl: '' }) }),
    /Select a ChatGPT Project/
  );
  assert.equal(companion.queuedTaskCount(), 0, 'nothing is queued without a valid destination');
});

test('send refuses Continue mode without a selected session', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });

  await assert.rejects(
    () =>
      handoff.send(prepared.id, {
        destination: continueDestination({ chatId: null, chatTitle: null, chatUrl: null }),
      }),
    /Select a chat session/
  );
  assert.equal(companion.queuedTaskCount(), 0);
});

test('send without a destination keeps the legacy behavior', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });

  await handoff.send(prepared.id);
  const task = companion.takeTask();
  assert.equal(task.kind, 'handoff');
  assert.equal(task.destination, null, 'no destination means the current tab is used');

  const detail = await handoff.get(prepared.id);
  assert.equal(detail.destination, null);
});

// ---- deterministic targeting ------------------------------------------ //

test('the queued task carries the exact selected destination', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });

  await handoff.send(prepared.id, { destination: continueDestination() });
  const task = companion.takeTask();
  assert.deepEqual(task.destination, continueDestination());

  const detail = await handoff.get(prepared.id);
  assert.deepEqual(detail.destination, continueDestination(), 'stored on the handoff itself');

  // The local mapping is remembered immediately (last-used restore).
  const { newChatTitle, ...mapping } = continueDestination();
  assert.equal(newChatTitle, null);
  assert.deepEqual(handoff.destinationFor(project), mapping);
});

test('a project id is derived from the project URL when only a URL is given', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });

  await handoff.send(prepared.id, {
    destination: continueDestination({ chatgptProjectId: '', chatgptProjectName: '' }),
  });
  const task = companion.takeTask();
  assert.equal(task.destination.chatgptProjectId, 'proj-1');
});

test('PROJECT_NOT_FOUND is reported and never falls back to another destination', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });
  await handoff.send(prepared.id, { destination: continueDestination({ chatgptProjectId: 'proj-gone' }) });

  await respond(companion, {
    status: 'PROJECT_NOT_FOUND',
    message: 'not inside the selected ChatGPT Project.',
  });

  const detail = await handoff.get(prepared.id);
  assert.equal(detail.status, 'error');
  assert.match(detail.error, /^PROJECT_NOT_FOUND:/);
  assert.match(detail.error, /Refresh Projects/);
  assert.equal(companion.queuedTaskCount(), 0, 'no silent retry against another project');
  assert.equal(detail.destination.chatgptProjectId, 'proj-gone', 'the selection is never swapped');
  assert.equal(handoff.destinationFor(project).chatgptProjectId, 'proj-gone', 'mapping untouched');
});

test('CHAT_NOT_FOUND is reported and never falls back to a generic chat', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });
  await handoff.send(prepared.id, { destination: continueDestination({ chatId: 'chat-deleted' }) });

  await respond(companion, { status: 'CHAT_NOT_FOUND', message: 'the session is not open.' });

  const detail = await handoff.get(prepared.id);
  assert.equal(detail.status, 'error');
  assert.match(detail.error, /^CHAT_NOT_FOUND:/);
  assert.match(detail.error, /Refresh Sessions/);
  assert.equal(companion.queuedTaskCount(), 0, 'no fallback send into a new/random chat');
  assert.equal(detail.destination.chatId, 'chat-deleted', 'selection untouched');
});

test('UI_UNSUPPORTED is reported as its own deterministic code', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });
  await handoff.send(prepared.id, { destination: continueDestination() });

  await respond(companion, { status: 'UI_UNSUPPORTED' });

  const detail = await handoff.get(prepared.id);
  assert.equal(detail.status, 'error');
  assert.match(detail.error, /^UI_UNSUPPORTED:/);
});

// ---- continue / create flows ------------------------------------------ //

test('continue flow: the reported session becomes the remembered mapping', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });
  await handoff.send(prepared.id, { destination: continueDestination({ chatId: 'chat-old' }) });

  await respond(companion, {
    status: 'OK',
    responseText: patchJson([
      { path: 'src/menu.ts', action: 'replace', content: "export const menu = ['sales', 'inventory'];\n" },
    ]),
    session: {
      chatgptProjectId: 'proj-1',
      chatgptProjectName: 'HCR Development',
      chatgptProjectUrl: PROJECT_URL,
      chatId: 'chat-9',
      chatTitle: 'Renamed by ChatGPT',
      chatUrl: 'https://chatgpt.com/c/chat-9',
      chatMode: 'continue',
    },
  });

  const detail = await handoff.get(prepared.id);
  assert.equal(detail.status, 'ready_for_review');
  const saved = handoff.destinationFor(project);
  assert.equal(saved.chatId, 'chat-9', 'the session actually used wins');
  assert.equal(saved.chatTitle, 'Renamed by ChatGPT');
  assert.equal(saved.chatgptProjectId, 'proj-1');
});

test('create flow: the newly created session is remembered for the local project', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });
  const createDestination = continueDestination({
    chatId: null,
    chatTitle: null,
    chatUrl: null,
    chatMode: 'create',
    newChatTitle: 'Inventory work',
  });

  await handoff.send(prepared.id, { destination: createDestination });
  const task = companion.takeTask();
  assert.equal(task.destination.chatMode, 'create');
  assert.equal(task.destination.newChatTitle, 'Inventory work');

  await respond(companion, {
    status: 'OK',
    responseText: patchJson([
      { path: 'src/menu.ts', action: 'replace', content: "export const menu = ['sales', 'inventory'];\n" },
    ]),
    session: {
      chatgptProjectId: 'proj-1',
      chatgptProjectName: 'HCR Development',
      chatgptProjectUrl: PROJECT_URL,
      chatId: 'chat-created',
      chatTitle: 'Inventory work',
      chatUrl: 'https://chatgpt.com/c/chat-created',
      chatMode: 'create',
    },
  });

  const detail = await handoff.get(prepared.id);
  assert.equal(detail.status, 'ready_for_review');
  const saved = handoff.destinationFor(project);
  assert.equal(saved.chatId, 'chat-created', 'create mode settles on the created session');
  assert.equal(saved.chatMode, 'create');
});

test('retries keep the original destination (deterministic, no re-selection)', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });
  await handoff.send(prepared.id, { destination: continueDestination() });

  await respond(companion, { status: 'OK', responseText: 'Sure, edit the file yourself.' });
  assert.equal((await handoff.get(prepared.id)).status, 'invalid_patch_response');

  await handoff.retry(prepared.id);
  const task = companion.takeTask();
  assert.equal(task.kind, 'handoff');
  assert.deepEqual(task.destination, continueDestination(), 'the same destination is reused');
  assert.match(task.prompt, /did not match HCR_PATCH_V1/);
});

// ---- identity: URL/id decide, names never do --------------------------- //

test('restore matches by id/URL only - never by name and never at random', () => {
  const saved = continueDestination({
    chatgptProjectName: 'Old Project Name',
    chatTitle: 'Old Session Name',
  });
  const projects = [
    { id: 'proj-1', name: 'Renamed Project', url: `${PROJECT_URL}/` },
    // Same name as the saved one, different identity: must NOT be chosen.
    { id: 'proj-2', name: 'Old Project Name', url: 'https://chatgpt.com/project/proj-2' },
  ];
  const chats = [
    { id: 'chat-1', title: 'Renamed Session', url: `${CHAT_URL}` },
    { id: 'chat-2', title: 'Old Session Name', url: 'https://chatgpt.com/c/chat-2' },
  ];

  const restored = restoreChatgptSelection(projects, chats, saved);
  assert.equal(restored.project?.id, 'proj-1', 'id wins, the look-alike name is ignored');
  assert.equal(restored.chat?.id, 'chat-1');

  // Saved identity no longer exists: nothing is auto-selected.
  const gone = restoreChatgptSelection(projects, chats, {
    ...saved,
    chatgptProjectId: 'proj-missing',
    chatgptProjectUrl: 'https://chatgpt.com/project/proj-missing',
    chatId: 'chat-missing',
    chatUrl: 'https://chatgpt.com/c/chat-missing',
  });
  assert.equal(gone.project, null);
  assert.equal(gone.chat, null);

  // No saved mapping at all: nothing is auto-selected.
  const none = restoreChatgptSelection(projects, chats, null);
  assert.equal(none.project, null);
  assert.equal(none.chat, null);

  // Create mode restores the project but never invents a session.
  const createMode = restoreChatgptSelection(projects, [], { ...saved, chatMode: 'create' });
  assert.equal(createMode.project?.id, 'proj-1');
  assert.equal(createMode.chat, null);
});

test('destinationMatches accepts only the selected chat (continue) or project (create)', () => {
  const continueDestinationSelection = continueDestination();

  // Continue: only the exact selected session matches.
  assert.equal(destinationMatches(CHAT_URL, continueDestinationSelection), true);
  assert.equal(destinationMatches(`${CHAT_URL}/`, continueDestinationSelection), true, 'trailing slash');
  assert.equal(destinationMatches('https://chatgpt.com/c/chat-2', continueDestinationSelection), false);
  assert.equal(destinationMatches('https://chatgpt.com/c/chat-1?model=x', continueDestinationSelection), true);
  assert.equal(destinationMatches('https://chatgpt.com/', continueDestinationSelection), false, 'never the generic home');
  assert.equal(destinationMatches(PROJECT_URL, continueDestinationSelection), false, 'the project page is not the session');
  assert.equal(destinationMatches(null, continueDestinationSelection), false);

  // Create: only the exact selected project page matches.
  const createDestinationSelection = continueDestination({ chatMode: 'create' });
  assert.equal(destinationMatches(PROJECT_URL, createDestinationSelection), true);
  assert.equal(destinationMatches(`${PROJECT_URL}/`, createDestinationSelection), true);
  assert.equal(destinationMatches('https://chatgpt.com/project/proj-2', createDestinationSelection), false);
  assert.equal(destinationMatches(CHAT_URL, createDestinationSelection), false);

  // Identity by URL when ids are missing.
  const urlOnly = continueDestination({ chatId: null, chatUrl: `${CHAT_URL}` });
  assert.equal(destinationMatches(CHAT_URL, urlOnly), true);
});

test('project/chat matching prefers ids and URLs over display names', () => {
  const saved = continueDestination({ chatgptProjectName: 'Same Name', chatTitle: 'Same Title' });

  assert.equal(
    projectMatchesDestination({ id: 'proj-1', name: 'Totally Different', url: PROJECT_URL }, saved),
    true,
    'renamed project still matches by id'
  );
  assert.equal(
    projectMatchesDestination({ id: 'proj-2', name: 'Same Name', url: 'https://chatgpt.com/project/proj-2' }, saved),
    false,
    'a project with the same name but another id never matches'
  );

  assert.equal(
    chatMatchesDestination({ id: 'chat-1', title: 'Renamed', url: CHAT_URL }, saved),
    true,
    'renamed session still matches by id'
  );
  assert.equal(
    chatMatchesDestination({ id: 'chat-2', title: 'Same Title', url: 'https://chatgpt.com/c/chat-2' }, saved),
    false
  );

  // URL identity when the destination has no id.
  const urlDestination = continueDestination({ chatId: null, chatTitle: null, chatUrl: `${CHAT_URL}` });
  assert.equal(chatMatchesDestination({ id: 'chat-1', title: '', url: CHAT_URL }, urlDestination), true);
});

test('URL helpers parse ChatGPT project and session URLs', () => {
  assert.equal(normalizeChatgptUrl('https://chatgpt.com/c/c1/'), 'https://chatgpt.com/c/c1');
  assert.equal(normalizeChatgptUrl('  '), null);
  assert.equal(normalizeChatgptUrl(''), null);
  assert.equal(chatgptProjectIdFromUrl('https://chatgpt.com/project/abc-123'), 'abc-123');
  assert.equal(chatgptProjectIdFromUrl('https://chatgpt.com/projects/abc-123/'), 'abc-123');
  assert.equal(chatgptProjectIdFromUrl(CHAT_URL), null);
  assert.equal(chatgptChatIdFromUrl('https://chatgpt.com/c/chat-1'), 'chat-1');
  assert.equal(chatgptChatIdFromUrl('https://chatgpt.com/chat/chat-1?model=x'), 'chat-1');
  assert.equal(chatgptChatIdFromUrl('https://chatgpt.com/conversation/chat-1'), 'chat-1');
  assert.equal(chatgptChatIdFromUrl(PROJECT_URL), null);
});
