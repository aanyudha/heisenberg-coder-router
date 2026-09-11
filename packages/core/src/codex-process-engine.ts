import type { CodexRunStatus, ProviderType } from '@heisenberg/contracts';
import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { AppError, formatDate, isCommandAvailable, isWindows } from '@heisenberg/shared';

/**
 * Codex Process Engine - Starts and stops the Codex CLI as a child process
 * bound to a project directory, provider, and model.
 *
 * - Ollama: `codex --oss -m <model>` (Codex talks to the local Ollama API)
 * - OpenAI: `codex` (Codex uses its existing OpenAI login/configuration)
 */
export class CodexProcessEngine {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private state: CodexRunStatus['state'] = 'idle';
  private provider: ProviderType | null = null;
  private model: string | null = null;
  private projectDir: string | null = null;
  private startedAt: string | null = null;
  private exitedAt: string | null = null;
  private exitCode: number | null = null;
  private lastError: string | null = null;
  private command: string | null = null;

  isRunning(): boolean {
    return this.state === 'running' || this.state === 'starting';
  }

  getStatus(): CodexRunStatus {
    return {
      state: this.state,
      pid: this.child?.pid,
      command: this.command ?? undefined,
      provider: this.provider ?? undefined,
      model: this.model ?? undefined,
      projectDir: this.projectDir ?? undefined,
      startedAt: this.startedAt ?? undefined,
      exitedAt: this.exitedAt ?? undefined,
      exitCode: this.exitCode,
      error: this.lastError ?? undefined,
    };
  }

  /**
   * Start Codex in the given project directory. Resolves once the process is
   * spawned; Codex itself runs its own TUI in the spawned console window.
   */
  async start(options: {
    provider: ProviderType;
    model: string | null;
    projectDir: string;
  }): Promise<CodexRunStatus> {
    if (this.isRunning()) {
      throw new AppError('Codex is already running. Stop it first.', 409);
    }

    if (!(await isCommandAvailable('codex'))) {
      throw new AppError(
        'Codex CLI is not installed or not in PATH. Install it with: npm install -g @openai/codex',
        400
      );
    }

    const args: string[] = [];
    if (options.provider === 'ollama') {
      if (!options.model) {
        throw new Error('A model must be selected when using the Ollama provider.');
      }
      // `--oss` points Codex at the local Ollama endpoint (localhost:11434).
      args.push('--oss', '-m', options.model);
    }
    // OpenAI: no extra flags — Codex uses its existing login/configuration.

    const command = ['codex', ...args].join(' ');
    this.command = command;
    this.state = 'starting';
    this.lastError = null;
    this.provider = options.provider;
    this.model = options.model;
    this.projectDir = options.projectDir;

    await new Promise<void>((resolveP, rejectP) => {
      try {
        this.child = spawn('codex', args, {
          cwd: options.projectDir,
          // On Windows, a shell is required to resolve .cmd shims from npm.
          shell: isWindows(),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: !isWindows(),
          windowsHide: false,
        });
      } catch (error) {
        this.state = 'stopped';
        this.lastError = error instanceof Error ? error.message : 'Failed to spawn Codex';
        rejectP(new Error(this.lastError));
        return;
      }

      let settled = false;
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(grace);
        this.state = 'running';
        this.startedAt = formatDate();
        resolveP();
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(grace);
        this.state = 'stopped';
        this.exitedAt = formatDate();
        this.lastError = message;
        this.child = null;
        rejectP(new Error(message));
      };

      const onExit = (code: number | null) => {
        this.exitCode = code;
        this.exitedAt = formatDate();
        if (!settled) {
          // Process died before the grace period: startup failed.
          fail(`Codex exited immediately with code ${code ?? 'unknown'}`);
          return;
        }
        this.state = this.state === 'stopped' ? 'stopped' : 'exited';
        this.child = null;
      };

      this.child.once('error', (error) => fail(error.message));
      this.child.once('exit', onExit);

      // If the process is still alive after a short grace period, consider it started.
      const grace = setTimeout(() => succeed(), 700);
    });

    return this.getStatus();
  }

  /**
   * Stop the running Codex process.
   */
  stop(): CodexRunStatus {
    if (!this.child) {
      if (this.state === 'running' || this.state === 'starting') {
        this.state = 'stopped';
        this.exitedAt = formatDate();
      }
      return this.getStatus();
    }
    try {
      if (isWindows()) {
        // taskkill kills the spawned shell and its child (codex).
        spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true });
      } else if (this.child.pid) {
        try {
          process.kill(-this.child.pid, 'SIGTERM');
        } catch {
          this.child.kill('SIGTERM');
        }
      }
      this.state = 'stopped';
      this.exitedAt = formatDate();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Failed to stop Codex';
    }
    return this.getStatus();
  }
}
