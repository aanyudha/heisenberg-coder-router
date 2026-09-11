import type { FastifyInstance } from 'fastify';
import type { TelemetrySnapshot } from '@heisenberg/contracts';
import type { AppContext } from '../context.js';

export async function registerTelemetryRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { telemetry } = context;

  // Truthful telemetry snapshot. Unknown metrics are null, never faked to zero.
  app.get('/api/telemetry', async (): Promise<TelemetrySnapshot> => {
    return telemetry.getSnapshot();
  });
}
