import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { AppError } from '@heisenberg/shared';
import type {
  ChatgptDestination,
  ChatgptSessionRef,
  CompanionStage,
  CompanionTaskResult,
  HcrPatchV1,
  ProjectContextSummary,
  WebHandoffStatus,
  WebHandoffSummary,
} from '@heisenberg/contracts';
import type { DatabaseEngine, WebHandoffRecord } from './database-engine.js';
import type { BrowserCompanionEngine } from './browser-companion-engine.js';
import type { ProjectContext, ProjectContextEngine } from './project-context-engine.js';
import type { PatchPathIssue } from './patch-validation-engine.js';
import { CORRECTION_PROMPT, parseHcrPatch } from './patch-schema.js';
import type { WorkspaceApplyEngine, ApplyOutcome } from './workspace-apply-engine.js';
import { ChatgptDestinationEngine, chatgptProjectIdFromUrl } from './chatgpt-destination-engine.js';
import { diffLines, type FileDiff } from './diff-engine.js';

/** Maximum patch size persisted in SQLite (local-only, for review/revert). */
const MAX_PERSISTED_PATCH_BYTES = 1_000_000;

export interface ReviewFile {
  path: string;
  action: 'create' | 'replace' | 'delete';
  /** create | update | delete | missing (file does not exist for replace). */
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
  pathIssues: PatchPathIssue[];
  canApply: boolean;
  canRevert: boolean;
  canRetry: boolean;
  companion: { queued: boolean; stage: CompanionStage | null };
  contextSummary: ProjectContextSummary | null;
}

export interface PrepareInput {
  task: string;
  projectDir: string;
  selectedFiles?: string[];
}

/** Optional targeting passed together with an explicit Send. */
export interface SendInput {
  destination?: ChatgptDestination | null;
}

/** Human-readable failure text for the deterministic targeting error codes. */
const TARGETING_ERRORS: Record<string, string> = {
  PROJECT_NOT_FOUND:
    'PROJECT_NOT_FOUND: the selected ChatGPT Project could not be found. Refresh Projects and select a current one.',
  CHAT_NOT_FOUND:
    'CHAT_NOT_FOUND: the selected chat session could not be found in that ChatGPT Project. Refresh Sessions and select a current one.',
  UI_UNSUPPORTED: 'UI_UNSUPPORTED: the ChatGPT page could not be understood (ChatGPT UI changed).',
};

/** Prompt contract sent to ChatGPT Web through the Browser Companion. */
export function buildHandoffPrompt(context: ProjectContext, task: string): string {
  const fileSections = context.files
    .map((file) => {
      const content = context.contents[file.path] ?? '';
      return `=== ${file.path} (${file.bytes} bytes) ===\n${content}`;
    })
    .join('\n\n');

  return `You are acting as the planning/code-generation intelligence for
Heisenberg Coder Router (HCR).

You are not directly controlling the filesystem. HCR validates your response
and the user reviews the diff before anything is written.

Project: ${context.projectName}
Project root: ${context.projectRoot}
All paths you return MUST be relative to the project root.

Task:
${task}

Selected project files:
${fileSections}

Project file tree (selected, ${context.tree.length} entries):
${context.tree.slice(0, 200).join('\n')}

Return ONLY valid HCR_PATCH_V1 JSON.
Do not use markdown fences.
Do not add explanations outside JSON.

{
  "version": "HCR_PATCH_V1",
  "summary": "<one line description of the change>",
  "files": [
    { "path": "<relative path>", "action": "create", "content": "<full file content>" },
    { "path": "<relative path>", "action": "replace", "content": "<full file content>" },
    { "path": "<relative path>", "action": "delete" }
  ]
}

Rules:
- Allowed actions: create, replace, delete only.
- Never include shell commands, scripts, or instructions to run anything.
- Never use absolute paths or ".." segments.
- Include the complete content for create/replace (no placeholders, no diffs).`;
}

/**
 * Web Handoff Engine - orchestrates the ChatGPT Web intelligence workflow.
 *
 * UI -> API -> WebHandoffEngine -> Browser Companion -> ChatGPT Web ->
 * HCR_PATCH_V1 -> validation -> user review -> WorkspaceApplyEngine.
 *
 * Codex is deliberately not involved, and no OpenAI API credentials are used.
 */
export class WebHandoffEngine {
  private contexts = new Map<string, ProjectContext>();
  private rawResponses = new Map<string, string>();
  private stageByHandoff = new Map<string, CompanionStage>();
  private pendingByHandoff = new Map<string, string>(); // handoffId -> taskId
  /** Local project -> last-used ChatGPT Project/session mapping. */
  private readonly destinations: ChatgptDestinationEngine;

