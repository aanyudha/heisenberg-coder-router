import type { ProviderType, Model } from '@heisenberg/contracts';
import { ProviderEngine } from './provider-engine.js';

/**
 * Model Engine - Model selection and validation for the selected provider.
 */
export class ModelEngine {
  private providerEngine: ProviderEngine;

  constructor(providerEngine: ProviderEngine) {
    this.providerEngine = providerEngine;
  }

  async getModels(provider: ProviderType): Promise<Model[]> {
    return this.providerEngine.getModels(provider);
  }

  async isValidModel(provider: ProviderType, modelId: string): Promise<boolean> {
    const models = await this.getModels(provider);
    return models.some((m) => m.id === modelId);
  }

  getActiveModel(): string | null {
    return this.providerEngine.getActiveModel();
  }

  setActiveModel(model: string): void {
    this.providerEngine.setModel(model);
  }
}
