import type { FastifyInstance } from 'fastify';
import type { ChatgptDestination, ProjectContextSummary, WebHandoffSummary } from '@heisenberg/contracts';
import type { AppContext } from '../context.js';
import type { WebHandoffDetail } from '@heisenberg/core';
import { AppError } from '@heisenberg/shared';

interface PrepareBody {
  task?: string;
  projectDir?: string;
  selectedFiles?: string[];
}

/**
 * Web Handoff API - the ChatGPT Web intelligence workflow.
 *
 * UI -> API -> WebHandoffEngine -> Browser Companion -> ChatGPT Web ->
 * HCR_PATCH_V1 -> validation -> explicit user review -> WorkspaceApplyEngine.
 */
export async function registerWebHandoffRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { webHandoff, projects } = context;

  // Prepare: builds the reviewable project context. Nothing is transmitted.
  app.post('/api/web-handoff', async (request): Promise<WebHandoffDetail> => {
    const body = (request.body ?? {}) as PrepareBody;
    const projectDir = body.projectDir?.trim() || projects.getProject()?.path;
    if (!projectDir) {
      throw new AppError('Select a project before preparing a Web Handoff', 400);
    }
    return await webHandoff.prepare({
      task: body.task ?? '',
      projectDir,
      selectedFiles: Array.isArray(body.selectedFiles) ? body.selectedFiles : undefined,
    });
  });

  // History (metadata only).
  app.get('/api/web-handoff', async (request): Promise<{ handoffs: WebHandoffSummary[] }> => {
    const { limit } = request.query as { limit?: string };
    const parsed = Number.parseInt(limit ?? '20', 10);
    const clamped = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 20;
    return { handoffs: webHandoff.list(clamped) };
  });

  app.get('/api/web-handoff/:id', async (request): Promise<WebHandoffDetail> => {
    const { id } = request.params as { id: string };
    return await webHandoff.get(id);
  });

  // Privacy review: exactly what would be sent to ChatGPT Web.
  app.get('/api/web-handoff/:id/context', async (request): Promise<ProjectContextSummary> => {
    const { id } = request.params as { id: string };
    return await webHandoff.context(id);
  });

  // Explicit send: queue the prompt for the Browser Companion.
  // Optional `destination` targets one ChatGPT Project + session (§ targeting).
  app.post('/api/web-handoff/:id/send', async (request): Promise<WebHandoffDetail> => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { destination?: ChatgptDestination | null };
    return await webHandoff.send(id, { destination: body.destination ?? null });
  });

  // Correction prompt after an invalid HCR_PATCH_V1 response.
  app.post('/api/web-handoff/:id/retry', async (request): Promise<WebHandoffDetail> => {
    const { id } = request.params as { id: string };
    return await webHandoff.retry(id);
  });

  app.post('/api/web-handoff/:id/reject', async (request): Promise<WebHandoffDetail> => {
    const { id } = request.params as { id: string };
    return await webHandoff.reject(id);
  });

  // Explicit apply: writes into the selected project (no git, no shell).
  app.post('/api/web-handoff/:id/apply', async (request) => {
    const { id } = request.params as { id: string };
    const { outcome, detail } = await webHandoff.apply(id);
    return {
      applied: true,
      changedFiles: outcome.changedFiles,
      files: outcome.files.map((file) => ({
        path: file.path,
        action: file.action,
        status: file.status,
        note: file.note ?? null,
      })),
      diffs: outcome.diffs,
      handoff: detail,
    };
  });

  // One-level rollback of the most recently applied patch.
  app.post('/api/web-handoff/:id/revert', async (request) => {
    const { id } = request.params as { id: string };
    const { outcome, detail } = await webHandoff.revert(id);
    return {
      reverted: true,
      changedFiles: outcome.changedFiles,
      files: outcome.files.map((file) => ({
        path: file.path,
        action: file.action,
        status: file.status,
        note: file.note ?? null,
      })),
      handoff: detail,
    };
  });
}
