import {
  HCODER_AGENT_VERSION,
  HCR_PATCH_VERSION,
  HCODER_TOOLS,
} from '@heisenberg/contracts';
import type {
  HcoderAgentStatus,
  HcoderAgentV1,
  HcoderToolRequest,
  HcoderTurnReply,
} from '@heisenberg/contracts';
import { extractJsonCandidate, validatePatch } from './patch-schema.js';
import { HCODER_AGENT_LOOP_LIMITS } from './hcoder-tool-engine.js';

const AGENT_STATUSES: readonly HcoderAgentStatus[] = ['needs_context', 'ready', 'answered'];

/**
 * The provider-neutral instruction sent with every HCoder session.
 *
 * It is deliberately transport-agnostic: the same text works through the
 * Browser Companion (ChatGPT Web), Ollama, or any future HCR route. HCR owns
 * route/provider/model selection - this contract never mentions a provider.
 */
export const HCODER_AGENT_INSTRUCTION = `You are operating through HCoder, the local coding agent of
Heisenberg Coder Router (HCR).

You cannot directly access the filesystem and you cannot execute shell
commands. HCR selects the intelligence route; HCoder runs only safe, read-only
local tools and stages patches for explicit user approval.

Project root: all paths MUST be relative to the project root.
Never use absolute paths, ".." segments, or Windows drive letters.

When additional project context is required, respond ONLY with HCODER_AGENT_V1:

{
  "version": "HCODER_AGENT_V1",
  "status": "needs_context",
  "requests": [
    { "id": "r1", "tool": "read_file", "path": "src/App.tsx" }
  ]
}

Available tools:
- read_file(path[, offset, limit])
- list_directory(path)
- search_files(pattern)
- search_text(query[, path][, glob])
- read_many_files(paths)

When enough context is available, respond ONLY with HCR_PATCH_V1:

{
  "version": "HCR_PATCH_V1",
  "summary": "<one line description>",
  "files": [
    { "path": "<relative path>", "action": "create|replace|delete", "content": "<full new file content>" }
  ]
}

When you can answer without tools or file changes, respond with a short
plain-text answer.

Rules:
- Do not invent file contents.
- Do not request shell commands (no cmd, powershell, bash, npm, npx, git).
- Do not include prose outside the structured contract when a contract is
  required.
- Never include credentials, secrets or instructions to run anything.`;

export interface AgentParseResult {
  ok: boolean;
  agent: HcoderAgentV1 | null;
  errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((entry) => typeof entry === 'string')) return null;
  return value;
}

/**
 * Validate a parsed value against the HCODER_AGENT_V1 schema.
 * Strict: unknown versions, unknown tools and malformed requests are rejected.
 */
export function validateHcoderAgent(value: unknown): AgentParseResult {
  const errors: string[] = [];

  if (!isPlainObject(value)) {
    return { ok: false, agent: null, errors: ['Response is not a JSON object.'] };
  }

  // Tolerate a single wrapper object: { "agent": { HCODER_AGENT_V1 ... } }.
  let candidate: Record<string, unknown> = value;
  if (candidate.version === undefined && isPlainObject(candidate.agent)) {
    candidate = candidate.agent;
  }

  if (candidate.version !== HCODER_AGENT_VERSION) {
    errors.push(`version must be "${HCODER_AGENT_VERSION}" (received ${JSON.stringify(candidate.version ?? null)}).`);
  }

  const status = candidate.status;
  if (typeof status !== 'string' || !AGENT_STATUSES.includes(status as HcoderAgentStatus)) {
    errors.push(`status must be one of: ${AGENT_STATUSES.join(' | ')}.`);
  }

  const requests = candidate.requests;
  if (!Array.isArray(requests)) {
    errors.push('requests must be an array.');
    return { ok: false, agent: null, errors };
  }

  const normalized: HcoderToolRequest[] = [];
  requests.forEach((entry, index) => {
    const label = `requests[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${label} must be an object.`);
      return;
    }
    const id = entry.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      errors.push(`${label}.id must be a non-empty string.`);
      return;
    }
    const tool = entry.tool;
    if (typeof tool !== 'string' || !(HCODER_TOOLS as readonly string[]).includes(tool)) {
      errors.push(`${label}.tool "${String(tool ?? '')}" is not a supported tool. Supported: ${HCODER_TOOLS.join(', ')}.`);
      return;
    }

    const request: HcoderToolRequest = { id: id.trim(), tool: tool as HcoderToolRequest['tool'] };

    if (tool === 'read_file' || tool === 'list_directory') {
      if (typeof entry.path !== 'string' || entry.path.trim().length === 0) {
        errors.push(`${label}.path must be a non-empty string for tool "${tool}".`);
        return;
      }
      request.path = entry.path.trim();
      if (tool === 'read_file') {
        if (entry.offset !== undefined && (typeof entry.offset !== 'number' || !Number.isFinite(entry.offset))) {
          errors.push(`${label}.offset must be a number.`);
          return;
        }
        if (entry.limit !== undefined && (typeof entry.limit !== 'number' || !Number.isFinite(entry.limit))) {
          errors.push(`${label}.limit must be a number.`);
          return;
        }
        if (entry.offset !== undefined) request.offset = entry.offset as number;
        if (entry.limit !== undefined) request.limit = entry.limit as number;
      }
    } else if (tool === 'search_files') {
      if (typeof entry.pattern !== 'string' || entry.pattern.trim().length === 0) {
        errors.push(`${label}.pattern must be a non-empty string for tool "search_files".`);
        return;
      }
      request.pattern = entry.pattern.trim();
    } else if (tool === 'search_text') {
      if (typeof entry.query !== 'string' || entry.query.trim().length === 0) {
        errors.push(`${label}.query must be a non-empty string for tool "search_text".`);
        return;
      }
      request.query = entry.query;
      if (entry.path !== undefined) {
        if (typeof entry.path !== 'string') {
          errors.push(`${label}.path must be a string.`);
          return;
        }
        request.path = entry.path;
      }
      if (entry.glob !== undefined) {
        if (typeof entry.glob !== 'string') {
          errors.push(`${label}.glob must be a string.`);
          return;
        }
        request.glob = entry.glob;
      }
    } else if (tool === 'read_many_files') {
      const paths = asStringArray(entry.paths);
      if (paths === null || paths.length === 0) {
        errors.push(`${label}.paths must be a non-empty array of strings for tool "read_many_files".`);
        return;
      }
      request.paths = paths;
    }

    normalized.push(request);
  });

  if (errors.length > 0) {
    return { ok: false, agent: null, errors };
  }

  if (status === 'needs_context' && normalized.length === 0) {
    return { ok: false, agent: null, errors: ['status "needs_context" requires at least one request.'] };
  }

  return {
    ok: true,
    agent: {
      version: HCODER_AGENT_VERSION,
      status: status as HcoderAgentStatus,
      requests: normalized,
      ...(typeof candidate.message === 'string' && candidate.message.trim().length > 0
        ? { message: candidate.message }
        : {}),
    },
    errors: [],
  };
}

