import { existsSync, mkdirSync } from 'fs';
import { readFile, rename, unlink, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { AppError } from '@heisenberg/shared';
import type { HcrPatchV1 } from '@heisenberg/contracts';
import { PatchValidationEngine, type PatchPathIssue } from './patch-validation-engine.js';
import { diffLines, toUnifiedDiff, type FileDiff } from './diff-engine.js';

export type ApplyFileStatus = 'created' | 'updated' | 'deleted' | 'unchanged' | 'skipped';

export interface ApplyFileResult {
  path: string;
  action: 'create' | 'replace' | 'delete';
  status: ApplyFileStatus;
  beforeExists: boolean;
  afterExists: boolean;
  before: string | null;
  after: string | null;
  diff: FileDiff | null;
  note?: string;
}

export interface ApplyOutcome {
  handoffId: string | null;
  projectRoot: string;
  changedFiles: string[];
  files: ApplyFileResult[];
  diffs: FileDiff[];
  /** True when a partially applied patch was automatically restored. */
  rolledBack: boolean;
}

interface SnapshotFile {
  relativePath: string;
  existed: boolean;
  content: string | null;
}

interface RollbackSnapshot {
  handoffId: string;
  projectRoot: string;
  files: SnapshotFile[];
  createdAt: string;
}

/**
 * Workspace Apply Engine - the only component that touches project files.
 *
 * Guarantees:
 *  - the patch is re-validated immediately before any write
 *  - original contents are captured first, enabling one-level rollback
 *  - writes are atomic where practical (temp file + rename in the same dir)
 *  - no git commits, no shell commands, no automatic execution of anything
 */
export class WorkspaceApplyEngine {
  private snapshot: RollbackSnapshot | null = null;

  constructor(private readonly validator: PatchValidationEngine) {}

  /**
   * Validate a patch against a project root without touching the filesystem
   * (apart from path/symlink checks). Used before showing the review UI too.
   */
  validate(projectRoot: string, patch: HcrPatchV1): { ok: boolean; issues: PatchPathIssue[] } {
    const root = resolve(projectRoot);
    if (!existsSync(root)) {
      return { ok: false, issues: [{ path: projectRoot, error: 'Project directory no longer exists.' }] };
    }
    const pathResult = this.validator.validatePatchPaths(root, patch);
    return { ok: pathResult.ok, issues: pathResult.issues };
  }

  /** Apply an already validated patch to the selected project. */
  async apply(handoffId: string | null, projectRoot: string, patch: HcrPatchV1): Promise<ApplyOutcome> {
    const root = resolve(projectRoot);
    if (!existsSync(root)) {
      throw new AppError(`Project directory no longer exists: ${root}`, 400);
    }

    const pathResult = this.validator.validatePatchPaths(root, patch);
    if (!pathResult.ok) {
      throw new AppError(`Patch rejected: ${pathResult.issues.map((i) => `${i.path}: ${i.error}`).join('; ')}`, 400);
    }

    // Read current contents and detect structural problems BEFORE writing.
    const plan: ApplyFileResult[] = [];
    const errors: string[] = [];
    const snapshotFiles: SnapshotFile[] = [];

    for (const file of patch.files) {
      const relativePath = this.validator.validateProjectPath(root, file.path).relativePath;
      const absolutePath = resolve(root, relativePath);
      const beforeExists = existsSync(absolutePath);
      let before: string | null = null;
      if (beforeExists) {
        try {
          before = await readFile(absolutePath, 'utf8');
        } catch {
          errors.push(`${relativePath}: existing file could not be read (binary or locked?).`);
          continue;
        }
      }

      if (file.action === 'replace' && !beforeExists) {
        errors.push(`${relativePath}: replace requested but the file does not exist in the project.`);
        continue;
      }
      if (file.action === 'delete' && !beforeExists) {
        plan.push({
          path: relativePath,
          action: 'delete',
          status: 'skipped',
          beforeExists: false,
          afterExists: false,
          before: null,
          after: null,
          diff: null,
          note: 'File does not exist - nothing to delete.',
        });
        continue;
      }

      snapshotFiles.push({ relativePath, existed: beforeExists, content: before });

      if (file.action === 'delete') {
        plan.push({
          path: relativePath,
          action: 'delete',
          status: before === null ? 'unchanged' : 'deleted',
          beforeExists: true,
          afterExists: false,
          before,
          after: null,
          diff: buildDiff(relativePath, 'delete', before, ''),
        });
        continue;
      }

      const after = file.content ?? '';
      const status: ApplyFileStatus = !beforeExists ? 'created' : before === after ? 'unchanged' : 'updated';
      plan.push({
        path: relativePath,
        action: file.action,
        status,
        beforeExists,
        afterExists: true,
        before,
        after,
        diff: status === 'unchanged' ? null : buildDiff(relativePath, file.action, before, after),
      });
    }

    if (errors.length > 0) {
      throw new AppError(`Patch rejected: ${errors.join(' ')}`, 400);
    }

    // One-level rollback: a new apply replaces any previous snapshot.
    const rollback: RollbackSnapshot = {
      handoffId: handoffId ?? '__adhoc__',
      projectRoot: root,
      files: snapshotFiles,
      createdAt: new Date().toISOString(),
    };

    const changed = plan.filter((entry) => entry.status === 'created' || entry.status === 'updated' || entry.status === 'deleted');
    if (changed.length === 0) {
      return {
        handoffId,
        projectRoot: root,
        changedFiles: [],
        files: plan,
        diffs: [],
        rolledBack: false,
      };
    }

    this.snapshot = rollback;

    // Write. On any failure, restore everything captured in the snapshot.
    const written: string[] = [];
    try {
      for (const entry of changed) {
        const absolutePath = resolve(root, entry.path);
        if (entry.action === 'delete') {
          await unlink(absolutePath);
        } else {
          await atomicWrite(absolutePath, entry.after ?? '');
        }
        written.push(entry.path);
      }
    } catch (error) {
      const restore = await this.restoreSnapshot(rollback);
      throw new AppError(
        `Apply failed and was rolled back (${restore} file(s) restored): ${error instanceof Error ? error.message : 'unknown error'}`,
        500
      );
    }

    return {
      handoffId,
      projectRoot: root,
      changedFiles: changed.map((entry) => entry.path),
      files: plan,
      diffs: plan.flatMap((entry) => (entry.diff ? [entry.diff] : [])),
      rolledBack: false,
    };
  }

  /** Whether the most recent applied patch can still be reverted. */
  canRevert(handoffId: string): boolean {
    return this.snapshot !== null && this.snapshot.handoffId === handoffId;
  }

  /** One-level rollback of the most recently applied Web Handoff patch. */
  async revert(handoffId: string): Promise<ApplyOutcome> {
    if (!this.snapshot) {
      throw new AppError('No rollback snapshot available. Only the most recently applied patch can be reverted.', 409);
    }
    if (this.snapshot.handoffId !== handoffId) {
      throw new AppError('Rollback is only available for the most recently applied Web Handoff patch.', 409);
    }

    const snapshot = this.snapshot;
    if (!existsSync(snapshot.projectRoot)) {
      throw new AppError(`Project directory no longer exists: ${snapshot.projectRoot}`, 400);
    }

    const files: ApplyFileResult[] = [];
    const errors: string[] = [];
    for (const entry of snapshot.files) {
      const absolutePath = resolve(snapshot.projectRoot, entry.relativePath);
      try {
        if (entry.existed) {
          const existedBeforeRevert = existsSync(absolutePath);
          const current = existedBeforeRevert ? await readFile(absolutePath, 'utf8') : null;
          const status: ApplyFileStatus = !existedBeforeRevert ? 'created' : current === entry.content ? 'unchanged' : 'updated';
          files.push({
            path: entry.relativePath,
            action: 'replace',
            status,
            beforeExists: existedBeforeRevert,
            afterExists: true,
            before: current,
            after: entry.content,
            diff: status === 'unchanged' ? null : buildDiff(entry.relativePath, 'replace', current, entry.content),
          });
          if (status !== 'unchanged') await atomicWrite(absolutePath, entry.content ?? '');
        } else {
          const exists = existsSync(absolutePath);
          const current = exists ? await readFile(absolutePath, 'utf8') : null;
          files.push({
            path: entry.relativePath,
            action: 'delete',
            status: exists ? 'deleted' : 'unchanged',
            beforeExists: exists,
            afterExists: false,
            before: current,
            after: null,
            diff: exists ? buildDiff(entry.relativePath, 'delete', current, '') : null,
          });
          if (exists) await unlink(absolutePath);
        }
      } catch (error) {
        errors.push(`${entry.relativePath}: ${error instanceof Error ? error.message : 'restore failed'}`);
      }
    }

    const restored = files.filter((entry) => entry.status !== 'unchanged');
    this.snapshot = null;

    if (errors.length > 0) {
      throw new AppError(`Revert incomplete: ${errors.join('; ')}`, 500);
    }

    return {
      handoffId,
      projectRoot: snapshot.projectRoot,
      changedFiles: restored.map((entry) => entry.path),
      files,
      diffs: files.flatMap((entry) => (entry.diff ? [entry.diff] : [])),
      rolledBack: false,
    };
  }

  /** Snapshot age (ISO) for diagnostics; null when nothing is revertible. */
  snapshotInfo(): { handoffId: string; projectRoot: string; createdAt: string } | null {
    if (!this.snapshot) return null;
    return {
      handoffId: this.snapshot.handoffId,
      projectRoot: this.snapshot.projectRoot,
      createdAt: this.snapshot.createdAt,
    };
  }

  // ------------------------------------------------------------------ //

  private async restoreSnapshot(snapshot: RollbackSnapshot): Promise<number> {
    let restored = 0;
    for (const entry of snapshot.files) {
      const absolutePath = resolve(snapshot.projectRoot, entry.relativePath);
      try {
        if (entry.existed) {
          if (!existsSync(absolutePath) || (await readFile(absolutePath, 'utf8')) !== entry.content) {
            await atomicWrite(absolutePath, entry.content ?? '');
            restored++;
          }
        } else if (existsSync(absolutePath)) {
          await unlink(absolutePath);
          restored++;
        }
      } catch {
        // Best effort: continue restoring the remaining files.
      }
    }
    return restored;
  }
}

// -------------------------------------------------------------------- //

function buildDiff(
  path: string,
  action: 'create' | 'replace' | 'delete',
  before: string | null,
  after: string | null
): FileDiff {
  const beforeExists = before !== null;
  const afterExists = after !== null;
  const result = diffLines(beforeExists ? before : null, afterExists ? after ?? '' : '');
  return {
    path,
    action,
    beforeExists,
    afterExists,
    lines: result.lines,
    added: result.added,
    removed: result.removed,
    summarized: result.summarized,
  };
}

/** Write via temp file + rename in the same directory (atomic on POSIX). */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const directory = dirname(targetPath);
  mkdirSync(directory, { recursive: true });
  const tempPath = join(directory, `.hcr-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, targetPath);
  } catch (error) {
    // Windows rename can fail when the target is open; fall back to a direct
    // write so application still succeeds.
    try {
      await unlink(tempPath);
    } catch {
      // temp file may not exist
    }
    try {
      await writeFile(targetPath, content, 'utf8');
    } catch {
      throw error;
    }
  }
}

export { toUnifiedDiff };
export type { FileDiff };
