import type { FastifyInstance } from 'fastify';
import type { StatusResponse } from '@heisenberg/contracts';
import type { AppContext } from '../context.js';

export async function registerStatusRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { ollama, codex, providers, projects, routing } = context;

  app.get('/api/status', async (): Promise<StatusResponse> => {
    const [ollamaStatus, codexStatus, providerList, routingStatus] = await Promise.all([
      ollama.getStatus(),
      codex.getStatus(),
      providers.getProviders(),
      Promise.resolve(routing.status()),
    ]);

    return {
      server: { host: '127.0.0.1', port: 7876 },
      codex: codexStatus,
      ollama: ollamaStatus,
      providers: providerList,
      routing: routingStatus,
      project: projects.getProject(),
    };
  });
}
