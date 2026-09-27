import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HCODER_AGENT_INSTRUCTION,
  validateHcoderAgent,
  parseHcoderAgent,
  classifyAgentReply,
  loopLimitMessage,
} from '../packages/core/dist/index.js';

test('the agent instruction is provider-neutral and shell-free', () => {
  assert.match(HCODER_AGENT_INSTRUCTION, /HCODER_AGENT_V1/);
  assert.match(HCODER_AGENT_INSTRUCTION, /HCR_PATCH_V1/);
  assert.match(HCODER_AGENT_INSTRUCTION, /read-only/);
  assert.match(HCODER_AGENT_INSTRUCTION, /no cmd, powershell, bash, npm, npx, git/);
  // Transport/provider neutrality: no provider names in the contract.
  assert.doesNotMatch(HCODER_AGENT_INSTRUCTION, /ChatGPT|chatgpt|Ollama|ollama|OpenAI/);
  assert.doesNotMatch(HCODER_AGENT_INSTRUCTION, /password\s*[:=]|api[_-]?key\s*[:=]|Bearer\s+\S+/i);
});

test('validateHcoderAgent accepts a well-formed request list', () => {
  const result = validateHcoderAgent({
    version: 'HCODER_AGENT_V1',
    status: 'needs_context',
    requests: [
      { id: 'r1', tool: 'read_file', path: 'src/app.ts' },
      { id: 'r2', tool: 'search_text', query: 'TODO', glob: '*.ts' },
      { id: 'r3', tool: 'read_many_files', paths: ['a.ts', 'b.ts'] },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.agent.requests.length, 3);
  assert.equal(result.agent.requests[0].tool, 'read_file');
});

test('validateHcoderAgent rejects unknown tools, versions and malformed requests', () => {
  const unknownTool = validateHcoderAgent({
    version: 'HCODER_AGENT_V1',
    status: 'needs_context',
    requests: [{ id: 'r1', tool: 'run_shell', command: 'rm -rf /' }],
  });
  assert.equal(unknownTool.ok, false);
  assert.match(unknownTool.errors.join(' '), /not a supported tool/);

  const badVersion = validateHcoderAgent({ version: 'HCR_PATCH_V1', status: 'needs_context', requests: [] });
  assert.equal(badVersion.ok, false);
  assert.match(badVersion.errors.join(' '), /version must be "HCODER_AGENT_V1"/);

  const emptyContext = validateHcoderAgent({ version: 'HCODER_AGENT_V1', status: 'needs_context', requests: [] });
  assert.equal(emptyContext.ok, false);
  assert.match(emptyContext.errors.join(' '), /at least one request/);

  const badStatus = validateHcoderAgent({ version: 'HCODER_AGENT_V1', status: 'running', requests: [] });
  assert.equal(badStatus.ok, false);
  assert.match(badStatus.errors.join(' '), /status must be one of/);

  const noPath = validateHcoderAgent({
    version: 'HCODER_AGENT_V1',
    status: 'needs_context',
    requests: [{ id: 'r1', tool: 'read_file' }],
  });
  assert.equal(noPath.ok, false);
  assert.match(noPath.errors.join(' '), /path must be a non-empty string/);
});

test('parseHcoderAgent extracts JSON from around prose', () => {
  const raw = [
    'Sure, let me look at the project.',
    '```json',
    JSON.stringify({
      version: 'HCODER_AGENT_V1',
      status: 'needs_context',
      requests: [{ id: 'r1', tool: 'list_directory', path: './' }],
    }),
    '```',
  ].join('\n');

  const result = parseHcoderAgent(raw);
  assert.equal(result.ok, true);
  assert.equal(result.agent.requests[0].tool, 'list_directory');
});

test('classifyAgentReply: valid agent, valid patch, prose, and invalid contract claims', () => {
  const agent = classifyAgentReply(
    JSON.stringify({
      version: 'HCODER_AGENT_V1',
      status: 'needs_context',
      requests: [{ id: 'r1', tool: 'read_file', path: 'src/app.ts' }],
    })
  );
  assert.equal(agent.kind, 'agent');
  assert.equal(agent.agent.requests.length, 1);

  const patch = classifyAgentReply(
    JSON.stringify({
      version: 'HCR_PATCH_V1',
      summary: 'Add feature',
      files: [{ path: 'src/app.ts', action: 'replace', content: 'new\n' }],
    })
  );
  assert.equal(patch.kind, 'patch');
  assert.equal(patch.patch.summary, 'Add feature');

  const prose = classifyAgentReply('You should add validation in the parser and then run the tests.');
  assert.equal(prose.kind, 'text');
  assert.match(prose.text, /validation/);

  // Claims the contract but the JSON is broken -> deterministic failure.
  const broken = classifyAgentReply('{"version": "HCODER_AGENT_V1", "status": ');
  assert.equal(broken.kind, 'invalid');
  assert.ok(broken.errors.length > 0);

  // Claims the contract with no JSON at all.
  const noJson = classifyAgentReply('Here is your HCODER_AGENT_V1 response: nothing structured.');
  assert.equal(noJson.kind, 'invalid');

  // Claims the contract, valid JSON, unknown tool.
  const badTool = classifyAgentReply(
    JSON.stringify({
      version: 'HCODER_AGENT_V1',
      status: 'needs_context',
      requests: [{ id: 'r1', tool: 'bash', command: 'ls' }],
    })
  );
  assert.equal(badTool.kind, 'invalid');
  assert.match(badTool.errors.join(' '), /not a supported tool/);
});

test('an agent response with zero requests is a terminal text answer', () => {
  const result = classifyAgentReply(
    JSON.stringify({ version: 'HCODER_AGENT_V1', status: 'answered', requests: [], message: 'All done.' })
  );
  assert.equal(result.kind, 'text');
  assert.equal(result.text, 'All done.');
});

test('loopLimitMessage is explicit about the round budget', () => {
  assert.match(loopLimitMessage(12), /stopped after 12 rounds \(limit 12\)/);
});
