import type { FastifyInstance } from 'fastify';
import type { Provider, Model } from '@heisenberg/contracts';
import type { AppContext } from '../context.js';
import { assertValidProvider } from '@heisenberg/providers';

export async function registerProviderRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { providers } = context;

  // List all providers with their status.
  app.get('/api/providers', async (): Promise<Provider[]> => {
    return providers.getProviders();
  });

  // List models for a specific provider.
  app.get('/api/providers/:provider/models', async (request): Promise<Model[]> => {
    const { provider } = request.params as { provider: string };
    const validated = assertValidProvider(provider);
    return providers.getModels(validated);
  });
}
