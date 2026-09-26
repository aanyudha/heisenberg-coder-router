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

// ---- routing / status ----

export interface RoutingState {
  desired: { provider: 'ollama' | 'openai'; model: string | null; projectDir: string | null };
  applied: { provider: 'ollama' | 'openai' | null; model: string | null };
  status: 'applied' | 'drift' | 'not_configured' | 'error';
  detail?: string;
  configPath: string;
  backupPath?: string;
}

export interface CodexStatus {
  installed: boolean;
  path?: string;
  version?: string;
}

export interface OllamaStatus {
  online: boolean;
  endpoint: string;
  version?: string;
  models: ModelInfo[];
}

export interface StatusResponse {
  server: { host: string; port: number };
  codex: CodexStatus;
  ollama: OllamaStatus;
  providers: ProviderInfo[];
  routing: RoutingState;
  project: ProjectInfoLike | null;
}

export interface RoutingVerify {
  status: RoutingState['status'];
  checks: {
    codexInstalled: boolean;
    configReadable: boolean;
    configValidToml: boolean;
    providerMatches: boolean;
    modelMatches: boolean;
  };
  vscodeCodex: VsCodeCodexInfo;
  layers?: {
    configSynced: boolean;
    runtimeAvailable: boolean;
    trafficObserved: boolean;
    detail: string;
  };
  configPath: string;
}

export type TelemetrySourceLike =
  | 'hcr-gateway'
  | 'hcr'
  | 'ollama'
  | 'codex'
  | 'provider'
  | 'unavailable';

export interface TelemetryLive {
  source: TelemetrySourceLike;
  active: boolean;
  state: string;
  provider: string | null;
  model: string | null;
  client: string | null;
  requestId: string | null;
  latencyMs: number | null;
  timeToFirstByteMs: number | null;
  requestCount: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  tokensPerSecond?: number | null;
  uptimeSeconds?: number | null;
  observedAt?: string;
}

export interface TelemetryLike extends TelemetryLive {
  contextUsed?: number | null;
  contextLimit?: number | null;
  averageLatencyMs?: number | null;
}

export interface RecentTraffic {
  requestId: string;
  provider: string;
  model: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  state: string;
  responseStatus: number | null;
  streaming: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  error: string | null;
}

// ---- Web Handoff ----

export type PatchAction = 'create' | 'replace' | 'delete';

export interface HcrPatchFile {
  path: string;
  action: PatchAction;
  content?: string;
}

export interface HcrPatchV1 {
  version: 'HCR_PATCH_V1';
  summary: string;
  files: HcrPatchFile[];
}

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

export interface ContextFileInfo {
  path: string;
  bytes: number;
  selected: 'required' | 'user' | 'auto';
}

export interface ContextExclusionInfo {
  path: string;
  reason: string;
}

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
}

export interface DiffLine {
  type: 'context' | 'add' | 'del';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface FileDiff {
  path: string;
  action: PatchAction;
  beforeExists: boolean;
  afterExists: boolean;
  lines: DiffLine[];
  added: number;
  removed: number;
  summarized: boolean;
}

export interface ReviewFile {
  path: string;
  action: PatchAction;
  state: 'create' | 'update' | 'delete' | 'missing';
  exists: boolean;
  beforeBytes: number | null;
  afterBytes: number | null;
}

export interface WebHandoffDetail extends WebHandoffSummary {
  task: string;
  patch: HcrPatchV1 | null;
  patchErrors: string[];
  rawResponse: string | null;
  files: ReviewFile[];
  diffs: FileDiff[];
  pathIssues: { path: string; error: string }[];
  canApply: boolean;
  canRevert: boolean;
  canRetry: boolean;
  companion: { queued: boolean; stage: WebHandoffStatus | null };
  contextSummary: ProjectContextSummary | null;
}

// ---- Browser Companion ----

export interface CompanionStatus {
  installed: null;
  installedState: 'unknown';
  connected: boolean;
  lastSeenAt: string | null;
  paired: boolean;
  provider: 'chatgpt-web';
  chatgpt: {
    state: 'ready' | 'auth_required' | 'tab_not_found' | 'unknown' | 'error';
    detail: string | null;
    reportedAt: string | null;
  };
  pairingReady: boolean;
  pairingExpiresAt: string | null;
}

export interface PairingCodeResponse {
  code: string;
  expiresAt: string;
  instructions: string[];
}

export interface DownloadInfo {
  url: string;
  filename: string;
  available: boolean;
  bytes: number;
}
