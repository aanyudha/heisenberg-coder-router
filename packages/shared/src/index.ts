import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

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

/**
 * Codex CLI configuration home (CODEX_HOME, default ~/.codex).
 * Verified against codex-cli 0.154.0: `codex doctor` reports CODEX_HOME and
 * reads config from <CODEX_HOME>/config.toml. The VS Code integration's
 * app-server shares the same CODEX_HOME (see codex-engine.ts detection).
 */
export function getCodexHome(): string {
  const envHome = process.env.CODEX_HOME;
  if (envHome && envHome.trim().length > 0) {
    return resolve(envHome.trim());
  }
  return join(homedir(), '.codex');
}

export function getCodexConfigPath(): string {
  return join(getCodexHome(), 'config.toml');
}

/** Default HCR server origin (localhost-only control/data plane). */
export const HCR_DEFAULT_ORIGIN = 'http://127.0.0.1:7876';

/** HCR gateway route prefix for Ollama inference traffic. */
export const HCR_GATEWAY_PREFIX = '/gateway/ollama/v1';

/**
 * Base URL Codex uses for the HCR-managed Ollama provider: the HCR gateway,
 * NOT Ollama directly. This is what puts HCR in the inference data path so
 * live route verification and truthful telemetry are possible.
 */
export function getHcrGatewayBaseUrl(): string {
  const origin = process.env.HCR_ORIGIN?.trim();
  return `${origin && origin.length > 0 ? origin.replace(/\/+$/, '') : HCR_DEFAULT_ORIGIN}${HCR_GATEWAY_PREFIX}`;
}

/**
 * Resolved Ollama upstream base URL for the gateway. Loop prevention: the
 * upstream must never point back at the HCR gateway origin.
 */
export function getGatewayUpstreamBaseUrl(): string {
  const host = process.env.OLLAMA_HOST;
  const ollamaBase =
    host && host.trim().length > 0
      ? /^https?:\/\//.test(host.trim())
        ? host.trim().replace(/\/+$/, '')
        : `http://${host.trim()}`
      : 'http://127.0.0.1:11434';
  const upstream = `${ollamaBase}/v1`;
  const origin = process.env.HCR_ORIGIN?.trim().replace(/\/+$/, '') ?? HCR_DEFAULT_ORIGIN;
  if (upstream.startsWith(origin)) {
    throw new Error(
      `Gateway loop prevented: Ollama upstream (${upstream}) must not point back at the HCR origin (${origin}).`
    );
  }
  return upstream;
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
