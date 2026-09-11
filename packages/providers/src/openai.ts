import type { Model, ProviderType } from '@heisenberg/contracts';
import { isCommandAvailable, safeExec, AppError } from '@heisenberg/shared';

const VALID_PROVIDERS: ProviderType[] = ['ollama', 'openai'];

export function isValidProvider(value: string): value is ProviderType {
  return VALID_PROVIDERS.includes(value as ProviderType);
}

export function assertValidProvider(value: string): ProviderType {
  if (!isValidProvider(value)) {
    throw new AppError(`Invalid provider "${value}". Supported providers: ollama, openai`, 400);
  }
  return value;
}

/**
 * Async check used by the engine layer.
 */
export async function checkOpenAIAvailability(): Promise<{ available: boolean; version?: string }> {
  const installed = await isCommandAvailable('codex');
  if (!installed) {
    return { available: false };
  }
  const version = await safeExec('codex --version');
  return { available: true, version: version ?? undefined };
}

/**
 * Get available OpenAI models via the Codex CLI.
 * `codex` is installed via npm and `codex --help` is fast; auth is Codex's own.
 */
export async function getOpenAIModels(): Promise<Model[]> {
  const installed = await isCommandAvailable('codex');
  if (!installed) {
    return [];
  }

  const help = await safeExec('codex --help');
  if (!help) {
    return [];
  }

  // Parse the `-m, --model <MODEL>` line from the help output instead of
  // hardcoding model names.
  const match = help.match(/--model\s*(?:<|\[)([^\]>]+)/);
  if (match) {
    const hint = match[1].trim();
    return [
      {
        id: hint,
        name: hint,
        provider: 'openai',
      },
    ];
  }

  return [];
}
