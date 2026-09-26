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
  /**
   * Ollama context window (tokens) HCR advertises to Codex via
   * `model_context_window` in config.toml. Null = HCR has no observed value
   * and must not guess (Codex then applies its own default).
   */
  contextWindow: number | null;
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
  /** Layered route verification (config / runtime / live traffic). */
  layers: {
    /** Codex config points at the HCR gateway route. */
    configSynced: boolean;
    /** Ollama online and desired model discovered. */
    runtimeAvailable: boolean;
    /** A real inference request has passed through the HCR gateway. */
    trafficObserved: boolean;
    detail: string;
  };
  configPath: string;
}

export interface ApplyRouteResponse {
  ok: boolean;
  routing: RoutingStatus;
}

// ---- Telemetry (truthful observability) ----

/** Where telemetry values came from. 'hcr-gateway' = observed in the data path. */
export type TelemetrySource = 'hcr-gateway' | 'hcr' | 'ollama' | 'codex' | 'provider' | 'unavailable';

/** Observable gateway request states (only reported when actually observed). */
export type GatewayRequestState =
  | 'idle'
  | 'receiving'
  | 'forwarding'
  | 'streaming'
  | 'completed'
  | 'error';

export interface TelemetrySnapshot {
  source: TelemetrySource;

  /** True while a gateway request is currently in flight. */
  active: boolean;
  /** Current gateway request state ('idle' when nothing is in flight). */
  state: GatewayRequestState;

  /** Provider/model of the current desired route (context for the metrics). */
  provider: RouteProvider | null;
  model: string | null;

  /** Client identity only when reliably observable; otherwise null. */
  client: string | null;
  /** Live/last gateway request id, when one exists. */
  requestId: string | null;

  // Inference metrics — null when not reliably observable. Unknown is NOT
  // the same as zero.
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;

  contextUsed?: number | null;
  contextLimit?: number | null;

  requestCount?: number | null;

  latencyMs?: number | null;
  timeToFirstByteMs?: number | null;
  averageLatencyMs?: number | null;

  tokensPerSecond?: number | null;

  /** Real metric: HCR server process uptime in seconds. */
  uptimeSeconds?: number | null;

  observedAt?: string;
}

// ---- Web Handoff (ChatGPT Web intelligence source) ----

/** Versioned patch contract returned by ChatGPT Web through the companion. */
export const HCR_PATCH_VERSION = 'HCR_PATCH_V1';

/** Phase 1 patch actions. No shell commands, ever. */
export type HcrPatchAction = 'create' | 'replace' | 'delete';

export interface HcrPatchFile {
  path: string;
  action: HcrPatchAction;
  /** Full new file content for create/replace. Ignored for delete. */
  content?: string;
}

export interface HcrPatchV1 {
  version: typeof HCR_PATCH_VERSION;
  summary: string;
  files: HcrPatchFile[];
}

/**
 * Web Handoff lifecycle.
 *
 * context_ready  - project context prepared, waiting for explicit Send
 * waiting_*      - companion task queued / ChatGPT interaction in progress
 * ready_for_review - valid HCR_PATCH_V1, awaiting explicit Apply
 */
export type WebHandoffStatus =
  | 'context_ready'
  | 'waiting_for_browser'
  | 'opening_chatgpt'
  | 'sending_prompt'
  | 'waiting_for_response'
  | 'receiving_response'
  | 'validating_patch'
  | 'ready_for_review'
  | 'invalid_patch_response'
  | 'applied'
  | 'reverted'
  | 'rejected'
  | 'error';

/** Stages the browser companion can report while driving ChatGPT Web. */
export type CompanionStage = Exclude<
  WebHandoffStatus,
  'context_ready' | 'ready_for_review' | 'invalid_patch_response' | 'applied' | 'reverted' | 'rejected' | 'error'
>;

/** Failure codes the browser companion can report for a queued task. */
export type CompanionTaskFailure =
  | 'AUTH_REQUIRED'
  | 'NO_TAB'
  | 'TIMEOUT'
  | 'ERROR'
  /** The selected ChatGPT Project could not be found. Never falls back. */
  | 'PROJECT_NOT_FOUND'
  /** The selected chat/session could not be found. Never falls back. */
  | 'CHAT_NOT_FOUND'
  /** The ChatGPT DOM could not be understood. */
  | 'UI_UNSUPPORTED';

