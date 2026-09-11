import type { CodexStatus } from '@heisenberg/contracts';
import { isCommandAvailable, resolveCommandPath, safeExec } from '@heisenberg/shared';

/**
 * Codex Engine - Detects the Codex CLI in PATH.
 * Codex is an external dependency; this engine never installs it.
 */
export class CodexEngine {
  private status: CodexStatus | null = null;

  async initialize(): Promise<CodexStatus> {
    const installed = await isCommandAvailable('codex');
    const path = installed ? await resolveCommandPath('codex') : null;
    const version = installed ? await safeExec('codex --version') : null;

    this.status = {
      installed,
      path: path ?? undefined,
      version: version ?? undefined,
    };

    return this.status;
  }

  async getStatus(): Promise<CodexStatus> {
    if (!this.status) {
      return this.initialize();
    }
    return this.status;
  }

  async refresh(): Promise<CodexStatus> {
    return this.initialize();
  }

  isInstalled(): boolean {
    return this.status?.installed ?? false;
  }
}