  constructor(
    private readonly db: DatabaseEngine,
    private readonly contextEngine: ProjectContextEngine,
    private readonly applyEngine: WorkspaceApplyEngine,
    private readonly companion: BrowserCompanionEngine
  ) {
    this.destinations = new ChatgptDestinationEngine(db);
  }

  /** Restore the last-used ChatGPT destination for a local HCR project. */
  destinationFor(localProjectPath: string): ChatgptDestination | null {
    return this.destinations.get(localProjectPath);
  }

  /** Step 1: prepare (never sends anything) - build reviewable context. */
  async prepare(input: PrepareInput): Promise<WebHandoffDetail> {
    const task = input.task?.trim();
    if (!task || task.length === 0) throw new AppError('Task description is required', 400);
    if (task.length > 8000) throw new AppError('Task description is too long (max 8000 characters)', 400);

    const projectRoot = resolve(input.projectDir);
    if (!existsSync(projectRoot)) {
      throw new AppError(`Project directory does not exist: ${projectRoot}`, 400);
    }

    const context = await this.contextEngine.build(projectRoot, {
      task,
      selectedFiles: input.selectedFiles,
    });

    const id = randomBytes(8).toString('hex');
    this.contexts.set(id, context);

    const now = new Date().toISOString();
    this.db.createWebHandoff({
      id,
      projectPath: context.projectRoot,
      projectName: context.projectName,
      taskTitle: truncate(task, 120),
      status: 'context_ready',
      source: 'chatgpt-web',
      summary: null,
      filesChanged: 0,
      patchJson: null,
      error: null,
      createdAt: now,
      completedAt: null,
      destinationJson: null,
    });

    return this.detail(id, { task, context });
  }

  /** Step 2: explicit Send - queue the prepared prompt for the companion. */
  async send(id: string, input: SendInput = {}): Promise<WebHandoffDetail> {
    const record = this.requireRecord(id);
    const taskId = this.pendingByHandoff.get(id);
    const taskPending = taskId ? this.companion.hasTask(taskId) : false;
    const sendable: string[] = ['context_ready', 'waiting_for_browser', 'error'];
    if (taskPending) {
      throw new AppError(`Handoff ${id} is already queued for the Browser Companion.`, 409);
    }
    if (!sendable.includes(record.status)) {
      throw new AppError(`Handoff ${id} cannot be sent (status: ${record.status}).`, 409);
    }

    const destination = normalizeDestination(input.destination);

    const context = this.contexts.get(id) ?? (await this.rebuildContext(record));
    if (context) this.contexts.set(id, context);

    const taskText = record.taskTitle;
    const prompt = context
      ? buildHandoffPrompt(context, taskText)
      : `Project: ${record.projectName}\n\nTask:\n${taskText}\n\nReturn ONLY valid HCR_PATCH_V1 JSON.`;

    const queued = this.companion.queueTask({ handoffId: id, prompt, destination });
    this.pendingByHandoff.set(id, queued.id);
    this.stageByHandoff.set(id, 'waiting_for_browser');
    this.db.updateWebHandoff(id, {
      error: null,
      completedAt: null,
      destinationJson: destination ? JSON.stringify(destination) : record.destinationJson,
    });
    if (destination) this.rememberDestination(record.projectPath, destination, null);
    this.setStatus(id, 'waiting_for_browser');

    return await this.detail(id, { task: taskText, context });
  }

  /** Re-queue with the correction prompt after an invalid response. */
  async retry(id: string): Promise<WebHandoffDetail> {
    const record = this.requireRecord(id);
    if (record.status !== 'invalid_patch_response') {
      throw new AppError(`Handoff ${id} cannot be retried (status: ${record.status}).`, 409);
    }
    const previous = this.rawResponses.get(id) ?? '';
    const prompt = [
      `${CORRECTION_PROMPT}`,
      '',
      'Project context:',
      `Project: ${record.projectName}`,
      `Task: ${record.taskTitle}`,
      '',
      'Your previous response was:',
      truncate(previous, 4000),
    ].join('\n');

    // Retries keep the originally selected destination (deterministic).
    const destination = readDestination(record);
    const queued = this.companion.queueTask({ handoffId: id, prompt, destination });
    this.pendingByHandoff.set(id, queued.id);
    this.stageByHandoff.set(id, 'waiting_for_browser');
    this.db.updateWebHandoff(id, { error: null, completedAt: null });
    this.setStatus(id, 'waiting_for_browser');
    return await this.detail(id, { task: record.taskTitle, context: this.contexts.get(id) ?? null });
  }

