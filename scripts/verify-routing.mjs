// Dev-only verification harness (not part of the app runtime).
// Exercises CodexConfigEngine + RoutingEngine against a scratch CODEX_HOME
// and a scratch Ollama mock, without touching the user's real ~/.codex.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = 'C:/heisenberg-coder-router';
const scratchHome = join(tmpdir(), 'hcr-codex-home-test');
rmSync(scratchHome, { recursive: true, force: true });
mkdirSync(scratchHome, { recursive: true });

process.env.CODEX_HOME = scratchHome;
process.env.OLLAMA_HOST = '127.0.0.1:21437';

// --- Ollama mock on :21437 (implements tags/version AND codex doctor /v1 probes) ---
const ollamaMock = createServer((req, res) => {
  if (req.url === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: '0.12.9-mock' }));
    return;
  }
  if (req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      models: [
        { name: 'qwen3-coder:30b', model: 'qwen3-coder:30b', size: 1800000000, modified_at: '2026-09-01T00:00:00Z' },
        { name: 'gpt-oss:20b', model: 'gpt-oss:20b', size: 1400000000, modified_at: '2026-08-01T00:00:00Z' },
      ],
    }));
    return;
  }
  // codex doctor probes: HEAD /v1/responses, GET /v1/models
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'qwen3-coder:30b' }, { id: 'gpt-oss:20b' }] }));
    return;
  }
  if (req.url.startsWith('/v1/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});
ollamaMock.on('clientError', (err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});
await new Promise((r) => ollamaMock.listen(21437, '127.0.0.1', r));

const results = [];
const check = (name, cond, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) process.exitCode = 1;
};

// --- import built modules with scratch env applied ---
const shared = await import(`file://${ROOT}/packages/shared/dist/index.js`);
const core = await import(`file://${ROOT}/packages/core/dist/index.js`);
const providers = await import(`file://${ROOT}/packages/providers/dist/index.js`);

// 1) getCodexHome honors CODEX_HOME
check('CODEX_HOME honored', shared.getCodexHome() === scratchHome, shared.getCodexHome());
check('config path under scratch home', shared.getCodexConfigPath().startsWith(scratchHome));

// 2) Ollama discovery against mock
const ollamaStatus = await providers.getOllamaStatus();
check('ollama mock online', ollamaStatus.online === true, `version=${ollamaStatus.version}`);
check('ollama mock models discovered', ollamaStatus.models.length === 2, ollamaStatus.models.map(m => m.id).join(','));

// 3) Apply Ollama route -> config created, valid TOML, keys written
const configEngine = new core.CodexConfigEngine();
const routing = new core.RoutingEngine(
  configEngine,
  () => providers.getOllamaStatus(),
  async () => ({ installed: true, version: 'codex-cli 0.154.0' })
);
routing.setDesired({ provider: 'openai', projectDir: ROOT });
routing.setDesired({ provider: 'ollama', model: 'qwen3-coder:30b' });

let applied;
try {
  applied = await routing.apply();
  check('ollama apply succeeded', applied.status === 'applied', JSON.stringify(applied.applied));
} catch (e) {
  check('ollama apply succeeded', false, String(e));
}

const configPath = shared.getCodexConfigPath();
const configText = readFileSync(configPath, 'utf-8');
check('model key written', configText.includes('model = "qwen3-coder:30b"'));
check('model_provider key written (hcr-ollama)', configText.includes('model_provider = "hcr-ollama"'));
check('HCR provider table written', configText.includes('[model_providers.hcr-ollama]'));
check('wire_api responses', configText.includes('wire_api = "responses"'));
check('base_url from OLLAMA_HOST', configText.includes('http://127.0.0.1:21437/v1'));

// 4) Backup behavior: no config existed before -> no backup
check('no backup when config did not pre-exist', !existsSync(configEngine.backupPath));

// 5) Drift: user edits model externally -> status drifts
const drifted = configText.replace('model = "qwen3-coder:30b"', 'model = "gpt-oss:20b"');
writeFileSync(configPath, drifted, 'utf-8');
const driftStatus = routing.status();
check('drift detected after external edit', driftStatus.status === 'drift', driftStatus.detail ?? '');

// 6) Reapply restores HCR route
await routing.apply();
check('reapply restores route', routing.status().status === 'applied');

// 7) OpenAI apply: strips ollama keys/table; provider falls back to openai
routing.setDesired({ provider: 'openai' });
const openaiApplied = await routing.apply();
const afterOpenai = readFileSync(configPath, 'utf-8');
check('openai apply ok', openaiApplied.status === 'applied', JSON.stringify(openaiApplied.applied));
check('openai: no model_provider key', !afterOpenai.includes('model_provider'));
check('openai: no hcr-ollama table', !afterOpenai.includes('[model_providers.hcr-ollama]'));
check('openai: no model key', !afterOpenai.includes('\nmodel ='));

// 8) Backup on existing config: seed a realistic config, apply, check backup + preservation
const seededConfig = [
  'model = "gpt-5.4"',
  'model_reasoning_effort = "high"',
  'personality = "pragmatic"',
  '[windows]',
  'sandbox = "elevated"',
  '',
  "[projects.'c:\\\\someproj']",
  'trust_level = "trusted"',
  '',
].join('\n');
writeFileSync(configPath, seededConfig, 'utf-8');
rmSync(configEngine.backupPath, { force: true });
routing.setDesired({ provider: 'ollama', model: 'qwen3-coder:30b' });
await routing.apply();
const seededBackup = readFileSync(configEngine.backupPath, 'utf-8');
check('one-time backup created for pre-existing config', seededBackup === seededConfig);
const afterOllama = readFileSync(configPath, 'utf-8');
check('unrelated key preserved (model_reasoning_effort)', afterOllama.includes('model_reasoning_effort = "high"'));
check('unrelated section preserved ([windows])', afterOllama.includes('[windows]'));
check('unrelated section preserved ([projects...])', afterOllama.includes("[projects.'c:\\\\someproj']"));
check('existing model replaced in place', /model = "qwen3-coder:30b"/.test(afterOllama));
check('model_provider added before first section', afterOllama.indexOf('model_provider') < afterOllama.indexOf('[windows]'));

// 9) Malformed config -> clear error, no write
writeFileSync(configPath, 'this is not toml at all\n[[[broken\n', 'utf-8');
let malformedBlocked = false;
try {
  await routing.apply();
} catch (e) {
  malformedBlocked = String(e).includes('malformed TOML');
}
check('malformed config blocks apply with clear error', malformedBlocked);

// 10) Persistence: settings survive a fresh DatabaseEngine (restart simulation)
const scratchDb = join(tmpdir(), 'hcr-router-test.sqlite');
rmSync(scratchDb, { force: true });
const db1 = new core.DatabaseEngine();
db1.initialize();
db1.setSetting('active_provider', 'ollama');
db1.setSetting('active_model', 'qwen3-coder:30b');
db1.setSetting('project_dir', 'C:/heisenberg-coder-router/apps/web');
db1.close();
const db2 = new core.DatabaseEngine();
db2.initialize();
check('provider persisted', db2.getSetting('active_provider') === 'ollama');
check('model persisted', db2.getSetting('active_model') === 'qwen3-coder:30b');
check('project persisted', db2.getSetting('project_dir') === 'C:/heisenberg-coder-router/apps/web');
db2.close();

// 11) VS Code detection (real machine: extension dir absent; settings check runs)
const vscode = core.detectVsCodeCodex();
check('vscode detection runs', typeof vscode.detected === 'boolean', vscode.detail);

// 12) REAL Codex CLI validation: restore HCR ollama route, run codex doctor.
// The mock must run in a SEPARATE process: execFileSync blocks this process's
// event loop, which would starve an in-process mock during doctor's probes.
writeFileSync(configPath, afterOllama, 'utf-8');
const codexExe = 'C:/Users/aan/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
// Free the in-process mock so the child mock can bind the same port.
ollamaMock.close();
const mockChild = spawnMockChild(21437);
await new Promise((r) => setTimeout(r, 800));
let doctorOutput = '';
try {
  doctorOutput = execFileSync(codexExe, ['doctor'], {
    env: { ...process.env, CODEX_HOME: scratchHome },
    encoding: 'utf-8',
    timeout: 90000,
  });
} catch (e) {
  doctorOutput = (e.stdout ?? '') + String(e);
}
check('codex doctor: HCR config parses ok (✓ config loaded)', /✓ config\s+loaded/.test(doctorOutput));
const modelLine = doctorOutput.split('\n').find(l => /\bmodel\s/.test(l) && /·/.test(l));
check('codex doctor: model qwen3-coder:30b · hcr-ollama', /model\s+qwen3-coder:30b · hcr-ollama/.test(modelLine ?? ''), modelLine?.trim() ?? '');
const providerLine = doctorOutput.split('\n').find(l => l.includes('default model provider'));
check('codex doctor: default provider hcr-ollama', /provider\s+hcr-ollama/.test(providerLine ?? ''), providerLine?.trim() ?? '');
check('codex doctor: reachability ok (✓ reachability)', /✓ reachability/.test(doctorOutput));

// 13) REAL Codex CLI: apply OpenAI route -> doctor shows provider back to openai
routing.setDesired({ provider: 'openai' });
await routing.apply();
try {
  doctorOutput = execFileSync(codexExe, ['doctor'], {
    env: { ...process.env, CODEX_HOME: scratchHome },
    encoding: 'utf-8',
    timeout: 90000,
  });
} catch (e) {
  doctorOutput = (e.stdout ?? '') + String(e);
}
mockChild.kill();
const providerLine2 = doctorOutput.split('\n').find(l => l.includes('default model provider'));
check('codex doctor: provider back to openai after openai apply', /provider\s+openai/.test(providerLine2 ?? ''), providerLine2?.trim() ?? '');
check('codex doctor: no stale ollama model after openai apply', !/qwen3-coder/.test(doctorOutput));

/** Spawn the Ollama mock as a separate process for codex doctor probes. */
function spawnMockChild(port) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import { createServer } from 'node:http';
const s = createServer((req, res) => {
  if (req.url === '/api/version') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({version:'0.12.9-mock'})); return; }
  if (req.url === '/api/tags') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({models:[]})); return; }
  if (req.url === '/v1/models') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({data:[{id:'qwen3-coder:30b'}]})); return; }
  if (req.url.startsWith('/v1/')) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); return; }
  res.writeHead(404).end();
});
s.listen(${port}, '127.0.0.1');
`,
    ],
    { stdio: 'ignore' }
  );
  return child;
}

ollamaMock.close();
rmSync(scratchHome, { recursive: true, force: true });
rmSync(scratchDb, { force: true });

console.log('\n=== RESULTS ===');
for (const r of results) console.log(r);
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
