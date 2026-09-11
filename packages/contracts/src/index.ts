// Provider types
export type ProviderType = 'ollama' | 'openai';

export interface Provider {
  type: ProviderType;
  name: string;
  status: 'online' | 'external' | 'offline' | 'unknown';
  note?: string;
  version?: string;
}

// Model types
export interface Model {
  id: string; // stable route id used by routing
  name: string;
  provider: ProviderType;
  size?: string;
  modified?: string;
}

// Codex CLI types (detection only — HCR never launches Codex)
export interface CodexStatus {
  installed: boolean;
  path?: string;
  version?: string;
}

// Ollama types
export interface OllamaStatus {
  online: boolean;
  endpoint: string; // base URL honoring OLLAMA_HOST
  version?: string;
  models: Model[]; // live from local Ollama API; never hardcoded
}

// Project types
export interface ProjectInfo {
  name: string;
  path: string;
}

// Health response
export interface HealthResponse {
  status: 'ok';
  timestamp: string;
}

// Full status response
export interface StatusResponse {
  server: {
    host: string;
    port: number;
  };
  codex: CodexStatus;
  ollama: OllamaStatus;
  providers: Provider[];
  routing: RoutingStatus;
  project: ProjectInfo | null;
}

// ---- Routing (HCR routing control plane) ----

export type RouteProvider = 'ollama' | 'openai';

export interface RouteConfig {
  provider: RouteProvider;
  /** Required for ollama; ignored/cleared for openai. */
  model: string | null;
  /** Project directory Codex will run against (HCR-side metadata). */
  projectDir: string | null;
}

export type RouteStatus = 'applied' | 'drift' | 'not_configured' | 'error';

export interface AppliedRoute {
  provider: RouteProvider | null;
  model: string | null;
}

export interface RoutingStatus {
  desired: RouteConfig;
  applied: AppliedRoute;
  status: RouteStatus;
  /** Human-readable explanation, e.g. drift details or apply failure. */
  detail?: string;
  configPath: string;
  backupPath?: string;
}

export interface RoutingVerify {
  status: RouteStatus;
  desired: RouteConfig;
  applied: AppliedRoute;
  checks: {
    codexInstalled: boolean;
    configReadable: boolean;
    configValidToml: boolean;
    providerMatches: boolean;
    modelMatches: boolean;
  };
  vscodeCodex: {
    /** Whether a VS Code Codex integration was detected on this machine. */
    detected: boolean;
    /** Whether HCR could confirm that integration honors the shared Codex config route. */
    confirmed: boolean;
    detail: string;
  };
  configPath: string;
}

export interface ApplyRouteResponse {
  ok: boolean;
  routing: RoutingStatus;
}

// ---- Telemetry (truthful observability) ----

/** Where telemetry values came from. 'unavailable' = HCR cannot observe. */
export type TelemetrySource = 'hcr' | 'ollama' | 'codex' | 'provider' | 'unavailable';

export interface TelemetrySnapshot {
  source: TelemetrySource;

  /** Provider/model of the current desired route (context for the metrics). */
  provider: RouteProvider | null;
  model: string | null;

  // Inference metrics — null when HCR has no reliable source (it is not in
  // the inference data path). Unknown is NOT the same as zero.
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;

  contextUsed?: number | null;
  contextLimit?: number | null;

  requestCount?: number | null;

  latencyMs?: number | null;
  averageLatencyMs?: number | null;

  tokensPerSecond?: number | null;

  /** Real metric: HCR server process uptime in seconds. */
  uptimeSeconds?: number | null;

  observedAt?: string;
}
