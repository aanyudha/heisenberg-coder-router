import { DatabaseEngine, OllamaEngine, CodexEngine, ProviderEngine, ProjectEngine, ModelEngine, CodexConfigEngine, RoutingEngine, TelemetryEngine, GatewayEngine } from '@heisenberg/core';
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

  return { db, ollama, codex, providers, projects, models, routing, telemetry, gateway };
}

const KEY_PROVIDER = 'active_provider';
const KEY_MODEL = 'active_model';
const KEY_PROJECT = 'project_dir';

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
  const projectDir = ctx.db.getSetting(KEY_PROJECT);
  if (projectDir) {
    // Fire and forget: restored project is re-validated on apply.
    void ctx.projects.setProject(projectDir).catch(() => {
      ctx.db.setSetting(KEY_PROJECT, '');
    });
    ctx.routing.setDesired({ projectDir });
  }
}

export function saveDesiredRoute(ctx: AppContext, patch: { provider?: RouteProvider; model?: string | null; projectDir?: string }): void {
  if (patch.provider !== undefined) ctx.db.setSetting(KEY_PROVIDER, patch.provider);
  if (patch.model !== undefined) ctx.db.setSetting(KEY_MODEL, patch.model ?? '');
  if (patch.projectDir !== undefined) ctx.db.setSetting(KEY_PROJECT, patch.projectDir);
}
