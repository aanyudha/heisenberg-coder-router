import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import type { HcrPatchFile, HcrPatchV1 } from '@heisenberg/contracts';
import { PatchValidationEngine } from './patch-validation-engine.js';
import { WorkspaceApplyEngine, type ApplyOutcome } from './workspace-apply-engine.js';
import { diffLines, type FileDiff } from './diff-engine.js';

/** Deterministic HCoder-local failure codes (surfaced by the CLI). */
export class HcoderStoreError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'HcoderStoreError';
  }
}

export type PatchHistoryStatus = 'staged' | 'applied' | 'reverted' | 'rejected' | 'failed';

/** Metadata-only history record (never dumps file contents). */
export interface HcoderHistoryEntry {
  id: string;
  timestamp: string;
  completedAt: string | null;
  summary: string;
  files: { path: string; action: HcrPatchFile['action'] }[];
  filesChanged: number;
  status: PatchHistoryStatus;
  route: string | null;
  provider: string | null;
  model: string | null;
  destination: string | null;
  error: string | null;
}

export interface HcoderStagedPatch {
  id: string;
  projectRoot: string;
  createdAt: string;
  summary: string;
  patch: HcrPatchV1;
  route: string | null;
  provider: string | null;
  model: string | null;
  destination: string | null;
}

export interface HcoderPatchMeta {
  route?: string | null;
  provider?: string | null;
  model?: string | null;
  destination?: string | null;
}

interface SnapshotEntry {
  path: string;
  beforeExists: boolean;
  before: string | null;
}

interface StoreState {
  version: 1;
  projectRoot: string;
  pending: HcoderStagedPatch | null;
  history: HcoderHistoryEntry[];
  /** history entry id -> pre-apply file snapshot (used by revert). */
  snapshots: Record<string, SnapshotEntry[]>;
}

/** Metadata HCoder history shows per entry (snapshot is never displayed). */
export function toHistoryMetadata(entry: HcoderHistoryEntry): HcoderHistoryEntry {
  const { ...metadata } = entry;
  return metadata;
}

/**
 * HCoder Patch Store - local staging/apply/revert/history for one project.
 *
 * Guarantees:
 *  - staging never touches the project filesystem
 *  - a staged patch is bound to the project root that created it; it can
 *    never be applied to a different project
 *  - apply re-validates every path, snapshots the current state first, then
 *    writes through the shared WorkspaceApplyEngine (atomic temp+rename,
 *    automatic rollback on multi-file failure)
 *  - revert restores the snapshot: replaced files, deleted files and files
 *    created by the patch - no AI-generated reverse patch is ever used
 */
export class HcoderPatchStore {
  private readonly home: string;
  private readonly validator: PatchValidationEngine;
  private readonly applyEngine: WorkspaceApplyEngine;

  constructor(home?: string) {
    const override = process.env.HCODER_HOME?.trim();
    this.home = home ?? (override && override.length > 0 ? override : join(homedir(), '.hcoder'));
    this.validator = new PatchValidationEngine();
    this.applyEngine = new WorkspaceApplyEngine(this.validator);
  }

  /** Absolute path of the state file backing one project. */
  statePath(projectRoot: string): string {
    const key = createHash('sha1').update(resolve(projectRoot).toLowerCase()).digest('hex').slice(0, 16);
    return join(this.home, 'projects', `${key}.json`);
  }

  // ---- staging ----------------------------------------------------- //

  /** Stage a validated HCR_PATCH_V1. Nothing is written to the project. */
  stage(projectRoot: string, patch: HcrPatchV1, meta: HcoderPatchMeta = {}): HcoderStagedPatch {
    const root = resolve(projectRoot);
    const validation = this.validator.validatePatchPaths(root, patch);
    if (!validation.ok) {
      throw new HcoderStoreError(
        `Patch rejected: ${validation.issues.map((issue) => `${issue.path}: ${issue.error}`).join('; ')}`,
        'PATH_REJECTED'
      );
    }

    const state = this.load(projectRoot);
    const id = randomBytes(8).toString('hex');
    const staged: HcoderStagedPatch = {
      id,
      projectRoot: root,
      createdAt: new Date().toISOString(),
      summary: patch.summary,
      patch,
      route: meta.route ?? null,
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      destination: meta.destination ?? null,
    };

    state.pending = staged;
    state.history.push({
      id,
      timestamp: staged.createdAt,
      completedAt: null,
      summary: patch.summary,
      files: patch.files.map((file) => ({ path: file.path.replace(/\\/g, '/'), action: file.action })),
      filesChanged: patch.files.length,
      status: 'staged',
      route: staged.route,
      provider: staged.provider,
      model: staged.model,
      destination: staged.destination,
      error: null,
    });
    this.save(projectRoot, state);
    return staged;
  }

