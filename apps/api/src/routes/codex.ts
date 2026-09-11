import type { FastifyInstance } from 'fastify';
import type { CodexStatus } from '@heisenberg/contracts';
import type { AppContext } from '../context.js';

export async function registerCodexRoutes(app: FastifyInstance, { codex }: AppContext) {
  // Get Codex CLI status (installed or not).
  app.get('/api/codex/status', async (): Promise<CodexStatus> => {
    return codex.getStatus();
  });
}
