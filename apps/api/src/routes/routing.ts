import type { FastifyInstance } from 'fastify';
import type { ApplyRouteResponse, ProviderType, RoutingStatus } from '@heisenberg/contracts';
import type { AppContext } from '../context.js';
import { saveDesiredRoute } from '../context.js';
import { AppError } from '@heisenberg/shared';
import { assertValidProvider } from '@heisenberg/providers';

interface ApplyBody {
  provider?: string;
  model?: string | null;
  projectDir?: string;
}

export async function registerRoutingRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { routing, projects } = context;

  // Current routing state: HCR desired vs Codex applied.
  app.get('/api/routing', async (): Promise<RoutingStatus> => {
    return routing.status();
  });

  // Apply the desired route to Codex config (provider+model as one decision).
  app.post('/api/routing/apply', async (request, reply): Promise<ApplyRouteResponse> => {
    const body = (request.body ?? {}) as ApplyBody;

    if (body.provider !== undefined) {
      const provider = assertValidProvider(body.provider);
      routing.setDesired({ provider });
      saveDesiredRoute(context, { provider });
      // Switching provider clears the model: one routing decision.
      saveDesiredRoute(context, { model: null });
    }
    if (body.model !== undefined) {
      const model = body.model?.trim() || null;
      routing.setDesired({ model });
      saveDesiredRoute(context, { model });
    }

    // Project: from body, or fall back to the registered project.
    let projectDir = body.projectDir?.trim();
    if (!projectDir && projects.getProject()) {
      projectDir = projects.getProject()!.path;
    }
    if (!projectDir) {
      throw new AppError('Project directory is required before applying routing', 400);
    }
    const project = await projects.setProject(projectDir);
    saveDesiredRoute(context, { projectDir: project.path });
    routing.setDesired({ projectDir: project.path });

    const status = await routing.apply();
    void reply;
    return { ok: true, routing: status };
  });

  // Verify routing: drift check + environment checks + VS Code Codex detection.
  app.get('/api/routing/verify', async () => {
    return routing.verify();
  });

  // Set active provider without applying (desired-state selection only).
  app.post('/api/providers/active', async (request, reply) => {
    const { provider } = request.body as { provider?: string };
    const validated = assertValidProvider(provider ?? '') as ProviderType;
    routing.setDesired({ provider: validated });
    saveDesiredRoute(context, { provider: validated, model: null });
    reply.send({ success: true, provider: validated });
  });

  // Set active model without applying (desired-state selection only).
  app.post('/api/providers/model', async (request, reply) => {
    const { model } = request.body as { model?: string };
    if (!model || model.trim().length === 0) {
      throw new AppError('Model is required', 400);
    }
    const trimmed = model.trim();
    routing.setDesired({ model: trimmed });
    saveDesiredRoute(context, { model: trimmed });
    reply.send({ success: true, model: trimmed });
  });
}