  pending(projectRoot: string): HcoderStagedPatch | null {
    return this.load(projectRoot).pending;
  }

  /** User explicitly rejected the staged patch (kept in history). */
  reject(projectRoot: string): HcoderHistoryEntry {
    const state = this.load(projectRoot);
    if (!state.pending) {
      throw new HcoderStoreError('No pending patch to reject.', 'NO_PENDING_PATCH');
    }
    const entry = state.history.find((candidate) => candidate.id === state.pending?.id);
    if (entry) {
      entry.status = 'rejected';
      entry.completedAt = new Date().toISOString();
    }
    state.pending = null;
    this.save(projectRoot, state);
    return entry ?? this.history(projectRoot, 1)[0];
  }

  // ---- diff -------------------------------------------------------- //

  /** Unified-style diffs of the pending patch against the current files. */
  diff(projectRoot: string): FileDiff[] {
    const state = this.load(projectRoot);
    if (!state.pending) return [];
    const root = resolve(projectRoot);
    const diffs: FileDiff[] = [];

    for (const file of state.pending.patch.files) {
      const relativePath = file.path.replace(/\\/g, '/');
      const absolutePath = resolve(root, ...relativePath.split('/'));
      const exists = existsSync(absolutePath);
      let before: string | null = null;
      if (exists) {
        try {
          before = readFileSync(absolutePath, 'utf8');
        } catch {
          before = null;
        }
      }

      if (file.action === 'delete') {
        if (before !== null) diffs.push(buildDiff(relativePath, 'delete', before, ''));
        continue;
      }
      const after = file.content ?? '';
      if (before !== after) {
        diffs.push(buildDiff(relativePath, file.action, exists ? before : null, after));
      }
    }
    return diffs;
  }

  // ---- apply ------------------------------------------------------- //

  /** Apply the pending patch after ownership + path re-validation. */
  async apply(projectRoot: string, meta: HcoderPatchMeta = {}): Promise<{ outcome: ApplyOutcome; entry: HcoderHistoryEntry }> {
    const root = resolve(projectRoot);
    const state = this.load(projectRoot);
    if (!state.pending) {
      throw new HcoderStoreError('No pending patch. Run the agent first, then "hcoder diff" and "hcoder apply".', 'NO_PENDING_PATCH');
    }
    const pending = state.pending;

    // 1. The patch must belong to THIS project.
    if (resolve(pending.projectRoot) !== root) {
      throw new HcoderStoreError(
        `Pending patch belongs to a different project (${pending.projectRoot}). Staged patches can only be applied where they were created.`,
        'PATCH_PROJECT_MISMATCH'
      );
    }

    // 2. Re-validate every path immediately before any write.
    const validation = this.validator.validatePatchPaths(root, pending.patch);
    if (!validation.ok) {
      throw new HcoderStoreError(
        `Patch rejected: ${validation.issues.map((issue) => `${issue.path}: ${issue.error}`).join('; ')}`,
        'PATH_REJECTED'
      );
    }

    const historyEntry = state.history.find((candidate) => candidate.id === pending.id);
    const completedAt = new Date().toISOString();

    try {
      // 3+4. Snapshot + atomic write happen inside the shared apply engine.
      const outcome = await this.applyEngine.apply(pending.id, root, pending.patch);

      // 5. Persist the pre-apply snapshot so `hcoder revert` can restore it
      //    even in a later process, then record history.
      state.snapshots[pending.id] = outcome.files.map((file) => ({
        path: file.path,
        beforeExists: file.beforeExists,
        before: file.before,
      }));
      if (historyEntry) {
        historyEntry.status = 'applied';
        historyEntry.completedAt = completedAt;
        historyEntry.filesChanged = outcome.changedFiles.length;
        historyEntry.route = pending.route ?? historyEntry.route;
        historyEntry.provider = pending.provider ?? historyEntry.provider;
        historyEntry.model = pending.model ?? historyEntry.model;
        historyEntry.destination = pending.destination ?? historyEntry.destination;
      }
      state.pending = null;
      this.save(projectRoot, state);
      return { outcome, entry: historyEntry ?? this.history(projectRoot, 1)[0] };
    } catch (error) {
      if (historyEntry) {
        historyEntry.status = 'failed';
        historyEntry.completedAt = completedAt;
        historyEntry.error = error instanceof Error ? error.message : 'Apply failed.';
      }
      this.save(projectRoot, state);
      throw new HcoderStoreError(
        error instanceof Error ? error.message : 'Apply failed.',
        'APPLY_FAILED'
      );
    }
  }