/**
 * Outcome reported by the browser companion for a queued task.
 *
 * - handoff tasks answer with `responseText` (HCR_PATCH_V1) + the session used
 * - discovery tasks answer with `projects` / `chats` (metadata only)
 * - every other status is a deterministic failure code (no silent fallback)
 */
export type CompanionTaskResult =
  | {
      status: 'OK';
      responseText?: string;
      projects?: ChatGptProject[];
      chats?: ChatGptChat[];
      session?: ChatgptSessionRef;
    }
  | { status: CompanionTaskFailure; message?: string };

// ---- ChatGPT destination targeting (Browser Companion discovery) ----

/** Delivery mode inside the selected ChatGPT Project. */
export type ChatgptSendMode = 'continue' | 'create';

/** A ChatGPT Project discovered from the signed-in ChatGPT Web UI. */
export interface ChatGptProject {
  id: string;
  name: string;
  url: string;
}

/** A chat/session belonging to exactly one ChatGPT Project. */
export interface ChatGptChat {
  id: string;
  title: string;
  url: string;
}

/**
 * Chosen Web Handoff destination: local project -> ChatGPT Project -> session.
 *
 * Identity is the URL/id; names are presentation only (they can change).
 */
export interface ChatgptDestination {
  chatgptProjectId: string;
  chatgptProjectName: string;
  chatgptProjectUrl: string;
  chatId: string | null;
  chatTitle: string | null;
  chatUrl: string | null;
  chatMode: ChatgptSendMode;
  /** Optional title for a newly created session (never authoritative). */
  newChatTitle?: string | null;
}

/** Session actually used/created, reported back with an OK handoff result. */
export interface ChatgptSessionRef {
  chatgptProjectId: string | null;
  chatgptProjectName: string | null;
  chatgptProjectUrl: string | null;
  chatId: string;
  chatTitle: string;
  chatUrl: string;
  chatMode: ChatgptSendMode;
}

/** Discovery answer status (metadata only - never conversation contents). */
export type ChatgptDiscoveryStatus =
  | 'ok'
  | 'not_connected'
  | 'auth_required'
  | 'ui_unsupported'
  | 'timeout'
  | 'no_tab'
  | 'error';

export interface ContextFileInfo {
  path: string;
  bytes: number;
  selected: 'required' | 'user' | 'auto';
}

export interface ContextExclusionInfo {
  path: string;
  reason: string;
}

/** Summary of the project context being prepared (privacy review payload). */
export interface ProjectContextSummary {
  projectName: string;
  projectRoot: string;
  fileCount: number;
  totalBytes: number;
  files: ContextFileInfo[];
  excluded: ContextExclusionInfo[];
  tree: string[];
  limits: { maxFiles: number; maxBytesPerFile: number; maxTotalBytes: number };
}

export interface WebHandoffSummary {
  id: string;
  project: string;
  projectName: string;
  taskTitle: string;
  status: WebHandoffStatus;
  source: 'chatgpt-web';
  summary: string | null;
  filesChanged: number;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  /** Where the prompt was (or will be) delivered inside ChatGPT Web. */
  destination: ChatgptDestination | null;
}

export interface CompanionStatus {
  /** HCR cannot know an extension exists before it ever contacts HCR. */
  installed: null;
  installedState: 'unknown';
  connected: boolean;
  lastSeenAt: string | null;
  paired: boolean;
  provider: 'chatgpt-web';
  /** ChatGPT Web state as last reported by the companion. */
  chatgpt: {
    state: 'ready' | 'auth_required' | 'tab_not_found' | 'unknown' | 'error';
    detail: string | null;
    reportedAt: string | null;
  };
  pairingReady: boolean;
  pairingExpiresAt: string | null;
}

/** Metadata-only record of one observed gateway request (no content). */
export interface RecentRequest {
  requestId: string;
  provider: 'ollama';
  model: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  state: GatewayRequestState;
  responseStatus: number | null;
  streaming: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  error: string | null;
}
