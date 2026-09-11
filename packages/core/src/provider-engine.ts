import type { ProviderType, Provider, Model } from '@heisenberg/contracts';
import { OllamaEngine } from './ollama-engine.js';
import { CodexEngine } from './codex-engine.js';
import { checkOpenAIAvailability, getOpenAIModels } from '@heisenberg/providers';

/**
 * Provider Engine - Manages provider selection and model listing.
 * Only two providers exist in Phase 1: Ollama (local) and OpenAI (via Codex CLI).
 */
export class ProviderEngine {
  private activeProvider: ProviderType = 'ollama';
  private activeModel: string | null = null;
  private ollamaEngine: OllamaEngine;
  private codexEngine: CodexEngine;

  constructor(ollamaEngine: OllamaEngine, codexEngine: CodexEngine) {
    this.ollamaEngine = ollamaEngine;
    this.codexEngine = codexEngine;
  }

  getActiveProvider(): ProviderType {
    return this.activeProvider;
  }

  getActiveModel(): string | null {
    return this.activeModel;
  }

  setProvider(provider: ProviderType): void {
    this.activeProvider = provider;
    this.activeModel = null;
  }

  setModel(model: string): void {
    this.activeModel = model;
  }

  async getProviders(): Promise<Provider[]> {
    const ollamaStatus = await this.ollamaEngine.getStatus();
    const codexStatus = await this.codexEngine.getStatus();

    return [
      {
        type: 'ollama',
        name: 'Ollama',
        status: ollamaStatus.online ? 'online' : 'offline',
      },
      {
        type: 'openai',
        name: 'OpenAI',
        status: codexStatus.installed ? 'online' : 'offline',
      },
    ];
  }

  async getModels(provider: ProviderType): Promise<Model[]> {
    switch (provider) {
      case 'ollama':
        return this.ollamaEngine.getModels();
      case 'openai':
        return getOpenAIModels();
      default:
        return [];
    }
  }
}

// Re-export for callers that need the async availability check.
export { checkOpenAIAvailability };
