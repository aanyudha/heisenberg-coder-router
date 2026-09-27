import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HcoderPatchStore, HcoderStoreError } from '../packages/core/dist/index.js';

const dirs = [];

function cleanup(dir) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // retry
    }
  }
}

after(() => {
  delete process.env.HCODER_HOME;
  for (const dir of dirs) cleanup(dir);
});

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'hcr-hcoder-home-'));
  dirs.push(dir);
  return dir;
}

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'hcr-hcoder-store-'));
  dirs.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), "export const menu = ['sales'];\n");
  writeFileSync(join(root, 'notes.md'), '# Notes\n');
  return root;
}

function storeWith(home) {
  process.env.HCODER_HOME = home;
  return new HcoderPatchStore(home);
}

const patch = (files, summary = 'Update the menu') => ({
  version: 'HCR_PATCH_V1',
  summary,
  files,
});

test('staging never touches the project filesystem', async () => {
  const home = makeHome();
  const project = makeProject();
  const store = storeWith(home);
  const before = readFileSync(join(project, 'src', 'app.ts'), 'utf8');

  const staged = store.stage(
    project,
    patch([{ path: 'src/app.ts', action: 'replace', content: "export const menu = ['sales', 'inventory'];\n" }])
  );

  assert.equal(staged.projectRoot, resolve(project));
  assert.equal(store.pending(project).id, staged.id);
  assert.equal(readFileSync(join(project, 'src', 'app.ts'), 'utf8'), before, 'staging must not write');

  const history = store.history(project);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'staged');
  assert.equal(history[0].filesChanged, 1);
});

test('diff previews the pending patch without applying it', async () => {
  const home = makeHome();
  const project = makeProject();
  const store = storeWith(home);
  const before = readFileSync(join(project, 'src', 'app.ts'), 'utf8');

  store.stage(
    project,
    patch([{ path: 'src/app.ts', action: 'replace', content: "export const menu = ['sales', 'inventory'];\n" }])
  );

  const diffs = store.diff(project);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].path, 'src/app.ts');
  assert.ok(diffs[0].added > 0);
  assert.ok(diffs[0].removed > 0);
  assert.equal(readFileSync(join(project, 'src', 'app.ts'), 'utf8'), before, 'diff must not write');
});

test('apply writes files, records history, and revert restores the snapshot', async () => {
  const home = makeHome();
  const project = makeProject();
  const store = storeWith(home);
  const original = readFileSync(join(project, 'src', 'app.ts'), 'utf8');
  writeFileSync(join(project, 'obsolete.md'), 'delete me\n');

  store.stage(
    project,
    patch([
      { path: 'src/app.ts', action: 'replace', content: "export const menu = ['sales', 'inventory'];\n" },
      { path: 'src/inventory.ts', action: 'create', content: 'export const inventory = [];\n' },
      { path: 'obsolete.md', action: 'delete' },
    ])
  );

  const applied = await store.apply(project);
  assert.equal(applied.entry.status, 'applied');
  assert.equal(applied.outcome.changedFiles.length, 3);
  assert.equal(
    readFileSync(join(project, 'src', 'app.ts'), 'utf8'),
    "export const menu = ['sales', 'inventory'];\n"
  );
  assert.equal(existsSync(join(project, 'src', 'inventory.ts')), true);
  assert.equal(existsSync(join(project, 'obsolete.md')), false);
  assert.equal(store.pending(project), null, 'applying consumes the pending patch');

  const reverted = await store.revert(project);
  assert.equal(reverted.entry.status, 'reverted');
  assert.equal(readFileSync(join(project, 'src', 'app.ts'), 'utf8'), original, 'replaced file restored');
  assert.equal(existsSync(join(project, 'src', 'inventory.ts')), false, 'created file removed');
  assert.equal(existsSync(join(project, 'obsolete.md')), true, 'deleted file restored');
  assert.equal(readFileSync(join(project, 'obsolete.md'), 'utf8'), 'delete me\n');
});

test('apply is refused with NO_PENDING_PATCH when nothing is staged', async () => {
  const home = makeHome();
  const project = makeProject();
  const store = storeWith(home);

  await assert.rejects(
    () => store.apply(project),
    (error) => error instanceof HcoderStoreError && error.code === 'NO_PENDING_PATCH'
  );
  await assert.rejects(
    () => store.revert(project),
    (error) => error instanceof HcoderStoreError && error.code === 'NO_APPLIED_PATCH'
  );
});

