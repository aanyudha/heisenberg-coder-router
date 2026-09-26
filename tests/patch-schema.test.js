import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHcrPatch, validatePatch, PATCH_LIMITS, CORRECTION_PROMPT } from '../packages/core/dist/index.js';

const valid = {
  version: 'HCR_PATCH_V1',
  summary: 'Add the Inventory menu',
  files: [{ path: 'src/menu.ts', action: 'create', content: "export const menu = ['inventory'];\n" }],
};

test('parses a bare HCR_PATCH_V1 object', () => {
  const result = parseHcrPatch(JSON.stringify(valid));
  assert.equal(result.ok, true);
  assert.equal(result.extraction, 'bare');
  assert.equal(result.patch.version, 'HCR_PATCH_V1');
  assert.equal(result.patch.files.length, 1);
  assert.equal(result.patch.files[0].action, 'create');
});

test('parses a markdown-fenced response', () => {
  const raw = '```json\n' + JSON.stringify(valid) + '\n```';
  const result = parseHcrPatch(raw);
  assert.equal(result.ok, true);
  assert.equal(result.extraction, 'fenced');
});

test('extracts JSON surrounded by prose', () => {
  const raw = `Sure! Here is the patch:\n${JSON.stringify(valid)}\nLet me know if you need anything else.`;
  const result = parseHcrPatch(raw);
  assert.equal(result.ok, true);
  assert.equal(result.extraction, 'extracted');
});

test('rejects prose with no JSON object', () => {
  const result = parseHcrPatch('I would suggest editing the sidebar by hand.');
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /does not contain a JSON object/i);
});

test('rejects a wrong version', () => {
  const result = validatePatch({ ...valid, version: 'HCR_PATCH_V2' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /version must be "HCR_PATCH_V1"/);
});

test('rejects unknown actions', () => {
  const result = validatePatch({
    ...valid,
    files: [{ path: 'a.txt', action: 'execute', content: 'x' }],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /action must be one of create\|replace\|delete/);
});

test('rejects create without content', () => {
  const result = validatePatch({
    ...valid,
    files: [{ path: 'a.txt', action: 'create' }],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /content must be a string/);
});

test('rejects empty files array and non-objects', () => {
  assert.equal(validatePatch({ ...valid, files: [] }).ok, false);
  assert.equal(validatePatch({ ...valid, files: ['src/a.ts'] }).ok, false);
  assert.equal(validatePatch('not an object').ok, false);
});

test('accepts a delete action without content', () => {
  const result = validatePatch({
    ...valid,
    files: [{ path: 'old.ts', action: 'delete' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.patch.files[0].content, undefined);
});

test('enforces the file count limit', () => {
  const files = Array.from({ length: PATCH_LIMITS.maxFiles + 1 }, (_, i) => ({
    path: `f${i}.txt`,
    action: 'create',
    content: 'x',
  }));
  const result = validatePatch({ ...valid, files });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /maximum of \d+ entries/);
});

test('enforces the per-file content limit', () => {
  const result = validatePatch({
    ...valid,
    files: [{ path: 'big.txt', action: 'create', content: 'x'.repeat(PATCH_LIMITS.maxContentBytesPerFile + 1) }],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /content exceeds \d+ bytes/);
});

test('tolerates a single patch wrapper object', () => {
  const result = validatePatch({ patch: valid });
  assert.equal(result.ok, true);
  assert.equal(result.patch.summary, valid.summary);
});

test('correction prompt demands HCR_PATCH_V1 and forbids shell commands', () => {
  assert.match(CORRECTION_PROMPT, /HCR_PATCH_V1/);
  assert.match(CORRECTION_PROMPT, /Never include shell commands/);
  assert.match(CORRECTION_PROMPT, /absolute paths or "\.\."/);
});
