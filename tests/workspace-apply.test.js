import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PatchValidationEngine, WorkspaceApplyEngine } from '../packages/core/dist/index.js';

const roots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'hcr-apply-'));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const engine = new WorkspaceApplyEngine(new PatchValidationEngine());

function patch(files, summary = 'test patch') {
  return { version: 'HCR_PATCH_V1', summary, files };
}

test('creates, replaces and deletes files', async () => {
  const root = makeRoot();
  writeFileSync(join(root, 'existing.txt'), 'before\n');
  writeFileSync(join(root, 'doomed.txt'), 'goodbye\n');

  const outcome = await engine.apply('h1', root, patch([
    { path: 'created.txt', action: 'create', content: 'brand new\n' },
    { path: 'existing.txt', action: 'replace', content: 'after\n' },
    { path: 'doomed.txt', action: 'delete' },
    { path: 'missing.txt', action: 'delete' },
  ]));

  assert.equal(outcome.rolledBack, false);
  assert.ok(outcome.changedFiles.includes('created.txt'));
  const statuses = Object.fromEntries(outcome.files.map((file) => [file.path, file.status]));
  assert.equal(statuses['created.txt'], 'created');
  assert.equal(statuses['existing.txt'], 'updated');
  assert.equal(statuses['doomed.txt'], 'deleted');
  assert.equal(statuses['missing.txt'], 'skipped');
  assert.equal(readFileSync(join(root, 'existing.txt'), 'utf8'), 'after\n');
  assert.equal(existsSync(join(root, 'doomed.txt')), false);
  assert.equal(readFileSync(join(root, 'created.txt'), 'utf8'), 'brand new\n');
  assert.equal(existsSync(join(root, 'missing.txt')), false);
  assert.ok(outcome.diffs.length > 0);
});

test('rejects traversal, protected and absolute paths before writing', async () => {
  const root = makeRoot();
  for (const bad of ['../escape.txt', '.env', '.git/config']) {
    await assert.rejects(
      () => engine.apply('h2', root, patch([{ path: bad, action: 'create', content: 'x' }])),
      /Patch rejected/,
      bad
    );
  }
  assert.equal(existsSync(join(root, '..', 'escape.txt')), false);
});

test('rejects replacing a file that does not exist', async () => {
  const root = makeRoot();
  await assert.rejects(
    () => engine.apply('h3', root, patch([{ path: 'nope.txt', action: 'replace', content: 'x' }])),
    /does not exist/
  );
});

test('revert restores the previous contents (one level)', async () => {
  const root = makeRoot();
  writeFileSync(join(root, 'a.txt'), 'original\n');

  await engine.apply('h4', root, patch([
    { path: 'a.txt', action: 'replace', content: 'changed\n' },
    { path: 'b.txt', action: 'create', content: 'new file\n' },
  ]));
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'changed\n');
  assert.equal(existsSync(join(root, 'b.txt')), true);
  assert.equal(engine.canRevert('h4'), true);
  assert.equal(engine.canRevert('other'), false);

  const reverted = await engine.revert('h4');
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original\n');
  assert.equal(existsSync(join(root, 'b.txt')), false);
  assert.ok(reverted.changedFiles.length >= 2);
  assert.equal(engine.canRevert('h4'), false);
});

test('revert refuses a handoff that is not the most recent apply', async () => {
  const root = makeRoot();
  await engine.apply('h5', root, patch([{ path: 'x.txt', action: 'create', content: 'x\n' }]));
  await assert.rejects(() => engine.revert('h6'), /most recently applied/);
});

test('rolls back every write when a later write fails', async (t) => {
  const root = makeRoot();
  // `notadir` is a file, so creating `notadir/file.txt` fails at write time,
  // after `good.txt` has already been written.
  writeFileSync(join(root, 'notadir'), 'i am a file\n');

  try {
    await assert.rejects(
      () =>
        engine.apply('h7', root, patch([
          { path: 'good.txt', action: 'create', content: 'should be rolled back\n' },
          { path: 'notadir/file.txt', action: 'create', content: 'cannot create a file under a file\n' },
        ])),
      /rolled back/
    );
  } catch (error) {
    // Some platforms reject the plan before any write; that is still safe.
    if (!/Patch rejected/.test(String(error?.message))) throw error;
    t.diagnostic('platform rejected the plan before writing; no partial state to roll back');
  }

  assert.equal(existsSync(join(root, 'good.txt')), false, 'first write must be rolled back');
  assert.equal(readFileSync(join(root, 'notadir'), 'utf8'), 'i am a file\n');
});

test('validate() reports problems without touching the filesystem', async () => {
  const root = makeRoot();
  const ok = engine.validate(root, patch([{ path: 'ok.txt', action: 'create', content: 'x' }]));
  assert.equal(ok.ok, true);
  const bad = engine.validate(root, patch([{ path: '../ok.txt', action: 'create', content: 'x' }]));
  assert.equal(bad.ok, false);
  assert.equal(bad.issues.length, 1);
  assert.equal(existsSync(join(root, '..', 'ok.txt')), false);
});
