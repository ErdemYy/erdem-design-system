/**
 * Public library API of project-intel. The CLI (bin/project-intel.mjs) is a thin layer over these.
 * Everything is offline, deterministic and dependency-free (Node standard library only).
 */
export { TOOL, SCHEMA, HASH_ALGO } from './lib/constants.mjs';
export { loadConfig, DEFAULTS, DEFAULT_IGNORES, ConfigError } from './lib/config.mjs';
export { scanProject } from './lib/scan.mjs';
export { hashContent, setFingerprint } from './lib/fingerprint.mjs';
export { listAdapters } from './lib/languages/registry.mjs';
export { buildGraph } from './graph/build.mjs';
export { buildView } from './graph/views.mjs';
export { renderMermaid } from './graph/render-mermaid.mjs';
export { renderDot } from './graph/render-dot.mjs';
export { createGraphQuery } from './analyze/query.mjs';
export { generateIndex } from './index/generate.mjs';
export { checkStatus } from './index/status.mjs';
export { runIndex, runGraph, runStatus, runImpact, buildProjectGraph } from './lib/pipeline.mjs';
export { validate as validateJson } from './lib/jsonschema.mjs';
export { shouldAutoRefresh, relevantArtifacts, mayWrite, RELIANCE } from './automation/refresh-decision.mjs';
export { autoRefresh, classifyState, trackedUnder, declaredProfile, actionRecord } from './automation/refresh.mjs';
export { planValidation, effectiveDepth } from './automation/validation-plan.mjs';
export { runValidationPlan, applyValidationToTaskState } from './automation/validation-runner.mjs';
export { discoverCommands } from './automation/validation-discovery.mjs';
export { classifyText, classifyArgv } from './automation/validation-classify.mjs';
export { updateTaskState, handoffDecision, validationRecord } from './automation/validation-state.mjs';
