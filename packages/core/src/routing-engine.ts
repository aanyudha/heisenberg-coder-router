import { existsSync } from 'fs';
import type {
  AppliedRoute,
  CodexStatus,
  OllamaStatus,
  RouteConfig,
  RouteStatus,
  RoutingStatus,
  RoutingVerify,
} from '@heisenberg/contracts';
import { AppError } from '@heisenberg/shared';
import { getOllamaBaseUrl } from '@heisenberg/providers';
import { CodexConfigEngine, HCR_PROVIDER_ID, type CodexConfigState } from './codex-config-engine.js';
import { detectVsCodeCodex } from './vscode-detection.js';

/**
 * Routing Engine - The HCR routing control plane.
 *
 * Desired state (provider/model/project) is persisted in HCR's SQLite and
 * applied to the real Codex configuration (CODEX_HOME/config.toml) so a
 * normal `codex` invocation - from CLI or the VS Code integration, which
 * shares CODEX_HOME - uses the HCR-selected provider+model route.
 *
 * Statuses:
 *   applied        - Codex config matches the desired route
 *   drift          - Codex config differs from the desired route
 *   not_configured - no route applied yet (no usable Codex config)
 *   error          - Codex config unreadable/malformed
 */
export class RoutingEngine {
  private desired: RouteConfig = { provider: 'ollama', model: null, projectDir: null };

  constructor(
    private readonly codexConfig: CodexConfigEngine,
    private readonly getOllamaStatus: () => Promise<OllamaStatus>,
    private readonly getCodexStatus: () => Promise<CodexStatus>
  ) {}

  getDesired(): RouteConfig {
    return { ...this.desired };
  }

  /**
   * Update desired state. Provider and model stay coupled: changing the
   * provider clears the model so no cross-provider state survives.
   */
  setDesired(route: Partial<RouteConfig>): void {
    if (route.provider !== undefined) {
      this.desired.provider = route.provider;
      this.desired.model = null;
    }
    if (route.model !== undefined) {
      // Only meaningful for ollama; openai clears it.
      this.desired.model = this.desired.provider === 'openai' ? null : route.model;
    }
    if (route.projectDir !== undefined) this.desired.projectDir = route.projectDir;
  }

  /**
   * Apply the desired route to Codex config. Provider and model are resolved
   * together BEFORE any write. Ollama requires Ollama online and the model to
   * be a live-discovered Ollama model; OpenAI strips Ollama state.
   */
  async apply(): Promise<RoutingStatus> {
    if (!this.desired.projectDir) {
      throw new AppError('Project directory is required before applying routing', 400);
    }
    if (this.desired.provider === 'ollama') {
      // Validate parameters (400) before probing dependencies (409).
      if (!this.desired.model) {
        throw new AppError('Cannot apply Ollama routing: no model selected.', 400);
      }
      const ollama = await this.getOllamaStatus();
      if (!ollama.online) {
        throw new AppError('Cannot apply Ollama routing: Ollama is offline.', 409);
      }
      const known = ollama.models.some((m) => m.id === this.desired.model);
      if (!known) {
        throw new AppError(
          `Model "${this.desired.model}" is not available for the Ollama provider. Refresh Ollama models first.`,
          400
        );
      }
    }

    this.codexConfig.applyRoute({
      provider: this.desired.provider,
      model: this.desired.model,
    });

    return this.status();
  }

  /**
   * Compare desired vs applied. Read-only.
   */
  status(): RoutingStatus {
    const state = this.codexConfig.readState();
    const applied = toAppliedRoute(state);
    const { status, detail } = this.classify(state);
    return {
      desired: this.getDesired(),
      applied,
      status,
      detail,
      configPath: this.codexConfig.configPath,
      backupPath: existsSync(this.codexConfig.backupPath) ? this.codexConfig.backupPath : undefined,
    };
  }

  /**
   * Deep verification: drift check + environment checks + VS Code Codex
   * detection. Read-only; never writes config.
   */
  async verify(): Promise<RoutingVerify> {
    const codex = await this.getCodexStatus();
    const state = this.codexConfig.readState();
    const applied = toAppliedRoute(state);
    const { status, detail } = this.classify(state);
    const vscode = detectVsCodeCodex();

    const providerMatches =
      applied.provider === this.desired.provider &&
      (this.desired.provider === 'openai' || state.ollamaTablePresent);

    const modelMatches =
      this.desired.provider === 'openai'
        ? applied.model === null
        : applied.model === this.desired.model;

    return {
      status,
      desired: this.getDesired(),
      applied,
      checks: {
        codexInstalled: codex.installed,
        configReadable: state.configExists && state.validToml,
        configValidToml: state.validToml,
        providerMatches,
        modelMatches,
      },
      vscodeCodex: vscode,
      configPath: this.codexConfig.configPath,
    };
  }

  // ------------------------------------------------------------------ //

  private classify(state: CodexConfigState & { validToml: boolean; parseError?: string }): {
    status: RouteStatus;
    detail?: string;
  } {
    if (state.configExists && !state.validToml) {
      return { status: 'error', detail: state.parseError ?? 'Codex config is malformed TOML.' };
    }
    if (!state.configExists) {
      // No config file: Codex uses its built-in default provider (openai).
      if (this.desired.provider === 'openai') {
        return {
          status: 'applied',
          detail: 'Codex uses its default OpenAI provider (no config file needed).',
        };
      }
      return { status: 'not_configured', detail: 'Codex config does not exist yet. Apply routing to create it.' };
    }

    const appliedProvider = mapAppliedProvider(state.providerKey);
    if (appliedProvider === this.desired.provider) {
      if (this.desired.provider === 'ollama' && state.model !== this.desired.model) {
        return {
          status: 'drift',
          detail: `Codex is configured for model "${state.model ?? '(none)'}" but HCR desired "${this.desired.model ?? '(none)'}".`,
        };
      }
      if (this.desired.provider === 'openai' && state.model !== null) {
        return {
          status: 'drift',
          detail: 'OpenAI route expects no model override in Codex config, but a model key is present.',
        };
      }
      return { status: 'applied' };
    }
    return {
      status: 'drift',
      detail: `HCR desired ${this.desired.provider} but Codex config has ${appliedProvider}.`,
    };
  }
}

// -------------------------------------------------------------------- //

function toAppliedRoute(state: CodexConfigState): AppliedRoute {
  return {
    provider: mapAppliedProvider(state.providerKey),
    model: state.model,
  };
}

/** Map the raw config provider id to an HCR provider type. */
function mapAppliedProvider(providerKey: string | null): AppliedRoute['provider'] {
  // Codex falls back to its default provider (openai) when the key is absent.
  if (providerKey === null) return 'openai';
  if (providerKey === HCR_PROVIDER_ID) return 'ollama';
  if (providerKey === 'ollama' || providerKey === 'openai') return providerKey;
  return 'openai';
}

/** Exported for verify payloads: the Ollama base URL honoring OLLAMA_HOST. */
export function ollamaEndpoint(): string {
  return `${getOllamaBaseUrl()}/v1`;
}
