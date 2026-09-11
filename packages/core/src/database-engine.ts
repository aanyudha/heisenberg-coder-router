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

    // Keep the initial database minimal: settings + lightweight session log.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        project_dir TEXT NOT NULL,
        created_at TEXT NOT NULL
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

  insertSession(id: string, provider: string, model: string, projectDir: string, createdAt: string): void {
    if (!this.db) return;
    this.db
      .prepare('INSERT INTO sessions (id, provider, model, project_dir, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, provider, model, projectDir, createdAt);
  }

  deleteSession(id: string): boolean {
    if (!this.db) return false;
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return result.changes > 0;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
