import { DatabaseEngine } from '@heisenberg/core';
import { OllamaEngine } from '@heisenberg/core';
import { CodexEngine } from '@heisenberg/core';
import { CodexProcessEngine } from '@heisenberg/core';
import { ProviderEngine } from '@heisenberg/core';
import { ProjectEngine } from '@heisenberg/core';
import { SessionEngine } from '@heisenberg/core';
import { ModelEngine } from '@heisenberg/core';

export interface AppContext {
  db: DatabaseEngine;
  ollama: OllamaEngine;
  codex: CodexEngine;
  codexProcess: CodexProcessEngine;
  providers: ProviderEngine;
  projects: ProjectEngine;
  sessions: SessionEngine;
  models: ModelEngine;
}

export function createContext(): AppContext {
  const db = new DatabaseEngine();
  const ollama = new OllamaEngine();
  const codex = new CodexEngine();
  const codexProcess = new CodexProcessEngine();
  const providers = new ProviderEngine(ollama, codex);
  const projects = new ProjectEngine();
  const sessions = new SessionEngine(db);
  const models = new ModelEngine(providers);

  return { db, ollama, codex, codexProcess, providers, projects, sessions, models };
}

const KEY_PROVIDER = 'active_provider';
const KEY_MODEL = 'active_model';
const KEY_PROJECT = 'project_dir';

export function loadSettings(ctx: AppContext): void {
  const provider = ctx.db.getSetting(KEY_PROVIDER);
  if (provider === 'ollama' || provider === 'openai') {
    ctx.providers.setProvider(provider);
  }
  const model = ctx.db.getSetting(KEY_MODEL);
  if (model) {
    ctx.providers.setModel(model);
  }
  const projectDir = ctx.db.getSetting(KEY_PROJECT);
  if (projectDir) {
    // Fire and forget: restored project is validated again on start.
    void ctx.projects.setProject(projectDir).catch(() => {
      ctx.db.setSetting(KEY_PROJECT, '');
    });
  }
}

export function saveProvider(ctx: AppContext, provider: string): void {
  ctx.db.setSetting(KEY_PROVIDER, provider);
}

export function saveModel(ctx: AppContext, model: string): void {
  ctx.db.setSetting(KEY_MODEL, model);
}

export function saveProject(ctx: AppContext, projectDir: string): void {
  ctx.db.setSetting(KEY_PROJECT, projectDir);
}
