import type { FastifyInstance } from 'fastify';
import type { CodexStatus } from '@heisenberg/contracts';
import type { AppContext } from '../context.js';

export async function registerCodexRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { codex } = context;

  // Get Codex CLI status (installed or not). Detection only — HCR never
  // launches Codex processes; it routes Codex through its configuration.
  app.get('/api/codex/status', async (): Promise<CodexStatus> => {
    return codex.getStatus();
  });
}
