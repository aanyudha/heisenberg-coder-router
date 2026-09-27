import { existsSync, realpathSync } from 'fs';
import { isAbsolute, resolve, sep, join } from 'path';
import type { HcrPatchFile, HcrPatchV1 } from '@heisenberg/contracts';

export interface PathValidationResult {
  ok: boolean;
  /** Normalized project-relative path (forward slashes). */
  relativePath: string;
  /** Absolute path inside the project root (only when ok). */
  absolutePath: string | null;
  error: string | null;
}

/** What the caller intends to do with the path (affects wording only). */
export type PathPurpose = 'write' | 'read';

export interface PatchPathIssue {
  path: string;
  error: string;
}

export interface PatchPathValidation {
  ok: boolean;
  issues: PatchPathIssue[];
}

/** Default files Web Handoff may never create/replace/delete. */
export const DEFAULT_PROTECTED_PATTERNS: readonly string[] = [
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.sample',
  '!.env.template',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.keystore',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_*',
  '.npmrc',
  '.netrc',
  'credentials',
  'credentials.*',
  'secrets.*',
  '*.secret',
  '.ssh/*',
  '.git/*',
  'data/*.sqlite',
  'data/*.sqlite-*',
];

/** Windows reserved device names (also invalid as file stems). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** System directories a patch must never target, even relative to a root. */
const SYSTEM_PREFIXES = [
  'c:\\windows',
  'c:\\program files',
  'c:\\programdata',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/var',
  '/boot',
  '/system32',
];

function normalizeSeparators(input: string): string {
  return input.replace(/\\/g, '/');
}

function isCaseInsensitivePlatform(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

/** True when `child` is inside `parent` (or equal to it). */
export function isInside(parent: string, child: string): boolean {
  const a = resolve(parent);
  const b = resolve(child);
  if (a === b) return true;
  const rel = relPath(a, b);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function relPath(from: string, to: string): string {
  const fromParts = splitPath(from);
  const toParts = splitPath(to);
  const ignoreCase = isCaseInsensitivePlatform();
  const cmp = (s: string) => (ignoreCase ? s.toLowerCase() : s);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && cmp(fromParts[i]) === cmp(toParts[i])) i++;
  return [...Array(fromParts.length - i).fill('..'), ...toParts.slice(i)].join('/');
}

function splitPath(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0 && !/^[a-zA-Z]:$/.test(s));
}

/** Simple glob-ish matcher for the protected patterns (no dependencies). */
/** Directory components no patch may ever write into. */
const PROTECTED_DIRS = new Set(['.git', '.ssh', '.hg', '.svn']);

function matchesPattern(relPathValue: string, pattern: string): boolean {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  const regexSource = `^${body
    .split('*')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
    .join('.*')}$`;
  const matched = new RegExp(regexSource, 'i').test(relPathValue);
  return negated ? false : matched;
}

/**
 * Patch Validation Engine - workspace path safety for Web Handoff.
 *
 * Every path returned by ChatGPT Web must resolve inside the selected project
 * root. Absolute paths, "..", Windows system directories, reserved device
 * names, protected secret files and symlink escapes are rejected before any
 * file operation happens.
 */
export class PatchValidationEngine {
  private readonly protectedPatterns: string[];

  constructor(protectedPatterns: readonly string[] = DEFAULT_PROTECTED_PATTERNS) {
    this.protectedPatterns = [...protectedPatterns];
  }

