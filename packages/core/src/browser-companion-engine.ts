import { randomBytes, timingSafeEqual } from 'crypto';
import { AppError } from '@heisenberg/shared';
import type { CompanionStage, CompanionStatus, CompanionTaskResult } from '@heisenberg/contracts';
import type { DatabaseEngine } from './database-engine.js';

const KEY_SECRET = 'companion_pairing_secret';
const KEY_PAIRING_CODE = 'companion_pairing_code';
const KEY_PAIRING_CODE_EXPIRES = 'companion_pairing_code_expires';
/** Set only after the extension has completed a real pairing exchange. */
const KEY_PAIRED_AT = 'companion_paired_at';

/** Heartbeat older than this means the extension is no longer connected. */
const HEARTBEAT_TIMEOUT_MS = 25_000;
const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;
const TASK_TTL_MS = 5 * 60 * 1000;
const MAX_QUEUED_TASKS = 5;

export interface CompanionTask {
  id: string;
  handoffId: string;
  prompt: string;
  createdAt: string;
}

export type CompanionResultHandler = (handoffId: string, taskId: string, result: CompanionTaskResult) => void | Promise<void>;

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

function shortCode(): string {
  // Human-transcribable, single alphabet, no ambiguous characters.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

/**
 * Browser Companion Engine - local pairing + task hand-off with the optional
 * Chrome/Edge companion extension.
 *
 * Security model:
 *  - HCR generates a random pairing secret on first use (stored locally).
 *  - A short-lived pairing code lets the extension obtain that secret once.
 *  - Every companion control request must present the secret; unknown/invalid
 *    tokens are rejected.
 *  - The secret is never sent anywhere except back to the local extension and
 *    is never written into ChatGPT Web or any remote endpoint.
 *  - HCR stores no cookies, no session tokens and no ChatGPT credentials.
 */
export class BrowserCompanionEngine {
  private lastSeenAtMs: number | null = null;
  private pending: CompanionTask[] = [];
  private stageByTask = new Map<string, CompanionStage>();
  private resultHandler: CompanionResultHandler | null = null;
  private chatgpt: CompanionStatus['chatgpt'] = {
    state: 'unknown',
    detail: null,
    reportedAt: null,
  };

  constructor(private readonly db: DatabaseEngine) {}

  /** Idempotently create the local pairing secret (first use). */
  ensureSecret(): string {
    const existing = this.db.getSetting(KEY_SECRET);
    if (existing && existing.length >= 32) return existing;
    const secret = randomBytes(32).toString('hex');
    this.db.setSetting(KEY_SECRET, secret);
    return secret;
  }

  /** True only after the extension has exchanged a pairing code for the secret. */
  paired(): boolean {
    return Boolean(this.db.getSetting(KEY_PAIRED_AT));
  }

  /** Short-lived code the user types into the extension to pair it. */
  generatePairingCode(ttlMs: number = DEFAULT_CODE_TTL_MS): { code: string; expiresAt: string } {
    this.ensureSecret();
    const code = shortCode();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db.setSetting(KEY_PAIRING_CODE, code);
    this.db.setSetting(KEY_PAIRING_CODE_EXPIRES, expiresAt);
    return { code, expiresAt };
  }

  activePairingCode(): { code: string; expiresAt: string } | null {
    const code = this.db.getSetting(KEY_PAIRING_CODE);
    const expiresAt = this.db.getSetting(KEY_PAIRING_CODE_EXPIRES);
    if (!code || !expiresAt) return null;
    if (Date.parse(expiresAt) < Date.now()) return null;
    return { code, expiresAt };
  }

  /** Exchange a valid pairing code for the pairing secret (the token). */
  pair(code: string): { token: string; expiresAt: string | null } {
    this.ensureSecret();
    const stored = this.db.getSetting(KEY_PAIRING_CODE);
    const expiresAt = this.db.getSetting(KEY_PAIRING_CODE_EXPIRES);
    if (!stored || !code || !safeEqual(stored.trim().toUpperCase(), code.trim().toUpperCase())) {
      throw new AppError('Invalid pairing code. Generate a new code in HCR and try again.', 403);
    }
    if (!expiresAt || Date.parse(expiresAt) < Date.now()) {
      throw new AppError('Pairing code expired. Generate a new code in HCR and try again.', 403);
    }
    // Single use: burn the code after a successful pairing.
    this.db.setSetting(KEY_PAIRING_CODE, '');
    this.db.setSetting(KEY_PAIRING_CODE_EXPIRES, '');
    this.db.setSetting(KEY_PAIRED_AT, new Date().toISOString());
    return { token: this.ensureSecret(), expiresAt };
  }

  /** Validate the pairing secret presented by the extension. */
  verify(token: string | undefined | null): boolean {
    if (!token) return false;
    const secret = this.db.getSetting(KEY_SECRET);
    if (!secret) return false;
    return safeEqual(secret, token);
  }

  requireToken(token: string | undefined | null): void {
    if (!this.verify(token)) {
      throw new AppError('Unauthorized: valid HCR Browser Companion pairing required.', 401);
    }
  }

  /** Deliberate reset: new secret, old extension pairing stops working. */
  reset(): { pairingCode: string | null } {
    this.db.setSetting(KEY_SECRET, randomBytes(32).toString('hex'));
    this.db.setSetting(KEY_PAIRING_CODE, '');
    this.db.setSetting(KEY_PAIRING_CODE_EXPIRES, '');
    this.db.setSetting(KEY_PAIRED_AT, '');
    this.lastSeenAtMs = null;
    return { pairingCode: null };
  }

  heartbeat(): { lastSeenAt: string; connected: boolean } {
    this.lastSeenAtMs = Date.now();
    return { lastSeenAt: new Date(this.lastSeenAtMs).toISOString(), connected: true };
  }

  lastSeen(): string | null {
    return this.lastSeenAtMs === null ? null : new Date(this.lastSeenAtMs).toISOString();
  }

  isConnected(): boolean {
    return this.lastSeenAtMs !== null && Date.now() - this.lastSeenAtMs <= HEARTBEAT_TIMEOUT_MS;
  }

  /** ChatGPT Web state as reported by the extension (never inferred). */
  reportChatgptState(state: CompanionStatus['chatgpt']['state'], detail: string | null = null): void {
    this.chatgpt = { state, detail, reportedAt: new Date().toISOString() };
  }

  status(): CompanionStatus {
    const pairing = this.activePairingCode();
    return {
      installed: null,
      installedState: 'unknown',
      connected: this.isConnected(),
      lastSeenAt: this.lastSeen(),
      paired: this.paired(),
      provider: 'chatgpt-web',
      chatgpt: { ...this.chatgpt },
      pairingReady: pairing !== null,
      pairingExpiresAt: pairing?.expiresAt ?? null,
    };
  }

  setResultHandler(handler: CompanionResultHandler): void {
    this.resultHandler = handler;
  }

  // ---- task queue ----

  queueTask(task: Omit<CompanionTask, 'id' | 'createdAt'>): CompanionTask {
    const full: CompanionTask = {
      ...task,
      id: randomBytes(8).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    this.pending.push(full);
    if (this.pending.length > MAX_QUEUED_TASKS) {
      this.pending.splice(0, this.pending.length - MAX_QUEUED_TASKS);
    }
    return full;
  }

  /** Next live task for the extension (kept until a result arrives). */
  takeTask(): CompanionTask | null {
    const now = Date.now();
    this.pending = this.pending.filter((task) => now - Date.parse(task.createdAt) <= TASK_TTL_MS);
    return this.pending[0] ?? null;
  }

  hasTask(taskId: string): boolean {
    return this.pending.some((task) => task.id === taskId);
  }

  setStage(taskId: string, stage: CompanionStage): void {
    this.stageByTask.set(taskId, stage);
  }

  stageOf(taskId: string): CompanionStage | undefined {
    return this.stageByTask.get(taskId);
  }

  /** Deliver a companion result to the owning Web Handoff (if any). */
  async resolveTask(taskId: string, result: CompanionTaskResult): Promise<string | null> {
    const index = this.pending.findIndex((task) => task.id === taskId);
    const task = index >= 0 ? this.pending[index] : null;
    if (index >= 0) this.pending.splice(index, 1);
    this.stageByTask.delete(taskId);
    if (!task) return null;
    if (this.resultHandler) await this.resultHandler(task.handoffId, taskId, result);
    return task.handoffId;
  }

  /** Drop queued tasks belonging to a handoff (user rejected/cancelled). */
  dropTasksFor(handoffId: string): void {
    this.pending = this.pending.filter((task) => task.handoffId !== handoffId);
  }

  queuedTaskCount(): number {
    return this.pending.length;
  }
}
