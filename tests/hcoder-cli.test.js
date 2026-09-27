import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HcoderPatchStore } from '../packages/core/dist/index.js';

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Isolated HCR control plane + offline Ollama for this process.
process.env.HCR_DATA_DIR = mkdtempSync(join(tmpdir(), 'hcr-hcoder-cli-db-'));
process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
delete process.env.HCR_PUBLIC_ORIGIN;

const { createContext } = await import('../apps/api/dist/context.js');
const { createServer } = await import('../apps/api/dist/server.js');

const dirs = [process.env.HCR_DATA_DIR];
const HOME = mkdtempSync(join(tmpdir(), 'hcr-hcoder-cli-home-'));
dirs.push(HOME);
const CLI = join(resolve('.'), 'apps', 'cli', 'dist', 'index.js');

const context = createContext();
context.db.initialize();
const { app } = await createServer(context);
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${app.server.address().port}`;

after(async () => {
  await app.close();
  try {
    context.db.close();
  } catch {
    // already closed
  }
  delete process.env.HCR_DATA_DIR;
  delete process.env.OLLAMA_HOST;
  for (const dir of dirs) {
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

/** Runs the built packaged CLI entrypoint in a child process (stdin scripted). */
function hcoder(args, { env = {}, input, cwd } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HCODER_HOME: HOME, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'hcr-hcoder-cli-project-'));
  dirs.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), "export const menu = ['sales'];\n");
  return root;
}

function pairAndConnect() {
  const { code } = context.companion.generatePairingCode();
  context.companion.pair(code);
  context.companion.heartbeat();
}

async function takeTask(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = context.companion.takeTask();
    if (task) return task;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no companion task was queued in time');
}

const DEAD_ORIGIN = 'http://127.0.0.1:9';

test('version, help and unknown options behave predictably', async () => {
  const version = await hcoder(['version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^0\.1\.0$/);

  const help = await hcoder(['help']);
  assert.equal(help.code, 0);
  for (const line of ['hcoder status', 'hcoder diff', 'hcoder apply', 'hcoder revert', 'hcoder route']) {
    assert.match(help.stdout, new RegExp(line.replace(' ', '\\s')));
  }
  assert.match(help.stdout, /never applies them without an explicit "hcoder apply"/);

  const unknown = await hcoder(['--bogus']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /USAGE: Unknown option/);

  assert.match(help.stdout, /hcoder\s+Interactive session in the current project/);

  // An EXPLICIT empty `run` still demands a task - only bare `hcoder` opens
  // the REPL (that dispatch is covered by the interactive tests below).
  const noTask = await hcoder(['run']);
  assert.equal(noTask.code, 2);
  assert.match(noTask.stderr, /A task is required/);
});

test('bare `hcoder` enters the interactive REPL (no "A task is required")', async () => {
  // temporaryProject/ with app.ts + README.md, run with cwd = temporaryProject
  const project = mkdtempSync(join(tmpdir(), 'hcr-hcoder-repl-'));
  dirs.push(project);
  writeFileSync(join(project, 'app.ts'), 'export const answer = 42;\n');
  writeFileSync(join(project, 'README.md'), '# temporaryProject\n');
  const realProject = realpathSync(project);

  const result = await hcoder([], {
    env: { HCR_ORIGIN: DEAD_ORIGIN },
    cwd: project,
    input: 'exit\n',
  });

  assert.equal(result.code, 0, `expected a clean exit, stderr: ${result.stderr}`);
  const all = result.stdout + result.stderr;
  assert.match(result.stdout, /HCoder 0\.1\.0/, 'header contains HCoder');
  assert.match(result.stdout, new RegExp(escapeRegExp(realProject)), 'header contains the project path');
  assert.match(result.stdout, /^> /m, 'the interactive prompt starts');
  assert.doesNotMatch(all, /A task is required/);
  assert.match(result.stdout, /Goodbye\./, '"exit" terminates cleanly');
});

test('interactive REPL commands and agent tasks run through the shared engine', async () => {
  pairAndConnect();
  const project = mkdtempSync(join(tmpdir(), 'hcr-hcoder-repl-cmd-'));
  dirs.push(project);
  writeFileSync(join(project, 'README.md'), '# repl\n');
  const realProject = realpathSync(project);

  // `help` and `project` are REPL commands; every other line runs the SAME
  // agent engine as `hcoder "<task>"`. Two task prompts must stay in ONE
  // logical HCoder session (same handoff/session id, same ChatGPT session).
  const child = hcoder([], {
    env: { HCR_ORIGIN: origin },
    cwd: project,
    input: 'help\nproject\ninspect this project\nnow compare with the README\nexit\n',
  });

  const reply = (message) =>
    JSON.stringify({
      version: 'HCODER_AGENT_V1',
      status: 'answered',
      requests: [],
      message,
    });
  const sessionInfo = {
    chatgptProjectId: 'proj-repl',
    chatgptProjectName: 'REPL Project',
    chatgptProjectUrl: 'https://chatgpt.com/g/project/proj-repl',
    chatId: 'chat-repl',
    chatTitle: 'REPL session',
    chatUrl: 'https://chatgpt.com/c/chat-repl',
    chatMode: 'create',
  };

  // First prompt -> agent turn 1.
  const firstTask = await takeTask();
  assert.equal(firstTask.kind, 'agent');
  assert.match(firstTask.prompt, /HCODER_AGENT_V1/);
  await context.companion.resolveTask(firstTask.id, {
    status: 'OK',
    responseText: reply('The project contains a single README file.'),
    session: sessionInfo,
  });

  // Second prompt -> agent turn 2 in the SAME logical session.
  const secondTask = await takeTask();
  assert.equal(secondTask.kind, 'agent');
  assert.ok(firstTask.handoffId, 'turn 1 carried the logical session id');
  assert.equal(
    secondTask.handoffId,
    firstTask.handoffId,
    'both prompts share one HCoder session (continuity)'
  );
  assert.equal(secondTask.destination?.chatId, 'chat-repl', 'the same chat is reused');
  assert.equal(secondTask.destination?.chatMode, 'continue', 'never creates a second chat');
  await context.companion.resolveTask(secondTask.id, {
    status: 'OK',
    responseText: reply('README.md only documents the project.'),
  });

  const result = await child;
  assert.equal(result.code, 0, `expected a clean exit, stderr: ${result.stderr}`);
  assert.match(result.stdout, /Commands:/, 'help printed the REPL command list');
  assert.match(result.stdout, new RegExp(escapeRegExp(realProject)), 'project printed the root');
  assert.match(result.stdout, /Thinking\.\.\./, 'task lines used the agent engine');
  assert.match(result.stdout, /single README file/, 'the first agent answer was rendered');
  assert.match(result.stdout, /only documents the project/, 'the second agent answer was rendered');
  assert.doesNotMatch(result.stdout + result.stderr, /A task is required/);
  assert.match(result.stdout, /Goodbye\./);
});

test('every command fails with a deterministic code when HCR is unreachable', async () => {
  const env = { HCR_ORIGIN: DEAD_ORIGIN };

  const status = await hcoder(['status'], { env });
  assert.equal(status.code, 1);
  assert.match(status.stderr, /HCR_UNAVAILABLE: HCR is not reachable/);

  const statusJson = await hcoder(['status', '--json'], { env });
  assert.equal(statusJson.code, 1);
  const payload = JSON.parse(statusJson.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'HCR_UNAVAILABLE');

  const route = await hcoder(['route'], { env });
  assert.equal(route.code, 1);
  assert.match(route.stderr, /HCR_UNAVAILABLE/);

  const run = await hcoder(['run', 'add a feature'], { env });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /HCR_UNAVAILABLE/);

  const stdinJson = await hcoder(['--stdin-json', '--json'], {
    env,
    input: JSON.stringify({ task: 'add a feature' }),
  });
  assert.equal(stdinJson.code, 1);
  const stdinPayload = JSON.parse(stdinJson.stdout);
  assert.equal(stdinPayload.ok, false);
  assert.equal(stdinPayload.code, 'HCR_UNAVAILABLE');
});

test('diff / apply / revert / reject / history work without HCR (local store only)', async () => {
  const project = makeProject();
  const original = readFileSync(join(project, 'src', 'app.ts'), 'utf8');
  const store = new HcoderPatchStore(HOME);

  // Nothing staged yet.
  const empty = await hcoder(['diff', '--json', '-p', project]);
  assert.equal(empty.code, 1);
  assert.equal(JSON.parse(empty.stdout).code, 'NO_PENDING_PATCH');

  store.stage(project, {
    version: 'HCR_PATCH_V1',
    summary: 'Add inventory',
    files: [
      { path: 'src/app.ts', action: 'replace', content: "export const menu = ['sales', 'inventory'];\n" },
    ],
  });
  assert.equal(readFileSync(join(project, 'src', 'app.ts'), 'utf8'), original, 'staging wrote nothing');

  const diff = await hcoder(['diff', '--json', '-p', project]);
  assert.equal(diff.code, 0);
  const diffPayload = JSON.parse(diff.stdout);
  assert.equal(diffPayload.ok, true);
  assert.equal(diffPayload.pending.summary, 'Add inventory');
  assert.ok(diffPayload.diffs.length > 0);

  const applied = await hcoder(['apply', '-p', project]);
  assert.equal(applied.code, 0);
  assert.match(applied.stdout, /Applied patch/);
  assert.equal(
    readFileSync(join(project, 'src', 'app.ts'), 'utf8'),
    "export const menu = ['sales', 'inventory'];\n"
  );

  const history = await hcoder(['history', '--json', '-p', project]);
  assert.equal(history.code, 0);
  const entries = JSON.parse(history.stdout).history;
  assert.equal(entries[0].status, 'applied');
  assert.equal(entries[0].summary, 'Add inventory');

  const reverted = await hcoder(['revert', '--json', '-p', project]);
  assert.equal(reverted.code, 0);
  assert.equal(JSON.parse(reverted.stdout).reverted, true);
  assert.equal(readFileSync(join(project, 'src', 'app.ts'), 'utf8'), original, 'revert restored the file');

  const again = await hcoder(['revert'], { env: {}, });
  // Note: this revert targets the current working directory (repo root), so
  // it must fail deterministically rather than touch anything.
  assert.equal(again.code, 1);
  assert.match(again.stderr, /NO_APPLIED_PATCH|NO_PENDING_PATCH|PATCH_PROJECT_MISMATCH|PROJECT_NOT_FOUND/);
});

test('reject discards a pending patch', async () => {
  const project = makeProject();
  const store = new HcoderPatchStore(HOME);
  store.stage(project, {
    version: 'HCR_PATCH_V1',
    summary: 'Discard me',
    files: [{ path: 'src/app.ts', action: 'replace', content: 'changed\n' }],
  });

  const rejected = await hcoder(['reject', '--json', '-p', project]);
  assert.equal(rejected.code, 0);
  assert.equal(JSON.parse(rejected.stdout).rejected, true);
  assert.equal(store.pending(project), null);

  const diff = await hcoder(['diff', '-p', project]);
  assert.equal(diff.code, 1);
  assert.match(diff.stderr, /NO_PENDING_PATCH/);
});

test('the missing project directory fails before anything else', async () => {
  const missing = join(tmpdir(), 'hcr-hcoder-does-not-exist-xyz');
  const result = await hcoder(['diff', '-p', missing]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /PROJECT_NOT_FOUND/);
});

test('end to end: hcoder run -> HCR -> companion -> staged patch -> apply -> revert', async () => {
  pairAndConnect();
  const project = makeProject();
  const original = readFileSync(join(project, 'src', 'app.ts'), 'utf8');
  const env = { HCR_ORIGIN: origin };

  // Start the CLI run, answer it like the browser extension would.
  const runPromise = hcoder(['run', 'Add an inventory menu', '-p', project, '--json'], { env });
  const task = await takeTask();
  assert.equal(task.kind, 'agent');
  assert.match(task.prompt, /HCODER_AGENT_V1/);

  await context.companion.resolveTask(task.id, {
    status: 'OK',
    responseText: JSON.stringify({
      version: 'HCR_PATCH_V1',
      summary: 'Add inventory menu',
      files: [
        {
          path: 'src/app.ts',
          action: 'replace',
          content: "export const menu = ['sales', 'inventory'];\n",
        },
      ],
    }),
    session: {
      chatgptProjectId: 'proj-cli',
      chatgptProjectName: 'CLI Project',
      chatgptProjectUrl: 'https://chatgpt.com/g/project/proj-cli',
      chatId: 'chat-cli',
      chatTitle: 'CLI session',
      chatUrl: 'https://chatgpt.com/c/chat-cli',
      chatMode: 'create',
    },
  });

  const run = await runPromise;
  assert.equal(run.code, 0, `expected success, stderr: ${run.stderr}`);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'patch');
  assert.equal(result.route, 'companion');
  assert.equal(result.provider, 'chatgpt-web');
  assert.equal(result.patch.summary, 'Add inventory menu');
  assert.equal(result.patch.files[0].path, 'src/app.ts');
  assert.equal(readFileSync(join(project, 'src', 'app.ts'), 'utf8'), original, 'run never writes');

  // Review, apply, rollback - all explicit CLI commands.
  const diff = await hcoder(['diff', '-p', project], { env });
  assert.equal(diff.code, 0);
  assert.match(diff.stdout, /Add inventory menu/);

  const applied = await hcoder(['apply', '-p', project], { env });
  assert.equal(applied.code, 0);
  assert.equal(
    readFileSync(join(project, 'src', 'app.ts'), 'utf8'),
    "export const menu = ['sales', 'inventory'];\n"
  );

  const reverted = await hcoder(['revert', '-p', project], { env });
  assert.equal(reverted.code, 0);
  assert.equal(readFileSync(join(project, 'src', 'app.ts'), 'utf8'), original);

  const status = await hcoder(['status', '-p', project, '--json'], { env });
  assert.equal(status.code, 0);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.route, 'companion');
  assert.equal(statusPayload.destination.chatId, 'chat-cli');
  assert.equal(statusPayload.capabilities.shell, false);
  assert.match(statusPayload.dashboardUrl, /:7876\/#\/hcoder/);

  const download = await hcoder(['download', '--json'], { env });
  assert.equal(download.code, 0);
  const packageInfo = JSON.parse(download.stdout).package;
  assert.equal(packageInfo.available, existsSync(join(resolve('.'), 'apps', 'cli', 'hcoder-latest.tgz')));
  assert.match(packageInfo.installCommand, /:7876\/downloads\/hcoder-latest\.tgz/);
});

test('the CLI tarball declares the hcoder bin and ships only dist', async () => {
  const tarball = join(resolve('.'), 'apps', 'cli', 'hcoder-latest.tgz');
  assert.equal(existsSync(tarball), true, 'run npm run build first');
  const pkg = JSON.parse(readFileSync(join(resolve('.'), 'apps', 'cli', 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@heisenberg/hcoder');
  assert.equal(pkg.bin.hcoder, './dist/index.js');
  assert.equal(pkg.private, undefined, 'the package must be publishable to npm pack');
  assert.deepEqual(pkg.files, ['dist']);
});
