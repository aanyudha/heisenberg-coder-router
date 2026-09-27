import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ChatgptSessionRef,
  HcoderAgentMessage,
  HcoderStatusResponse,
  HcoderTurnRequest,
  HcoderTurnResponse,
} from '@heisenberg/contracts';
import { HCODER_VERSION } from '@heisenberg/contracts';
import type { AgentLoopEvent, AgentLoopResult, AgentLoopTransport, FileDiff } from '@heisenberg/core';
import {
  HcoderAgentLoop,
  HcoderPatchStore,
  HcoderStoreError,
  HcoderToolEngine,
  toUnifiedDiff,
} from '@heisenberg/core';
import { HcrClient, HcrError } from './client.js';

// ---------------------------------------------------------------------- //
// HCoder - provider-neutral local coding agent for HCR.                    //
//                                                                            //
// Boundary rules (never violated here):                                    //
//  - no provider is contacted directly: every turn goes through HCR        //
//  - no shell execution: no cmd/powershell/bash/npm/npx/git                //
//  - no patch is ever applied automatically: stage -> review -> apply      //
// ---------------------------------------------------------------------- //

const COMMANDS = new Set([
  'run',
  'status',
  'diff',
  'apply',
  'revert',
  'reject',
  'history',
  'route',
  'download',
  'help',
  'version',
]);

const HELP = `HCoder ${HCODER_VERSION} - local coding agent for HCR

Usage:
  hcoder <task...>                 Run the agent on a task (default command)
  hcoder run <task...>             Same as above
  hcoder status [--json]           Route, provider, destination, limits, package
  hcoder diff [--json]             Show the pending patch (nothing is written)
  hcoder apply [--json]            Apply the reviewed pending patch
  hcoder revert [--json]           Restore the last HCoder-applied patch
  hcoder reject [--json]           Discard the pending patch
  hcoder history [--limit n]       Patch history (metadata only)
  hcoder route [companion|ollama]  Show or switch the HCR intelligence route
  hcoder download [--json]         Install / update / uninstall commands
  hcoder version                   Print the version

Options:
  -p, --project <dir>   Project root (default: current directory)
      --hcr <origin>    HCR origin (default: $HCR_ORIGIN or http://127.0.0.1:7876)
      --stdin-json      Read {"task","projectRoot"} from stdin, emit JSON result
      --json            Emit machine-readable JSON
  -q, --quiet           Suppress progress lines (errors still go to stderr)
  -h, --help            Show this help
  -V, --version         Show the version

Safety: HCoder reads the project with bounded tools, stages patches locally
and never applies them without an explicit "hcoder apply". There is no shell
execution - all commands, diffs, installs and updates stay inside HCR.`;

class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'CliError';
  }
}

interface CliOptions {
  command: string;
  taskArgs: string[];
  origin?: string;
  project?: string;
  json: boolean;
  quiet: boolean;
  stdinJson: boolean;
  limit: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: 'run',
    taskArgs: [],
    json: false,
    quiet: false,
    stdinJson: false,
    limit: 20,
  };
  let commandTaken = false;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--json') options.json = true;
    else if (token === '--quiet' || token === '-q') options.quiet = true;
    else if (token === '--stdin-json') options.stdinJson = true;
    else if (token === '--help' || token === '-h') options.command = 'help';
    else if (token === '--version' || token === '-V') options.command = 'version';
    else if (token === '--project' || token === '-p') {
      const value = argv[++index];
      if (!value) throw new CliError('USAGE', `${token} requires a directory.`);
      options.project = value;
    } else if (token === '--hcr' || token === '--origin') {
      const value = argv[++index];
      if (!value) throw new CliError('USAGE', `${token} requires an origin URL.`);
      options.origin = value;
    } else if (token === '--limit') {
      const value = Number.parseInt(argv[++index] ?? '', 10);
      if (!Number.isFinite(value) || value < 1) throw new CliError('USAGE', '--limit requires a positive number.');
      options.limit = Math.min(value, 100);
    } else if (token.startsWith('-') && token.length > 1) {
      throw new CliError('USAGE', `Unknown option: ${token}`);
    } else if (!commandTaken && COMMANDS.has(token)) {
      options.command = token;
      commandTaken = true;
    } else {
      options.taskArgs.push(token);
      commandTaken = true;
    }
  }
  return options;
}

// ---- output ------------------------------------------------------------ //