  /** Extension reported a lifecycle stage while driving ChatGPT Web. */
  setStage(id: string, stage: CompanionStage): void {
    const record = this.db.getWebHandoff(id);
    if (!record) return;
    const live: CompanionStage[] = [
      'waiting_for_browser',
      'opening_chatgpt',
      'sending_prompt',
      'waiting_for_response',
      'receiving_response',
    ];
    if (!live.includes(stage)) return;
    this.stageByHandoff.set(id, stage);
    this.setStatus(id, stage);
  }

  /**
   * Step 3: companion delivered the final assistant response (or an error).
   * Normalizes, validates the HCR_PATCH_V1 schema, then path safety.
   */
  async handleResult(handoffId: string, taskId: string, result: CompanionTaskResult): Promise<void> {
    const record = this.db.getWebHandoff(handoffId);
    if (!record) return;
    void taskId;
    this.pendingByHandoff.delete(handoffId);
    this.stageByHandoff.delete(handoffId);

    if (result.status !== 'OK') {
      const targeting = TARGETING_ERRORS[result.status];
      const message =
        result.status === 'AUTH_REQUIRED'
          ? 'Open ChatGPT and sign in, then retry.'
          : targeting
            ? `${targeting}${result.message ? ` ${result.message}` : ''}`
            : (result.message ?? `Browser companion reported ${result.status}.`);
      this.db.updateWebHandoff(handoffId, {
        status: result.status === 'AUTH_REQUIRED' ? 'waiting_for_browser' : 'error',
        error: message,
        completedAt: null,
      });
      this.companion.reportChatgptState(
        result.status === 'AUTH_REQUIRED' ? 'auth_required' : 'error',
        message
      );
      return;
    }

    const raw = result.responseText ?? '';
    this.rawResponses.set(handoffId, raw);
    this.setStatus(handoffId, 'validating_patch');

    // The session actually used (or created) becomes the preferred mapping.
    const destination = readDestination(record);
    if (destination) {
      this.rememberDestination(record.projectPath, destination, result.session ?? null);
    }

    const parsed = parseHcrPatch(raw);
    if (!parsed.ok || !parsed.patch) {
      this.db.updateWebHandoff(handoffId, {
        status: 'invalid_patch_response',
        error: parsed.errors.join(' '),
        completedAt: new Date().toISOString(),
      });
      return;
    }

    const pathResult = this.applyEngine.validate(record.projectPath, parsed.patch);
    if (!pathResult.ok) {
      this.db.updateWebHandoff(handoffId, {
        status: 'invalid_patch_response',
        error: pathResult.issues.map((issue) => `${issue.path}: ${issue.error}`).join(' '),
        completedAt: new Date().toISOString(),
      });
      return;
    }

    const patchJson = JSON.stringify(parsed.patch);
    this.db.updateWebHandoff(handoffId, {
      status: 'ready_for_review',
      summary: parsed.patch.summary,
      filesChanged: countEffectiveChanges(parsed.patch),
      patchJson: Buffer.byteLength(patchJson, 'utf8') <= MAX_PERSISTED_PATCH_BYTES ? patchJson : null,
      error: null,
      completedAt: new Date().toISOString(),
    });
    this.companion.reportChatgptState('ready', null);
  }

  /** User explicitly rejected the proposed patch. */
  async reject(id: string): Promise<WebHandoffDetail> {
    const record = this.requireRecord(id);
    if (record.status !== 'ready_for_review' && record.status !== 'invalid_patch_response') {
      throw new AppError(`Handoff ${id} cannot be rejected (status: ${record.status}).`, 409);
    }
    this.companion.dropTasksFor(id);
    this.pendingByHandoff.delete(id);
    this.setStatus(id, 'rejected');
    return await this.detail(id, { task: record.taskTitle, context: this.contexts.get(id) ?? null });
  }

  /** Step 4: user explicitly applied the reviewed patch. */
  async apply(id: string): Promise<{ outcome: ApplyOutcome; detail: WebHandoffDetail }> {
    const record = this.requireRecord(id);
    if (record.status !== 'ready_for_review') {
      throw new AppError(`Handoff ${id} is not ready to apply (status: ${record.status}).`, 409);
    }
    const patch = this.readPatch(record);
    if (!patch) {
      throw new AppError('Patch is no longer available locally. Retry the handoff.', 409);
    }

    const outcome = await this.applyEngine.apply(id, record.projectPath, patch);
    this.db.updateWebHandoff(id, {
      status: 'applied',
      filesChanged: outcome.changedFiles.length,
      error: null,
      completedAt: new Date().toISOString(),
    });
    return {
      outcome,
      detail: await this.detail(id, { task: record.taskTitle, context: this.contexts.get(id) ?? null }),
    };
  }

