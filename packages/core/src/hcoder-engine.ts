import { randomBytes } from 'crypto';
import type {
  ChatgptDestination,
  ChatgptSessionRef,
  CompanionStatus,
  CompanionTaskResult,
  HcoderAgentMessage,
  HcoderRoute,
  HcoderStatusResponse,
  HcoderTurnRequest,
  HcoderTurnResponse,
  OllamaStatus,
} from '@heisenberg/contracts';
import { HCODER_ROUTE_LABELS, HCODER_VERSION } from '@heisenberg/contracts';
import { AppError } from '@heisenberg/shared';
import { ollamaChatComplete, type OllamaChatMessage } from '@heisenberg/providers';
import type { DatabaseEngine } from './database-engine.js';
import type { BrowserCompanionEngine } from './browser-companion-engine.js';
import { ChatgptDestinationEngine } from './chatgpt-destination-engine.js';
import { HCODER_AGENT_INSTRUCTION, classifyAgentReply } from './hcoder-agent-protocol.js';
import { HCODER_AGENT_LOOP_LIMITS, HCODER_TOOL_LIMITS } from './hcoder-tool-engine.js';

const KEY_ROUTE = 'hcoder_route';

/** How long HCR waits for one intelligence route to answer an agent turn. */
const AGENT_TURN_TIMEOUT_MS = 240_000;

/** HCoder failure with a deterministic, machine-readable code. */
export class HcoderAgentError extends AppError {
  constructor(
    public readonly code: string,
    message: string,
    statusCode = 409
  ) {
    super(message, statusCode);
    this.name = 'HcoderAgentError';
  }
}

/** Status payload HCR composes before adding package/download metadata. */
export type HcoderEngineStatus = Omit<HcoderStatusResponse, 'package' | 'dashboardUrl'>;

export interface HcoderEngineDeps {
  db: DatabaseEngine;
  companion: BrowserCompanionEngine;
  /** Current HCR desired route state (provider/model) - route selection lives in HCR. */
  getRouteState: () => { provider: string; model: string | null };
  getOllamaStatus: () => Promise<OllamaStatus>;
  /** HCR-selected project, used when a caller does not name one. */
  getProjectRoot: () => string | null;
}

/** Human-readable failure text for the deterministic companion codes. */
const COMPANION_ERRORS: Record<string, string> = {
  PROJECT_NOT_FOUND:
    'PROJECT_NOT_FOUND: the selected ChatGPT Project could not be found. Refresh Projects in the Web Handoff page and select a current one.',
  CHAT_NOT_FOUND:
    'CHAT_NOT_FOUND: the selected chat session could not be found in that ChatGPT Project. Refresh Sessions and select a current one.',
  UI_UNSUPPORTED: 'UI_UNSUPPORTED: the ChatGPT page could not be understood (ChatGPT UI changed).',
  NO_TAB: 'NO_TAB: open ChatGPT Web in a browser tab, then retry.',
  AUTH_REQUIRED: 'AUTH_REQUIRED: open ChatGPT and sign in, then retry.',
  TIMEOUT: 'TIMEOUT: the intelligence route did not answer in time.',
};

const KNOWN_ROUTES: readonly HcoderRoute[] = ['companion', 'ollama'];

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function sessionRefFromDestination(destination: ChatgptDestination | null): ChatgptSessionRef | null {
  if (!destination) return null;
  return {
    chatgptProjectId: destination.chatgptProjectId || null,
    chatgptProjectName: destination.chatgptProjectName || null,
    chatgptProjectUrl: destination.chatgptProjectUrl || null,
    chatId: destination.chatId ?? '',
    chatTitle: destination.chatTitle ?? '',
    chatUrl: destination.chatUrl ?? '',
    chatMode: destination.chatMode,
  };
}

