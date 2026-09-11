// Dev-only: boots the real Fastify app (createServer + real context + SQLite)
// on a scratch port to verify the routing HTTP API end-to-end.
import { spawn } from 'node:child_process';

const PORT = 7877;
const child = spawn(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `
import { createServer } from './apps/api/dist/server.js';
import { createContext, loadSettings } from './apps/api/dist/context.js';
import { ensureDataDir } from './packages/shared/dist/index.js';
process.env.CODEX_HOME = 'C:/Users/aan/AppData/Local/Temp/hcr-api-test-codex-home';
ensureDataDir();
const context = createContext();
context.db.initialize();
loadSettings(context);
await Promise.all([context.ollama.initialize(), context.codex.initialize()]);
const { app } = await createServer(context);
await app.listen({ host: '127.0.0.1', port: ${PORT} });
console.log('TEST SERVER UP');
`,
  ],
  { cwd: 'C:/heisenberg-coder-router', stdio: ['ignore', 'pipe', 'pipe'] }
);

let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
await new Promise((r) => setTimeout(r, 4000));

const results = [];
const check = (name, cond, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) process.exitCode = 1;
};
const j = async (path, opts) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, opts);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
};

// GET /api/health
const health = await j('/api/health');
check('GET /api/health', health.status === 200 && health.body.status === 'ok');

// GET /api/codex/status
const codex = await j('/api/codex/status');
check('GET /api/codex/status', codex.status === 200 && codex.body.installed === true, codex.body.version ?? '');

// GET /api/ollama/status (offline -> graceful)
const ollama = await j('/api/ollama/status');
check('GET /api/ollama/status (offline graceful)', ollama.status === 200 && ollama.body.online === false);

// GET /api/ollama/models (empty ok)
const models = await j('/api/ollama/models');
check('GET /api/ollama/models (empty ok)', models.status === 200 && Array.isArray(models.body));

// GET /api/providers
const providers = await j('/api/providers');
check('GET /api/providers', providers.status === 200 && providers.body.length === 2);

// invalid provider rejected with 400 (no silent fallback)
const bad = await j('/api/providers/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'claude' }) });
check('POST /api/providers/active claude -> 400', bad.status === 400, bad.body.error ?? '');
const bad2 = await j('/api/providers/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'gemini' }) });
check('POST /api/providers/active gemini -> 400', bad2.status === 400);

// GET /api/routing -> not_configured initially (scratch CODEX_HOME)
let routing = await j('/api/routing');
check('GET /api/routing', routing.status === 200 && routing.body.status === 'not_configured', routing.body.status);

// POST /api/routing/apply with openai -> writes config (scratch home), status applied
const apply = await j('/api/routing/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'openai', projectDir: 'C:/heisenberg-coder-router/apps/web' }) });
check('POST /api/routing/apply openai', apply.status === 200 && apply.body.routing.status === 'applied', JSON.stringify(apply.body.routing?.applied));
check('apply response contains configPath', typeof apply.body.routing?.configPath === 'string');

// GET /api/routing/verify
const verify = await j('/api/routing/verify');
check('GET /api/routing/verify', verify.status === 200 && verify.body.checks?.codexInstalled === true);
check('verify: applied provider openai', verify.body.applied?.provider === 'openai');

// ollama apply without model -> 400 (provider+model coupling)
const applyBad = await j('/api/routing/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'ollama' }) });
check('apply ollama without model -> 400', applyBad.status === 400, (applyBad.body.error ?? '').slice(0, 60));

// GET /api/status includes routing block, no run block
const status = await j('/api/status');
check('GET /api/status has routing', status.status === 200 && status.body.routing?.status !== undefined);
check('GET /api/status has no launcher run block', status.body.run === undefined);

// GET /api/project restored from sqlite
const project = await j('/api/project');
check('GET /api/project', project.status === 200 && project.body.project?.path === 'C:\\heisenberg-coder-router\\apps\\web', project.body.project?.path ?? 'null');

// SPA served by Fastify
const spa = await fetch(`http://127.0.0.1:${PORT}/`);
const spaText = await spa.text();
check('SPA served by Fastify', spa.status === 200 && spaText.includes('<title>'));

// unknown API -> 404 JSON
const notFound = await j('/api/nonexistent');
check('unknown API -> 404 JSON', notFound.status === 404 && notFound.body.error === 'Not found');

// old launcher endpoints must be gone
const goneStart = await j('/api/codex/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const goneStop = await j('/api/codex/stop', { method: 'POST' });
check('POST /api/codex/start removed', goneStart.status === 404);
check('POST /api/codex/stop removed', goneStop.status === 404);

child.kill();
await new Promise((r) => setTimeout(r, 500));
console.log('\n=== API RESULTS ===');
for (const r of results) console.log(r);
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} API checks passed`);
if (failed > 0) console.log('--- server output ---\n' + out.slice(-1500));
process.exit(process.exitCode ?? 0);
