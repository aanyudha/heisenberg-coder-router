export { OllamaEngine } from './ollama-engine.js';
export { CodexEngine } from './codex-engine.js';
export { ProviderEngine } from './provider-engine.js';
export { ProjectEngine } from './project-engine.js';
export { ModelEngine } from './model-engine.js';
export { DatabaseEngine } from './database-engine.js';
export type { WebHandoffRow, WebHandoffRecord } from './database-engine.js';
export { CodexConfigEngine } from './codex-config-engine.js';
export { RoutingEngine, ollamaEndpoint } from './routing-engine.js';
export { detectVsCodeCodex } from './vscode-detection.js';
export { TelemetryEngine } from './telemetry-engine.js';
export { GatewayEngine, type ObservedUsage } from './gateway-engine.js';

// Web Handoff feature set
export {
  parseHcrPatch,
  validatePatch,
  extractJsonCandidate,
  CORRECTION_PROMPT,
  PATCH_LIMITS,
} from './patch-schema.js';
export type { PatchParseResult } from './patch-schema.js';
export {
  PatchValidationEngine,
  DEFAULT_PROTECTED_PATTERNS,
  isInside,
} from './patch-validation-engine.js';
export type {
  PathValidationResult,
  PatchPathIssue,
  PatchPathValidation,
} from './patch-validation-engine.js';
export { ProjectContextEngine, CONTEXT_LIMITS, IGNORED_DIRECTORIES } from './project-context-engine.js';
export type { ProjectContext, ContextOptions } from './project-context-engine.js';
export { WorkspaceApplyEngine } from './workspace-apply-engine.js';
export type { ApplyOutcome, ApplyFileResult, ApplyFileStatus } from './workspace-apply-engine.js';
export { diffLines, toUnifiedDiff } from './diff-engine.js';
export type { DiffLine, FileDiff } from './diff-engine.js';
export { BrowserCompanionEngine } from './browser-companion-engine.js';
export type { CompanionTask, CompanionResultHandler } from './browser-companion-engine.js';
export { WebHandoffEngine, buildHandoffPrompt } from './web-handoff-engine.js';
export type { WebHandoffDetail, ReviewFile } from './web-handoff-engine.js';
