import type { OllamaStatus, Model } from '@heisenberg/contracts';

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

/**
 * Resolve the Ollama base URL. Honors OLLAMA_HOST (host:port) when set,
 * otherwise uses the standard local endpoint.
 */
export function getOllamaBaseUrl(): string {
  const host = process.env.OLLAMA_HOST;
  if (host && host.trim().length > 0) {
    const trimmed = host.trim();
    // Allow both "host:port" and full URLs.
    if (/^https?:\/\//.test(trimmed)) {
      return trimmed.replace(/\/+$/, '');
    }
    return `http://${trimmed}`;
  }
  return DEFAULT_OLLAMA_URL;
}

/**
 * Get list of installed Ollama models from the local Ollama API.
 * Returns an empty list when Ollama is unreachable. Never throws.
 */
export async function getOllamaModels(): Promise<Model[]> {
  try {
    const response = await fetch(`${getOllamaBaseUrl()}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as {
      models?: Array<{
        name: string;
        model: string;
        size?: number;
        modified_at?: string;
      }>;
    };

    if (!data.models || !Array.isArray(data.models)) {
      return [];
    }

    return data.models.map((m) => ({
      id: m.model || m.name,
      name: m.name,
      provider: 'ollama' as const,
      size: m.size ? formatBytes(m.size) : undefined,
      modified: m.modified_at,
    }));
  } catch {
    return [];
  }
}

/**
 * Check if Ollama is running and get its status. Never throws: when Ollama is
 * unreachable the status is reported as offline instead of crashing.
 */
export async function getOllamaStatus(): Promise<OllamaStatus> {
  try {
    const response = await fetch(`${getOllamaBaseUrl()}/api/version`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return { online: false, endpoint: getOllamaBaseUrl(), models: [] };
    }

    const data = (await response.json()) as { version?: string };
    const models = await getOllamaModels();
    return {
      online: true,
      endpoint: getOllamaBaseUrl(),
      version: data.version,
      models,
    };
  } catch {
    return { online: false, endpoint: getOllamaBaseUrl(), models: [] };
  }
}

export interface OllamaContextInfo {
  /** Runtime context size (num_ctx) observed via /api/ps when the model is loaded; null otherwise. */
  loadedContextSize: number | null;
  /** Model-declared base context size (ollama.modelfile parameter) via /api/show; null otherwise. */
  declaredContextSize: number | null;
  /** The effective context window Codex should assume: loaded value wins, then declared. */
  contextWindow: number | null;
}

/**
 * Discover a model's context size. Two layers, reported separately so callers
 * can distinguish "observed at runtime" from "declared by the model":
 *   - /api/ps returns num_ctx ONLY while the model is loaded in memory.
 *   - /api/show returns the base ollama.modelfile parameter num_ctx
 *     (declared default, typically 4096) but not an effective override.
 * Never throws: nulls mean "not observable right now", not zero.
 */
export async function getOllamaContextInfo(model: string): Promise<OllamaContextInfo> {
  let loaded: number | null = null;
  let declared: number | null = null;
  try {
    const ps = await fetch(`${getOllamaBaseUrl()}/api/ps`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
      headers: { Accept: 'application/json' },
    });
    if (ps.ok) {
      const data = (await ps.json()) as { models?: Array<{ name: string; context_length?: number }> };
      const entry = data.models?.find(
        (m) => m.name === model || m.name.split(':')[0] === model.split(':')[0]
      );
      if (typeof entry?.context_length === 'number' && entry.context_length > 0) {
        loaded = entry.context_length;
      }
    }
  } catch {
    // Not loaded / unreachable: stays null.
  }
  try {
    const show = await fetch(`${getOllamaBaseUrl()}/api/show`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (show.ok) {
      const data = (await show.json()) as {
        model_info?: Record<string, unknown>;
        parameters?: string;
      };
      // Base model_info key, e.g. "<arch>.context_length" (no overrides applied).
      const infoKey = Object.keys(data.model_info ?? {}).find(
        (k) => k.endsWith('.context_length')
      );
      const infoValue = infoKey ? data.model_info?.[infoKey] : undefined;
      if (typeof infoValue === 'number' && infoValue > 0) {
        declared = infoValue;
      }
      // Explicit num_ctx Modelfile parameter line ("num_ctx 32768").
      const param = data.parameters
        ?.split('\n')
        .map((line) => line.trim())
        .find((line) => /^num_ctx\s+\d+$/.test(line));
      if (param) {
        const value = Number.parseInt(param.split(/\s+/)[1] ?? '', 10);
        if (Number.isFinite(value) && value > 0) declared = value;
      }
    }
  } catch {
    // Unreachable: stays null.
  }
  return { loadedContextSize: loaded, declaredContextSize: declared, contextWindow: loaded ?? declared };
}

/**
 * Format bytes to human readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
