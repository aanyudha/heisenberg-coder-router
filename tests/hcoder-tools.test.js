import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HcoderToolEngine, HCODER_TOOL_LIMITS } from '../packages/core/dist/index.js';

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
  for (const dir of dirs) cleanup(dir);
});

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'hcr-hcoder-tools-'));
  dirs.push(root);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'README.md'), '# Fixture\n');
  writeFileSync(join(root, 'src', 'app.ts'), 'const one = 1;\nconst two = 2;\nconst three = 3;\n');
  writeFileSync(join(root, 'src', 'secret-note.ts'), 'never mind\n');
  writeFileSync(join(root, 'ignored.ts'), 'ignored\n');
  writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
  writeFileSync(join(root, '.env'), 'TOKEN=stolen\n');
  writeFileSync(join(root, 'node_modules', 'dep.js'), 'module.exports = 1;\n');
  return root;
}

test('read_file returns content, bytes and a bounded line window', async () => {
  const engine = new HcoderToolEngine(makeProject());

  const full = await engine.execute({ id: 'r1', tool: 'read_file', path: 'src/app.ts' });
  assert.equal(full.ok, true);
  assert.equal(full.path, 'src/app.ts');
  assert.match(full.content, /const one = 1;/);
  assert.equal(full.bytes > 0, true);

  const window = await engine.execute({ id: 'r2', tool: 'read_file', path: 'src/app.ts', offset: 2, limit: 1 });
  assert.equal(window.ok, true);
  assert.equal(window.content, 'const two = 2;');
  assert.equal(window.truncated, true, 'lines beyond the window mark the result truncated');
});

test('read_file rejects traversal, absolute paths, secrets and binaries', async () => {
  const root = makeProject();
  const engine = new HcoderToolEngine(root);

  const escaped = await engine.execute({ id: 'r1', tool: 'read_file', path: '../outside.txt' });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.error.code, 'PATH_REJECTED');

  const absolute = await engine.execute({ id: 'r2', tool: 'read_file', path: '/etc/passwd' });
  assert.equal(absolute.ok, false);
  assert.equal(absolute.error.code, 'PATH_REJECTED');

  const secret = await engine.execute({ id: 'r3', tool: 'read_file', path: '.env' });
  assert.equal(secret.ok, false);
  assert.equal(secret.error.code, 'PATH_REJECTED');
  assert.match(secret.error.message, /HCoder/);

  const missing = await engine.execute({ id: 'r4', tool: 'read_file', path: 'nope.txt' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'NOT_FOUND');

  writeFileSync(join(root, 'blob.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const binary = await engine.execute({ id: 'r5', tool: 'read_file', path: 'blob.png' });
  assert.equal(binary.ok, false);
  assert.equal(binary.error.code, 'BINARY_FILE');
});

test('read_file refuses files above the byte limit', async () => {
  const root = makeProject();
  writeFileSync(join(root, 'huge.txt'), 'a'.repeat(HCODER_TOOL_LIMITS.maxBytesPerFile + 1));
  const engine = new HcoderToolEngine(root);

  const result = await engine.execute({ id: 'r1', tool: 'read_file', path: 'huge.txt' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'FILE_TOO_LARGE');
});

test('list_directory lists the project but never node_modules or ignored files', async () => {
  const engine = new HcoderToolEngine(makeProject());

  const rootList = await engine.execute({ id: 'l1', tool: 'list_directory', path: './' });
  assert.equal(rootList.ok, true);
  const names = rootList.entries.map((entry) => entry.name);
  assert.ok(names.includes('src'));
  assert.ok(names.includes('README.md'));
  assert.equal(names.includes('node_modules'), false, 'ignored directories never surface');
  assert.equal(names.includes('.env'), false, 'protected files never surface');

  const srcList = await engine.execute({ id: 'l2', tool: 'list_directory', path: 'src' });
  assert.equal(srcList.ok, true);
  const srcNames = srcList.entries.map((entry) => entry.name);
  assert.ok(srcNames.includes('app.ts'));

  const escaped = await engine.execute({ id: 'l3', tool: 'list_directory', path: '..' });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.error.code, 'PATH_REJECTED');
});

test('search_files matches by pattern and honors .gitignore', async () => {
  const engine = new HcoderToolEngine(makeProject());

  const byGlob = await engine.execute({ id: 's1', tool: 'search_files', pattern: '*.ts' });
  assert.equal(byGlob.ok, true);
  const paths = byGlob.matches.map((match) => match.path);
  assert.ok(paths.includes('src/app.ts'));
  assert.equal(paths.includes('ignored.ts'), false, 'gitignored files are not searched');
  assert.equal(paths.includes('node_modules/dep.js'), false);

  const byName = await engine.execute({ id: 's2', tool: 'search_files', pattern: 'README' });
  assert.equal(byName.ok, true);
  assert.ok(byName.matches.some((match) => match.path === 'README.md'));

  const noPattern = await engine.execute({ id: 's3', tool: 'search_files' });
  assert.equal(noPattern.ok, false);
  assert.equal(noPattern.error.code, 'INVALID_TOOL_REQUEST');
});

test('search_text reports path, line and snippet', async () => {
  const engine = new HcoderToolEngine(makeProject());

  const found = await engine.execute({ id: 't1', tool: 'search_text', query: 'const two' });
  assert.equal(found.ok, true);
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].path, 'src/app.ts');
  assert.equal(found.matches[0].line, 2);
  assert.match(found.matches[0].snippet, /const two/);

  const scoped = await engine.execute({ id: 't2', tool: 'search_text', query: 'const two', glob: 'README.md' });
  assert.equal(scoped.ok, true);
  assert.equal(scoped.matches.length, 0, 'glob filters exclude other files');

  const noQuery = await engine.execute({ id: 't3', tool: 'search_text' });
  assert.equal(noQuery.ok, false);
  assert.equal(noQuery.error.code, 'INVALID_TOOL_REQUEST');
});