test('a staged patch can only be applied to the project that staged it', async () => {
  const home = makeHome();
  const projectA = makeProject();
  const projectB = makeProject();
  const store = storeWith(home);

  const staged = store.stage(
    projectA,
    patch([{ path: 'src/app.ts', action: 'replace', content: 'changed\n' }])
  );
  assert.equal(staged.projectRoot, projectA);

  // Simulate a pending patch that ended up in another project's state.
  const stateA = store.statePath(projectA);
  const stateB = store.statePath(projectB);
  copyFileSync(stateA, stateB);

  await assert.rejects(
    () => store.apply(projectB),
    (error) => error instanceof HcoderStoreError && error.code === 'PATCH_PROJECT_MISMATCH'
  );
  assert.equal(readFileSync(join(projectB, 'src', 'app.ts'), 'utf8'), "export const menu = ['sales'];\n");
});

test('protected and traversal paths are rejected at staging time', async () => {
  const home = makeHome();
  const project = makeProject();
  const store = storeWith(home);

  assert.throws(
    () => store.stage(project, patch([{ path: '../escape.txt', action: 'create', content: 'pwned\n' }])),
    (error) => error instanceof HcoderStoreError && error.code === 'PATH_REJECTED'
  );
  assert.throws(
    () => store.stage(project, patch([{ path: '.env', action: 'create', content: 'TOKEN=stolen\n' }])),
    (error) => error instanceof HcoderStoreError && error.code === 'PATH_REJECTED'
  );
  assert.equal(existsSync(join(project, '..', 'escape.txt')), false);
  assert.equal(store.pending(project), null, 'nothing was staged');
});

test('reject discards the pending patch and keeps history', async () => {
  const home = makeHome();
  const project = makeProject();
  const store = storeWith(home);

  store.stage(project, patch([{ path: 'src/app.ts', action: 'replace', content: 'rejected\n' }]));
  const entry = store.reject(project);

  assert.equal(entry.status, 'rejected');
  assert.equal(store.pending(project), null);
  assert.throws(
    () => store.reject(project),
    (error) => error instanceof HcoderStoreError && error.code === 'NO_PENDING_PATCH'
  );
});

test('a mid-apply failure rolls back every file (all-or-nothing)', async () => {
  const home = makeHome();
  const project = makeProject();
  const store = storeWith(home);
  const original = readFileSync(join(project, 'src', 'app.ts'), 'utf8');

  // File 1 is a valid replace; file 2 tries to create a path underneath
  // that same FILE (a.txt/b.txt), which fails with ENOTDIR mid-apply.
  writeFileSync(join(project, 'a.txt'), 'original a\n');
  store.stage(
    project,
    patch(
      [
        { path: 'a.txt', action: 'replace', content: 'rewritten a\n' },
        { path: 'a.txt/b.txt', action: 'create', content: 'nested\n' },
      ],
      'broken multi-file patch'
    )
  );

  await assert.rejects(
    () => store.apply(project),
    (error) => error instanceof HcoderStoreError && error.code === 'APPLY_FAILED'
  );
  assert.equal(readFileSync(join(project, 'a.txt'), 'utf8'), 'original a\n', 'first write was rolled back');
  assert.equal(existsSync(join(project, 'a.txt/b.txt')), false);
  assert.equal(readFileSync(join(project, 'src', 'app.ts'), 'utf8'), original);

  const history = store.history(project);
  assert.equal(history[0].status, 'failed');
  assert.ok(history[0].error);
});

test('history is metadata-only and most recent first', async () => {
  const home = makeHome();
  const project = makeProject();
  const store = storeWith(home);

  store.stage(project, patch([{ path: 'notes.md', action: 'replace', content: '# Changed\n' }], 'First'));
  await store.apply(project);
  store.stage(project, patch([{ path: 'notes.md', action: 'replace', content: '# Changed twice\n' }], 'Second'));

  const history = store.history(project);
  assert.equal(history.length, 2);
  assert.equal(history[0].summary, 'Second');
  assert.equal(history[0].status, 'staged');
  assert.equal(history[1].summary, 'First');
  assert.equal(history[1].status, 'applied');
  const serialized = JSON.stringify(history);
  assert.equal(serialized.includes('# Changed\n'), false, 'history never dumps file contents');
});

test('HCODER_HOME isolates state per home directory', async () => {
  const homeOne = makeHome();
  const homeTwo = makeHome();
  const project = makeProject();

  const storeOne = storeWith(homeOne);
  storeOne.stage(project, patch([{ path: 'notes.md', action: 'replace', content: 'one\n' }]));

  const storeTwo = new HcoderPatchStore(homeTwo);
  assert.equal(storeTwo.pending(project), null, 'state is scoped to the home directory');

  const storeOneAgain = new HcoderPatchStore(homeOne);
  assert.ok(storeOneAgain.pending(project), 'state persists across store instances');
});