interface TurnWaiter {
  resolve: (result: CompanionTaskResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * HCoder Engine - HCR's provider-neutral agent-turn service.
 *
 * HCoder (the local CLI) never talks to a provider: it submits agent turns to
 * HCR, and HCR decides which intelligence route answers them - Browser
 * Companion -> ChatGPT Web, Ollama -> a selected local model, or a future
 * HOrchestrator. Transport details stay inside this engine; the HCoder agent
 * protocol (HCODER_AGENT_V1 / HCODER_TOOL_RESULT_V1 / HCR_PATCH_V1) is
 * identical on every route.
 *
 * Rules encoded here:
 *  - no silent provider fallback: an incapable or unavailable route fails
 *    with a deterministic code (AGENT_PROTOCOL_UNSUPPORTED / ROUTE_UNAVAILABLE)
 *  - session continuity: companion turns reuse the SAME ChatGPT Project +
 *    chat session (created once, then reused); Ollama turns carry the full
 *    local conversation on every request
 *  - the AI never touches the filesystem: tool execution and patch staging
 *    live in HCoder, and HCR_PATCH_V1 remains the only write protocol
 */
export class HcoderEngine {
  private readonly destinations: ChatgptDestinationEngine;
  private readonly waiters = new Map<string, TurnWaiter>();

  constructor(private readonly deps: HcoderEngineDeps) {
    this.destinations = new ChatgptDestinationEngine(deps.db);
    deps.companion.setAgentResultHandler((_sessionId, taskId, result) => {
      const waiter = this.waiters.get(taskId);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.waiters.delete(taskId);
      waiter.resolve(result);
    });
  }

  // ---- route selection (HCR decides, never the CLI) ---------------- //

  /** Active HCoder route: explicit choice, else derived from HCR state. */
  currentRoute(): HcoderRoute {
    const stored = this.deps.db.getSetting(KEY_ROUTE);
    if (stored && !(KNOWN_ROUTES as readonly string[]).includes(stored)) {
      // A route HCR does not know (e.g. a future provider) must never fall
      // back to another one - turns will fail with a capability error.
      return stored as HcoderRoute;
    }
    if (stored === 'companion' || stored === 'ollama') return stored;
    if (this.deps.companion.paired()) return 'companion';
    const state = this.deps.getRouteState();
    if (state.provider === 'ollama' && state.model) return 'ollama';
    return 'companion';
  }

  /** Explicit route selection (persisted in HCR SQLite). */
  setRoute(route: string): HcoderRoute {
    const normalized = route.trim();
    if (!(KNOWN_ROUTES as readonly string[]).includes(normalized)) {
      throw new HcoderAgentError(
        'AGENT_PROTOCOL_UNSUPPORTED',
        `Route "${normalized}" does not support the HCoder agent protocol yet. Supported routes: ${KNOWN_ROUTES.join(', ')}.`,
        501
      );
    }
    this.deps.db.setSetting(KEY_ROUTE, normalized);
    return normalized as HcoderRoute;
  }

  // ---- agent turns -------------------------------------------------- //

  async turn(request: HcoderTurnRequest): Promise<HcoderTurnResponse> {
    const projectRoot = typeof request.projectRoot === 'string' ? request.projectRoot.trim() : '';
    if (projectRoot.length === 0) {
      throw new HcoderAgentError('SESSION_NOT_FOUND', 'projectRoot is required for an agent turn.', 400);
    }
    const messages = this.validateMessages(request.messages);
    const sessionId =
      typeof request.sessionId === 'string' && request.sessionId.trim().length > 0
        ? request.sessionId.trim()
        : randomBytes(8).toString('hex');

    const route = this.currentRoute();
    const state = this.deps.getRouteState();

    let raw: string;
    let destination: ChatgptSessionRef | null = null;
    let provider: string;
    let model: string | null = null;

    if (route === 'companion') {
      provider = 'chatgpt-web';
      const viaCompanion = await this.turnViaCompanion(sessionId, projectRoot, messages);
      raw = viaCompanion.raw;
      destination = viaCompanion.destination ?? sessionRefFromDestination(this.destinationFor(projectRoot));
    } else if (route === 'ollama') {
      provider = 'ollama';
      model = state.model;
      raw = await this.turnViaOllama(projectRoot, messages, state, model);
    } else {
      throw new HcoderAgentError(
        'AGENT_PROTOCOL_UNSUPPORTED',
        `Route "${route}" does not support the HCoder agent protocol. HCR will not fall back to another provider - select a supported route.`,
        501
      );
    }

    return {
      sessionId,
      route,
      provider,
      model,
      destination,
      reply: classifyAgentReply(raw),
    };
  }

  /** Last-used ChatGPT Project/session for one local project (or null). */
  destinationFor(projectRoot: string): ChatgptDestination | null {
    return this.destinations.get(projectRoot);
  }

  // ---- status ------------------------------------------------------- //

  describe(projectRoot?: string | null): HcoderEngineStatus {
    const route = this.currentRoute();
    const state = this.deps.getRouteState();
    const root = projectRoot?.trim() || this.deps.getProjectRoot();
    const destination = route === 'companion' && root ? this.destinationFor(root) : null;

    return {
      version: HCODER_VERSION,
      route,
      routeLabel: HCODER_ROUTE_LABELS[route] ?? route,
      provider: route === 'companion' ? 'chatgpt-web' : route === 'ollama' ? 'ollama' : route,
      model: route === 'ollama' ? state.model : null,
      destination: sessionRefFromDestination(destination),
      companion: this.deps.companion.status(),
      online: true,
      capabilities: {
        readFile: true,
        listDirectory: true,
        searchFiles: true,
        searchText: true,
        patchApply: true,
        rollback: true,
        shell: false,
      },
      limits: {
        maxRounds: HCODER_AGENT_LOOP_LIMITS.maxRounds,
        maxToolRequestsPerRound: HCODER_AGENT_LOOP_LIMITS.maxToolRequestsPerRound,
        maxBytesPerFile: HCODER_TOOL_LIMITS.maxBytesPerFile,
        maxResultBytesPerRound: HCODER_TOOL_LIMITS.maxResultBytesPerRound,
        maxTotalToolResultBytes: HCODER_TOOL_LIMITS.maxTotalToolResultBytes,
        maxSearchResults: HCODER_TOOL_LIMITS.maxSearchResults,
      },
    };
  }

  companionStatus(): CompanionStatus {
    return this.deps.companion.status();
  }

  // ------------------------------------------------------------------ //
  // Routes (transport stays here; the agent protocol never changes)     //
  // ------------------------------------------------------------------ //

  private async turnViaCompanion(
    sessionId: string,
    projectRoot: string,
    messages: HcoderAgentMessage[]
  ): Promise<{ raw: string; destination: ChatgptSessionRef | null }> {
    const companion = this.deps.companion;
    if (!companion.paired()) {
      throw new HcoderAgentError(
        'ROUTE_UNAVAILABLE',
        'Browser Companion is not paired with HCR. Pair the extension (Browser Companion page) or switch the HCoder route to Ollama.',
        503
      );
    }
    if (!companion.isConnected()) {
      throw new HcoderAgentError(
        'ROUTE_UNAVAILABLE',
        'Browser Companion is not connected. Open the extension and ChatGPT Web, or switch the HCoder route to Ollama.',
        503
      );
    }

    // Session continuity: reuse the saved ChatGPT Project/session. A saved
    // chat always wins and is targeted in "continue" mode, so no tool round
    // ever creates a new chat. "create" mode runs exactly once: the created
    // session is captured and becomes the continued session from then on.
    const saved = this.destinationFor(projectRoot);
    const destination = saved
      ? saved.chatId || saved.chatUrl
        ? { ...saved, chatMode: 'continue' as const }
        : saved
      : null;

    const prompt = buildCompanionPrompt(messages, projectRoot);
    const task = companion.queueTask({
      handoffId: sessionId,
      prompt,
      destination,
      kind: 'agent',
    });

    const result = await this.awaitAgentTask(task.id);
    if (result.status !== 'OK') {
      const message =
        result.status === 'ERROR'
          ? (result.message ?? 'Browser companion reported an error.')
          : (COMPANION_ERRORS[result.status] ?? `Browser companion reported ${result.status}.`);
      throw new HcoderAgentError(result.status, message, 409);
    }

    const session = result.session ?? null;

    // Remember the session actually used (create-once, then reuse).
    if (saved || session) {
      const base: ChatgptDestination =
        saved ??
        ({
          chatgptProjectId: session?.chatgptProjectId ?? '',
          chatgptProjectName: session?.chatgptProjectName ?? '',
          chatgptProjectUrl: session?.chatgptProjectUrl ?? '',
          chatId: null,
          chatTitle: null,
          chatUrl: null,
          chatMode: 'continue',
        } satisfies ChatgptDestination);
      if (base.chatgptProjectId || base.chatgptProjectUrl) {
        const hasChat = Boolean(session?.chatId || session?.chatUrl);
        this.destinations.save(projectRoot, {
          ...base,
          chatId: session?.chatId ?? base.chatId,
          chatTitle: session?.chatTitle ?? base.chatTitle,
          chatUrl: session?.chatUrl ?? base.chatUrl,
          chatMode: hasChat ? 'continue' : base.chatMode,
        });
      }
    }

    return { raw: result.responseText ?? '', destination: session };
  }

  private awaitAgentTask(taskId: string): Promise<CompanionTaskResult> {
    return new Promise<CompanionTaskResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(taskId);
        reject(
          new HcoderAgentError(
            'TIMEOUT',
            `TIMEOUT: the intelligence route did not answer within ${Math.round(AGENT_TURN_TIMEOUT_MS / 1000)}s.`,
            504
          )
        );
      }, AGENT_TURN_TIMEOUT_MS);
      this.waiters.set(taskId, { resolve, timer });
    });
  }

  private async turnViaOllama(
    projectRoot: string,
    messages: HcoderAgentMessage[],
    state: { provider: string; model: string | null },
    model: string | null
  ): Promise<string> {
    if (state.provider !== 'ollama' || !model) {
      throw new HcoderAgentError(
        'ROUTE_UNAVAILABLE',
        'ROUTE_UNAVAILABLE: the HCoder route is Ollama, but HCR has no Ollama model selected. Apply an Ollama route first. HCR will not fall back to another provider.',
        503
      );
    }
    const status = await this.deps.getOllamaStatus();
    if (!status.online) {
      throw new HcoderAgentError(
        'ROUTE_UNAVAILABLE',
        'ROUTE_UNAVAILABLE: Ollama is offline. Start Ollama or switch the HCoder route to the Browser Companion. HCR will not fall back to another provider.',
        503
      );
    }

    const chat: OllamaChatMessage[] = [
      { role: 'system', content: `${HCODER_AGENT_INSTRUCTION}\n\nProject root: ${projectRoot}` },
    ];
    for (const message of messages) {
      if (message.role === 'assistant') {
        chat.push({ role: 'assistant', content: message.content });
      } else if (message.role === 'tool') {
        chat.push({ role: 'user', content: `HCODER_TOOL_RESULT_V1:\n${message.content}` });
      } else {
        chat.push({ role: 'user', content: message.content });
      }
    }

    try {
      return await ollamaChatComplete(model, chat);
    } catch (error) {
      throw new HcoderAgentError(
        'ROUTE_UNAVAILABLE',
        `ROUTE_UNAVAILABLE: ${error instanceof Error ? error.message : 'Ollama request failed.'}`,
        503
      );
    }
  }

  // ------------------------------------------------------------------ //

  private validateMessages(messages: unknown): HcoderAgentMessage[] {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new HcoderAgentError('SESSION_NOT_FOUND', 'messages must be a non-empty array.', 400);
    }
    const normalized: HcoderAgentMessage[] = [];
    for (const [index, message] of messages.entries()) {
      if (!message || typeof message !== 'object') {
        throw new HcoderAgentError('SESSION_NOT_FOUND', `messages[${index}] must be an object.`, 400);
      }
      const role = (message as { role?: unknown }).role;
      const content = (message as { content?: unknown }).content;
      if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
        throw new HcoderAgentError('SESSION_NOT_FOUND', `messages[${index}].role must be user|assistant|tool.`, 400);
      }
      if (typeof content !== 'string') {
        throw new HcoderAgentError('SESSION_NOT_FOUND', `messages[${index}].content must be a string.`, 400);
      }
      normalized.push({ role, content });
    }
    return normalized;
  }
}

/**
 * Prompt delivered through the Browser Companion.
 *
 * The ChatGPT chat itself carries the conversation (same Project + same
 * session for every round), so only the contract, the original task and the
 * newest message are sent - never the whole transcript on every round.
 */
export function buildCompanionPrompt(messages: HcoderAgentMessage[], projectRoot: string): string {
  const firstUser = messages.find((message) => message.role === 'user');
  const task = firstUser?.content ?? '';
  const latest = messages[messages.length - 1];

  if (messages.length <= 1) {
    return `${HCODER_AGENT_INSTRUCTION}\n\nProject root: ${projectRoot}\n\nTask:\n${task}`;
  }
  return [
    HCODER_AGENT_INSTRUCTION,
    '',
    `HCoder agent turn - continuing in this chat. Project root: ${projectRoot}`,
    '',
    `Original task:`,
    truncate(task, 4000),
    '',
    `Latest message (${latest.role}):`,
    truncate(latest.content, 120_000),
  ].join('\n');
}
