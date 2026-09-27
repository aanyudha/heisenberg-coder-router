import type { FastifyInstance } from 'fastify';
import type { HcoderRoute, HcoderStatusResponse, HcoderTurnRequest, HcoderTurnResponse } from '@heisenberg/contracts';
import { HCODER_ROUTE_LABELS } from '@heisenberg/contracts';
import type { AppContext } from '../context.js';
import { hcoderPackageInfo, publicOrigin } from './downloads.js';

/**
 * HCoder API - the local coding agent's control channel.
 *
 * HCoder (the installed CLI) never talks to a provider: every agent turn
 * goes through `POST /api/hcoder/turn`, and HCR's HcoderEngine picks the
 * active intelligence route (Browser Companion -> ChatGPT Web, Ollama ->
 * local model). Filesystem tools, patch staging and apply/revert stay local
 * to the CLI (HCR_PATCH_V1 remains the only write protocol).
 */
export async function registerHcoderRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { hcoder } = context;

  // One agent turn (full local conversation history; CLI owns the session).
  app.post('/api/hcoder/turn', async (request): Promise<HcoderTurnResponse> => {
    const body = (request.body ?? {}) as HcoderTurnRequest;
    return await hcoder.turn(body);
  });

  // Status for the CLI and the dashboard (route, provider, limits, package).
  app.get('/api/hcoder/status', async (request): Promise<HcoderStatusResponse> => {
    const { projectRoot } = request.query as { projectRoot?: string };
    return {
      ...hcoder.describe(projectRoot),
      package: hcoderPackageInfo(),
      dashboardUrl: `${publicOrigin()}/#/hcoder`,
    };
  });

  // Explicit route selection (persisted in HCR - the CLI never picks one).
  app.post('/api/hcoder/route', async (request): Promise<{ route: HcoderRoute; routeLabel: string }> => {
    const body = (request.body ?? {}) as { route?: string };
    const route = hcoder.setRoute(typeof body.route === 'string' ? body.route : '');
    return { route, routeLabel: HCODER_ROUTE_LABELS[route] };
  });

  // Which conversation the companion route last used for a local project
  // (session continuity info shown by `hcoder status`).
  app.get('/api/hcoder/destination', async (request): Promise<{ destination: unknown | null }> => {
    const { projectRoot } = request.query as { projectRoot?: string };
    return { destination: hcoder.destinationFor(projectRoot ?? '') };
  });
}
