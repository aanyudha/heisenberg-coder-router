import type { Session, ProviderType } from '@heisenberg/contracts';
import { generateId, formatDate } from '@heisenberg/shared';
import { DatabaseEngine } from './database-engine.js';

/**
 * Session Engine - Minimal session log (Phase 1).
 * Records one row per started Codex run. No complex persistence.
 */
export class SessionEngine {
  private db: DatabaseEngine;

  constructor(db: DatabaseEngine) {
    this.db = db;
  }

  recordStart(provider: ProviderType, model: string | null, projectDir: string): Session {
    const session: Session = {
      id: generateId(),
      projectId: 'default',
      provider,
      model: model ?? '(default)',
      createdAt: formatDate(),
    };

    this.db.insertSession(session.id, session.provider, session.model, projectDir, session.createdAt);
    return session;
  }

  deleteSession(id: string): boolean {
    return this.db.deleteSession(id);
  }
}
