import {
  BrowserCompanionEngine,
  CodexConfigEngine,
  CodexEngine,
  DatabaseEngine,
  GatewayEngine,
  HcoderEngine,
  ModelEngine,
  OllamaEngine,
  ProjectContextEngine,
  ProjectEngine,
  ProviderEngine,
  RoutingEngine,
  TelemetryEngine,
  PatchValidationEngine,
  WebHandoffEngine,
  WorkspaceApplyEngine,
} from '@heisenberg/core';
import type { RouteProvider } from '@heisenberg/contracts';

export interface AppContext {
  db: DatabaseEngine;
  ollama: OllamaEngine;
  codex: CodexEngine;
  providers: ProviderEngine;
  projects: ProjectEngine;
  models: ModelEngine;
  routing: RoutingEngine;
  telemetry: TelemetryEngine;
  gateway: GatewayEngine;
  /** Optional Web Handoff feature set (ChatGPT Web intelligence source). */
  companion: BrowserCompanionEngine;
  webHandoff: WebHandoffEngine;
  /** HCoder control channel (provider-neutral agent turns for the local CLI). */
  hcoder: HcoderEngine;
}

export function createContext(): AppContext {
  const db = new DatabaseEngine();
  const ollama = new OllamaEngine();
  const codex = new CodexEngine();
  const providers = new ProviderEngine(ollama, codex);
  const projects = new ProjectEngine();
  const models = new ModelEngine(providers);
  const codexConfig = new CodexConfigEngine();
  const gateway = new GatewayEngine();
  const routing = new RoutingEngine(
    codexConfig,
    () => ollama.getStatus(),
    () => codex.getStatus(),
    gateway
  );
  const telemetry = new TelemetryEngine(() => ({
    provider: routing.getDesired().provider,
    model: routing.getDesired().model,
  }));
  telemetry.setGateway(gateway);

  // Web Handoff: context -> prompt -> companion -> patch -> apply.
  const contextEngine = new ProjectContextEngine();
  const patchValidator = new PatchValidationEngine();
  const applyEngine = new WorkspaceApplyEngine(patchValidator);
  const companion = new BrowserCompanionEngine(db);
  const webHandoff = new WebHandoffEngine(db, contextEngine, applyEngine, companion);
  companion.setResultHandler((handoffId, taskId, result) =>
    webHandoff.handleResult(handoffId, taskId, result)
  );

  // HCoder: provider-neutral agent turns (companion vs Ollama route).
  const hcoder = new HcoderEngine({
    db,
    companion,
    getRouteState: () => {
      const desired = routing.getDesired();
      return { provider: desired.provider, model: desired.model ?? null };
    },
    getOllamaStatus: () => ollama.getStatus(),
    getProjectRoot: () => projects.getProject()?.path ?? null,
  });

  return {
    db,
    ollama,
    codex,
    providers,
    projects,
    models,
    routing,
    telemetry,
    gateway,
    companion,
    webHandoff,
    hcoder,
  };
}

const KEY_PROVIDER = 'active_provider';
const KEY_MODEL = 'active_model';
const KEY_PROJECT = 'project_dir';
const KEY_CONTEXT_WINDOW = 'context_window';

/** Restore HCR desired route (provider/model/project) persisted in SQLite. */
export function loadSettings(ctx: AppContext): void {
  const provider = ctx.db.getSetting(KEY_PROVIDER);
  if (provider === 'ollama' || provider === 'openai') {
    ctx.routing.setDesired({ provider });
  }
  const model = ctx.db.getSetting(KEY_MODEL);
  if (model) {
    ctx.routing.setDesired({ model });
  }
  const contextWindow = ctx.db.getSetting(KEY_CONTEXT_WINDOW);
  if (contextWindow) {
    const parsed = Number.parseInt(contextWindow, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      ctx.routing.setDesired({ contextWindow: parsed });
    }
  }
  const projectDir = ctx.db.getSetting(KEY_PROJECT);
  if (projectDir) {
    // Fire and forget: restored project is re-validated on apply.
    void ctx.projects.setProject(projectDir).catch(() => {
      ctx.db.setSetting(KEY_PROJECT, '');
    });
    ctx.routing.setDesired({ projectDir });
  }
  // First use: create the local Browser Companion pairing secret.
  ctx.companion.ensureSecret();
}

export function saveDesiredRoute(
  ctx: AppContext,
  patch: { provider?: RouteProvider; model?: string | null; contextWindow?: number | null; projectDir?: string }
): void {
  if (patch.provider !== undefined) ctx.db.setSetting(KEY_PROVIDER, patch.provider);
  if (patch.model !== undefined) ctx.db.setSetting(KEY_MODEL, patch.model ?? '');
  if (patch.contextWindow !== undefined) {
    ctx.db.setSetting(KEY_CONTEXT_WINDOW, patch.contextWindow !== null ? String(patch.contextWindow) : '');
  }
  if (patch.projectDir !== undefined) ctx.db.setSetting(KEY_PROJECT, patch.projectDir);
}
