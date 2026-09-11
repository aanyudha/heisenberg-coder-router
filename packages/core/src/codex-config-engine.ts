import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { AppError, getCodexConfigPath } from '@heisenberg/shared';
import { getOllamaBaseUrl } from '@heisenberg/providers';

/**
 * Codex Config Engine - Applies the HCR desired route to the real Codex
 * configuration so a normal `codex` invocation (CLI, or the VS Code
 * integration which shares CODEX_HOME) uses the HCR-selected
 * provider + model.
 *
 * Config mechanism verified against codex-cli 0.154.0 (`codex doctor`):
 *   - config file: <CODEX_HOME>/config.toml (default ~/.codex/config.toml)
 *   - top-level keys: `model` (string), `model_provider` (string)
 *   - default provider when `model_provider` is unset: openai
 *   - `ollama` is a BUILT-IN provider id; redefining it via a user
 *     [model_providers.ollama] table breaks Codex config loading. HCR
 *     therefore registers its own provider id `hcr-ollama` (verified working)
 *     so the endpoint can be pinned and OLLAMA_HOST honored.
 *
 * Provider/model semantics (provider + model always applied together):
 *   - ollama: model = "<selected>", model_provider = "hcr-ollama", plus an
 *     HCR-owned [model_providers.hcr-ollama] table (base_url honors
 *     OLLAMA_HOST, wire_api = "responses").
 *   - openai: HCR-owned keys are removed so Codex falls back to its default
 *     OpenAI provider and existing login. No Ollama state may survive.
 *
 * Safety rules:
 *   - one-time backup before the first HCR modification (never per click)
 *   - only mutate settings HCR owns; all other keys/sections/comments are
 *     preserved
 *   - the file is rewritten only when content actually changes
 *   - malformed TOML -> clear error, no write
 */

/** HCR's provider id inside Codex config.toml. */
export const HCR_PROVIDER_ID = 'hcr-ollama';

/** Keys/sections HCR owns in Codex config.toml. */
const OWNED_KEYS = ['model', 'model_provider'] as const;

interface ParsedConfig {
  /** Top-level scalar key/value pairs (raw TOML value text). */
  topLevel: Record<string, string>;
  /** Lines that could not be understood as TOML. */
  errors: string[];
  /** Header line index of the [model_providers.<HCR> ] table, if present. */
  ollamaTableStart: number | null;
  /** Inclusive last line index of the ollama table (before next header/EOF). */
  ollamaTableEnd: number | null;
  /** Keys inside the ollama table. */
  ollamaTableKeys: Record<string, { lineIndex: number; valueText: string }>;
}

export interface CodexConfigState {
  configExists: boolean;
  /** Explicit model_provider value, or null when absent (Codex default: openai). */
  providerKey: string | null;
  model: string | null;
  ollamaTablePresent: boolean;
  ollamaTableBaseUrl: string | null;
}

export class CodexConfigEngine {
  readonly configPath: string;
  readonly backupPath: string;

  constructor() {
    this.configPath = getCodexConfigPath();
    this.backupPath = `${this.configPath}.hcr-backup`;
  }

  /**
   * Read the currently applied route from Codex config without throwing.
   * `validToml: false` signals a malformed config (error state).
   */
  readState(): CodexConfigState & { validToml: boolean; parseError?: string } {
    if (!existsSync(this.configPath)) {
      return {
        configExists: false,
        validToml: true,
        providerKey: null,
        model: null,
        ollamaTablePresent: false,
        ollamaTableBaseUrl: null,
      };
    }
    try {
      const parsed = this.parse(readFileSync(this.configPath, 'utf-8'));
      return {
        configExists: true,
        validToml: parsed.errors.length === 0,
        parseError: parsed.errors.length > 0 ? parsed.errors.join('; ') : undefined,
        providerKey: parsed.topLevel['model_provider'] ? unquote(parsed.topLevel['model_provider']) : null,
        model: parsed.topLevel['model'] ? unquote(parsed.topLevel['model']) : null,
        ollamaTablePresent: parsed.ollamaTableStart !== null,
        ollamaTableBaseUrl: parsed.ollamaTableKeys['base_url']
          ? unquote(parsed.ollamaTableKeys['base_url'].valueText)
          : null,
      };
    } catch (error) {
      return {
        configExists: true,
        validToml: false,
        parseError: error instanceof Error ? error.message : 'unreadable config',
        providerKey: null,
        model: null,
        ollamaTablePresent: false,
        ollamaTableBaseUrl: null,
      };
    }
  }

