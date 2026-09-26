import { randomBytes, timingSafeEqual } from 'crypto';
import { AppError } from '@heisenberg/shared';
import type {
  ChatGptChat,
  ChatGptProject,
  ChatgptDestination,
  ChatgptDiscoveryStatus,
  CompanionStage,
  CompanionStatus,
  CompanionTaskFailure,
  CompanionTaskResult,
} from '@heisenberg/contracts';
import type { DatabaseEngine } from './database-engine.js';
import { chatgptChatIdFromUrl, chatgptProjectIdFromUrl } from './chatgpt-destination-engine.js';

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
/** How long HCR waits for the extension to answer a discovery request. */
const DISCOVERY_TIMEOUT_MS = 30_000;
/** Brief in-memory cache for discovery (Refresh buttons bypass it). */
const DISCOVERY_CACHE_MS = 30_000;

/** What a queued companion task asks the extension to do. */
export type CompanionTaskKind = 'handoff' | 'discover_projects' | 'discover_chats';

export interface CompanionTask {
  id: string;
  handoffId: string;
  prompt: string;
  createdAt: string;
  kind: CompanionTaskKind;
  /** Where the prompt must be delivered inside ChatGPT Web (handoff tasks). */
  destination?: ChatgptDestination | null;
  /** Project to list sessions from (discover_chats tasks). */
  projectId?: string;
  projectUrl?: string;
}

/** Discovery answer - metadata only, never conversation contents. */
export interface DiscoveryAnswer {
  status: ChatgptDiscoveryStatus;
  projects?: ChatGptProject[];
  chats?: ChatGptChat[];
  error: string | null;
}

export type CompanionResultHandler = (handoffId: string, taskId: string, result: CompanionTaskResult) => void | Promise<void>;

interface DiscoveryWaiter {
  answer: (answer: DiscoveryAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

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
  private discoveryWaiters = new Map<string, DiscoveryWaiter>();
  private discoveryCache = new Map<string, { at: number; answer: DiscoveryAnswer }>();
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

  queueTask(
    task: Omit<CompanionTask, 'id' | 'createdAt' | 'kind'> & { kind?: CompanionTaskKind }
  ): CompanionTask {
    const full: CompanionTask = {
      ...task,
      kind: task.kind ?? 'handoff',
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

    // Discovery tasks answer the waiting request instead of a Web Handoff.
    if (task.kind !== 'handoff') {
      this.settleDiscovery(task, result);
      return null;
    }

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

  // ---- ChatGPT destination discovery (metadata only) ---------------- //

  /** Ask the extension for the ChatGPT Projects visible in the signed-in UI. */
  discoverProjects(options: { refresh?: boolean } = {}): Promise<DiscoveryAnswer> {
    return this.requestDiscovery('projects', undefined, options);
  }

  /** Ask the extension for the sessions belonging to exactly one Project. */
  discoverChats(
    projectId: string,
    projectUrl: string,
    options: { refresh?: boolean } = {}
  ): Promise<DiscoveryAnswer> {
    if (!projectId && !projectUrl) {
      throw new AppError('A ChatGPT Project id or URL is required to list its chats.', 400);
    }
    return this.requestDiscovery(`chats:${projectId || projectUrl}`, { projectId, projectUrl }, options);
  }

  private requestDiscovery(
    cacheKey: string,
    target: { projectId?: string; projectUrl?: string } | undefined,
    options: { refresh?: boolean }
  ): Promise<DiscoveryAnswer> {
    const cached = this.discoveryCache.get(cacheKey);
    if (!options.refresh && cached && Date.now() - cached.at <= DISCOVERY_CACHE_MS) {
      return Promise.resolve({ ...cached.answer });
    }
    if (!this.isConnected()) {
      return Promise.resolve({
        status: 'not_connected',
        error: 'Browser Companion is not connected. Pair the extension and open ChatGPT.',
      });
    }

    const kind = target ? 'discover_chats' : 'discover_projects';
    const queued = this.queueTask({
      handoffId: '',
      prompt: '',
      kind,
      projectId: target?.projectId,
      projectUrl: target?.projectUrl,
    });

    return new Promise<DiscoveryAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.discoveryWaiters.delete(queued.id);
        // Late answers for an expired request are simply dropped.
        this.pending = this.pending.filter((task) => task.id !== queued.id);
        resolve({ status: 'timeout', error: 'Discovery timed out. Is a ChatGPT tab open and signed in?' });
      }, DISCOVERY_TIMEOUT_MS);
      this.discoveryWaiters.set(queued.id, { answer: resolve, timer });
    }).then((answer) => {
      // Only successful discovery is cached (failures must stay retryable).
      if (answer.status === 'ok') {
        this.discoveryCache.set(cacheKey, { at: Date.now(), answer: { ...answer } });
      }
      return answer;
    });
  }

  private settleDiscovery(task: CompanionTask, result: CompanionTaskResult): void {
    const waiter = this.discoveryWaiters.get(task.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.discoveryWaiters.delete(task.id);

    if (result.status !== 'OK') {
      waiter.answer({
        status: toDiscoveryStatus(result.status),
        error: result.message ?? discoveryErrorMessage(result.status),
      });
      return;
    }

    // Metadata only: every discovered item is reduced to its identity fields
    // so no unrelated conversation content can ever leave the browser.
    if (task.kind === 'discover_projects') {
      waiter.answer({ status: 'ok', projects: sanitizeProjects(result.projects), error: null });
      return;
    }
    waiter.answer({ status: 'ok', chats: sanitizeChats(result.chats), error: null });
  }
}

