import { DatabaseSync } from 'node:sqlite';
import { ensureDataDir, getDbPath } from '@heisenberg/shared';

/**
 * Database Engine - Minimal SQLite persistence (Phase 1).
 * Creates data/router.sqlite automatically on first startup.
 */
export class DatabaseEngine {
  private db: DatabaseSync | null = null;

  initialize(): DatabaseSync {
    if (this.db) return this.db;

    ensureDataDir();
    const dbPath = getDbPath();
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
    return this.db;
  }

  private migrate(): void {
    if (!this.db) return;

    // Keep the initial database minimal: desired routing state only.
    // No session/conversation persistence (out of Phase 1 scope).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  getSetting(key: string): string | null {
    if (!this.db) return null;
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    if (!this.db) return;
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