/** Normalize + validate a raw model reply into HCODER_AGENT_V1. */
export function parseHcoderAgent(raw: string): AgentParseResult {
  const { json } = extractJsonCandidate(raw);
  if (json === null) {
    return { ok: false, agent: null, errors: ['Response does not contain a JSON object.'] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      agent: null,
      errors: [`Response is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
    };
  }
  return validateHcoderAgent(parsed);
}

/**
 * Classify one raw assistant reply into the provider-neutral turn reply.
 *
 *  - HCODER_AGENT_V1 (valid)     -> tool requests, executed by HCoder
 *  - HCR_PATCH_V1 (valid)        -> staged for review, never auto-applied
 *  - anything that CLAIMS a contract but is malformed -> INVALID_AGENT_RESPONSE
 *  - plain prose                 -> final answer (loop stops)
 */
export function classifyAgentReply(raw: string): HcoderTurnReply {
  const trimmed = raw ?? '';
  const claimsAgent = trimmed.includes(HCODER_AGENT_VERSION);
  const claimsPatch = trimmed.includes(HCR_PATCH_VERSION);

  const { json } = extractJsonCandidate(trimmed);
  if (json === null) {
    if (claimsAgent || claimsPatch) {
      return { kind: 'invalid', raw: trimmed, errors: ['Response mentions a contract but contains no JSON object.'] };
    }
    return { kind: 'text', raw: trimmed, text: trimmed.trim() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    if (claimsAgent || claimsPatch) {
      return {
        kind: 'invalid',
        raw: trimmed,
        errors: [`Response is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
      };
    }
    return { kind: 'text', raw: trimmed, text: trimmed.trim() };
  }

  const version = isPlainObject(parsed) ? parsed.version : undefined;
  const declaresAgent = version === HCODER_AGENT_VERSION || (version === undefined && isPlainObject(parsed) && isPlainObject(parsed.agent));
  if (declaresAgent || (claimsAgent && version === undefined)) {
    const result = validateHcoderAgent(parsed);
    if (!result.ok || !result.agent) {
      return { kind: 'invalid', raw: trimmed, errors: result.errors };
    }
    if (result.agent.requests.length === 0) {
      return { kind: 'text', raw: trimmed, text: result.agent.message ?? trimmed.trim() };
    }
    return { kind: 'agent', raw: trimmed, agent: result.agent };
  }

  const declaresPatch = version === HCR_PATCH_VERSION || (version === undefined && isPlainObject(parsed) && isPlainObject(parsed.patch));
  if (declaresPatch || claimsPatch) {
    const result = validatePatch(parsed);
    if (!result.ok || !result.patch) {
      return { kind: 'invalid', raw: trimmed, errors: result.errors };
    }
    return { kind: 'patch', raw: trimmed, patch: result.patch };
  }

  return { kind: 'text', raw: trimmed, text: trimmed.trim() };
}

/** Human-readable reason for loop exhaustion (used by the loop and the CLI). */
export function loopLimitMessage(rounds: number, maxRounds: number = HCODER_AGENT_LOOP_LIMITS.maxRounds): string {
  return `Agent loop stopped after ${rounds} rounds (limit ${maxRounds}).`;
}