  // ---- revert ------------------------------------------------------ //

  /** Restore the snapshot of the most recent HCoder-applied patch. */
  async revert(projectRoot: string): Promise<{ restored: string[]; entry: HcoderHistoryEntry }> {
    const state = this.load(projectRoot);
    const entry = [...state.history].reverse().find((candidate) => candidate.status === 'applied');
    if (!entry) {
      throw new HcoderStoreError('No HCoder-applied patch available to revert.', 'NO_APPLIED_PATCH');
    }
    const snapshot = state.snapshots[entry.id];
    if (!snapshot) {
      throw new HcoderStoreError('Rollback snapshot is missing for the most recent applied patch.', 'NO_APPLIED_PATCH');
    }

    const root = resolve(projectRoot);
    if (!existsSync(root)) {
      throw new HcoderStoreError(`Project directory no longer exists: ${root}`, 'PATCH_PROJECT_MISMATCH');
    }

    const restored: string[] = [];
    const errors: string[] = [];
    for (const file of snapshot) {
      const absolutePath = resolve(root, ...file.path.split('/'));
      try {
        if (file.beforeExists) {
          atomicWriteSync(absolutePath, file.before ?? '');
        } else if (existsSync(absolutePath)) {
          unlinkSync(absolutePath);
        }
        restored.push(file.path);
      } catch (error) {
        errors.push(`${file.path}: ${error instanceof Error ? error.message : 'restore failed'}`);
      }
    }

    if (errors.length > 0) {
      throw new HcoderStoreError(`Revert incomplete: ${errors.join('; ')}`, 'REVERT_FAILED');
    }

    entry.status = 'reverted';
    entry.completedAt = new Date().toISOString();
    delete state.snapshots[entry.id];
    this.save(projectRoot, state);
    return { restored, entry };
  }

  /** Metadata-only history (most recent first). */
  history(projectRoot: string, limit = 20): HcoderHistoryEntry[] {
    const state = this.load(projectRoot);
    return [...state.history].reverse().slice(0, Math.max(1, limit)).map(toHistoryMetadata);
  }

  // ------------------------------------------------------------------ //

  private load(projectRoot: string): StoreState {
    const path = this.statePath(projectRoot);
    if (!existsSync(path)) {
      return { version: 1, projectRoot: resolve(projectRoot), pending: null, history: [], snapshots: {} };
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoreState>;
      return {
        version: 1,
        projectRoot: typeof parsed.projectRoot === 'string' ? parsed.projectRoot : resolve(projectRoot),
        pending: parsed.pending ?? null,
        history: Array.isArray(parsed.history) ? parsed.history : [],
        snapshots: parsed.snapshots && typeof parsed.snapshots === 'object' ? parsed.snapshots : {},
      };
    } catch {
      return { version: 1, projectRoot: resolve(projectRoot), pending: null, history: [], snapshots: {} };
    }
  }

  private save(projectRoot: string, state: StoreState): void {
    const path = this.statePath(projectRoot);
    mkdirSync(join(path, '..'), { recursive: true });
    const tempPath = `${path}.tmp-${randomBytes(4).toString('hex')}`;
    writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
    try {
      renameSync(tempPath, path);
    } catch {
      writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
      try {
        unlinkSync(tempPath);
      } catch {
        // temp file already gone
      }
    }
  }
}

function buildDiff(path: string, action: 'create' | 'replace' | 'delete', before: string | null, after: string): FileDiff {
  const result = diffLines(before, after);
  return {
    path,
    action,
    beforeExists: before !== null,
    afterExists: action !== 'delete',
    lines: result.lines,
    added: result.added,
    removed: result.removed,
    summarized: result.summarized,
  };
}

/** Temp file + rename in the same directory (best-effort atomic). */
function atomicWriteSync(targetPath: string, content: string): void {
  const directory = join(targetPath, '..');
  mkdirSync(directory, { recursive: true });
  const tempPath = join(directory, `.hcoder-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tempPath, content, 'utf8');
    renameSync(tempPath, targetPath);
  } catch {
    try {
      unlinkSync(tempPath);
    } catch {
      // temp file may not exist
    }
    writeFileSync(targetPath, content, 'utf8');
  }
}