const out = (text: string): void => void process.stdout.write(`${text}\n`);
const err = (text: string): void => void process.stderr.write(`${text}\n`);
const jsonOut = (value: unknown): void => void process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

function reportError(code: string, message: string, json: boolean): void {
  const text = message.startsWith(`${code}: `) ? message : `${code}: ${message}`;
  if (json) jsonOut({ ok: false, code, error: text });
  else err(text);
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof HcrError) return { code: error.code, message: error.message };
  if (error instanceof HcoderStoreError) return { code: error.code, message: error.message };
  if (error instanceof CliError) return { code: error.code, message: error.message };
  return { code: 'ERROR', message: error instanceof Error ? error.message : 'Unexpected failure.' };
}

// ---- helpers ----------------------------------------------------------- //

function requireProject(raw?: string): string {
  const target = resolve(raw ?? process.cwd());
  let stats;
  try {
    stats = statSync(target);
  } catch {
    throw new CliError('PROJECT_NOT_FOUND', `Project directory not found: ${target}`);
  }
  if (!stats.isDirectory()) {
    throw new CliError('PROJECT_NOT_FOUND', `Not a directory: ${target}`);
  }
  return realpathSync(target);
}

function destinationLabel(destination: ChatgptSessionRef | null): string | null {
  if (!destination) return null;
  return (
    destination.chatUrl || destination.chatId || destination.chatgptProjectUrl || destination.chatgptProjectId || null
  );
}

function kilobytes(bytes: number): string {
  return `${Math.round(bytes / 1024)}KB`;
}

