import type { OllamaStatus, Model, Provider } from '@heisenberg/contracts';

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
      return { online: false, models: [] };
    }

    const data = (await response.json()) as { version?: string };
    const models = await getOllamaModels();
    return {
      online: true,
      version: data.version,
      models,
    };
  } catch {
    return { online: false, models: [] };
  }
}

/**
 * Get Ollama provider info (status filled in by the engine layer).
 */
export function getOllamaProvider(): Provider {
  return {
    type: 'ollama',
    name: 'Ollama',
    status: 'unknown',
  };
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
