import type { FastifyInstance } from 'fastify';
import type { ProviderType, Provider, Model, StartCodexResponse } from '@heisenberg/contracts';
import type { AppContext } from '../context.js';
import { assertValidProvider } from '@heisenberg/providers';
import { saveProvider, saveModel, saveProject } from '../context.js';
import { AppError } from '@heisenberg/shared';

interface StartCodexBody {
  projectDir?: string;
  provider?: string;
  model?: string | null;
}

export async function registerProviderRoutes(app: FastifyInstance, context: AppContext) {
  const { providers, projects, codexProcess, sessions } = context;

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

  // Set active provider.
  app.post('/api/providers/active', async (request, reply) => {
    const { provider } = request.body as { provider?: string };
    const validated = assertValidProvider(provider ?? '');
    providers.setProvider(validated);
    saveProvider(context, validated);
    // Switching provider resets the model selection.
    saveModel(context, '');
    reply.send({ success: true, provider: validated });
  });

  // Set active model.
  app.post('/api/providers/model', async (request, reply) => {
    const { model } = request.body as { model?: string };
    if (!model || model.trim().length === 0) {
      throw new AppError('Model is required', 400);
    }
    providers.setModel(model.trim());
    saveModel(context, model.trim());
    reply.send({ success: true, model: model.trim() });
  });

  // Start Codex with the selected provider/model in the selected project.
  app.post('/api/codex/start', async (request, reply): Promise<StartCodexResponse> => {
    const body = (request.body ?? {}) as StartCodexBody;

    // Project directory: from body or fall back to the registered project.
    let projectDir = body.projectDir?.trim();
    if (!projectDir && projects.getProject()) {
      projectDir = projects.getProject()!.path;
    }
    if (!projectDir) {
      throw new AppError('Project directory is required before starting Codex', 400);
    }
    const project = await projects.setProject(projectDir);
    saveProject(context, project.path);

    // Provider: from body or fall back to the active provider.
    const provider = body.provider ? assertValidProvider(body.provider) : providers.getActiveProvider();

    // Model: required for Ollama.
    let model = body.model ?? providers.getActiveModel();
    if (provider === 'ollama' && !model) {
      throw new AppError('A model must be selected for the Ollama provider', 400);
    }
    if (model) {
      providers.setModel(model);
      saveModel(context, model);
    }

    await codexProcess.start({ provider, model, projectDir: project.path });
    sessions.recordStart(provider, model, project.path);
    return { run: codexProcess.getStatus() };
  });

  // Stop the running Codex process.
  app.post('/api/codex/stop', async () => {
    codexProcess.stop();
    return { run: codexProcess.getStatus() };
  });
}