function describeDestination(status: HcoderStatusResponse): string {
  if (status.route === 'ollama') return '-';
  const destination = status.destination;
  if (!destination) return 'current ChatGPT tab (the first turn creates the session)';
  const parts = [
    destination.chatgptProjectName || destination.chatgptProjectId,
    destination.chatTitle,
    destination.chatUrl,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : 'saved ChatGPT session';
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function printStatus(status: HcoderStatusResponse): void {
  out(`HCoder ${status.version} · HCR ${status.online ? 'online' : 'offline'}`);
  out(`Route: ${status.routeLabel}`);
  out(`Provider: ${status.provider}${status.model ? ` · ${status.model}` : ''}`);
  out(`Destination: ${describeDestination(status)}`);
  if (status.companion) {
    const paired = status.companion.paired ? 'paired' : 'not paired';
    const connected = status.companion.connected ? 'connected' : 'not connected';
    out(`Companion: ${paired}, ${connected}`);
  }
  const limits = status.limits;
  out(
    `Limits: ${limits.maxRounds} rounds · ${limits.maxToolRequestsPerRound} tools/round · ` +
      `${kilobytes(limits.maxBytesPerFile)}/file · ${kilobytes(limits.maxResultBytesPerRound)}/round · ` +
      `${kilobytes(limits.maxTotalToolResultBytes)}/task`
  );
  out(`Install: ${status.package.installCommand}`);
  out(`Update:  ${status.package.updateCommand}`);
  out(`Remove:  ${status.package.uninstallCommand}`);
  out(
    status.package.available
      ? `Package: ${status.package.bytes} bytes at ${status.package.url}`
      : `Package: not built yet - run "npm run build" (${status.package.url})`
  );
  out(`Dashboard: ${status.dashboardUrl}`);
}

function printTurnLine(event: AgentLoopEvent): void {
  if (event.type === 'round') err(`→ round ${event.round}`);
  else if (event.type === 'tools') err(`← round ${event.round}: ${event.requests} tool request(s)`);
  else if (event.type === 'patch') err(`✓ round ${event.round}: ${event.summary}`);
}

// ---- commands ---------------------------------------------------------- //

async function cmdStatus(options: CliOptions, client: HcrClient): Promise<number> {
  const projectRoot = options.project ? requireProject(options.project) : undefined;
  const status = await client.status(projectRoot);
  if (options.json) jsonOut(status);
  else printStatus(status);
  return 0;
}

async function cmdRoute(options: CliOptions, client: HcrClient): Promise<number> {
  const requested = options.taskArgs[0];
  if (!requested) {
    const status = await client.status(options.project ? requireProject(options.project) : undefined);
    if (options.json) jsonOut({ route: status.route, routeLabel: status.routeLabel });
    else out(`Route: ${status.routeLabel} (${status.route})`);
    return 0;
  }
  const updated = await client.setRoute(requested);
  if (options.json) jsonOut(updated);
  else out(`Route set to: ${updated.routeLabel} (${updated.route})`);
  return 0;
}

async function cmdDownload(options: CliOptions, client: HcrClient): Promise<number> {
  const status = await client.status();
  if (options.json) jsonOut({ package: status.package, dashboardUrl: status.dashboardUrl });
  else {
    out(`Install: ${status.package.installCommand}`);
    out(`Update:  ${status.package.updateCommand}`);
    out(`Remove:  ${status.package.uninstallCommand}`);
    out(`Dashboard: ${status.dashboardUrl}`);
    if (!status.package.available) err('Package not built yet - run "npm run build" first.');
  }
  return 0;
}

async function cmdRun(options: CliOptions, client: HcrClient): Promise<number> {
  let task = options.taskArgs.join(' ').trim();
  let projectInput = options.project;

  if (options.stdinJson) {
    if (process.stdin.isTTY) {
      throw new CliError('USAGE', '--stdin-json requires input on stdin.');
    }
    const raw = await readStdin();
    let input: { task?: unknown; projectRoot?: unknown } = {};
    try {
      input = JSON.parse(raw) as typeof input;
    } catch {
      throw new CliError('USAGE', 'STDIN did not contain valid JSON.');
    }
    if (typeof input.task === 'string') task = input.task;
    if (typeof input.projectRoot === 'string') projectInput = input.projectRoot;
  } else if (!task && !process.stdin.isTTY) {
    task = (await readStdin()).trim();
  }

  if (!task) {
    throw new CliError('USAGE', 'A task is required: hcoder "<what should change>"');
  }

  const projectRoot = requireProject(projectInput);
  // Fail fast when HCR is down, and learn the active route before looping.
  const status = await client.status(projectRoot);
  if (!options.json && !options.quiet) {
    const provider = `${status.provider}${status.model ? ` · ${status.model}` : ''}`;
    err(`HCoder ${HCODER_VERSION} · ${status.routeLabel} · ${provider} · ${projectRoot}`);
  }

  const tools = new HcoderToolEngine(projectRoot);
  const store = new HcoderPatchStore();
  let sessionId: string | undefined;
  let lastTurn: HcoderTurnResponse | null = null;

  const transport: AgentLoopTransport = {
    async submit(messages: HcoderAgentMessage[]): Promise<string> {
      const request: HcoderTurnRequest = {
        ...(sessionId ? { sessionId } : {}),
        projectRoot,
        messages,
      };
      const turn = await client.turn(request);
      sessionId = turn.sessionId;
      lastTurn = turn;
      return turn.reply.raw;
    },
  };

  const loop = new HcoderAgentLoop({
    transport,
    tools,
    onEvent: options.json || options.quiet ? undefined : printTurnLine,
  });

  const result: AgentLoopResult = await loop.run(task);
  // `lastTurn` is only assigned inside the transport closure; read it back
  // through a widened view so TypeScript keeps the full union.
  const turn = lastTurn as HcoderTurnResponse | null;
  const meta = {
    route: turn?.route ?? null,
    provider: turn?.provider ?? null,
    model: turn?.model ?? null,
    destination: destinationLabel(turn?.destination ?? null),
  };
  const common = {
    rounds: result.rounds,
    sessionId: sessionId ?? null,
    route: meta.route,
    provider: meta.provider,
    model: meta.model,
  };

  if (result.kind === 'error') {
    reportError(result.code, result.message, options.json);
    return 1;
  }

  if (result.kind === 'text') {
    if (options.json) jsonOut({ ok: true, kind: 'text', text: result.text, ...common });
    else out(result.text);
    return 0;
  }

  // Patch: stage it. NEVER applied here - the user reviews first.
  const staged = store.stage(projectRoot, result.patch, meta);
  if (options.json) {
    jsonOut({
      ok: true,
      kind: 'patch',
      ...common,
      patch: {
        id: staged.id,
        summary: staged.summary,
        files: staged.patch.files.map((file) => ({ path: file.path, action: file.action })),
      },
    });
    return 0;
  }
  out(`Patch staged (nothing written to disk): ${staged.summary}`);
  for (const file of staged.patch.files) {
    out(`  ${file.action.padEnd(7)} ${file.path}`);
  }
  out('');
  out('Review: hcoder diff    Apply: hcoder apply    Reject: hcoder reject');
  return 0;
}

async function cmdDiff(options: CliOptions): Promise<number> {
  const projectRoot = requireProject(options.project);
  const store = new HcoderPatchStore();
  const pending = store.pending(projectRoot);
  if (!pending) {
    reportError('NO_PENDING_PATCH', 'No pending patch. Run the agent first.', options.json);
    return 1;
  }
  const diffs: FileDiff[] = store.diff(projectRoot);
  if (options.json) {
    jsonOut({
      ok: true,
      pending: { id: pending.id, summary: pending.summary, createdAt: pending.createdAt },
      diffs,
    });
    return 0;
  }
  out(`Pending patch ${pending.id}: ${pending.summary}`);
  if (diffs.length === 0) {
    out('Pending patch produces no changes against the current files.');
    return 0;
  }
  for (const diff of diffs) out(toUnifiedDiff(diff));
  return 0;
}

async function cmdApply(options: CliOptions): Promise<number> {
  const projectRoot = requireProject(options.project);
  const store = new HcoderPatchStore();
  const { outcome, entry } = await store.apply(projectRoot);
  if (options.json) {
    jsonOut({
      ok: true,
      applied: true,
      id: entry.id,
      changedFiles: outcome.changedFiles.length,
      files: outcome.files.map((file) => ({
        path: file.path,
        action: file.action,
        status: file.status,
        note: file.note ?? null,
      })),
    });
    return 0;
  }
  out(`Applied patch ${entry.id}: ${outcome.changedFiles.length} file(s) changed`);
  for (const file of outcome.files) {
    out(`  ${file.status.padEnd(9)} ${file.action.padEnd(7)} ${file.path}${file.note ? ` (${file.note})` : ''}`);
  }
  out('Rollback: hcoder revert');
  return 0;
}

async function cmdRevert(options: CliOptions): Promise<number> {
  const projectRoot = requireProject(options.project);
  const store = new HcoderPatchStore();
  const { restored, entry } = await store.revert(projectRoot);
  if (options.json) jsonOut({ ok: true, reverted: true, id: entry.id, restored });
  else {
    out(`Reverted patch ${entry.id}: ${restored.length} path(s) restored.`);
    for (const path of restored) out(`  ${path}`);
  }
  return 0;
}

async function cmdReject(options: CliOptions): Promise<number> {
  const projectRoot = requireProject(options.project);
  const store = new HcoderPatchStore();
  const entry = store.reject(projectRoot);
  if (options.json) jsonOut({ ok: true, rejected: true, id: entry.id });
  else out(`Rejected patch ${entry.id}: ${entry.summary}`);
  return 0;
}

async function cmdHistory(options: CliOptions): Promise<number> {
  const projectRoot = requireProject(options.project);
  const store = new HcoderPatchStore();
  const history = store.history(projectRoot, options.limit);
  if (options.json) jsonOut({ ok: true, history });
  else if (history.length === 0) out('No HCoder patch history for this project.');
  else {
    for (const entry of history) {
      const files = `${entry.filesChanged} file(s)`;
      const detail = entry.status === 'failed' && entry.error ? ` · ${entry.error}` : '';
      out(`[${entry.status.padEnd(8)}] ${entry.timestamp}  ${files.padEnd(10)}  ${entry.summary}${detail}`);
    }
  }
  return 0;
}

// ---- entry ------------------------------------------------------------- //

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const client = new HcrClient(options.origin);

  switch (options.command) {
    case 'help':
      out(HELP);
      return 0;
    case 'version':
      out(HCODER_VERSION);
      return 0;
    case 'status':
      return await cmdStatus(options, client);
    case 'route':
      return await cmdRoute(options, client);
    case 'download':
      return await cmdDownload(options, client);
    case 'run':
      return await cmdRun(options, client);
    case 'diff':
      return await cmdDiff(options);
    case 'apply':
      return await cmdApply(options);
    case 'revert':
      return await cmdRevert(options);
    case 'reject':
      return await cmdReject(options);
    case 'history':
      return await cmdHistory(options);
    default:
      throw new CliError('USAGE', `Unknown command: ${options.command}`);
  }
}

const wantsJson = process.argv.includes('--json');
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const { code, message } = errorDetails(error);
    reportError(code, message, wantsJson);
    process.exitCode = code === 'USAGE' ? 2 : 1;
  });