  /** Whether a project-relative path is protected (secret/HCR-private). */
  isProtected(relativePath: string): string | null {
    const normalized = normalizeSeparators(relativePath).replace(/^\.\//, '');
    // Patterns match either the full relative path or the file basename, so
    // `src/id_rsa` and `certs/server.pem` are protected like their root-level
    // counterparts.
    const candidates = [normalized, normalized.slice(normalized.lastIndexOf('/') + 1)];
    let protectedBy: string | null = null;
    for (const pattern of this.protectedPatterns) {
      if (pattern.startsWith('!')) continue;
      if (candidates.some((candidate) => matchesPattern(candidate, pattern))) {
        // A later negation pattern (e.g. !.env.example) can unprotect.
        protectedBy = pattern;
      }
    }
    if (!protectedBy) return null;
    for (const pattern of this.protectedPatterns) {
      if (!pattern.startsWith('!')) continue;
      const body = pattern.slice(1);
      if (candidates.some((candidate) => matchesPattern(candidate, body))) {
        return null;
      }
    }
    return protectedBy;
  }

  /**
   * Validate one raw path from an untrusted source against a project root.
   *
   * The same engine guards Web Handoff writes and HCoder reads - only the
   * wording of a rejection differs (`purpose`). There is intentionally no
   * second path-validation implementation anywhere in the product.
   */
  validateProjectPath(
    projectRoot: string,
    rawPath: string,
    purpose: PathPurpose = 'write'
  ): PathValidationResult {
    const actor = purpose === 'read' ? 'HCoder' : 'Web Handoff';
    const verb = purpose === 'read' ? 'read' : 'modified';
    const fail = (error: string): PathValidationResult => ({
      ok: false,
      relativePath: rawPath,
      absolutePath: null,
      error,
    });

    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      return fail('Path is empty.');
    }
    const trimmed = rawPath.trim();
    if (trimmed.includes('\0')) {
      return fail('Path contains a null byte.');
    }

    // Absolute paths are rejected outright (Windows and POSIX forms).
    if (
      isAbsolute(trimmed) ||
      trimmed.startsWith('/') ||
      trimmed.startsWith('\\') ||
      /^[a-zA-Z]:[\\/]?/.test(trimmed) ||
      /^\\\\/.test(trimmed)
    ) {
      return fail(`Absolute paths are not allowed: ${trimmed}`);
    }

    const withForwardSlashes = normalizeSeparators(trimmed);
    const rawSegments = withForwardSlashes.split('/');
    const segments: string[] = [];
    for (const segment of rawSegments) {
      if (segment.length === 0 || segment === '.') continue;
      if (segment === '..') {
        return fail(`Parent directory traversal ("..") is not allowed: ${trimmed}`);
      }
      const stem = segment.split('.')[0];
      if (WINDOWS_RESERVED.test(stem)) {
        return fail(`Windows reserved device name is not allowed: ${segment}`);
      }
      segments.push(segment);
    }
    if (segments.length === 0) {
      return fail('Path resolves to the project root.');
    }

    const relativePath = segments.join('/');
    const projectRootResolved = resolve(projectRoot);
    const absolutePath = resolve(projectRootResolved, ...segments);

    // Defense in depth: the resolved path must stay inside the root.
    if (!isInside(projectRootResolved, absolutePath)) {
      return fail(`Path escapes the project root: ${trimmed}`);
    }

    // Windows system directories (applies when a project root sits on a drive
    // root, e.g. C:\ plus a relative "Windows/System32/..." path).
    const lowerAbsolute = absolutePath.toLowerCase();
    for (const prefix of SYSTEM_PREFIXES) {
      if (lowerAbsolute === prefix || lowerAbsolute.startsWith(`${prefix}${sep}`) || lowerAbsolute.startsWith(`${prefix}/`)) {
        return fail(`System directory paths are not allowed: ${absolutePath}`);
      }
    }

    // Symlink traversal: an existing ancestor that resolves outside the
    // project root (after realpath) is rejected.
    const linkError = this.checkSymlinkEscape(projectRootResolved, segments);
    if (linkError) return fail(linkError);

    const protectedDir = segments.find((segment) => PROTECTED_DIRS.has(segment.toLowerCase()));
    if (protectedDir) {
      return fail(`Protected directory ("${protectedDir}") cannot be ${verb} by ${actor}: ${relativePath}`);
    }

    const protectedBy = this.isProtected(relativePath);
    if (protectedBy) {
      return fail(`Protected file (${protectedBy}) cannot be ${verb} by ${actor}: ${relativePath}`);
    }

    return { ok: true, relativePath, absolutePath, error: null };
  }

  /** Validate every path in a patch. */
  validatePatchPaths(projectRoot: string, patch: HcrPatchV1): PatchPathValidation {
    const issues: PatchPathIssue[] = [];
    const seen = new Set<string>();
    for (const file of patch.files) {
      const result = this.validateProjectPath(projectRoot, file.path);
      if (!result.ok) {
        issues.push({ path: file.path, error: result.error ?? 'Invalid path.' });
        continue;
      }
      const key = result.relativePath.toLowerCase();
      if (seen.has(key)) {
        issues.push({ path: file.path, error: `Duplicate path in patch: ${result.relativePath}` });
        continue;
      }
      seen.add(key);
    }
    return { ok: issues.length === 0, issues };
  }

  /** Convenience: validate a list of patch files. */
  validateFiles(projectRoot: string, files: HcrPatchFile[]): PatchPathValidation {
    return this.validatePatchPaths(projectRoot, { version: 'HCR_PATCH_V1', summary: '', files });
  }

  // ------------------------------------------------------------------ //

  private checkSymlinkEscape(projectRoot: string, segments: string[]): string | null {
    let rootReal: string;
    try {
      rootReal = realpathSync(projectRoot);
    } catch {
      return null; // Root itself unavailable; caller checks existence later.
    }

    let current = projectRoot;
    for (const segment of segments) {
      current = join(current, segment);
      if (!existsSync(current)) continue;
      try {
        const real = realpathSync(current);
        if (!isInside(rootReal, real)) {
          return `Path traverses a symbolic link that leaves the project: ${segments.join('/')}`;
        }
      } catch {
        return `Path could not be resolved safely: ${segments.join('/')}`;
      }
    }
    return null;
  }
}