  /** Step 5: one-level rollback of the most recently applied Web Handoff patch. */
  async revert(id: string): Promise<{ outcome: ApplyOutcome; detail: WebHandoffDetail }> {
    const record = this.requireRecord(id);
    if (record.status !== 'applied') {
      throw new AppError(`Handoff ${id} is not applied (status: ${record.status}).`, 409);
    }
    const outcome = await this.applyEngine.revert(id);
    this.db.updateWebHandoff(id, {
      status: 'reverted',
      filesChanged: outcome.changedFiles.length,
      completedAt: new Date().toISOString(),
    });
    return {
      outcome,
      detail: await this.detail(id, { task: record.taskTitle, context: this.contexts.get(id) ?? null }),
    };
  }

  // ---- reads ----

  async get(id: string): Promise<WebHandoffDetail> {
    const record = this.requireRecord(id);
    return await this.detail(id, { task: record.taskTitle, context: this.contexts.get(id) ?? null });
  }

  list(limit = 20): WebHandoffSummary[] {
    return this.db.listWebHandoffs(limit).map(toSummary);
  }

  /** Full context for privacy review. Recomputed when the server restarted. */
  async context(id: string): Promise<ProjectContextSummary> {
    const record = this.requireRecord(id);
    const cached = this.contexts.get(id);
    if (cached) return stripContents(cached);
    const rebuilt = await this.rebuildContext(record);
    if (rebuilt) {
      this.contexts.set(id, rebuilt);
      return stripContents(rebuilt);
    }
    throw new AppError('Context is no longer available. Prepare the handoff again.', 409);
  }

  // ------------------------------------------------------------------ //

  private async rebuildContext(record: WebHandoffRecord): Promise<ProjectContext | null> {
    try {
      return await this.contextEngine.build(record.projectPath, { task: record.taskTitle });
    } catch {
      return null;
    }
  }

  private requireRecord(id: string): WebHandoffRecord {
    const record = this.db.getWebHandoff(id);
    if (!record) throw new AppError(`Web Handoff ${id} not found`, 404);
    return record;
  }

  /**
   * Remember the destination used for a local project (last-used restore).
   * On a successful result the actual session wins - in create mode that is
   * the newly created chat, which becomes the preferred session from now on.
   */
  private rememberDestination(
    localProjectPath: string,
    destination: ChatgptDestination,
    session: ChatgptSessionRef | null
  ): void {
    const prior = this.destinations.get(localProjectPath);
    const sameProject = prior !== null && prior.chatgptProjectId === destination.chatgptProjectId;
    const chat = session
      ? {
          chatId: session.chatId || null,
          chatTitle: session.chatTitle || null,
          chatUrl: session.chatUrl || null,
        }
      : destination.chatMode === 'continue'
        ? { chatId: destination.chatId, chatTitle: destination.chatTitle, chatUrl: destination.chatUrl }
        : sameProject && prior
          ? { chatId: prior.chatId, chatTitle: prior.chatTitle, chatUrl: prior.chatUrl }
          : { chatId: null, chatTitle: null, chatUrl: null };
    this.destinations.save(localProjectPath, { ...destination, ...chat });
  }

  private setStatus(id: string, status: WebHandoffStatus): void {
    this.db.updateWebHandoff(id, { status });
  }

  private readPatch(record: WebHandoffRecord): HcrPatchV1 | null {
    if (!record.patchJson) return null;
    try {
      return JSON.parse(record.patchJson) as HcrPatchV1;
    } catch {
      return null;
    }
  }