// ---- discovery helpers ----------------------------------------------- //

/** Reduce a discovery payload to identity fields only (metadata, never text). */
function sanitizeProjects(projects: unknown): ChatGptProject[] {
  if (!Array.isArray(projects)) return [];
  const out: ChatGptProject[] = [];
  const seen = new Set<string>();
  for (const raw of projects) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    const id = (typeof item.id === 'string' && item.id.trim().length > 0 ? item.id.trim() : '') ||
      chatgptProjectIdFromUrl(url) ||
      '';
    if (id.length === 0 || url.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: typeof item.name === 'string' ? item.name.trim() : '', url });
  }
  return out;
}

/** Reduce a session discovery payload to identity fields only. */
function sanitizeChats(chats: unknown): ChatGptChat[] {
  if (!Array.isArray(chats)) return [];
  const out: ChatGptChat[] = [];
  const seen = new Set<string>();
  for (const raw of chats) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    const id = (typeof item.id === 'string' && item.id.trim().length > 0 ? item.id.trim() : '') ||
      chatgptChatIdFromUrl(url) ||
      '';
    if (id.length === 0 || url.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: typeof item.title === 'string' ? item.title.trim() : '', url });
  }
  return out;
}

function toDiscoveryStatus(status: CompanionTaskFailure): ChatgptDiscoveryStatus {
  switch (status) {
    case 'AUTH_REQUIRED':
      return 'auth_required';
    case 'UI_UNSUPPORTED':
      return 'ui_unsupported';
    case 'NO_TAB':
      return 'no_tab';
    case 'TIMEOUT':
      return 'timeout';
    default:
      return 'error';
  }
}

function discoveryErrorMessage(status: CompanionTaskFailure): string {
  switch (status) {
    case 'AUTH_REQUIRED':
      return 'Open ChatGPT and sign in, then refresh.';
    case 'UI_UNSUPPORTED':
      return 'The ChatGPT page could not be understood (UI changed).';
    case 'NO_TAB':
      return 'Open ChatGPT Web in a browser tab, then refresh.';
    case 'TIMEOUT':
      return 'Discovery timed out. Is a ChatGPT tab open and signed in?';
    case 'PROJECT_NOT_FOUND':
      return 'The selected ChatGPT Project was not found (PROJECT_NOT_FOUND).';
    case 'CHAT_NOT_FOUND':
      return 'The selected chat session was not found (CHAT_NOT_FOUND).';
    default:
      return `Discovery failed (${status}).`;
  }
}
