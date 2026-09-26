import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectContextEngine, CONTEXT_LIMITS, buildHandoffPrompt } from '../packages/core/dist/index.js';

const roots = [];
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'hcr-context-'));
  roots.push(root);

  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(root, '.git'));

  writeFileSync(join(root, 'README.md'), '# Fixture project\n\nInventory menu demo.\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  writeFileSync(join(root, 'src', 'menu.ts'), "export const menu = ['sales'];\n// inventory menu goes here\n");
  writeFileSync(join(root, 'src', 'app.ts'), "import { menu } from './menu';\nexport const app = menu;\n");
  writeFileSync(join(root, '.env'), 'TOPSECRET_TOKEN=do-not-send-me\n');
  writeFileSync(join(root, '.env.production'), 'TOPSECRET_PROD=also-secret\n');
  writeFileSync(join(root, '.git', 'config'), '[core]\n\tsafeDirectory = *\n');
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(root, '.gitignore'), 'dist/\nignored.txt\n');
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'bundle.js'), 'console.log(1);\n');
  writeFileSync(join(root, 'ignored.txt'), 'should be ignored by gitignore\n');

  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const engine = new ProjectContextEngine();

test('excludes secrets, VCS, dependencies, lockfiles and binaries from context', async () => {
  const root = makeProject();
  const context = await engine.build(root, { task: 'Add an Inventory menu like Sales' });

  const paths = context.files.map((file) => file.path);
  const serialized = JSON.stringify({ paths, contents: context.contents, tree: context.tree });

  assert.equal(paths.some((path) => path.includes('.env')), false, '.env must never be selected');
  assert.ok(!serialized.includes('TOPSECRET_TOKEN'), 'secret content must never be included');
  assert.ok(!serialized.includes('TOPSECRET_PROD'), 'secret content must never be included');
  assert.ok(!serialized.includes('safeDirectory'), '.git contents must never be included');
  assert.equal(paths.some((path) => path.startsWith('node_modules/')), false, 'dependencies excluded');
  assert.equal(paths.some((path) => path === 'package-lock.json'), false, 'lockfiles excluded');
  assert.equal(paths.some((path) => path.endsWith('.png')), false, 'binaries excluded');
  assert.equal(paths.some((path) => path.startsWith('dist/')), false, 'gitignored files excluded');

  assert.equal(context.projectName, root.split(/[\\/]/).pop());
  assert.equal(context.projectRoot, root);
  assert.ok(context.fileCount > 0);
  assert.ok(context.totalBytes > 0);
  assert.equal(context.limits.maxFiles, CONTEXT_LIMITS.maxFiles);
  assert.ok(context.excluded.length > 0, 'exclusions are reported to the user');
});

test('ranks files relevant to the task first', async () => {
  const root = makeProject();
  const context = await engine.build(root, { task: 'Add an Inventory menu like Sales' });
  const paths = context.files.map((file) => file.path);
  assert.ok(paths.includes('src/menu.ts'), 'menu.ts is task-relevant');
  assert.ok(paths.includes('README.md'), 'instructions are always included');
  assert.ok(paths.includes('src/app.ts'), 'other sources still fit in the budget');
  // Relevance ordering: the task-relevant file outranks the unrelated source.
  assert.ok(
    paths.indexOf('src/menu.ts') < paths.indexOf('src/app.ts'),
    `expected src/menu.ts before src/app.ts, got ${JSON.stringify(paths)}`
  );
});

test('honours per-file and total size limits and reports them', async () => {
  const root = makeProject();
  writeFileSync(join(root, 'big.ts'), 'x'.repeat(5000));
  const context = await engine.build(root, { task: 'anything', maxBytesPerFile: 100 });

  const big = context.excluded.find((item) => item.path === 'big.ts');
  assert.ok(big, 'oversized file must be reported as excluded');
  assert.match(big.reason, /per-file limit/);
  assert.equal(context.files.some((file) => file.path === 'big.ts'), false);
});

test('honours the file count limit', async () => {
  const root = makeProject();
  const context = await engine.build(root, { task: 'anything', maxFiles: 2 });
  assert.ok(context.files.length <= 2, `expected <= 2 files, got ${context.files.length}`);
  assert.ok(context.excluded.some((item) => /file limit reached/.test(item.reason)));
});

test('handoff prompt contains the task, the project and the patch contract', async () => {
  const root = makeProject();
  const context = await engine.build(root, { task: 'Add an Inventory menu like Sales' });
  const prompt = buildHandoffPrompt(context, 'Add an Inventory menu like Sales');

  assert.match(prompt, /Add an Inventory menu like Sales/);
  assert.match(prompt, /HCR_PATCH_V1/);
  assert.match(prompt, /Never use absolute paths or "\.\."/);
  assert.match(prompt, /Never include shell commands/);
  assert.ok(prompt.includes(context.projectRoot));
  assert.ok(!prompt.includes('TOPSECRET'), 'secrets must not leak into the prompt');
  assert.ok(!prompt.includes('safeDirectory'), '.git contents must not leak into the prompt');
});
