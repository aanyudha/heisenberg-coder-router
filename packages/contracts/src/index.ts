// Provider types
export type ProviderType = 'ollama' | 'openai';

export interface Provider {
  type: ProviderType;
  name: string;
  status: 'online' | 'offline' | 'unknown';
}

// Model types
export interface Model {
  id: string;
  name: string;
  provider: ProviderType;
  size?: string;
  modified?: string;
}

// Codex CLI types
export interface CodexStatus {
  installed: boolean;
  path?: string;
  version?: string;
}

// Codex process run types
export type CodexRunState = 'idle' | 'starting' | 'running' | 'stopped' | 'exited';

export interface CodexRunStatus {
  state: CodexRunState;
  pid?: number;
  command?: string;
  provider?: ProviderType;
  model?: string;
  projectDir?: string;
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  error?: string;
}

// Ollama types
export interface OllamaStatus {
  online: boolean;
  version?: string;
  models: Model[];
}

// Project types
export interface ProjectInfo {
  name: string;
  path: string;
}

// Session types (minimal, Phase 1)
export interface Session {
  id: string;
  projectId: string;
  provider: ProviderType;
  model: string;
  createdAt: string;
}

// Health response
export interface HealthResponse {
  status: 'ok';
  timestamp: string;
}

// Status response
export interface StatusResponse {
  server: {
    host: string;
    port: number;
  };
  codex: CodexStatus;
  ollama: OllamaStatus;
  providers: Provider[];
  activeProvider: ProviderType;
  activeModel: string | null;
  project: ProjectInfo | null;
  run: CodexRunStatus;
}

// Start Codex response
export interface StartCodexResponse {
  run: CodexRunStatus;
}
