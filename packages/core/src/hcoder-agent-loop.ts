import type { HcoderAgentMessage, HcoderToolResultEntry, HcrPatchV1 } from '@heisenberg/contracts';
import { HCODER_AGENT_LOOP_LIMITS, HcoderToolEngine, HCODER_TOOL_LIMITS } from './hcoder-tool-engine.js';
import { classifyAgentReply, loopLimitMessage } from './hcoder-agent-protocol.js';

/** Provider-neutral transport: one agent turn through HCR (any route). */
export interface AgentLoopTransport {
  submit(messages: HcoderAgentMessage[]): Promise<string>;
}

export type AgentLoopEvent =
  | { type: 'round'; round: number }
  | { type: 'tools'; round: number; requests: number; results: HcoderToolResultEntry[] }
  | { type: 'patch'; round: number; summary: string };

export type AgentLoopResult =
  | { kind: 'patch'; patch: HcrPatchV1; raw: string; rounds: number }
  | { kind: 'text'; text: string; raw: string; rounds: number }
  | { kind: 'error'; code: string; message: string; rounds: number; errors?: string[] };

export interface AgentLoopOptions {
  transport: AgentLoopTransport;
  tools: HcoderToolEngine;
  limits?: { maxRounds: number; maxToolRequestsPerRound: number };
  onEvent?: (event: AgentLoopEvent) => void;
}

/**
 * HCoder Agent Loop - a real, bounded execution loop.
 *
 * user task -> HCR (route-selected intelligence) -> HCODER_AGENT_V1 ->
 * safe local tools -> HCODER_TOOL_RESULT_V1 -> HCR -> ... -> HCR_PATCH_V1.
 *
 * The loop NEVER applies a patch, NEVER runs a shell command and NEVER runs
 * indefinitely: it stops on the first patch/prose answer, on an invalid
 * contract, or when the round / request / byte budgets are exhausted.
 */
export class HcoderAgentLoop {
  private readonly transport: AgentLoopTransport;
  private readonly tools: HcoderToolEngine;
  private readonly limits: { maxRounds: number; maxToolRequestsPerRound: number };
  private readonly onEvent?: (event: AgentLoopEvent) => void;

  constructor(options: AgentLoopOptions) {
    this.transport = options.transport;
    this.tools = options.tools;
    this.limits = options.limits ?? HCODER_AGENT_LOOP_LIMITS;
    this.onEvent = options.onEvent;
  }

  async run(task: string): Promise<AgentLoopResult> {
    const messages: HcoderAgentMessage[] = [{ role: 'user', content: task }];
    let rounds = 0;

    for (let round = 1; round <= this.limits.maxRounds; round++) {
      rounds = round;
      this.emit({ type: 'round', round });

      let raw: string;
      try {
        raw = await this.transport.submit(messages);
      } catch (error) {
        const candidate = error as { code?: unknown; message?: unknown };
        const code = typeof candidate.code === 'string' && candidate.code.length > 0 ? candidate.code : 'HCR_UNAVAILABLE';
        const message = error instanceof Error ? error.message : 'Agent turn failed.';
        return { kind: 'error', code, message, rounds };
      }

      messages.push({ role: 'assistant', content: raw });
      const classified = classifyAgentReply(raw);

      if (classified.kind === 'patch' && classified.patch) {
        this.emit({ type: 'patch', round, summary: classified.patch.summary });
        return { kind: 'patch', patch: classified.patch, raw, rounds };
      }
      if (classified.kind === 'text') {
        return { kind: 'text', text: classified.text ?? raw.trim(), raw, rounds };
      }
      if (classified.kind === 'invalid') {
        return {
          kind: 'error',
          code: 'INVALID_AGENT_RESPONSE',
          message: (classified.errors ?? ['Malformed structured response.']).join(' '),
          rounds,
          errors: classified.errors,
        };
      }

      const agent = classified.agent;
      if (!agent) {
        return { kind: 'error', code: 'INVALID_AGENT_RESPONSE', message: 'Malformed structured response.', rounds };
      }
      if (agent.requests.length > this.limits.maxToolRequestsPerRound) {
        return {
          kind: 'error',
          code: 'AGENT_LOOP_LIMIT_REACHED',
          message: `Agent requested ${agent.requests.length} tools in one round (limit ${this.limits.maxToolRequestsPerRound}).`,
          rounds,
        };
      }

      const results = await this.tools.executeAll(agent.requests);
      this.emit({ type: 'tools', round, requests: agent.requests.length, results });
      messages.push({ role: 'tool', content: JSON.stringify(HcoderToolEngine.buildResult(results)) });

      if (this.tools.bytesUsed() >= HCODER_TOOL_LIMITS.maxTotalToolResultBytes) {
        return {
          kind: 'error',
          code: 'RESULT_TOO_LARGE',
          message: `Total tool-result budget exhausted (${HCODER_TOOL_LIMITS.maxTotalToolResultBytes} bytes).`,
          rounds,
        };
      }
    }

    return {
      kind: 'error',
      code: 'AGENT_LOOP_LIMIT_REACHED',
      message: loopLimitMessage(rounds, this.limits.maxRounds),
      rounds,
    };
  }

  private emit(event: AgentLoopEvent): void {
    this.onEvent?.(event);
  }
}
