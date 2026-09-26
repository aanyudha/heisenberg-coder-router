import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync, statSync } from 'fs';
import { join } from 'path';
import { getRepoRoot } from '@heisenberg/shared';

export const COMPANION_ZIP_NAME = 'hcr-browser-companion.zip';

/** Stable download location of the packaged Browser Companion extension. */
export function companionZipPath(): string {
  return join(getRepoRoot(), 'apps', 'browser-companion', COMPANION_ZIP_NAME);
}

/**
 * Extension distribution straight from HCR: `npm run build` packages the
 * Browser Companion, and this route serves it. The user still installs it
 * manually (Chrome/Edge require an explicit "Load unpacked" approval).
 */
export async function registerDownloadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/downloads/hcr-browser-companion.zip', async (_request, reply) => {
    const zipPath = companionZipPath();
    if (!existsSync(zipPath)) {
      reply.code(404).type('text/plain; charset=utf-8');
      return 'Browser Companion package not found. Run "npm run build" first.';
    }
    const size = statSync(zipPath).size;
    reply
      .header('content-type', 'application/zip')
      .header('content-length', size)
      .header('content-disposition', `attachment; filename="${COMPANION_ZIP_NAME}"`)
      .header('cache-control', 'no-store');
    return reply.send(createReadStream(zipPath));
  });

  // Discovery endpoint for the settings page.
  app.get('/api/browser-companion/download', async () => {
    const zipPath = companionZipPath();
    return {
      url: '/downloads/hcr-browser-companion.zip',
      filename: COMPANION_ZIP_NAME,
      available: existsSync(zipPath),
      bytes: existsSync(zipPath) ? statSync(zipPath).size : 0,
    };
  });
}
