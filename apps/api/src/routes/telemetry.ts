import type { FastifyInstance } from 'fastify';
import type { RecentRequest, TelemetrySnapshot } from '@heisenberg/contracts';
import type { AppContext } from '../context.js';

export async function registerTelemetryRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { telemetry, gateway } = context;

  // Truthful telemetry snapshot. Unknown metrics are null, never faked to zero.
  // When gateway traffic has been observed, source is 'hcr-gateway' and live
  // state (active/state/requestId) reflects the in-flight or last request.
  app.get('/api/telemetry', async (): Promise<TelemetrySnapshot> => {
    return telemetry.getSnapshot();
  });

  // Recent gateway request metadata (bounded ring buffer, no content).
  app.get('/api/telemetry/recent', async (): Promise<{ requests: RecentRequest[] }> => {
    return { requests: gateway.recent() };
  });
}
