#!/usr/bin/env node
/**
 * Builds and packages the HCoder CLI (@heisenberg/hcoder).
 *
 * Invoked by the root `npm run build` so the package is always available at:
 *   GET http://127.0.0.1:7876/downloads/hcoder-latest.tgz
 *
 * Output:
 *   apps/cli/dist/index.js                       (self-contained bundle)
 *   apps/cli/heisenberg-hcoder-<version>.tgz     (npm pack artifact)
 *   apps/cli/hcoder-latest.tgz                   (stable download name)
 *
 * The bundle is standalone: HCR's workspace packages are compiled in, so the
 * installed CLI has zero runtime dependencies and never needs the repo.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const cliRoot = join(repoRoot, 'apps', 'cli');
const distRoot = join(cliRoot, 'dist');
const entry = join(cliRoot, 'src', 'index.ts');
const latestPath = join(cliRoot, 'hcoder-latest.tgz');

/**
 * Run npm cross-platform. Inside `npm run` scripts the npm entry point is
 * exposed via npm_execpath (invoked with the current node binary); outside it
 * we fall back to npm on PATH (shell form on Windows, where npm is a .cmd).
 */
function runNpm(args) {
  const options = { cwd: cliRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] };
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && npmExecPath.length > 0) {
    return execFileSync(process.execPath, [npmExecPath, ...args], options);
  }
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    ...options,
    shell: process.platform === 'win32',
  });
}

async function bundle() {
  rmSync(distRoot, { recursive: true, force: true });
  mkdirSync(distRoot, { recursive: true });

  // tsconfig paths point at the workspace sources - the bundle therefore
  // never depends on stale dist/ output of the other packages.
  await build({
    entryPoints: [entry],
    outfile: join(distRoot, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    sourcemap: false,
    logLevel: 'warning',
    absWorkingDir: repoRoot,
    tsconfig: join(repoRoot, 'tsconfig.json'),
    banner: { js: '#!/usr/bin/env node' },
  });

  const bytes = statSync(join(distRoot, 'index.js')).size;
  console.log(`hcoder bundle: dist/index.js (${bytes} bytes)`);
  if (bytes < 10_000) {
    throw new Error('HCoder bundle unexpectedly small - build is broken.');
  }
}

function pack() {
  // Remove stale artifacts so we never ship an outdated tarball.
  for (const file of ['hcoder-latest.tgz']) {
    const path = join(cliRoot, file);
    if (existsSync(path)) unlinkSync(path);
  }

  const stdout = runNpm(['pack', '--pack-destination', distRoot]);
  const filename = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!filename || !filename.endsWith('.tgz')) {
    throw new Error(`npm pack did not report a tarball name (got: ${stdout.trim()}).`);
  }

  const packed = join(distRoot, filename);
  if (!existsSync(packed)) {
    throw new Error(`npm pack reported ${filename} but the file is missing.`);
  }
  copyFileSync(packed, join(cliRoot, filename)); // canonical versioned name
  copyFileSync(packed, latestPath); // stable name HCR serves
  unlinkSync(packed);

  console.log(`hcoder package: apps/cli/${filename}`);
  console.log(`hcoder package: apps/cli/hcoder-latest.tgz (${statSync(latestPath).size} bytes)`);
}

async function main() {
  await bundle();
  pack();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
