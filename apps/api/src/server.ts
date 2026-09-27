import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'fs';
import { join } from 'path';
import type { AppContext } from './context.js';
import { createContext } from './context.js';
import { AppError } from '@heisenberg/shared';
import { registerHealthRoutes } from './routes/health.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerRoutingRoutes } from './routes/routing.js';
import { registerOllamaRoutes } from './routes/ollama.js';
import { registerCodexRoutes } from './routes/codex.js';
import { registerProjectRoutes } from './routes/project.js';
import { registerTelemetryRoutes } from './routes/telemetry.js';
import { registerBrowserCompanionRoutes } from './routes/browser-companion.js';
import { registerWebHandoffRoutes } from './routes/web-handoff.js';
import { registerHcoderRoutes } from './routes/hcoder.js';
import { registerDownloadRoutes } from './routes/downloads.js';
import { registerGateway } from './gateway.js';

export const HOST = '127.0.0.1';
export const PORT = 7876;

export async function createServer(context: AppContext = createContext()): Promise<{
  app: FastifyInstance;
  context: AppContext;
}> {
  const app = Fastify({
    logger: false,
  });

  // Map AppError to its status code; everything else keeps its own statusCode or 500.
  // Deterministic codes (e.g. HCoder's ROUTE_UNAVAILABLE) ride along so local
  // clients never have to parse prose to decide what failed.
  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : 'Internal server error';
    const statusCode =
      error instanceof AppError
        ? error.statusCode
        : typeof (error as { statusCode?: number } | null)?.statusCode === 'number'
          ? (error as { statusCode: number }).statusCode
          : 500;
    const code = (error as { code?: unknown } | null)?.code;
    reply
      .code(statusCode)
      .send(typeof code === 'string' && code.length > 0 ? { error: message, code } : { error: message });
  });

  // Serve the built React app when it exists (after `npm run build`).
  const webDistPath = join(import.meta.dirname, '../../web/dist');
  if (existsSync(webDistPath)) {
    await app.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
      decorateReply: true,
    });

    // SPA support: index.html for all non-API routes.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.code(404).send({ error: 'Not found' });
      } else {
        reply.sendFile('index.html');
      }
    });
  }

  registerHealthRoutes(app);
  await registerStatusRoutes(app, context);
  await registerProviderRoutes(app, context);
  await registerRoutingRoutes(app, context);
  await registerOllamaRoutes(app, context);
  await registerCodexRoutes(app, context);
  await registerProjectRoutes(app, context);
  await registerTelemetryRoutes(app, context);

  // Web Handoff + Browser Companion (optional ChatGPT Web workflow).
  await registerBrowserCompanionRoutes(app, context);
  await registerWebHandoffRoutes(app, context);
  await registerHcoderRoutes(app, context);
  await registerDownloadRoutes(app);

  // Data plane: transparent Ollama gateway (streaming, metadata-only
  // observation). Registered last so /api routes keep precedence.
  await registerGateway(app, context);

  return { app, context };
}
