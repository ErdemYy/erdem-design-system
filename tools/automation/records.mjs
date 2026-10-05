/**
 * Pure helpers shared by the automation modules (refresh and context routing): the session state of an engine status
 * result and the Phase 5A action record. No file access, no process, no engine: importing this module can have no effect
 * beyond defining functions, which is what lets the context router stay structurally read-only.
 */

/**
 * Session state from an engine status result (adapters/GENERIC.md section 3). First match wins:
 * stale, then missing (every artifact missing), then partial, then unverifiable, then current.
 * Unavailable is decided by the caller when status could not run.
 */
export function classifyState(status) {
  const c = status?.counts;
  if (!c || !Array.isArray(status.artifacts)) return 'unavailable';
  if (c.STALE > 0) return 'stale';
  if (c.MISSING > 0 && c.CURRENT === 0 && c.UNVERIFIABLE === 0) return 'missing';
  if (c.MISSING > 0) return 'partial';
  if (c.UNVERIFIABLE > 0) return 'unverifiable';
  return 'current';
}

/** Compact action record, Phase 5A format. No file contents, no secrets, project-relative paths only. */
export function actionRecord({ event, action, reason, level, result, detail, now = new Date() }) {
  return { v: 1, event: event ?? 'INTELLIGENCE_CHECKED', action, reason, scope: 'project', level, result, detail: detail ?? {}, at: now.toISOString().replace(/\.\d+Z$/, 'Z') };
}