test('read_many_files merges files and enforces its request bounds', async () => {
  const engine = new HcoderToolEngine(makeProject());

  const many = await engine.execute({
    id: 'm1',
    tool: 'read_many_files',
    paths: ['README.md', 'src/app.ts'],
  });
  assert.equal(many.ok, true);
  assert.match(many.content, /=== README\.md ===/);
  assert.match(many.content, /=== src\/app\.ts ===/);

  const tooMany = await engine.execute({
    id: 'm2',
    tool: 'read_many_files',
    paths: Array.from({ length: HCODER_TOOL_LIMITS.maxReadManyFiles + 1 }, (_, i) => `f${i}.txt`),
  });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.error.code, 'INVALID_TOOL_REQUEST');
});

test('unknown tools are rejected - only the five declared tools exist', async () => {
  const engine = new HcoderToolEngine(makeProject());

  const shell = await engine.execute({ id: 'x1', tool: 'run_shell', command: 'rm -rf /' });
  assert.equal(shell.ok, false);
  assert.equal(shell.error.code, 'UNKNOWN_TOOL');
  assert.match(shell.error.message, /read_file, list_directory/);
});

test('per-round byte budget truncates oversized results instead of growing unbounded', async () => {
  const root = makeProject();
  for (const name of ['big1.txt', 'big2.txt', 'big3.txt']) {
    writeFileSync(join(root, name), 'x'.repeat(250 * 1024));
  }
  const engine = new HcoderToolEngine(root);

  const results = await engine.executeAll([
    { id: 'b1', tool: 'read_file', path: 'big1.txt' },
    { id: 'b2', tool: 'read_file', path: 'big2.txt' },
    { id: 'b3', tool: 'read_file', path: 'big3.txt' },
  ]);

  assert.equal(results.length, 3);
  assert.equal(results[0].truncated ?? false, false);
  const last = results[2];
  const lastBytes = Buffer.byteLength(last.content ?? '', 'utf8');
  const overBudget = (last.error && last.error.code === 'RESULT_TOO_LARGE') || last.truncated === true;
  assert.equal(overBudget, true, 'third result must be truncated or refused');
  assert.ok(lastBytes <= HCODER_TOOL_LIMITS.maxResultBytesPerRound);
});

test('buildResult emits the structured HCODER_TOOL_RESULT_V1 payload', () => {
  const payload = HcoderToolEngine.buildResult([{ id: 'r1', tool: 'read_file', ok: true, content: 'x' }]);
  assert.equal(payload.version, 'HCODER_TOOL_RESULT_V1');
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].id, 'r1');
});