  /** Build the review payload: proposed files + before/after diffs. */
  private async detail(
    id: string,
    extras: { task: string; context: ProjectContext | null }
  ): Promise<WebHandoffDetail> {
    const record = this.requireRecord(id);
    const patch = this.readPatch(record);
    const taskId = this.pendingByHandoff.get(id) ?? null;
    const queued = taskId ? this.companion.hasTask(taskId) : false;

    const base: WebHandoffDetail = {
      ...toSummary(record),
      task: extras.task,
      patch,
      patchErrors: record.error ? [record.error] : [],
      rawResponse: this.rawResponses.get(id) ?? null,
      files: [],
      diffs: [],
      pathIssues: [],
      canApply: false,
      canRevert: record.status === 'applied' && this.applyEngine.canRevert(id),
      canRetry: record.status === 'invalid_patch_response',
      companion: { queued, stage: this.stageByHandoff.get(id) ?? null },
      contextSummary: extras.context ? stripContents(extras.context) : null,
    };

    if (!patch) return base;

    const pathResult = this.applyEngine.validate(record.projectPath, patch);
    const files: ReviewFile[] = [];
    const diffs: FileDiff[] = [];

    for (const file of patch.files) {
      const relativePath = file.path.replace(/\\/g, '/');
      const absolutePath = resolve(record.projectPath, relativePath);
      const exists = existsSync(absolutePath);
      let before: string | null = null;
      if (exists) {
        try {
          before = await readFile(absolutePath, 'utf8');
        } catch {
          before = null;
        }
      }

      let state: ReviewFile['state'];
      if (file.action === 'delete') state = exists ? 'delete' : 'missing';
      else state = exists ? 'update' : 'create';

      files.push({
        path: relativePath,
        action: file.action,
        state,
        exists,
        beforeBytes: before === null ? null : Buffer.byteLength(before, 'utf8'),
        afterBytes: file.action === 'delete' ? null : Buffer.byteLength(file.content ?? '', 'utf8'),
      });

      if (file.action === 'delete') {
        if (exists) diffs.push(buildFileDiff(relativePath, 'delete', before, ''));
        continue;
      }
      const after = file.content ?? '';
      if (before !== after) {
        diffs.push(buildFileDiff(relativePath, file.action, exists ? before : null, after));
      }
    }

    return {
      ...base,
      files,
      diffs,
      pathIssues: pathResult.issues,
      canApply: record.status === 'ready_for_review' && patch !== null && pathResult.ok,
    };
  }
}

// -------------------------------------------------------------------- //

function buildFileDiff(
  path: string,
  action: 'create' | 'replace' | 'delete',
  before: string | null,
  after: string | null
): FileDiff {
  const result = diffLines(before, after ?? '');
  return {
    path,
    action,
    beforeExists: before !== null,
    afterExists: after !== null,
    lines: result.lines,
    added: result.added,
    removed: result.removed,
    summarized: result.summarized,
  };
}

function countEffectiveChanges(patch: HcrPatchV1): number {
  return patch.files.length;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function stripContents(context: ProjectContext): ProjectContextSummary {
  const { contents: _contents, instructions: _instructions, ...summary } = context;
  return summary;
}

function toSummary(record: WebHandoffRecord): WebHandoffSummary {
  return {
    id: record.id,
    project: record.projectPath,
    projectName: record.projectName,
    taskTitle: record.taskTitle,
    status: record.status as WebHandoffStatus,
    source: 'chatgpt-web',
    summary: record.summary,
    filesChanged: record.filesChanged,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    error: record.error,
    destination: readDestination(record),
  };
}

/** Destination metadata stored with the handoff (never credentials). */
function readDestination(record: WebHandoffRecord): ChatgptDestination | null {
  if (!record.destinationJson) return null;
  try {
    const parsed = JSON.parse(record.destinationJson) as ChatgptDestination | null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Validate + normalize a destination chosen in the UI. */
function normalizeDestination(destination: ChatgptDestination | null | undefined): ChatgptDestination | null {
  if (!destination) return null;
  const projectUrl = (destination.chatgptProjectUrl ?? '').trim();
  const projectId = (destination.chatgptProjectId ?? '').trim() || (projectUrl ? chatgptProjectIdFromUrl(projectUrl) ?? '' : '');
  if (projectId.length === 0 && projectUrl.length === 0) {
    throw new AppError('Select a ChatGPT Project before sending.', 400);
  }
  const chatMode: ChatgptDestination['chatMode'] = destination.chatMode === 'create' ? 'create' : 'continue';
  const chatId = (destination.chatId ?? '').trim() || null;
  const chatUrl = (destination.chatUrl ?? '').trim() || null;
  const chatTitle = (destination.chatTitle ?? '').trim() || null;
  if (chatMode === 'continue' && !chatId && !chatUrl) {
    throw new AppError('Select a chat session (or switch to Create New Session) before sending.', 400);
  }
  return {
    chatgptProjectId: projectId,
    chatgptProjectName: (destination.chatgptProjectName ?? '').trim(),
    chatgptProjectUrl: projectUrl,
    chatId,
    chatTitle,
    chatUrl,
    chatMode,
    newChatTitle: (destination.newChatTitle ?? '').trim() || null,
  };
}
