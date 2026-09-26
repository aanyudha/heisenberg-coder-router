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
    // Migration cleanup: databases created by the pre-routing launcher builds
    // may still carry a sessions table; drop it idempotently.
    this.db.exec('DROP TABLE IF EXISTS sessions;');

    // Web Handoff history: metadata only (plus the local-only patch needed to
    // review/revert). No cookies, no ChatGPT credentials, no project context.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS web_handoffs (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        project_name TEXT NOT NULL DEFAULT '',
        task_title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'chatgpt-web',
        summary TEXT,
        files_changed INTEGER NOT NULL DEFAULT 0,
        patch_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
  }

  // ---- settings ---------------------------------------------------- //

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

  // ---- Web Handoff history (metadata) ------------------------------ //

  createWebHandoff(row: WebHandoffRow): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO web_handoffs
          (id, project_path, project_name, task_title, status, source, summary, files_changed, patch_json, error, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.projectPath,
        row.projectName,
        row.taskTitle,
        row.status,
        row.source,
        row.summary,
        row.filesChanged,
        row.patchJson,
        row.error,
        row.createdAt,
        row.completedAt
      );
  }

  updateWebHandoff(id: string, patch: Partial<WebHandoffRow>): void {
    if (!this.db) return;
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    const set = (column: string, value: string | number | null) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.summary !== undefined) set('summary', patch.summary);
    if (patch.filesChanged !== undefined) set('files_changed', patch.filesChanged);
    if (patch.patchJson !== undefined) set('patch_json', patch.patchJson);
    if (patch.error !== undefined) set('error', patch.error);
    if (patch.completedAt !== undefined) set('completed_at', patch.completedAt);
    if (patch.taskTitle !== undefined) set('task_title', patch.taskTitle);
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE web_handoffs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  getWebHandoff(id: string): WebHandoffRecord | null {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM web_handoffs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapRow(row) : null;
  }

  listWebHandoffs(limit = 20): WebHandoffRecord[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare('SELECT * FROM web_handoffs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

/** SQLite row shape for web_handoffs (snake_case columns). */
export interface WebHandoffRow {
  id: string;
  projectPath: string;
  projectName: string;
  taskTitle: string;
  status: string;
  source: string;
  summary: string | null;
  filesChanged: number;
  patchJson: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type WebHandoffRecord = WebHandoffRow;

function mapRow(row: Record<string, unknown>): WebHandoffRecord {
  return {
    id: String(row.id),
    projectPath: String(row.project_path),
    projectName: String(row.project_name ?? ''),
    taskTitle: String(row.task_title ?? ''),
    status: String(row.status),
    source: String(row.source ?? 'chatgpt-web'),
    summary: row.summary === null || row.summary === undefined ? null : String(row.summary),
    filesChanged: Number(row.files_changed ?? 0),
    patchJson: row.patch_json === null || row.patch_json === undefined ? null : String(row.patch_json),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    createdAt: String(row.created_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
  };
}
