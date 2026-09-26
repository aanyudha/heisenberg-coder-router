import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseEngine, BrowserCompanionEngine } from '../packages/core/dist/index.js';

const dirs = [];
function makeDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hcr-companion-'));
  dirs.push(dir);
  process.env.HCR_DATA_DIR = dir;
  return dir;
}

after(() => {
  delete process.env.HCR_DATA_DIR;
  for (const dir of dirs) {
    // SQLite WAL files can stay briefly locked on Windows; never fail the run.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        // retry
      }
    }
  }
});

function newEngine() {
  makeDataDir();
  const db = new DatabaseEngine();
  db.initialize();
  return new BrowserCompanionEngine(db);
}

test('pairing is reported only after a real pairing exchange', () => {
  const companion = newEngine();
  assert.equal(companion.paired(), false);
  assert.equal(companion.status().paired, false);

  const { code } = companion.generatePairingCode();
  // A generated code alone does not mean the extension is paired.
  assert.equal(companion.status().paired, false);
  assert.equal(companion.status().pairingReady, true);

  companion.pair(code);
  assert.equal(companion.paired(), true);
  assert.equal(companion.status().paired, true);
});

test('pairing code is single use and rejects the wrong code', () => {
  const companion = newEngine();
  const { code } = companion.generatePairingCode();

  assert.throws(() => companion.pair('WRONG00'), /Invalid pairing code/);
  const { token } = companion.pair(code);
  assert.equal(token.length, 64);
  assert.throws(() => companion.pair(code), /Invalid pairing code/);
});

test('expired pairing codes are rejected', () => {
  const companion = newEngine();
  const { code } = companion.generatePairingCode(-1000);
  assert.throws(() => companion.pair(code), /expired/i);
  assert.equal(companion.status().pairingReady, false);
});

test('only the local pairing secret is accepted as a token', () => {
  const companion = newEngine();
  const { code } = companion.generatePairingCode();
  const { token } = companion.pair(code);

  assert.equal(companion.verify(token), true);
  assert.equal(companion.verify('not-the-secret'), false);
  assert.equal(companion.verify(null), false);
  assert.throws(() => companion.requireToken('bad-token'), (error) => error.statusCode === 401);
  assert.doesNotThrow(() => companion.requireToken(token));
});

test('reset rotates the secret and invalidates the previous pairing', () => {
  const companion = newEngine();
  const { code } = companion.generatePairingCode();
  const { token } = companion.pair(code);

  companion.reset();
  assert.equal(companion.verify(token), false, 'old token must stop working');
  assert.equal(companion.paired(), false, 'reset clears the paired state');
  assert.throws(() => companion.requireToken(token), (error) => error.statusCode === 401);
});

test('heartbeats drive the connection state', () => {
  const companion = newEngine();
  assert.equal(companion.status().connected, false);
  assert.equal(companion.status().lastSeenAt, null);

  const beat = companion.heartbeat();
  assert.equal(beat.connected, true);
  assert.equal(companion.status().connected, true);
  assert.ok(companion.status().lastSeenAt);
});

test('chatgpt state is only what the extension reports', () => {
  const companion = newEngine();
  assert.equal(companion.status().chatgpt.state, 'unknown');
  companion.reportChatgptState('auth_required', 'Open ChatGPT and sign in, then retry.');
  assert.equal(companion.status().chatgpt.state, 'auth_required');
  assert.match(companion.status().chatgpt.detail, /sign in/i);
});

test('tasks are queued once, taken once and delivered to the handler', async () => {
  const companion = newEngine();
  const queued = companion.queueTask({ handoffId: 'handoff-1', prompt: 'Return HCR_PATCH_V1' });

  assert.equal(companion.queuedTaskCount(), 1);
  assert.equal(companion.takeTask().id, queued.id);
  assert.equal(companion.hasTask(queued.id), true);

  companion.setStage(queued.id, 'sending_prompt');
  assert.equal(companion.stageOf(queued.id), 'sending_prompt');

  const delivered = [];
  companion.setResultHandler(async (handoffId, taskId, result) => {
    delivered.push({ handoffId, taskId, result });
  });

  const resolved = await companion.resolveTask(queued.id, { status: 'OK', responseText: '{}' });
  assert.equal(resolved, 'handoff-1');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].result.status, 'OK');
  assert.equal(companion.hasTask(queued.id), false);
  assert.equal(companion.queuedTaskCount(), 0);

  // Unknown/expired tasks resolve to null instead of throwing.
  const late = await companion.resolveTask('missing', { status: 'OK', responseText: '' });
  assert.equal(late, null);
});

test('dropTasksFor removes queued work for a rejected handoff', () => {
  const companion = newEngine();
  companion.queueTask({ handoffId: 'a', prompt: 'p1' });
  companion.queueTask({ handoffId: 'b', prompt: 'p2' });
  companion.dropTasksFor('a');
  assert.equal(companion.queuedTaskCount(), 1);
  assert.equal(companion.takeTask().handoffId, 'b');
});
