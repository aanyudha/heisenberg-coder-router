import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import type { ContextExclusionInfo, ContextFileInfo, ProjectContextSummary } from '@heisenberg/contracts';

/** Full project context handed to the Web Handoff prompt builder. */
export interface ProjectContext extends ProjectContextSummary {
  /** file path -> utf8 content (only for included files). */
  contents: Record<string, string>;
  /** README/instruction files included verbatim (subset of contents). */
  instructions: string[];
}

export interface ContextOptions {
  /** Free-text task, used only to rank automatically relevant files. */
  task?: string;
  /** Files the user explicitly selected (always included when readable). */
  selectedFiles?: string[];
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
  maxTreeEntries?: number;
}

export const CONTEXT_LIMITS = {
  maxFiles: 40,
  maxBytesPerFile: 64 * 1024,
  maxTotalBytes: 256 * 1024,
  maxTreeEntries: 400,
  maxDepth: 12,
  /** Walk safety valve - stops pathological repositories. */
  maxWalkEntries: 20_000,
} as const;

/** Directories never walked, never sent, never shown as project context. */
export const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.idea',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  'target',
  'vendor',
  '.svelte-kit',
  '.output',
  '.yarn',
  '.pnpm-store',
]);

/** File extensions treated as binary - never read as text. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tar', '.rar', '.7z', '.bz2', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.class', '.o', '.a',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac',
  '.db', '.sqlite', '.sqlite3', '.pyc', '.pyo', '.wasm',
]);

/** Exact file names never sent (secrets, credentials, lockfiles, artifacts). */
const SECRET_FILES = new Set([
  '.env', '.npmrc', '.netrc', '.htpasswd', '.pgpass',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'credentials', 'credentials.json', 'service-account.json',
]);

const SECRET_PREFIXES = ['.env.', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];
const SECRET_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.secret'];
const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'cargo.lock', 'poetry.lock', 'pipfile.lock', 'composer.lock', 'go.sum',
]);
const MINIFIED_SUFFIXES = ['.min.js', '.min.css', '.map'];

/** Files always considered first when building context (project shape). */
const HIGH_VALUE_FILES = ['package.json', 'tsconfig.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'makefile'];

/** Extensions considered source code for relevance ranking. */
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.cs', '.php', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.vue', '.svelte', '.html', '.css', '.scss', '.sql', '.sh', '.ps1', '.yaml',
  '.yml', '.toml', '.json', '.md', '.txt',
]);

/** Reasons surfaced to the user when a file is left out of the context. */
export type ExclusionReason =
  | 'ignored_directory'
  | 'gitignored'
  | 'binary'
  | 'secret'
  | 'lockfile'
  | 'generated'
  | 'too_large'
  | 'over_file_limit'
  | 'over_total_limit'
  | 'unreadable'
  | 'depth_limit';

interface WalkEntry {
  relativePath: string;
  absolutePath: string;
  size: number;
  name: string;
}

interface ChosenEntry {
  entry: WalkEntry;
  selected: ContextFileInfo['selected'];
  score: number;
}

/**
 * Project Context Engine - conservative, explicit, reviewable.
 *
 * Never uploads the whole repository: node_modules, .git, build output,
 * binaries, secrets and lockfiles are excluded by default, .gitignore is
 * honoured where possible, and hard file/byte limits are enforced with a
 * report of everything that was left out.
 */
