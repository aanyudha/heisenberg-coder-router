import { HCR_PATCH_VERSION } from '@heisenberg/contracts';
import type { HcrPatchAction, HcrPatchFile, HcrPatchV1 } from '@heisenberg/contracts';

/** Hard limits for a single HCR_PATCH_V1 payload coming from ChatGPT Web. */
export const PATCH_LIMITS = {
  maxFiles: 200,
  maxContentBytesPerFile: 1_000_000,
  maxTotalContentBytes: 4_000_000,
} as const;

const ACTIONS: readonly HcrPatchAction[] = ['create', 'replace', 'delete'];

export interface PatchParseResult {
  ok: boolean;
  patch: HcrPatchV1 | null;
  /** Human-readable schema problems (only set when ok is false). */
  errors: string[];
  /** Where the JSON was found: bare, inside a markdown fence, or extracted. */
  extraction: 'bare' | 'fenced' | 'extracted' | 'none';
}

/**
 * Strip a single surrounding markdown fence (```json ... ``` or ``` ... ```).
 * Returns null when the payload is not fenced.
 */
function stripFence(raw: string): string | null {
  const match = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/.exec(raw);
  if (match) return match[1];
  const inline = /^```[a-zA-Z0-9_-]*[ \t]*([\s\S]*?)[ \t]*```$/.exec(raw);
  if (inline) return inline[1];
  return null;
}

/**
 * Defensively locate a JSON object inside an arbitrary ChatGPT Web reply.
 * Never executes or interprets prose - it only extracts a JSON candidate.
 */
export function extractJsonCandidate(raw: string): { json: string | null; extraction: PatchParseResult['extraction'] } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { json: null, extraction: 'none' };

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return { json: trimmed, extraction: 'bare' };
  }

  const unfenced = stripFence(trimmed);
  if (unfenced !== null) {
    const inner = unfenced.trim();
    if (inner.length > 0) return { json: inner, extraction: 'fenced' };
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return { json: trimmed.slice(first, last + 1), extraction: 'extracted' };
  }
  return { json: null, extraction: 'none' };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Validate an already-parsed value against the HCR_PATCH_V1 schema.
 * Strict: unknown versions, missing fields and unknown actions are rejected.
 */
export function validatePatch(value: unknown): PatchParseResult {
  const errors: string[] = [];

  if (!isPlainObject(value)) {
    return { ok: false, patch: null, errors: ['Response is not a JSON object.'], extraction: 'none' };
  }

  // Tolerate a single wrapper object: { "patch": { HCR_PATCH_V1 ... } }.
  let candidate: Record<string, unknown> = value;
  if (candidate.version === undefined && isPlainObject(candidate.patch)) {
    candidate = candidate.patch;
  }

  if (candidate.version !== HCR_PATCH_VERSION) {
    errors.push(`version must be "${HCR_PATCH_VERSION}" (received ${JSON.stringify(candidate.version ?? null)}).`);
  }

  const summary = candidate.summary;
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    errors.push('summary must be a non-empty string.');
  }

  const files = candidate.files;
  if (!Array.isArray(files)) {
    errors.push('files must be an array.');
    return { ok: false, patch: null, errors, extraction: 'none' };
  }
  if (files.length === 0) {
    errors.push('files must contain at least one entry.');
  }
  if (files.length > PATCH_LIMITS.maxFiles) {
    errors.push(`files exceeds the maximum of ${PATCH_LIMITS.maxFiles} entries.`);
  }

  const normalizedFiles: HcrPatchFile[] = [];
  let totalBytes = 0;

  files.forEach((entry, index) => {
    const label = `files[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${label} must be an object.`);
      return;
    }
    const path = entry.path;
    if (typeof path !== 'string' || path.trim().length === 0) {
      errors.push(`${label}.path must be a non-empty string.`);
      return;
    }
    const action = entry.action;
    if (typeof action !== 'string' || !ACTIONS.includes(action as HcrPatchAction)) {
      errors.push(`${label}.action must be one of create|replace|delete.`);
      return;
    }

    const normalized: HcrPatchFile = { path: path.trim(), action: action as HcrPatchAction };

    if (action === 'delete') {
      // Content on a delete is meaningless; ignore it rather than fail.
      normalizedFiles.push(normalized);
      return;
    }

    const content = entry.content;
    if (typeof content !== 'string') {
      errors.push(`${label}.content must be a string for action "${action}".`);
      return;
    }
    const size = byteLength(content);
    if (size > PATCH_LIMITS.maxContentBytesPerFile) {
      errors.push(`${label}.content exceeds ${PATCH_LIMITS.maxContentBytesPerFile} bytes.`);
      return;
    }
    totalBytes += size;
    if (totalBytes > PATCH_LIMITS.maxTotalContentBytes) {
      errors.push(`Total patch content exceeds ${PATCH_LIMITS.maxTotalContentBytes} bytes.`);
      return;
    }
    normalized.content = content;
    normalizedFiles.push(normalized);
  });

  if (errors.length > 0) {
    return { ok: false, patch: null, errors, extraction: 'none' };
  }

  return {
    ok: true,
    patch: {
      version: HCR_PATCH_VERSION,
      summary: (summary as string).trim(),
      files: normalizedFiles,
    },
    errors: [],
    extraction: 'none',
  };
}

/**
 * Normalize + validate a raw ChatGPT Web reply into HCR_PATCH_V1.
 * Markdown fences are tolerated; prose alone is never treated as a patch.
 */
export function parseHcrPatch(raw: string): PatchParseResult {
  const { json, extraction } = extractJsonCandidate(raw);
  if (json === null) {
    return {
      ok: false,
      patch: null,
      errors: ['Response does not contain a JSON object.'],
      extraction: 'none',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      patch: null,
      errors: [`Response is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
      extraction,
    };
  }

  const result = validatePatch(parsed);
  return { ...result, extraction: result.ok ? extraction : extraction };
}

/** Correction prompt sent back to ChatGPT Web when a response fails validation. */
export const CORRECTION_PROMPT = `Your previous response did not match HCR_PATCH_V1.
Return ONLY valid JSON with exactly this shape and nothing else - no markdown fences, no explanation, no comments:

{
  "version": "HCR_PATCH_V1",
  "summary": "<one line description of the change>",
  "files": [
    { "path": "<path relative to the project root>", "action": "create|replace|delete", "content": "<full new file content, required for create/replace>" }
  ]
}

Rules:
- Allowed actions are only: create, replace, delete.
- Never include shell commands, scripts or instructions to run anything.
- Never use absolute paths or ".." path segments.`;
