export interface ProjectInfoLike {
  name: string;
  path: string;
}

export type ProviderTypeLike = 'ollama' | 'openai';

export interface ProviderInfo {
  type: ProviderTypeLike;
  name: string;
  status: 'online' | 'external' | 'offline' | 'unknown';
  note?: string;
  version?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderTypeLike;
  size?: string;
  modified?: string;
}

export interface VsCodeCodexInfo {
  detected: boolean;
  confirmed: boolean;
  detail: string;
}

export type { ProjectInfoLike as ProjectInfo };
