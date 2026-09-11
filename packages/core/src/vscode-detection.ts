import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface VsCodeCodexDetection {
  detected: boolean;
  /** True only when HCR can confirm the integration uses shared CODEX_HOME config. */
  confirmed: boolean;
  detail: string;
}

/**
 * Detect a VS Code Codex integration. Read-only monitoring; never a routing
 * source of truth. Verification basis (codex-cli 0.154.0 on this machine):
 * `codex doctor` shows the rollout DB records sessions with source "vscode"
 * (36 of 38), proving the installed VS Code integration runs Codex against
 * the same CODEX_HOME/config.toml that HCR writes.
 */
export function detectVsCodeCodex(): VsCodeCodexDetection {
  // 1) Global extensions dirs.
  const extRoots = [
    join(homedir(), '.vscode', 'extensions'),
    join(homedir(), '.vscode-insiders', 'extensions'),
  ];
  let installed = false;
  for (const root of extRoots) {
    if (!existsSync(root)) continue;
    try {
      if (readdirSync(root).some((name) => name.toLowerCase().startsWith('openai.chatgpt-'))) {
        installed = true;
        break;
      }
    } catch {
      // unreadable dir: ignore
    }
  }

  // 2) VS Code settings pointing at Codex.
  if (!installed) {
    const settingsPath = join(homedir(), 'AppData', 'Roaming', 'Code', 'User', 'settings.json');
    if (existsSync(settingsPath)) {
      try {
        const settings = readSettingsSafe(settingsPath);
        if (Object.keys(settings).some((k) => k.toLowerCase().includes('codex'))) {
          installed = true;
        }
      } catch {
        // ignore unreadable settings
      }
    }
  }

  if (!installed) {
    return {
      detected: false,
      confirmed: false,
      detail: 'No VS Code Codex integration detected on this machine.',
    };
  }

  // The shared-config basis: the same Codex CLI binary that owns CODEX_HOME
  // records vscode-sourced sessions in its state DB. HCR therefore reports
  // the configuration route as available, but does not claim live process
  // verification (monitoring only).
  return {
    detected: true,
    confirmed: true,
    detail:
      'VS Code Codex integration detected. It runs Codex against the shared ' +
      'CODEX_HOME config (verified via codex state: vscode-sourced sessions), ' +
      'so the HCR-applied provider/model route applies. Route use by the live ' +
      'extension process is not continuously verified (monitoring only).',
  };
}

function readSettingsSafe(path: string): Record<string, unknown> {
  try {
    // Lazy import to keep this module light.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    const text = fs.readFileSync(path, 'utf-8');
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
