import type { FastifyInstance } from 'fastify';
import type { ProjectInfo } from '@heisenberg/contracts';
import type { AppContext } from '../context.js';
import { saveProject } from '../context.js';
import { AppError } from '@heisenberg/shared';

export async function registerProjectRoutes(app: FastifyInstance, context: AppContext) {
  const { projects } = context;

  // Get current project.
  app.get('/api/project', async (): Promise<{ project: ProjectInfo | null }> => {
    return { project: projects.getProject() };
  });

  // Set the project directory Codex will run in.
  app.post('/api/project', async (request): Promise<{ project: ProjectInfo }> => {
    const { projectDir } = request.body as { projectDir?: string };
    if (!projectDir || projectDir.trim().length === 0) {
      throw new AppError('projectDir is required', 400);
    }
    const project = await projects.setProject(projectDir.trim());
    saveProject(context, project.path);
    return { project };
  });
}