  /**
   * Apply the desired route to Codex config. Provider and model are written
   * together as one routing decision.
   */
  applyRoute(route: { provider: 'ollama' | 'openai'; model: string | null }): {
    backupCreated: boolean;
    changed: boolean;
  } {
    const model = route.provider === 'openai' ? null : route.model?.trim() ?? null;
    if (route.provider === 'ollama' && !model) {
      throw new AppError('A model must be selected for the Ollama provider', 400);
    }

    const exists = existsSync(this.configPath);
    const original = exists ? this.readConfigOrThrow() : '';

    if (exists) {
      // Malformed config blocks any modification.
      const parsed = this.parse(original);
      if (parsed.errors.length > 0) {
        throw new AppError(
          `Codex config at ${this.configPath} is malformed TOML and was not modified. ` +
            `Fix it manually or restore the backup at ${this.backupPath}. ` +
            `Details: ${parsed.errors.slice(0, 3).join('; ')}`,
          500
        );
      }
    }

    // One-time backup before the first HCR modification. Never refreshed.
    let backupCreated = false;
    if (exists && !existsSync(this.backupPath)) {
      copyFileSync(this.configPath, this.backupPath);
      backupCreated = true;
    }

    let updated: string;
    if (route.provider === 'ollama') {
      const baseUrl = `${getOllamaBaseUrl()}/v1`;
      updated = this.upsertTopLevel(original, [
        { key: 'model', value: quote(model!) },
        { key: 'model_provider', value: quote(HCR_PROVIDER_ID) },
      ]);
      updated = this.upsertOllamaTable(updated, {
        name: '"Ollama (HCR)"',
        base_url: quote(baseUrl),
        wire_api: '"responses"',
      });
    } else {
      // OpenAI: strip every HCR-owned key and the Ollama provider table so no
      // stale local-provider state leaks into the OpenAI/Codex cloud route.
      updated = this.removeTopLevel(original, [...OWNED_KEYS]);
      updated = this.removeOllamaTable(updated);
    }

    const changed = updated !== original || !exists;
    if (changed) {
      // CODEX_HOME may not exist yet (fresh machine); create it on first write.
      mkdirSync(dirname(this.configPath), { recursive: true });
      writeFileSync(this.configPath, updated, 'utf-8');
    }
    return { backupCreated, changed };
  }

  // ------------------------------------------------------------------ //
  // internals                                                           //
  // ------------------------------------------------------------------ //

  private readConfigOrThrow(): string {
    try {
      return readFileSync(this.configPath, 'utf-8');
    } catch (error) {
      throw new AppError(
        `Cannot read Codex config at ${this.configPath}: ${error instanceof Error ? error.message : 'unknown error'}`,
        500
      );
    }
  }

  /**
   * Line-oriented TOML reader limited to what HCR needs: top-level scalar
   * keys and the [model_providers.ollama] table. Tolerates multi-line arrays
   * and comments; reports anything unparseable as an error instead of
   * guessing, so callers never write into a file they do not understand.
   */
  private parse(text: string): ParsedConfig {
    const lines = text.split(/\r?\n/);
    const topLevel: Record<string, string> = {};
    const errors: string[] = [];
    const ollamaTableKeys: Record<string, { lineIndex: number; valueText: string }> = {};

    let section = '';
    let ollamaTableStart: number | null = null;
    let ollamaTableEnd: number | null = null;
    let arrayDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];

      // Inside a multi-line array value: just track bracket depth.
      if (arrayDepth > 0) {
        arrayDepth += countUnquoted(raw, '[') - countUnquoted(raw, ']');
        if (arrayDepth <= 0) arrayDepth = 0;
        if (ollamaTableStart !== null && ollamaTableEnd === null) ollamaTableEnd = i;
        continue;
      }

      const line = stripComment(raw);
      if (line.trim().length === 0) {
        if (ollamaTableStart !== null && ollamaTableEnd === null && raw.trim().length === 0) {
          ollamaTableEnd = i; // blank line after the table's last key
        }
        continue;
      }

