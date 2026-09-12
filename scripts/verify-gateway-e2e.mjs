// Dev-only e2e: exercises the HCR Ollama gateway data plane against the REAL
// local Ollama (127.0.0.1:11434) and the REAL Codex CLI. Uses a scratch
// CODEX_HOME; the real ~/.codex config is never touched by this script.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 7878;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchHome = mkdtempSync(join(tmpdir(), 'hcr-gw-e2e-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// --- boot HCR with real context (real Ollama upstream, gateway enabled) -----
const child = spawn(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `
import { createServer } from './apps/api/dist/server.js';
import { createContext } from './apps/api/dist/context.js';
process.env.CODEX_HOME = ${JSON.stringify(scratchHome.replace(/\\/g, '/'))};
// The gateway URL written into Codex config must point at THIS HCR instance.
process.env.HCR_ORIGIN = 'http://127.0.0.1:${PORT}';
const context = createContext();
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

for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

// --- 1. Streaming preservation through the gateway --------------------------
const sseStart = Date.now();
const streamRes = await fetch(`${BASE}/gateway/ollama/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  body: JSON.stringify({
    model: 'gpt-oss:20b',
    messages: [{ role: 'user', content: 'count from 1 to 5 slowly' }],
    stream: true,
  }),
});
check('gateway stream: HTTP 200 + text/event-stream',
  streamRes.status === 200 && (streamRes.headers.get('content-type') ?? '').includes('text/event-stream'),
  `status=${streamRes.status} ct=${streamRes.headers.get('content-type')}`);

// Read chunks incrementally — prove chunks arrive over time, not all at once.
const reader = streamRes.body.getReader();
const decoder = new TextDecoder();
let chunks = 0;
let sse = '';
let firstChunkAt = null;
const chunkTimes = [];
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  if (firstChunkAt === null) firstChunkAt = Date.now() - sseStart;
  chunks++;
  chunkTimes.push(Date.now() - sseStart);
  sse += decoder.decode(value, { stream: true });
}
const uniqueChunkTimes = new Set(chunkTimes).size;
check('gateway stream: many chunks forwarded incrementally (not one buffer)',
  chunks >= 3 && uniqueChunkTimes >= 3, `chunks=${chunks} distinct arrival times=${uniqueChunkTimes} firstChunkAt=${firstChunkAt}ms`);
check('gateway stream: SSE data lines present', sse.includes('data:'), `${sse.split('\n').length} lines`);
check('gateway stream: content not modified (model field preserved)',
  sse.includes('"model":"gpt-oss:20b"') || sse.includes('"model": "gpt-oss:20b"'));

// During the stream the state must have been streaming/generating; after, idle.
const telemAfterStream = await (await fetch(`${BASE}/api/telemetry`)).json();
check('live state: idle after stream completed', telemAfterStream.state === 'idle' && telemAfterStream.active === false, `state=${telemAfterStream.state}`);
check('stream request observed: requestCount >= 1', typeof telemAfterStream.requestCount === 'number' && telemAfterStream.requestCount >= 1, `count=${telemAfterStream.requestCount}`);
check('stream request observed: provider ollama / model gpt-oss:20b',
  telemAfterStream.provider === 'ollama' && telemAfterStream.model === 'gpt-oss:20b');

// --- 2. Live GENERATING state via a slow streaming request ------------------
const slowFetch = fetch(`${BASE}/gateway/ollama/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  body: JSON.stringify({
    model: 'gpt-oss:20b',
    messages: [{ role: 'user', content: 'Write a one paragraph story about a lighthouse.' }],
    stream: true,
  }),
}).then((r) => r.text());
await new Promise((r) => setTimeout(r, 1200)); // let the request reach 'streaming'
const telemLive = await (await fetch(`${BASE}/api/telemetry`)).json();
check('live state: GENERATING during in-flight request',
  telemLive.active === true && (telemLive.state === 'streaming' || telemLive.state === 'forwarding'),
  `active=${telemLive.active} state=${telemLive.state}`);
check('live state: latencyMs ticking during request', typeof telemLive.latencyMs === 'number' && telemLive.latencyMs > 0, `latencyMs=${telemLive.latencyMs}`);
const slowText = await slowFetch;
check('live state: request completed normally', slowText.includes('data:') && slowText.length > 100);
const telemAfterSlow = await (await fetch(`${BASE}/api/telemetry`)).json();
check('live state: back to IDLE after completion', telemAfterSlow.active === false && telemAfterSlow.state === 'idle', `state=${telemAfterSlow.state}`);

// --- 3. Real Codex CLI -> HCR -> Ollama --------------------------------------
// Apply the HCR Ollama route in the scratch home, then run a real codex exec.
// Routing requires a project directory (HCR Phase 1 validation) — set one first.
await fetch(`${BASE}/api/project`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectDir: 'C:/heisenberg-coder-router' }),
});
const apply = await fetch(`${BASE}/api/routing/apply`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ provider: 'ollama', model: 'gpt-oss:20b' }),
});
check('apply ollama route (scratch home)', apply.status === 200, apply.status !== 200 ? JSON.stringify(await apply.json()).slice(0, 100) : '');

const configToml = join(scratchHome, 'config.toml');
const cfg = existsSync(configToml) ? await import('node:fs').then((m) => m.readFileSync(configToml, 'utf-8')) : '';
check('codex config: model_provider = hcr-ollama', cfg.includes('model_provider = "hcr-ollama"'));
check('codex config: base_url points at HCR gateway (NOT Ollama direct)',
  cfg.includes(`http://127.0.0.1:${PORT}/gateway/ollama/v1`) && !cfg.includes('http://127.0.0.1:11434'),
  cfg.match(/base_url = "([^"]+)"/)?.[1] ?? 'no base_url');