export class ProjectContextEngine {
  async build(projectRoot: string, options: ContextOptions = {}): Promise<ProjectContext> {
    const root = resolve(projectRoot);
    const limits = {
      maxFiles: options.maxFiles ?? CONTEXT_LIMITS.maxFiles,
      maxBytesPerFile: options.maxBytesPerFile ?? CONTEXT_LIMITS.maxBytesPerFile,
      maxTotalBytes: options.maxTotalBytes ?? CONTEXT_LIMITS.maxTotalBytes,
    };
    const maxTreeEntries = options.maxTreeEntries ?? CONTEXT_LIMITS.maxTreeEntries;

    const gitignore = await readGitignore(root);
    const walk = await this.walk(root, gitignore, limits.maxBytesPerFile);

    const excluded: ContextExclusionInfo[] = walk.excluded;
    const readable = walk.entries;
    const tree = readable.slice(0, maxTreeEntries).map((entry) => entry.relativePath);
    if (readable.length > maxTreeEntries) {
      excluded.push({
        path: '(tree)',
        reason: `project tree truncated at ${maxTreeEntries} entries`,
      });
    }

    const byPath = new Map(readable.map((entry) => [entry.relativePath.toLowerCase(), entry]));
    const chosen = new Map<string, ChosenEntry>();

    const consider = (rawPath: string, selected: ContextFileInfo['selected'], score: number): void => {
      const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
      const entry = byPath.get(normalized.toLowerCase());
      if (!entry) return;
      const existing = chosen.get(entry.relativePath);
      if (existing) {
        if (selected === 'user') existing.selected = 'user';
        existing.score = Math.max(existing.score, score);
        return;
      }
      chosen.set(entry.relativePath, { entry, selected, score });
    };

    // 1. High-value project shape files.
    for (const name of HIGH_VALUE_FILES) {
      const hit = readable.find(
        (entry) => entry.relativePath.toLowerCase() === name || entry.relativePath.toLowerCase() === `./${name}`
      );
      if (hit) consider(hit.relativePath, 'required', 1000);
    }

    // 2. README / instruction files.
    const instructions = readable.filter((entry) => /^(readme|contributing|instructions|agents|claude)\b/i.test(entry.name));
    for (const entry of instructions) consider(entry.relativePath, 'required', 900);

    // 3. Explicit user selection.
    for (const file of options.selectedFiles ?? []) {
      consider(file, 'user', 1200);
    }

    // 4. Automatically relevant files ranked against the task text.
    const taskTokens = tokenize(options.task ?? '');
    const ranked = readable
      .filter((entry) => !chosen.has(entry.relativePath))
      .map((entry) => ({ entry, score: relevanceScore(entry, taskTokens) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.relativePath.localeCompare(b.entry.relativePath));
    for (const item of ranked) consider(item.entry.relativePath, 'auto', item.score);

    // Enforce file + total byte limits in priority order.
    const files: ContextFileInfo[] = [];
    const contents: Record<string, string> = {};
    let totalBytes = 0;
    const instructionPaths: string[] = [];

    const ordered = [...chosen.values()].sort((a, b) => {
      const rank = (value: ContextFileInfo['selected']) =>
        value === 'required' ? 0 : value === 'user' ? 1 : 2;
      return rank(a.selected) - rank(b.selected) || b.score - a.score;
    });

    for (const candidate of ordered) {
      if (files.length >= limits.maxFiles) {
        excluded.push({ path: candidate.entry.relativePath, reason: `file limit reached (${limits.maxFiles} files)` });
        continue;
      }
      if (candidate.entry.size > limits.maxBytesPerFile) {
        excluded.push({
          path: candidate.entry.relativePath,
          reason: `over per-file limit (${candidate.entry.size} > ${limits.maxBytesPerFile} bytes)`,
        });
        continue;
      }
      if (totalBytes + candidate.entry.size > limits.maxTotalBytes) {
        excluded.push({
          path: candidate.entry.relativePath,
          reason: `over total context limit (${limits.maxTotalBytes} bytes)`,
        });
        continue;
      }

      let content: string;
      try {
        content = await readFile(candidate.entry.absolutePath, 'utf8');
      } catch {
        excluded.push({ path: candidate.entry.relativePath, reason: 'unreadable' });
        continue;
      }
      if (content.includes('\0')) {
        excluded.push({ path: candidate.entry.relativePath, reason: 'binary' });
        continue;
      }

      contents[candidate.entry.relativePath] = content;
      totalBytes += Buffer.byteLength(content, 'utf8');
      files.push({
        path: candidate.entry.relativePath,
        bytes: Buffer.byteLength(content, 'utf8'),
        selected: candidate.selected,
      });
      if (/^(readme|contributing|instructions|agents|claude)\b/i.test(candidate.entry.name)) {
        instructionPaths.push(candidate.entry.relativePath);
      }
    }

    const projectName = root.split(/[\\/]/).filter(Boolean).pop() ?? root;

    return {
      projectName,
      projectRoot: root,
      fileCount: files.length,
      totalBytes,
      files,
      excluded: dedupeExclusions(excluded),
      tree,
      limits,
      contents,
      instructions: instructionPaths,
    };
  }

  // ------------------------------------------------------------------ //

  private async walk(
    root: string,
    gitignore: GitignoreRules,
    maxBytesPerFile: number
  ): Promise<{ entries: WalkEntry[]; excluded: ContextExclusionInfo[] }> {
    const entries: WalkEntry[] = [];
    const excluded: ContextExclusionInfo[] = [];
    let visited = 0;

    const walkDir = async (dir: string, depth: number): Promise<void> => {
      if (depth > CONTEXT_LIMITS.maxDepth) return;
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        if (visited++ > CONTEXT_LIMITS.maxWalkEntries) return;
        const absolutePath = join(dir, dirent.name);
        const relativePath = relative(root, absolutePath).split(sep).join('/');
        if (relativePath.length === 0) continue;

        if (dirent.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(dirent.name.toLowerCase())) {
            excluded.push({ path: `${relativePath}/`, reason: 'ignored directory' });
            continue;
          }
          if (gitignore.isIgnored(relativePath, true)) {
            excluded.push({ path: `${relativePath}/`, reason: 'gitignored' });
            continue;
          }
          await walkDir(absolutePath, depth + 1);
          continue;
        }
        if (!dirent.isFile()) continue;

        const lower = dirent.name.toLowerCase();
        if (SECRET_FILES.has(lower) || SECRET_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
          excluded.push({ path: relativePath, reason: 'secret / credential file' });
          continue;
        }
        if (SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
          excluded.push({ path: relativePath, reason: 'secret / credential file' });
          continue;
        }
        if (LOCKFILES.has(lower)) {
          excluded.push({ path: relativePath, reason: 'lockfile' });
          continue;
        }
        if (MINIFIED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
          excluded.push({ path: relativePath, reason: 'generated (minified)' });
          continue;
        }
        const dotIndex = lower.lastIndexOf('.');
        const extension = dotIndex >= 0 ? lower.slice(dotIndex) : '';
        if (BINARY_EXTENSIONS.has(extension)) {
          excluded.push({ path: relativePath, reason: 'binary file' });
          continue;
        }
        if (gitignore.isIgnored(relativePath, false)) {
          excluded.push({ path: relativePath, reason: 'gitignored' });
          continue;
        }

        let size = 0;
        try {
          const info = await stat(absolutePath);
          size = info.size;
        } catch {
          excluded.push({ path: relativePath, reason: 'unreadable' });
          continue;
        }
        if (size > maxBytesPerFile) {
          excluded.push({
            path: relativePath,
            reason: `over per-file limit (${size} > ${maxBytesPerFile} bytes)`,
          });
          continue;
        }

        entries.push({ relativePath, absolutePath, size, name: dirent.name });
      }
    };

    await walkDir(root, 0);
    entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { entries, excluded };
  }
}

