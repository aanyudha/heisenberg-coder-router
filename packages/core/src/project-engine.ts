import type { ProjectInfo } from '@heisenberg/contracts';
import { stat } from 'fs/promises';
import { isAbsolute, basename, resolve } from 'path';
import { AppError } from '@heisenberg/shared';

/**
 * Project Engine - Manages the project directory Codex runs against.
 */
export class ProjectEngine {
  private current: ProjectInfo | null = null;

  async setProject(projectDir: string): Promise<ProjectInfo> {
    const resolved = isAbsolute(projectDir) ? resolve(projectDir) : resolve(process.cwd(), projectDir);
    let info;
    try {
      info = await stat(resolved);
    } catch {
      throw new AppError(`Project directory does not exist: ${resolved}`, 400);
    }
    if (!info.isDirectory()) {
      throw new AppError(`Path is not a directory: ${resolved}`, 400);
    }

    this.current = { name: basename(resolved), path: resolved };
    return this.current;
  }

  getProject(): ProjectInfo | null {
    return this.current;
  }

  getProjectOrThrow(): ProjectInfo {
    if (!this.current) {
      throw new AppError('No project directory selected', 400);
    }
    return this.current;
  }

  clear(): void {
    this.current = null;
  }
}
