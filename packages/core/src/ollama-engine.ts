import type { OllamaStatus, Model } from '@heisenberg/contracts';
import { getOllamaStatus, getOllamaModels } from '@heisenberg/providers';

/**
 * Ollama Engine - Manages Ollama detection and model operations.
 * Degrades gracefully when Ollama is not installed/running.
 */
export class OllamaEngine {
  private status: OllamaStatus | null = null;

  async initialize(): Promise<OllamaStatus> {
    this.status = await getOllamaStatus();
    return this.status;
  }

  async getStatus(): Promise<OllamaStatus> {
    if (!this.status) {
      return this.initialize();
    }
    return this.status;
  }

  async refresh(): Promise<OllamaStatus> {
    this.status = await getOllamaStatus();
    return this.status;
  }

  async getModels(): Promise<Model[]> {
    const status = await this.getStatus();
    return status.models;
  }

  isOnline(): boolean {
    return this.status?.online ?? false;
  }
}
