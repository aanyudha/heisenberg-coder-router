import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HcoderAgentLoop, HcoderToolEngine } from '../packages/core/dist/index.js';

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
  const root = mkdtempSync(join(tmpdir(), 'hcr-hcoder-loop-'));
  dirs.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'README.md'), '# Fixture\n');
  writeFileSync(join(root, 'src', 'app.ts'), 'const one = 1;\n');
  return root;
}

const agentRequests = (requests) =>
  JSON.stringify({ version: 'HCODER_AGENT_V1', status: 'needs_context', requests });

const patchJson = (files, summary = 'Change the app') =>
  JSON.stringify({ version: 'HCR_PATCH_V1', summary, files });

/** Transport that replays a scripted sequence of raw replies. */
function scriptedTransport(replies) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async submit(messages) {
      calls.push(JSON.parse(JSON.stringify(messages)));
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (reply instanceof Error) throw reply;
      if (typeof reply === 'function') return reply(messages);
      return reply;
    },
  };
}

test('the loop runs tools then stages a patch - it never applies anything', async () => {
  const project = makeProject();
  const before = readFileSync(join(project, 'src', 'app.ts'), 'utf8');

  const transport = scriptedTransport([
    agentRequests([{ id: 'r1', tool: 'read_file', path: 'src/app.ts' }]),
    patchJson([{ path: 'src/app.ts', action: 'replace', content: 'const one = 1;\nconst two = 2;\n' }]),
  ]);
  const events = [];
  const loop = new HcoderAgentLoop({
    transport,
    tools: new HcoderToolEngine(project),
    onEvent: (event) => events.push(event),
  });

  const result = await loop.run('Add a second constant');

  assert.equal(result.kind, 'patch');
  assert.equal(result.rounds, 2);
  assert.equal(result.patch.files[0].path, 'src/app.ts');

  // Round 2 received the tool results from round 1.
  const secondCall = transport.calls[1];
  assert.equal(secondCall.length, 3);
  assert.equal(secondCall[2].role, 'tool');
  const toolPayload = JSON.parse(secondCall[2].content);
  assert.equal(toolPayload.version, 'HCODER_TOOL_RESULT_V1');
  assert.match(toolPayload.results[0].content, /const one = 1;/);

  // The loop must not touch the project.
  assert.equal(readFileSync(join(project, 'src', 'app.ts'), 'utf8'), before, 'no file was written');

  assert.equal(events[0].type, 'round');
  assert.equal(events.some((event) => event.type === 'tools'), true);
  assert.equal(events.some((event) => event.type === 'patch'), true);
});

test('prose replies stop the loop as a text answer', async () => {
  const project = makeProject();
  const transport = scriptedTransport(['Add validation to parseInput() and cover it with a unit test.']);
  const loop = new HcoderAgentLoop({ transport, tools: new HcoderToolEngine(project) });

  const result = await loop.run('How should I fix this?');
  assert.equal(result.kind, 'text');
  assert.equal(result.rounds, 1);
  assert.match(result.text, /parseInput/);
});

test('a contract-claiming malformed reply fails with INVALID_AGENT_RESPONSE', async () => {
  const project = makeProject();
  const transport = scriptedTransport(['{"version": "HCODER_AGENT_V1", "status": "needs_context",']);
  const loop = new HcoderAgentLoop({ transport, tools: new HcoderToolEngine(project) });

  const result = await loop.run('do something');
  assert.equal(result.kind, 'error');
  assert.equal(result.code, 'INVALID_AGENT_RESPONSE');
  assert.ok(result.errors.length > 0);
});

test('transport failures surface their deterministic code (no silent fallback)', async () => {
  const project = makeProject();
  const failure = Object.assign(new Error('ROUTE_UNAVAILABLE: Ollama is offline.'), { code: 'ROUTE_UNAVAILABLE' });
  const transport = scriptedTransport([failure]);
  const loop = new HcoderAgentLoop({ transport, tools: new HcoderToolEngine(project) });

  const result = await loop.run('anything');
  assert.equal(result.kind, 'error');
  assert.equal(result.code, 'ROUTE_UNAVAILABLE');
  assert.match(result.message, /Ollama is offline/);
});

test('more than maxToolRequestsPerRound requests in one round are refused', async () => {
  const project = makeProject();
  const tooMany = Array.from({ length: 11 }, (_, index) => ({
    id: `r${index + 1}`,
    tool: 'read_file',
    path: 'README.md',
  }));
  const transport = scriptedTransport([agentRequests(tooMany)]);
  const loop = new HcoderAgentLoop({ transport, tools: new HcoderToolEngine(project) });

  const result = await loop.run('read everything');
  assert.equal(result.kind, 'error');
  assert.equal(result.code, 'AGENT_LOOP_LIMIT_REACHED');
  assert.match(result.message, /11 tools in one round/);
});

test('the loop stops at the round budget instead of running forever', async () => {
  const project = makeProject();
  const transport = scriptedTransport([
    agentRequests([{ id: 'r1', tool: 'read_file', path: 'README.md' }]),
  ]);
  const loop = new HcoderAgentLoop({
    transport,
    tools: new HcoderToolEngine(project),
    limits: { maxRounds: 3, maxToolRequestsPerRound: 10 },
  });

  const result = await loop.run('keep reading');
  assert.equal(result.kind, 'error');
  assert.equal(result.code, 'AGENT_LOOP_LIMIT_REACHED');
  assert.equal(result.rounds, 3);
  assert.match(result.message, /stopped after 3 rounds \(limit 3\)/);
  assert.equal(transport.calls.length, 3, 'exactly maxRounds turns were submitted');
});

test('the cumulative tool budget ends the task with RESULT_TOO_LARGE', async () => {
  const project = makeProject();
  for (const name of ['big1.txt', 'big2.txt', 'big3.txt']) {
    writeFileSync(join(project, name), 'x'.repeat(250 * 1024));
  }
  const requests = ['big1.txt', 'big2.txt', 'big3.txt'].map((path, index) => ({
    id: `b${index}`,
    tool: 'read_file',
    path,
  }));
  const transport = scriptedTransport([agentRequests(requests)]);
  const loop = new HcoderAgentLoop({ transport, tools: new HcoderToolEngine(project) });

  const result = await loop.run('read the big files');
  assert.equal(result.kind, 'error');
  assert.equal(result.code, 'RESULT_TOO_LARGE');
  assert.match(result.message, /budget/);
});

test('every round carries the full conversation (CLI-owned history)', async () => {
  const project = makeProject();
  const transport = scriptedTransport([
    agentRequests([{ id: 'r1', tool: 'read_file', path: 'README.md' }]),
    agentRequests([{ id: 'r2', tool: 'read_file', path: 'src/app.ts' }]),
    'Done - the fixture reads cleanly.',
  ]);
  const loop = new HcoderAgentLoop({ transport, tools: new HcoderToolEngine(project) });

  const result = await loop.run('Inspect the fixture');
  assert.equal(result.kind, 'text');
  assert.equal(transport.calls.length, 3);
  assert.equal(transport.calls[0].length, 1);
  assert.equal(transport.calls[1].length, 3);
  assert.equal(transport.calls[2].length, 5);
  assert.equal(transport.calls[2][0].content, 'Inspect the fixture');
});
