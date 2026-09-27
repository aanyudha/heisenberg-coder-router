import { existsSync, readdirSync, statSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { extname, join, relative, resolve, sep } from 'path';
import type {
  HcoderDirectoryEntry,
  HcoderSearchMatch,
  HcoderToolRequest,
  HcoderToolResultEntry,
  HcoderToolResultV1,
} from '@heisenberg/contracts';
import { HCODER_TOOL_RESULT_VERSION } from '@heisenberg/contracts';
import { PatchValidationEngine } from './patch-validation-engine.js';
import { BINARY_EXTENSIONS, IGNORED_DIRECTORIES, readGitignore } from './project-context-engine.js';

/** Hard limits for one HCoder agent task (all bounded, never unbounded). */
export const HCODER_TOOL_LIMITS = {
  /** No single file read may exceed this many bytes. */
  maxBytesPerFile: 256 * 1024,
  /** All tool results of one round combined stay under this budget. */
  maxResultBytesPerRound: 512 * 1024,
  /** Whole-task budget across every round. */
  maxTotalToolResultBytes: 2 * 1024 * 1024,
  /** search_files / search_text result cap. */
  maxSearchResults: 50,
  /** Files opened by one search_text call. */
  maxSearchFilesScanned: 4_000,
  /** Entries returned by list_directory. */
  maxListEntries: 200,
  /** Files accepted by one read_many_files call. */
  maxReadManyFiles: 20,
  /** Search snippet length in characters. */
  maxSnippetChars: 240,
  /** Directory walk safety valve. */
  maxWalkEntries: 20_000,
  /** Depth limit for walks. */
  maxDepth: 12,
} as const;

/** Bounded agent-loop limits (HCODER_AGENT_V1 rounds). */
export const HCODER_AGENT_LOOP_LIMITS = {
  maxRounds: 12,
  maxToolRequestsPerRound: 10,
} as const;

const ROOT_ALIASES = new Set(['', '.', './', '.\\']);

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Escape a user pattern into a "glob-ish" matcher (`*` and `?` only). */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.split('?').map((piece) => piece.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.'))
    .join('.*');
  return new RegExp(`^${source}$`, 'i');
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

/** Cut a string to at most `maxBytes` UTF-8 bytes without throwing. */
function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (byteLength(text) <= maxBytes) return { text, truncated: false };
  const cut = Buffer.from(text, 'utf8').subarray(0, Math.max(0, maxBytes - 32)).toString('utf8');
  // Drop a possible partial code point at the cut boundary.
  const cleaned = cut.replace(/\uFFFD$/, '');
  return { text: `${cleaned}\n… [truncated]`, truncated: true };
}

/**
 * HCoder Tool Engine - the ONLY component that reads the local project.
 *
 * Every request is executed against one resolved project root. Paths go
 * through the shared PatchValidationEngine sandbox (same engine Web Handoff
 * uses for writes), so absolute paths, "..", drive letters, UNC paths, null
 * bytes, reserved device names, protected secrets and symlink escapes are
 * all rejected before a file is ever opened.
 *
 * There is no shell execution here - no cmd, powershell, bash, npm, npx or
 * git. Only bounded, read-only filesystem access.
 */
export class HcoderToolEngine {
  private totalResultBytes = 0;

  constructor(
    private readonly projectRoot: string,
    private readonly validator: PatchValidationEngine = new PatchValidationEngine()
  ) {}

  /** Execute one structured request. Never throws - failures become results. */
  async execute(request: HcoderToolRequest): Promise<HcoderToolResultEntry> {
    const id = typeof request?.id === 'string' && request.id.length > 0 ? request.id : '';
    const tool = request?.tool;
    if (!id) {
      return { id: '', tool: String(tool ?? ''), ok: false, error: { code: 'INVALID_TOOL_REQUEST', message: 'Request id is required.' } };
    }
    try {
      switch (tool) {
        case 'read_file':
          return await this.readFile(id, request);
        case 'list_directory':
          return await this.listDirectory(id, request);
        case 'search_files':
          return await this.searchFiles(id, request);
        case 'search_text':
          return await this.searchText(id, request);
        case 'read_many_files':
          return await this.readManyFiles(id, request);
        default:
          return {
            id,
            tool: String(tool ?? ''),
            ok: false,
            error: { code: 'UNKNOWN_TOOL', message: `Unknown tool "${String(tool ?? '')}". Available tools: read_file, list_directory, search_files, search_text, read_many_files.` },
          };
      }
    } catch (error) {
      return {
        id,
        tool: String(tool ?? ''),
        ok: false,
        error: { code: 'TOOL_FAILED', message: error instanceof Error ? error.message : 'Tool failed.' },
      };
    }
  }

  /**
   * Execute a full round of requests while enforcing the per-round and
   * cumulative byte budgets. Oversized content is truncated, never dropped
   * silently, and marked with `truncated: true`.
   */
  async executeAll(requests: HcoderToolRequest[]): Promise<HcoderToolResultEntry[]> {
    const results: HcoderToolResultEntry[] = [];
    let roundBytes = 0;

    for (const request of requests) {
      if (this.totalResultBytes >= HCODER_TOOL_LIMITS.maxTotalToolResultBytes) {
        results.push({
          id: request?.id ?? '',
          tool: String(request?.tool ?? ''),
          ok: false,
          error: {
            code: 'RESULT_TOO_LARGE',
            message: 'Total tool-result byte budget for this task is exhausted.',
          },
        });
        continue;
      }

      const entry = await this.execute(request);
      const serialized = JSON.stringify(entry);
      const entryBytes = byteLength(serialized);
      const remaining = HCODER_TOOL_LIMITS.maxResultBytesPerRound - roundBytes;

      let finalEntry = entry;
      if (entryBytes > remaining) {
        if (remaining < 256) {
          finalEntry = {
            ...entry,
            ok: false,
            content: undefined,
            entries: undefined,
            matches: undefined,
            error: {
              code: 'RESULT_TOO_LARGE',
              message: 'Tool-result budget for this round is exhausted.',
            },
          };
        } else if (typeof entry.content === 'string') {
          const cut = truncateToBytes(entry.content, Math.max(0, remaining - 64));
          finalEntry = { ...entry, content: cut.text, truncated: true };
        } else {
          // Non-content results (lists/matches) are small; keep them but stop
          // growing the round once the budget is spent.
          finalEntry = entry;
        }
      }

      const finalBytes = byteLength(JSON.stringify(finalEntry));
      roundBytes += finalBytes;
      this.totalResultBytes += finalBytes;
      results.push(finalEntry);
    }

    return results;
  }

  /** Build the HCODER_TOOL_RESULT_V1 payload for a set of results. */
  static buildResult(results: HcoderToolResultEntry[]): HcoderToolResultV1 {
    return { version: HCODER_TOOL_RESULT_VERSION, results };
  }

  /** Total tool-result bytes consumed so far (loop budget bookkeeping). */
  bytesUsed(): number {
    return this.totalResultBytes;
  }

  // ------------------------------------------------------------------ //
  // Tools                                                               //
  // ------------------------------------------------------------------ //

  private resolveSafe(rawPath: string, purpose: 'read' | 'write' = 'read'):
    | { ok: true; relativePath: string; absolutePath: string }
    | { ok: false; error: string; code: string } {
    const result = this.validator.validateProjectPath(this.projectRoot, rawPath, purpose);
    if (!result.ok || !result.absolutePath) {
      return { ok: false, error: result.error ?? 'Path rejected.', code: 'PATH_REJECTED' };
    }
    return { ok: true, relativePath: result.relativePath, absolutePath: result.absolutePath };
  }

  private async readFile(id: string, request: HcoderToolRequest): Promise<HcoderToolResultEntry> {
    if (typeof request.path !== 'string' || request.path.trim().length === 0) {
      return { id, tool: 'read_file', ok: false, error: { code: 'INVALID_TOOL_REQUEST', message: 'read_file requires "path".' } };
    }
    const resolved = this.resolveSafe(request.path);
    if (!resolved.ok) {
      return { id, tool: 'read_file', path: request.path, ok: false, error: { code: resolved.code, message: resolved.error } };
    }

    if (!existsSync(resolved.absolutePath)) {
      return { id, tool: 'read_file', path: resolved.relativePath, ok: false, error: { code: 'NOT_FOUND', message: `File not found: ${resolved.relativePath}` } };
    }
    const info = statSync(resolved.absolutePath);
    if (info.isDirectory()) {
      return { id, tool: 'read_file', path: resolved.relativePath, ok: false, error: { code: 'NOT_A_FILE', message: `Path is a directory: ${resolved.relativePath}. Use list_directory.` } };
    }
    if (info.size > HCODER_TOOL_LIMITS.maxBytesPerFile) {
      return {
        id,
        tool: 'read_file',
        path: resolved.relativePath,
        ok: false,
        error: { code: 'FILE_TOO_LARGE', message: `File is ${info.size} bytes; the read_file limit is ${HCODER_TOOL_LIMITS.maxBytesPerFile} bytes.` },
      };
    }
    if (BINARY_EXTENSIONS.has(extname(resolved.absolutePath).toLowerCase())) {
      return { id, tool: 'read_file', path: resolved.relativePath, ok: false, error: { code: 'BINARY_FILE', message: `Binary file: ${resolved.relativePath}` } };
    }

    const raw = await readFile(resolved.absolutePath, 'utf8');
    if (raw.includes('\0')) {
      return { id, tool: 'read_file', path: resolved.relativePath, ok: false, error: { code: 'BINARY_FILE', message: `Binary file: ${resolved.relativePath}` } };
    }

    const windowed = applyLineWindow(raw, request.offset, request.limit);
    return {
      id,
      tool: 'read_file',
      path: resolved.relativePath,
      ok: true,
      content: windowed.content,
      bytes: byteLength(windowed.content),
      truncated: windowed.truncated,
    };
  }

  private async listDirectory(id: string, request: HcoderToolRequest): Promise<HcoderToolResultEntry> {
    const rawPath = typeof request.path === 'string' ? request.path : '';
    let absolutePath = resolve(this.projectRoot);
    let relativePath = '';

    if (!ROOT_ALIASES.has(rawPath.trim())) {
      const resolved = this.resolveSafe(rawPath);
      if (!resolved.ok) {
        return { id, tool: 'list_directory', path: rawPath, ok: false, error: { code: resolved.code, message: resolved.error } };
      }
      absolutePath = resolved.absolutePath;
      relativePath = resolved.relativePath;
      if (!existsSync(absolutePath)) {
        return { id, tool: 'list_directory', path: relativePath, ok: false, error: { code: 'NOT_FOUND', message: `Directory not found: ${relativePath}` } };
      }
      if (!statSync(absolutePath).isDirectory()) {
        return { id, tool: 'list_directory', path: relativePath, ok: false, error: { code: 'NOT_A_DIRECTORY', message: `Not a directory: ${relativePath}` } };
      }
    }

    const gitignore = await readGitignore(resolve(this.projectRoot));
    const dirents = await readdir(absolutePath, { withFileTypes: true });
    const entries: HcoderDirectoryEntry[] = [];
    let truncated = false;

    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= HCODER_TOOL_LIMITS.maxListEntries) {
        truncated = true;
        break;
      }
      const childRelative = relativePath ? `${relativePath}/${dirent.name}` : dirent.name;
      const type = dirent.isDirectory() ? 'directory' : 'file';
      if (dirent.isDirectory() && IGNORED_DIRECTORIES.has(dirent.name.toLowerCase())) continue;
      if (gitignore.isIgnored(childRelative, dirent.isDirectory())) continue;
      const probe = this.validator.validateProjectPath(this.projectRoot, childRelative, 'read');
      if (!probe.ok) continue; // secrets / protected paths never surface
      entries.push({ name: dirent.name, type, relativePath: toPosix(childRelative) });
    }

    return { id, tool: 'list_directory', path: relativePath, ok: true, entries, truncated };
  }

  private async searchFiles(id: string, request: HcoderToolRequest): Promise<HcoderToolResultEntry> {
    const pattern = typeof request.pattern === 'string' ? request.pattern.trim() : '';
    if (pattern.length === 0) {
      return { id, tool: 'search_files', ok: false, error: { code: 'INVALID_TOOL_REQUEST', message: 'search_files requires "pattern".' } };
    }
    const matcher = globToRegExp(pattern.includes('*') || pattern.includes('?') ? pattern : `*${pattern}*`);
    const gitignore = await readGitignore(resolve(this.projectRoot));
    const matches: HcoderSearchMatch[] = [];
    let truncated = false;

    for (const found of this.walk({ gitignore })) {
      if (matches.length >= HCODER_TOOL_LIMITS.maxSearchResults) {
        truncated = true;
        break;
      }
      const name = found.split('/').pop() ?? found;
      if (matcher.test(found) || matcher.test(name)) {
        matches.push({ path: found });
      }
    }

    return { id, tool: 'search_files', ok: true, matches, truncated };
  }

  private async searchText(id: string, request: HcoderToolRequest): Promise<HcoderToolResultEntry> {
    const query = typeof request.query === 'string' ? request.query : '';
    if (query.trim().length === 0) {
      return { id, tool: 'search_text', ok: false, error: { code: 'INVALID_TOOL_REQUEST', message: 'search_text requires "query".' } };
    }

    let scopeRoot = resolve(this.projectRoot);
    let scopePrefix = '';
    if (typeof request.path === 'string' && request.path.trim().length > 0 && !ROOT_ALIASES.has(request.path.trim())) {
      const resolved = this.resolveSafe(request.path);
      if (!resolved.ok) {
        return { id, tool: 'search_text', path: request.path, ok: false, error: { code: resolved.code, message: resolved.error } };
      }
      if (!existsSync(resolved.absolutePath)) {
        return { id, tool: 'search_text', path: resolved.relativePath, ok: false, error: { code: 'NOT_FOUND', message: `Path not found: ${resolved.relativePath}` } };
      }
      scopeRoot = resolved.absolutePath;
      scopePrefix = statSync(resolved.absolutePath).isDirectory() ? `${resolved.relativePath}/` : '';
    }

    const glob = typeof request.glob === 'string' && request.glob.trim().length > 0 ? globToRegExp(request.glob.trim()) : null;
    const gitignore = await readGitignore(resolve(this.projectRoot));
    const needle = query.toLowerCase();
    const matches: HcoderSearchMatch[] = [];
    let scanned = 0;
    let truncated = false;

    const candidates = this.walk({ gitignore, from: scopeRoot, prefix: scopePrefix });
    for (const found of candidates) {
      if (matches.length >= HCODER_TOOL_LIMITS.maxSearchResults || scanned >= HCODER_TOOL_LIMITS.maxSearchFilesScanned) {
        truncated = true;
        break;
      }
      if (glob && !glob.test(found)) continue;

      const absolutePath = join(resolve(this.projectRoot), ...found.split('/'));
      if (!existsSync(absolutePath) || statSync(absolutePath).isDirectory()) continue;
      if (BINARY_EXTENSIONS.has(extname(absolutePath).toLowerCase())) continue;

      let size = 0;
      try {
        size = statSync(absolutePath).size;
      } catch {
        continue;
      }
      if (size > HCODER_TOOL_LIMITS.maxBytesPerFile) continue;
      scanned++;

      let content: string;
      try {
        content = await readFile(absolutePath, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\0')) continue;

      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index++) {
        if (matches.length >= HCODER_TOOL_LIMITS.maxSearchResults) {
          truncated = true;
          break;
        }
        const line = lines[index];
        if (!line.toLowerCase().includes(needle)) continue;
        matches.push({
          path: found,
          line: index + 1,
          snippet: line.trim().slice(0, HCODER_TOOL_LIMITS.maxSnippetChars),
        });
      }
    }

    return { id, tool: 'search_text', ok: true, matches, truncated };
  }

  private async readManyFiles(id: string, request: HcoderToolRequest): Promise<HcoderToolResultEntry> {
    const paths = Array.isArray(request.paths) ? request.paths : [];
    if (paths.length === 0) {
      return { id, tool: 'read_many_files', ok: false, error: { code: 'INVALID_TOOL_REQUEST', message: 'read_many_files requires "paths" (a non-empty array).' } };
    }
    if (paths.length > HCODER_TOOL_LIMITS.maxReadManyFiles) {
      return { id, tool: 'read_many_files', ok: false, error: { code: 'INVALID_TOOL_REQUEST', message: `read_many_files accepts at most ${HCODER_TOOL_LIMITS.maxReadManyFiles} paths.` } };
    }

    const sections: string[] = [];
    let failures = 0;
    for (const path of paths) {
      const result = await this.readFile(id, { id, tool: 'read_file', path });
      if (result.ok) {
        sections.push(`=== ${result.path} ===\n${result.content ?? ''}`);
      } else {
        failures++;
        sections.push(`=== ${String(path)} ===\n[error] ${result.error?.code ?? 'ERROR'}: ${result.error?.message ?? 'unreadable'}`);
      }
    }

    const content = sections.join('\n\n');
    const cut = truncateToBytes(content, HCODER_TOOL_LIMITS.maxBytesPerFile);
    return {
      id,
      tool: 'read_many_files',
      ok: failures === 0,
      content: cut.text,
      bytes: byteLength(cut.text),
      truncated: cut.truncated,
      error:
        failures > 0 && failures === paths.length
          ? { code: 'NOT_FOUND', message: 'None of the requested files could be read.' }
          : undefined,
    };
  }

  // ------------------------------------------------------------------ //

  /**
   * Bounded depth-first walk honoring ignored directories and .gitignore.
   * Protected/secret paths are never yielded.
   */
  private walk(options: {
    gitignore: { isIgnored(relativePath: string, isDirectory: boolean): boolean };
    from?: string;
    prefix?: string;
  }): string[] {
    const root = resolve(this.projectRoot);
    const start = options.from ?? root;
    const prefix = options.prefix ?? '';
    const results: string[] = [];
    const stack: { dir: string; depth: number }[] = [{ dir: start, depth: 0 }];
    let visited = 0;

    while (stack.length > 0 && visited <= HCODER_TOOL_LIMITS.maxWalkEntries) {
      const current = stack.pop();
      if (!current) break;
      if (current.depth > HCODER_TOOL_LIMITS.maxDepth) continue;

      let dirents;
      try {
        dirents = readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      dirents.sort((a, b) => b.name.localeCompare(a.name));

      for (const dirent of dirents) {
        if (visited++ > HCODER_TOOL_LIMITS.maxWalkEntries) break;
        const absolutePath = join(current.dir, dirent.name);
        const relativeFull = toPosix(relative(root, absolutePath));
        if (relativeFull.length === 0) continue;

        if (dirent.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(dirent.name.toLowerCase())) continue;
          if (options.gitignore.isIgnored(relativeFull, true)) continue;
          stack.push({ dir: absolutePath, depth: current.depth + 1 });
          continue;
        }
        if (!dirent.isFile()) continue;
        if (options.gitignore.isIgnored(relativeFull, false)) continue;
        const probe = this.validator.validateProjectPath(root, relativeFull, 'read');
        if (!probe.ok) continue; // secrets / escapes never surface
        results.push(prefix ? toPosix(relative(start, absolutePath)) : relativeFull);
      }
    }

    results.sort((a, b) => a.localeCompare(b));
    return results;
  }
}

// -------------------------------------------------------------------- //

/** Apply a 1-based inclusive line window (read_file offset/limit). */
function applyLineWindow(content: string, offset?: number, limit?: number): { content: string; truncated: boolean } {
  const lines = content.split('\n');
  const start = typeof offset === 'number' && Number.isFinite(offset) && offset > 0 ? Math.floor(offset) - 1 : 0;
  const end = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? start + Math.floor(limit) : lines.length;
  if (start === 0 && end >= lines.length) return { content, truncated: false };
  return { content: lines.slice(start, end).join('\n'), truncated: end < lines.length };
}