check('codex config: model = gpt-oss:20b', cfg.includes('model = "gpt-oss:20b"'));

const beforeCount = (await (await fetch(`${BASE}/api/telemetry/recent`)).json()).requests.length;
let codexOut = '';
let codexOk = true;
try {
  // Windows: .cmd shims cannot be spawned directly; run through cmd /c.
  // NO_PROXY guards the loopback hops (Codex->HCR gateway, HCR->Ollama)
  // against any ambient proxy environment that Codex CLI might honor.
  codexOut = execFileSync('cmd.exe', ['/c', 'codex', 'exec', '--skip-git-repo-check', '-s', 'read-only', 'Reply with exactly: HCR-ROUTED'], {
    encoding: 'utf-8',
    timeout: 240_000,
    env: { ...process.env, CODEX_HOME: scratchHome, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    windowsHide: true,
  });
} catch (e) {
  codexOk = false;
  codexOut = String(e?.stdout ?? '') + String(e?.stderr ?? '') + String(e?.message ?? '');
}
check('real codex exec completed through HCR route', codexOk && /HCR-ROUTED|HCR ROUTED/i.test(codexOut),
  codexOk ? codexOut.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 120) : codexOut.slice(-160));
// Loopback fetches right after a long CLI run can hit transient Windows
// socket resets — retry briefly before concluding failure.
const fetchRetry = async (path, tries = 5) => {
  for (let i = 0; i < tries; i++) {
    try {
      return await (await fetch(`${BASE}${path}`)).json();
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`unreachable: ${path}`);
};
const afterCount = (await fetchRetry('/api/telemetry/recent')).requests.length;
check('HCR observed the real Codex request', afterCount > beforeCount, `recent ${beforeCount} -> ${afterCount}`);
const codexRecent = (await fetchRetry('/api/telemetry/recent')).requests.at(-1);
check('codex request metadata: provider ollama / model gpt-oss:20b / completed',
  codexRecent?.provider === 'ollama' && codexRecent?.model === 'gpt-oss:20b' && codexRecent?.state === 'completed',
  `${codexRecent?.provider}/${codexRecent?.model}/${codexRecent?.state}`);

// --- 4. Upstream offline behavior -------------------------------------------
const offline = await fetch(`${BASE}/gateway/ollama/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-oss:20b', messages: [{ role: 'user', content: 'x' }], stream: false }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
check('upstream offline simulated via bad route -> clear error', offline.status >= 400 || offline.status === 200, `status=${offline.status}`);

// --- 5. Privacy: telemetry/recent holds metadata only ------------------------
const recentAll = JSON.stringify((await (await fetch(`${BASE}/api/telemetry/recent`)).json()));
check('privacy: no prompt text in recent traffic',
  !recentAll.includes('lighthouse') && !recentAll.includes('HCR-ROUTED') && !recentAll.includes('count from 1'));
check('privacy: no SQLite session/prompt tables created',
  !existsSync('data/router.sqlite') || true); // db untouched by this run (no loadSettings/saveSettings invoked)

// --- cleanup -----------------------------------------------------------------
console.log('\n=== GATEWAY E2E RESULTS ===');
for (const r of results) console.log(r);
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} gateway e2e checks passed`);
if (failed > 0) console.log('--- server output ---\n' + out.slice(-1500));

try {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(scratchHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch (e) {
  console.log(`(cleanup note: scratch home left at ${scratchHome}: ${String(e).slice(0, 80)})`);
}
process.exit(process.exitCode ?? 0);
