import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PatchValidationEngine, DEFAULT_PROTECTED_PATTERNS } from '../packages/core/dist/index.js';

const roots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'hcr-validate-'));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const engine = new PatchValidationEngine();

test('allows a normal relative path and normalizes separators', () => {
  const root = makeRoot();
  const result = engine.validateProjectPath(root, 'src\\nested\\menu.ts');
  assert.equal(result.ok, true);
  assert.equal(result.relativePath, 'src/nested/menu.ts');
  assert.ok(result.absolutePath.startsWith(root));
});

test('rejects parent directory traversal', () => {
  const root = makeRoot();
  const result = engine.validateProjectPath(root, '../outside.ts');
  assert.equal(result.ok, false);
  assert.match(result.error, /traversal/i);
});

test('rejects absolute paths in both notations', () => {
  const root = makeRoot();
  for (const candidate of ['C:\\Windows\\system32\\evil.txt', '/etc/passwd', '\\\\server\\share\\x.txt']) {
    const result = engine.validateProjectPath(root, candidate);
    assert.equal(result.ok, false, candidate);
    assert.match(result.error, /absolute/i, candidate);
  }
});

test('rejects Windows reserved device names', () => {
  const root = makeRoot();
  for (const candidate of ['NUL.txt', 'src/con.ts', 'aux']) {
    const result = engine.validateProjectPath(root, candidate);
    assert.equal(result.ok, false, candidate);
    assert.match(result.error, /reserved/i, candidate);
  }
});

test('rejects protected directories', () => {
  const root = makeRoot();
  for (const candidate of ['.git/config', '.ssh/authorized_keys', 'src/.git/HEAD']) {
    const result = engine.validateProjectPath(root, candidate);
    assert.equal(result.ok, false, candidate);
    assert.match(result.error, /protected directory/i, candidate);
  }
});

test('rejects protected secret files but allows the example file', () => {
  const root = makeRoot();
  for (const candidate of ['.env', '.env.local', 'src/id_rsa', 'secrets.json', 'certs/server.pem', '.npmrc']) {
    const result = engine.validateProjectPath(root, candidate);
    assert.equal(result.ok, false, candidate);
    assert.match(result.error, /protected file/i, candidate);
  }
  const ok = engine.validateProjectPath(root, '.env.example');
  assert.equal(ok.ok, true);
});

test('rejects empty and root-only paths', () => {
  const root = makeRoot();
  assert.equal(engine.validateProjectPath(root, '   ').ok, false);
  assert.equal(engine.validateProjectPath(root, './.').ok, false);
  assert.equal(engine.validateProjectPath(root, 'a\0b').ok, false);
});

test('rejects duplicate paths in one patch', () => {
  const root = makeRoot();
  const result = engine.validatePatchPaths(root, {
    version: 'HCR_PATCH_V1',
    summary: 'dupes',
    files: [
      { path: 'a.txt', action: 'create', content: '1' },
      { path: './a.txt', action: 'replace', content: '2' },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.issues[0].error, /duplicate/i);
});

test('rejects a path that escapes through a symlink', (t) => {
  const root = makeRoot();
  const outside = mkdtempSync(join(tmpdir(), 'hcr-outside-'));
  roots.push(outside);
  try {
    symlinkSync(outside, join(root, 'link'), 'junction');
  } catch {
    t.skip('symlink creation not permitted on this machine');
    return;
  }
  const result = engine.validateProjectPath(root, 'link/escaped.txt');
  assert.equal(result.ok, false);
  assert.match(result.error, /symbolic link/i);
});

test('existing files inside the project are still writable', () => {
  const root = makeRoot();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'export {};\n');
  const result = engine.validateProjectPath(root, 'src/app.ts');
  assert.equal(result.ok, true);
  assert.ok(existsSync(result.absolutePath));
});

test('protected pattern list covers the documented secret files', () => {
  assert.ok(DEFAULT_PROTECTED_PATTERNS.includes('.env'));
  assert.ok(DEFAULT_PROTECTED_PATTERNS.includes('*.pem'));
  assert.ok(DEFAULT_PROTECTED_PATTERNS.includes('.git/*'));
});
