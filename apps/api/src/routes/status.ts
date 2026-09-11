import type { FastifyInstance } from 'fastify';
import type { StatusResponse } from '@heisenberg/contracts';
import type { AppContext } from '../context.js';

export async function registerStatusRoutes(
  app: FastifyInstance,
  { ollama, codex, codexProcess, providers, projects }: AppContext
) {
  app.get('/api/status', async (): Promise<StatusResponse> => {
    const [ollamaStatus, codexStatus, providerList] = await Promise.all([
      ollama.getStatus(),
      codex.getStatus(),
      providers.getProviders(),
    ]);

    return {
      server: { host: '127.0.0.1', port: 7876 },
      codex: codexStatus,
      ollama: ollamaStatus,
      providers: providerList,
      activeProvider: providers.getActiveProvider(),
      activeModel: providers.getActiveModel(),
      project: projects.getProject(),
      run: codexProcess.getStatus(),
    };
  });
}
