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

// Wait for server readiness instead of a fixed sleep (cold start probes CLIs).
const waitUntilReady = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('test server did not become ready');
};
await waitUntilReady();

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

// GET /api/ollama/status — graceful in either state; endpoint always present
const ollama = await j('/api/ollama/status');
check('GET /api/ollama/status (graceful)', ollama.status === 200 && typeof ollama.body.online === 'boolean' && typeof ollama.body.endpoint === 'string', `online=${ollama.body.online}`);

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

// ollama apply without model -> 400 (provider+model coupling). Desired
// provider selection legitimately persists even when apply is rejected.
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

// GET /api/telemetry — truthful snapshot: uptime real, inference metrics null
const telemetry = await j('/api/telemetry');
check('GET /api/telemetry', telemetry.status === 200 && telemetry.body.source === 'unavailable');
check('telemetry: uptimeSeconds is a real number', typeof telemetry.body.uptimeSeconds === 'number' && telemetry.body.uptimeSeconds >= 0);
check('telemetry: inference metrics null (not zero)',
  telemetry.body.inputTokens === null && telemetry.body.totalTokens === null && telemetry.body.requestCount === null);
const routingNow = await j('/api/routing');
check('telemetry: provider matches routing desired', telemetry.body.provider === routingNow.body.desired.provider, `telemetry=${telemetry.body.provider} desired=${routingNow.body.desired.provider}`);
check('telemetry: observedAt present', typeof telemetry.body.observedAt === 'string');

// old launcher endpoints must be gone
const goneStart = await j('/api/codex/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const goneStop = await j('/api/codex/stop', { method: 'POST' });
check('POST /api/codex/start removed', goneStart.status === 404);
check('POST /api/codex/stop removed', goneStop.status === 404);

// ---- Gateway data plane (uses REAL Ollama upstream; non-streaming path) ----
// A real /v1/chat/completions request through the HCR gateway exercises the
// proxy, live tracking, and metadata observation end to end.
const GATEWAY_BODY = JSON.stringify({
  model: 'gpt-oss:20b',
  messages: [{ role: 'user', content: 'reply with the single word: pong' }],
  stream: false,
});
const gw = await j('/gateway/ollama/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: GATEWAY_BODY,
});
check('gateway: real Ollama chat completion via HCR (200, choice present)',
  gw.status === 200 && Array.isArray(gw.body?.choices) && gw.body.choices.length > 0,
  gw.status === 200 ? `model=${gw.body.model ?? '?'}` : `status=${gw.status} ${JSON.stringify(gw.body).slice(0, 80)}`);

// telemetry now reflects observed gateway traffic
const telemetryGw = await j('/api/telemetry');
check('telemetry after gateway: source hcr-gateway', telemetryGw.body.source === 'hcr-gateway', `source=${telemetryGw.body.source}`);
check('telemetry after gateway: requestCount >= 1 (real, not fake)',
  typeof telemetryGw.body.requestCount === 'number' && telemetryGw.body.requestCount >= 1, `requestCount=${telemetryGw.body.requestCount}`);
check('telemetry after gateway: state idle (request completed)', telemetryGw.body.state === 'idle' && telemetryGw.body.active === false, `state=${telemetryGw.body.state}`);
check('telemetry after gateway: latencyMs measured truthfully',
  telemetryGw.body.latencyMs === null || (typeof telemetryGw.body.latencyMs === 'number' && telemetryGw.body.latencyMs >= 0), `latencyMs=${telemetryGw.body.latencyMs}`);
// Tokens only if Ollama returned usage metadata — must be null or positive, never 0-faked.
check('telemetry after gateway: token fields null or positive',
  telemetryGw.body.totalTokens === null || telemetryGw.body.totalTokens > 0, `totalTokens=${telemetryGw.body.totalTokens}`);

// recent traffic metadata — must contain no prompt/response content
const recent = await j('/api/telemetry/recent');
const recentReq = recent.body.requests?.[recent.body.requests.length - 1];
check('GET /api/telemetry/recent has the gateway request', recent.status === 200 && recentReq !== undefined);
check('recent: provider ollama, model gpt-oss:20b',
  recentReq?.provider === 'ollama' && recentReq?.model === 'gpt-oss:20b', `${recentReq?.provider}/${recentReq?.model}`);
check('recent: completed state with duration', recentReq?.state === 'completed' && typeof recentReq?.durationMs === 'number');
const recentJson = JSON.stringify(recent.body);
check('privacy: no prompt/response content in telemetry',
  !recentJson.includes('pong') && !recentJson.toLowerCase().includes('reply with'), 'metadata only');

child.kill();
await new Promise((r) => setTimeout(r, 500));
console.log('\n=== API RESULTS ===');
for (const r of results) console.log(r);
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} API checks passed`);
if (failed > 0) console.log('--- server output ---\n' + out.slice(-1500));
process.exit(process.exitCode ?? 0);
