import type { FastifyInstance } from 'fastify';
import type { OllamaStatus, Model } from '@heisenberg/contracts';
import type { AppContext } from '../context.js';

export async function registerOllamaRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { ollama } = context;

  // Get Ollama status (online/offline, version).
  app.get('/api/ollama/status', async (): Promise<OllamaStatus> => {
    return ollama.getStatus();
  });

  // Refresh Ollama status and re-read installed models.
  app.post('/api/ollama/refresh', async (): Promise<OllamaStatus> => {
    return ollama.refresh();
  });

  // List installed Ollama models (read live from the local Ollama API).
  app.get('/api/ollama/models', async (): Promise<Model[]> => {
    return ollama.getModels();
  });
}
