import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DatabaseEngine,
  ProjectContextEngine,
  PatchValidationEngine,
  WorkspaceApplyEngine,
  BrowserCompanionEngine,
  WebHandoffEngine,
} from '../packages/core/dist/index.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'hcr-handoff-db-'));
  dirs.push(dir);
  process.env.HCR_DATA_DIR = dir;
  return dir;
}

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'hcr-handoff-project-'));
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
  // Same wiring the API server uses: companion results feed the handoff.
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

const patchJson = (files, summary = 'Add the Inventory menu') =>
  JSON.stringify({ version: 'HCR_PATCH_V1', summary, files });

test('prepare builds context without sending anything', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();

  const detail = await handoff.prepare({ task: 'Add an Inventory menu like Sales', projectDir: project });
  assert.equal(detail.status, 'context_ready');
  assert.equal(detail.source, 'chatgpt-web');
  assert.ok(detail.contextSummary.fileCount > 0);
  assert.equal(detail.contextSummary.files.some((file) => file.path.includes('.env')), false);
  assert.equal(companion.queuedTaskCount(), 0, 'prepare must not queue anything');
  assert.equal(handoff.list().length, 1);
});

test('send queues exactly one companion task', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const detail = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });

  const sent = await handoff.send(detail.id);
  assert.equal(sent.status, 'waiting_for_browser');
  assert.equal(sent.companion.queued, true);
  assert.equal(companion.queuedTaskCount(), 1);

  const task = companion.takeTask();
  assert.equal(task.handoffId, detail.id);
  assert.match(task.prompt, /HCR_PATCH_V1/);

  // Sending again while the task is pending is refused.
  await assert.rejects(() => handoff.send(detail.id), /already queued/);
});

test('a valid HCR_PATCH_V1 response becomes reviewable, applies and reverts', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });
  await handoff.send(prepared.id);

  await respond(companion, {
    status: 'OK',
    responseText: patchJson([
      { path: 'src/menu.ts', action: 'replace', content: "export const menu = ['sales', 'inventory'];\n" },
      { path: 'src/inventory.ts', action: 'create', content: "export const inventory = [];\n" },
    ]),
  });

  const reviewed = await handoff.get(prepared.id);
  assert.equal(reviewed.status, 'ready_for_review');
  assert.equal(reviewed.canApply, true);
  assert.equal(reviewed.files.length, 2);
  assert.ok(reviewed.diffs.length > 0);
  assert.match(reviewed.summary, /Inventory/);

  const applied = await handoff.apply(prepared.id);
  assert.equal(applied.detail.status, 'applied');
  assert.equal(applied.outcome.changedFiles.length, 2);
  assert.equal(
    readFileSync(join(project, 'src', 'menu.ts'), 'utf8'),
    "export const menu = ['sales', 'inventory'];\n"
  );
  assert.equal(existsSync(join(project, 'src', 'inventory.ts')), true);

  const reverted = await handoff.revert(prepared.id);
  assert.equal(reverted.detail.status, 'reverted');
  assert.equal(readFileSync(join(project, 'src', 'menu.ts'), 'utf8'), "export const menu = ['sales'];\n");
  assert.equal(existsSync(join(project, 'src', 'inventory.ts')), false);
});

test('a non-JSON response is rejected and can be retried with a correction prompt', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });
  await handoff.send(prepared.id);

  await respond(companion, {
    status: 'OK',
    responseText: 'Sure - just open src/menu.ts and add the entry by hand.',
  });

  const invalid = await handoff.get(prepared.id);
  assert.equal(invalid.status, 'invalid_patch_response');
  assert.ok(invalid.patchErrors.length > 0);
  assert.equal(invalid.canApply, false);
  assert.equal(invalid.canRetry, true);
  assert.equal(existsSync(join(project, 'src', 'menu.ts')), true, 'nothing was written');
  assert.equal(companion.queuedTaskCount(), 0, 'the consumed task is gone');

  const retried = await handoff.retry(prepared.id);
  assert.equal(retried.status, 'waiting_for_browser');
  assert.equal(companion.queuedTaskCount(), 1);
  const task = companion.takeTask();
  assert.match(task.prompt, /did not match HCR_PATCH_V1/);
  assert.match(task.prompt, /Your previous response was:/);
});

test('path traversal in a response is rejected before review', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Escape the project', projectDir: project });
  await handoff.send(prepared.id);

  await respond(companion, {
    status: 'OK',
    responseText: patchJson([{ path: '../escaped.txt', action: 'create', content: 'pwned\n' }], 'escape attempt'),
  });

  const detail = await handoff.get(prepared.id);
  assert.equal(detail.status, 'invalid_patch_response');
  assert.match(detail.error, /traversal/i);
  assert.equal(existsSync(join(project, '..', 'escaped.txt')), false);
});

test('protected files are refused even when the schema is valid', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Write a secret', projectDir: project });
  await handoff.send(prepared.id);

  await respond(companion, {
    status: 'OK',
    responseText: patchJson([{ path: '.env', action: 'create', content: 'TOKEN=stolen\n' }], 'write a secret'),
  });

  const detail = await handoff.get(prepared.id);
  assert.equal(detail.status, 'invalid_patch_response');
  assert.match(detail.error, /protected file/i);
  assert.equal(existsSync(join(project, '.env')), false);
});

test('AUTH_REQUIRED keeps the handoff waiting and explains what to do', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });
  await handoff.send(prepared.id);

  await respond(companion, { status: 'AUTH_REQUIRED' });

  const detail = await handoff.get(prepared.id);
  assert.equal(detail.status, 'waiting_for_browser');
  assert.match(detail.error, /Open ChatGPT and sign in, then retry\./);
  assert.equal(companion.status().chatgpt.state, 'auth_required');
  assert.equal(existsSync(join(project, 'src', 'menu.ts')), true, 'no file was written');
});

test('a browser timeout becomes an error state', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });
  await handoff.send(prepared.id);

  await respond(companion, { status: 'TIMEOUT', message: 'No response after 210s.' });

  const detail = await handoff.get(prepared.id);
  assert.equal(detail.status, 'error');
  assert.match(detail.error, /No response after 210s\./);
});

test('a rejected proposal is never applied', async () => {
  const { handoff, companion } = buildEngine();
  const project = makeProject();
  const before = readFileSync(join(project, 'src', 'menu.ts'), 'utf8');
  const prepared = await handoff.prepare({ task: 'Add an Inventory menu', projectDir: project });
  await handoff.send(prepared.id);

  await respond(companion, {
    status: 'OK',
    responseText: patchJson([{ path: 'src/menu.ts', action: 'replace', content: 'rejected\n' }]),
  });

  const rejected = await handoff.reject(prepared.id);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.canApply, false);
  await assert.rejects(() => handoff.apply(prepared.id), /not ready to apply/);
  assert.equal(readFileSync(join(project, 'src', 'menu.ts'), 'utf8'), before);
});