// -------------------------------------------------------------------- //
// .gitignore support (pragmatic subset: comments, *, ?, **, dir/, !, /) //
// -------------------------------------------------------------------- //

interface GitignoreRules {
  isIgnored(relativePath: string, isDirectory: boolean): boolean;
}

interface CompiledRule {
  negated: boolean;
  regex: RegExp;
}

function compileGitignorePattern(pattern: string): CompiledRule | null {
  let body = pattern;
  const negated = body.startsWith('!');
  if (negated) body = body.slice(1);
  body = body.trim();
  if (body.length === 0) return null;
  if (body.startsWith('#')) return null;

  let anchored = body.startsWith('/');
  if (anchored) body = body.slice(1);
  const dirOnly = body.endsWith('/');
  if (dirOnly) body = body.slice(0, -1);
  if (body.length === 0) return null;

  // A pattern without a slash matches at any depth; with a slash it is anchored.
  if (!pattern.slice(negated ? 1 : 0).includes('/')) anchored = false;

  let source = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '*') {
      if (body[i + 1] === '*') {
        if (body[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    if (char === '[') {
      const close = body.indexOf(']', i);
      if (close > i) {
        source += body.slice(i, close + 1);
        i = close;
        continue;
      }
    }
    source += char.replace(/[.+^${}()|\\]/g, '\\$&');
  }

  const prefix = anchored ? '^' : '(?:^|/)';
  const suffix = dirOnly ? '(?:/.*)?$' : '(?:$|/.*)$';
  return { negated, regex: new RegExp(`${prefix}${source}${suffix}`, 'i') };
}

async function readGitignore(root: string): Promise<GitignoreRules> {
  const gitignorePath = join(root, '.gitignore');
  const rules: CompiledRule[] = [];
  if (existsSync(gitignorePath)) {
    try {
      const raw = await readFile(gitignorePath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const rule = compileGitignorePattern(line);
        if (rule) rules.push(rule);
      }
    } catch {
      // Unreadable .gitignore: proceed without rules.
    }
  }

  return {
    isIgnored(relativePath: string, isDirectory: boolean): boolean {
      let ignored = false;
      for (const rule of rules) {
        const candidate = isDirectory ? `${relativePath}/` : relativePath;
        const match = rule.regex.test(candidate) || rule.regex.test(relativePath);
        if (match) ignored = !rule.negated;
      }
      return ignored;
    },
  };
}

// -------------------------------------------------------------------- //
// Relevance ranking                                                     //
// -------------------------------------------------------------------- //

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3)
  );
}

function relevanceScore(entry: WalkEntry, taskTokens: Set<string>): number {
  if (taskTokens.size === 0) return 0;
  const pathTokens = tokenize(entry.relativePath);
  const nameTokens = tokenize(entry.name);
  let score = 0;
  for (const token of taskTokens) {
    if (pathTokens.has(token)) score += 6;
    else if (nameTokens.has(token)) score += 8;
  }
  const dotIndex = entry.name.lastIndexOf('.');
  const extension = dotIndex >= 0 ? entry.name.slice(dotIndex).toLowerCase() : '';
  if (SOURCE_EXTENSIONS.has(extension)) score += 3;
  if (/^src\//i.test(entry.relativePath) || /^app\//i.test(entry.relativePath)) score += 2;
  if (/test|spec|__tests__/i.test(entry.relativePath)) score -= 3;
  if (/^docs\//i.test(entry.relativePath)) score += 1;
  return score;
}

function dedupeExclusions(items: ContextExclusionInfo[]): ContextExclusionInfo[] {
  const seen = new Set<string>();
  const out: ContextExclusionInfo[] = [];
  for (const item of items) {
    const key = `${item.path}::${item.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
