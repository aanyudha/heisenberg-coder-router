import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync, statSync } from 'fs';
import { join } from 'path';
import { getRepoRoot } from '@heisenberg/shared';
import { HCODER_VERSION } from '@heisenberg/contracts';
import type { HcoderPackageInfo } from '@heisenberg/contracts';

export const COMPANION_ZIP_NAME = 'hcr-browser-companion.zip';
export const HCODER_TARBALL_NAME = 'hcoder-latest.tgz';

/**
 * HCR control-plane origin. Fixed port 7876 (the established HCR origin) -
 * never migrated. Override only with an explicit HCR_PUBLIC_ORIGIN.
 */
const DEFAULT_ORIGIN = 'http://127.0.0.1:7876';

export function publicOrigin(): string {
  const override = (process.env.HCR_PUBLIC_ORIGIN ?? '').trim().replace(/\/+$/, '');
  return override.length > 0 ? override : DEFAULT_ORIGIN;
}

/** Stable download location of the packaged Browser Companion extension. */
export function companionZipPath(): string {
  return join(getRepoRoot(), 'apps', 'browser-companion', COMPANION_ZIP_NAME);
}

/** Stable download location of the packaged HCoder CLI tarball. */
export function hcoderTarballPath(): string {
  return join(getRepoRoot(), 'apps', 'cli', HCODER_TARBALL_NAME);
}

/** Install/update/uninstall commands for the local HCoder package. */
export function hcoderPackageInfo(): HcoderPackageInfo {
  const origin = publicOrigin();
  const tarballUrl = `${origin}/downloads/${HCODER_TARBALL_NAME}`;
  return {
    name: '@heisenberg/hcoder',
    version: HCODER_VERSION,
    filename: HCODER_TARBALL_NAME,
    available: existsSync(hcoderTarballPath()),
    bytes: existsSync(hcoderTarballPath()) ? statSync(hcoderTarballPath()).size : 0,
    url: tarballUrl,
    installCommand: `npm install -g ${tarballUrl}`,
    updateCommand: `npm install -g --force ${tarballUrl}`,
    uninstallCommand: 'npm uninstall -g @heisenberg/hcoder',
  };
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

  // HCoder CLI tarball: local npm distribution served by HCR itself.
  app.get(`/downloads/${HCODER_TARBALL_NAME}`, async (_request, reply) => {
    const tarballPath = hcoderTarballPath();
    if (!existsSync(tarballPath)) {
      reply.code(404).type('text/plain; charset=utf-8');
      return 'HCoder package not found. Run "npm run build" first.';
    }
    const size = statSync(tarballPath).size;
    reply
      .header('content-type', 'application/gzip')
      .header('content-length', size)
      .header('content-disposition', `attachment; filename="${HCODER_TARBALL_NAME}"`)
      .header('cache-control', 'no-store');
    return reply.send(createReadStream(tarballPath));
  });

  // Discovery endpoint for the HCoder dashboard / CLI status.
  app.get('/api/hcoder/download', async () => {
    const info = hcoderPackageInfo();
    return { url: `/downloads/${HCODER_TARBALL_NAME}`, filename: info.filename, available: info.available, bytes: info.bytes };
  });
}