      // Section header (also tolerate [[array tables]] without failing).
      const header = line.match(/^\s*\[\[?([^\]]*?)\]?\]\s*$/);
      if (header) {
        section = header[1].trim();
        if (section === `model_providers.${HCR_PROVIDER_ID}` && ollamaTableStart === null) {
          ollamaTableStart = i;
        } else if (ollamaTableStart !== null && ollamaTableEnd === null) {
          ollamaTableEnd = i - 1;
        }
        continue;
      }

      const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
      if (!kv) {
        errors.push(`line ${i + 1}: cannot parse: ${raw.trim()}`);
        continue;
      }

      // A value that opens an array may span multiple lines.
      const value = kv[2].trim();
      arrayDepth = countUnquoted(value, '[') - countUnquoted(value, ']');
      if (arrayDepth > 0) continue;

      if (section === '') {
        topLevel[kv[1]] = value;
      } else if (section === `model_providers.${HCR_PROVIDER_ID}`) {
        ollamaTableKeys[kv[1]] = { lineIndex: i, valueText: value };
        ollamaTableEnd = i;
      }
    }

    return { topLevel, errors, ollamaTableStart, ollamaTableEnd, ollamaTableKeys };
  }

  /** Replace values of existing top-level keys; append missing ones at the end of the top-level area. */
  private upsertTopLevel(text: string, entries: Array<{ key: string; value: string }>): string {
    const lines = text.split(/\r?\n/);

    // Replace existing key lines in place.
    for (const entry of entries) {
      const existing = findTopLevelKeyLine(lines, entry.key);
      if (existing !== null) {
        lines[existing] = `${entry.key} = ${entry.value}`;
      }
    }

    // Append keys that do not exist yet at the end of the top-level area,
    // i.e. before the first section header (or at EOF).
    const missing = entries.filter((e) => findTopLevelKeyLine(lines, e.key) === null);
    if (missing.length > 0) {
      const insertAt = firstSectionHeaderIndex(lines) ?? lines.length;
      const insertLines: string[] = [];
      if (insertAt === lines.length && text.trim().length > 0 && lines[lines.length - 1]?.trim() !== '') {
        insertLines.push('');
      }
      for (const entry of missing) {
        insertLines.push(`${entry.key} = ${entry.value}`);
      }
      lines.splice(insertAt, 0, ...insertLines);
    }

    return lines.join('\n');
  }

  /** Remove top-level keys (whole lines) owned by HCR; section-scoped keys with the same name are preserved. */
  private removeTopLevel(text: string, keys: readonly string[]): string {
    const lines = text.split(/\r?\n/);
    const keySet = new Set(keys);
    const headerAt = firstSectionHeaderIndex(lines) ?? lines.length;
    const filtered = lines.filter((line, index) => {
      const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
      if (index < headerAt && match && keySet.has(match[1])) return false;
      return true;
    });
    return filtered.join('\n');
  }

  /** Create or surgically update the HCR-owned [model_providers.ollama] table. */
  private upsertOllamaTable(
    text: string,
    entries: Record<string, string>
  ): string {
    const lines = text.split(/\r?\n/);
    const parsed = this.parse(text);

    if (parsed.ollamaTableStart === null) {
      // Append a fresh HCR-owned table at the end of the file.
      if (lines.length > 0 && lines[lines.length - 1]?.trim() !== '') {
        lines.push('');
      }
      lines.push(`[model_providers.${HCR_PROVIDER_ID}]`);
      for (const [key, value] of Object.entries(entries)) {
        lines.push(`${key} = ${value}`);
      }
      return lines.join('\n');
    }

    // Table exists: update only the keys HCR owns inside it.
    for (const [key, value] of Object.entries(entries)) {
      const existing = parsed.ollamaTableKeys[key];
      if (existing) {
        lines[existing.lineIndex] = `${key} = ${value}`;
      } else {
        const insertAt = (parsed.ollamaTableEnd ?? parsed.ollamaTableStart) + 1;
        lines.splice(insertAt, 0, `${key} = ${value}`);
      }
    }
    return lines.join('\n');
  }

  /** Remove the HCR-owned [model_providers.hcr-ollama] table entirely, if present. */
  private removeOllamaTable(text: string): string {
    const parsed = this.parse(text);
    if (parsed.ollamaTableStart === null) return text;
    const lines = text.split(/\r?\n/);
    const start = parsed.ollamaTableStart;
    const end = parsed.ollamaTableEnd ?? lines.length - 1;
    lines.splice(start, end - start + 1);
    return lines.join('\n');
  }
}

// -------------------------------------------------------------------- //
// helpers                                                               //
// -------------------------------------------------------------------- //

function quote(value: string): string {
  return JSON.stringify(value);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Strip a trailing TOML comment (# ...) that is not inside a string. */
function stripComment(line: string): string {
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inLiteral) {
      if (!inBasic || line[i - 1] !== '\\') inBasic = !inBasic;
    } else if (ch === "'" && !inBasic) {
      inLiteral = !inLiteral;
    } else if (ch === '#' && !inBasic && !inLiteral) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Count occurrences of a character outside string literals. */
function countUnquoted(line: string, target: string): number {
  let count = 0;
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inLiteral) {
      if (!inBasic || line[i - 1] !== '\\') inBasic = !inBasic;
    } else if (ch === "'" && !inBasic) {
      inLiteral = !inLiteral;
    } else if (ch === target && !inBasic && !inLiteral) {
      count++;
    }
  }
  return count;
}

function firstSectionHeaderIndex(lines: string[]): number | null {
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    if (/^\s*\[\[?[^\]]*\]?\]\s*$/.test(line) && line.trim().length > 0) {
      return i;
    }
  }
  return null;
}

/** Index of a top-level `key = ...` line (before the first section header). */
function findTopLevelKeyLine(lines: string[], key: string): number | null {
  const headerAt = firstSectionHeaderIndex(lines) ?? lines.length;
  for (let i = 0; i < headerAt; i++) {
    const match = lines[i].match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
    if (match && match[1] === key) return i;
  }
  return null;
}
