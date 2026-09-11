import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);

export class AppError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
  }
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Check if a command is available in PATH (cross-platform: `where` on Windows,
 * `command -v` on POSIX).
 */
export async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    const check = isWindows() ? `where ${command}` : `command -v ${command}`;
    await execAsync(check, { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the absolute path of a command, or null when not found.
 */
export async function resolveCommandPath(command: string): Promise<string | null> {
  try {
    const check = isWindows() ? `where ${command}` : `command -v ${command}`;
    const { stdout } = await execAsync(check, { windowsHide: true });
    const firstLine = stdout.trim().split(/\r?\n/)[0];
    return firstLine || null;
  } catch {
    return null;
  }
}

/**
 * Run a command and return trimmed stdout, or null on failure. Never throws.
 */
export async function safeExec(command: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const { stdout } = await execAsync(command, {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: timeoutMs,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Walk up from startDir until a package.json named "heisenberg-coder-router"
 * is found, so the repository root works regardless of the current working
 * directory (dev, built, or installed layout).
 */
export function findRepoRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 15; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (pkg.name === 'heisenberg-coder-router') {
          return dir;
        }
      } catch {
        // Malformed package.json: keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir);
}

let cachedRepoRoot: string | null = null;

export function getRepoRoot(): string {
  if (!cachedRepoRoot) {
    cachedRepoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  }
  return cachedRepoRoot;
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

export function getDataDir(): string {
  return join(getRepoRoot(), 'data');
}

export function getDbPath(): string {
  return join(getDataDir(), 'router.sqlite');
}

export function ensureDataDir(): string {
  const dataDir = getDataDir();
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function formatDate(date: Date = new Date()): string {
  return date.toISOString();
}

export { basename };
