import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@heisenberg/contracts';

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get('/api/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  });
}
