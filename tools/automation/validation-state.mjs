/**
 * What a validation result means for the task's own state artifacts (ai/AUTOMATION_PROTOCOL.md → TASK_STATE, HANDOFF, Observability).
 * Pure text transformations: no file access, no process, no network. There is no second state store: the only place a result is
 * recorded is ONE owned block inside `## Last validation` of the existing TASK_STATE.md, and the handoff when a handoff trigger holds.
 *
 * The owned block is delimited by two comment markers. Only what is between them is ever written or replaced; every other byte of
 * the file (user text, numbering, indentation, other sections, the line endings the file already uses) is left exactly as it was,
 * except the `updatedAt` value when something changed.
 *
 * Canonical rules applied here (and no others):
 *   - TASK_STATE.md is updated when validation COMPLETES (lastValidation, always), never per edit and never per step;
 *     a LARGE or ARCHITECTURAL task also records its validation plan (Task-class rules).
 *   - only the current owner writes it; an update with identical content is skipped.
 *   - a handoff is required only when work changes hands or cannot continue: a finished task or a passing TRIVIAL/SMALL one needs none.
 *   - the record is the Phase 5A action record; command output never enters state.
 */
import { actionRecord } from './records.mjs';

const WORDS = { PASS: 'passed', FAIL: 'failed', NOT_RUN: 'not run', DECLINED: 'not run, declined', BLOCKED: 'not run, blocked', UNKNOWN: 'unknown' };
const RISK_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const CLASS_RANK = { TRIVIAL: 0, SMALL: 1, MEDIUM: 2, LARGE: 3, ARCHITECTURAL: 4 };
export const STATE_FILE = 'TASK_STATE.md';
export const OWNED_BEGIN = '<!-- erdem:validation:begin (generated; only this block is rewritten) -->';
export const OWNED_END = '<!-- erdem:validation:end -->';
const BLOCK_RE = /<!-- erdem:validation:begin[^\r\n]*?-->[\s\S]*?<!-- erdem:validation:end -->/;

const one = (s, n = 100) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

/** The lines of the owned block for a completed validation: a header that carries the plan and content keys (for "not repeated for unchanged content"), one line per action, and what is open. */
export function lastValidationLines(result, { contentKey = null } = {}) {
  const head = `- ${result.depth} plan ${one(result.planId, 8)}${contentKey ? ` content ${one(contentKey, 8)}` : ''}: ${WORDS[result.status] ?? result.status}`;
  const lines = [head];
  for (const a of result.actions ?? []) lines.push(`- ${one(a.id)}: ${WORDS[a.status] ?? a.status}${a.reason ? ` (${one(a.reason)})` : ''}`);
  const open = (result.actions ?? []).filter((a) => a.status !== 'PASS');
  if (result.status !== 'PASS' && result.required !== false && open.length) lines.push(`- open: ${open.map((a) => `${one(a.id)} ${WORDS[a.status] ?? a.status}`).join('; ')}`);
  const failed = (result.actions ?? []).filter((a) => a.status === 'FAIL').map((a) => one(a.id));
  if (failed.length) lines.push(`- problem: failed: ${failed.join(', ')}`);
  const blocked = (result.actions ?? []).filter((a) => a.status === 'BLOCKED').map((a) => one(a.id));
  if (blocked.length) lines.push(`- problem: blocked: ${blocked.join(', ')}`);
  return lines;
}

/** The key a previous result carries: { depth, planId (8), contentKey (8 or null), status }, or null. Read from the owned block when there is one. */
export function parseLastValidation(stateText) {
  const text = String(stateText ?? '');
  const block = BLOCK_RE.exec(text);
  const scope = block ? block[0] : text;
  const m = scope.match(/^- (V[0-4]) plan ([0-9a-f]{1,8})(?: content ([0-9a-f]{1,8}))?: ([a-z ,()]+?)\s*$/m);
  if (!m) return null;
  const status = Object.entries(WORDS).find(([, w]) => w === m[4].trim())?.[0] ?? null;
  return { depth: m[1], planId: m[2], contentKey: m[3] ?? null, status };
}

const eolOf = (text) => {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
};

/** Put the owned block into the text: replace the existing block, else add it at the end of `## Last validation` (or the end of the file). Nothing else changes. */
function applyBlock(text, lines, eol) {
  const block = [OWNED_BEGIN, ...lines, OWNED_END].join(eol);
  if (BLOCK_RE.test(text)) return text.replace(BLOCK_RE, () => block);
  const m = /^## Last validation[ \t]*\r?\n/m.exec(text);
  if (!m) return `${text}${text.endsWith('\n') || !text ? '' : eol}${eol}## Last validation${eol}${block}${eol}`;
  const start = m.index + m[0].length;
  const next = text.slice(start).search(/^## /m);
  const end = next < 0 ? text.length : start + next;
  const body = text.slice(start, end);
  const trimmed = body.replace(/[\r\n]*$/, '');
  const tail = body.slice(trimmed.length);
  return `${text.slice(0, start)}${trimmed}${trimmed ? eol : ''}${block}${tail || eol}${text.slice(end)}`;
}

const SKELETON = (goal) => `---\nupdatedAt: <set>\nowner: <set>\n---\n# Task State\n\n## Goal\n${goal}\n\n## Status\nin-progress\n\n## Class and risk\nClass: <set>\nRisk: <set>\nReclassified: no\n\n## Completed\n\n## Changed files\n\n## Remaining\n\n## Known problems\n\n## Open decisions\n\n## Blocked\n\n## Relevant files\n\n## Last validation\n`;

/**
 * Creation triggers of ai/AUTOMATION_PROTOCOL.md → TASK_STATE: class MEDIUM or larger, risk MEDIUM or higher, the task spans
 * sessions, the task is paused or blocked, or a handoff is about to be written.
 */
export function stateRequired({ taskClass = null, risk = 'LOW', spansSessions = false, blocked = false, handoffAhead = false } = {}) {
  return (CLASS_RANK[taskClass] ?? -1) >= CLASS_RANK.MEDIUM || (RISK_RANK[risk] ?? 0) >= RISK_RANK.MEDIUM || spansSessions || blocked || handoffAhead;
}

/**
 * The TASK_STATE.md text after a validation event. Only the owned block (and the `updatedAt` value) can differ from the input.
 * @param {string|null} text   the current file, or null when there is none
 * @param {object} result      the validation result (validation-runner.mjs) or, for phase "planned", the plan
 * @param {object} ctx         { phase: 'completed'|'planned', owner, now, taskClass, risk, contentKey, goal, spansSessions }
 * @returns {{text: string|null, changed: boolean, created: boolean, skipped: string|null, refused: string|null}}
 */
export function updateTaskState(text, result, ctx = {}) {
  const phase = ctx.phase === 'planned' ? 'planned' : 'completed';
  const now = (ctx.now ?? new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  const out = (o) => ({ text: null, changed: false, created: false, skipped: null, refused: null, ...o });
  if (phase === 'planned' && !((CLASS_RANK[ctx.taskClass] ?? -1) >= CLASS_RANK.LARGE)) return out({ text, skipped: 'plan-is-recorded-only-for-large-or-architectural' });
  if (phase === 'completed' && result.reused && text) return out({ text, skipped: 'identical' }); // an earlier result for unchanged content is already recorded
  let base = text;
  let created = false;
  if (base === null || base === undefined) {
    if (!stateRequired({ taskClass: ctx.taskClass, risk: ctx.risk, spansSessions: ctx.spansSessions, blocked: result.status === 'BLOCKED', handoffAhead: !!ctx.handoffAhead })) return out({ skipped: 'state-not-required' });
    base = SKELETON(one(ctx.goal ?? '(not stated)', 200)).replace('owner: <set>', `owner: ${one(ctx.owner ?? 'unknown', 60)}`).replace('Class: <set>', `Class: ${ctx.taskClass ?? 'unclassified'}`).replace('Risk: <set>', `Risk: ${ctx.risk ?? 'LOW'}`);
    created = true;
  } else {
    const owner = (base.match(/^owner:[ \t]*(.*)$/m) ?? [])[1]?.trim();
    const status = (base.match(/^## Status[ \t]*\r?\n\s*([^\r\n]*)/m) ?? [])[1]?.trim();
    if (!ctx.owner) return out({ refused: 'owner-unknown', text: base });
    if (owner && owner !== ctx.owner && (status === 'in-progress' || status === 'blocked')) return out({ refused: 'not-owner', text: base });
  }
  const eol = eolOf(base);
  const lines = phase === 'completed'
    ? lastValidationLines(result, { contentKey: ctx.contentKey })
    : [`- ${result.depth} plan ${one(result.planId, 8)} planned (${(result.actions ?? []).map((a) => one(a.id)).join(', ') || 'no action'}): ${result.confirmationRequired?.length ? 'awaiting confirmation' : 'ready'}`];
  let next = applyBlock(base, lines, eol);
  const strip = (t) => t.replace(/^updatedAt:.*$/m, '');
  if (!created && strip(next) === strip(base)) return out({ text: base, skipped: 'identical' });
  next = next.replace(/^(updatedAt:[ \t]*).*$/m, (_, k) => `${k}${now}`);
  return out({ text: next, changed: true, created });
}

/**
 * Whether a handoff is required (HANDOFF_REQUIRED, ai/AUTOMATION_PROTOCOL.md → HANDOFF). It is decided, not written: the order is
 * TASK_STATE.md first, then one new HANDOFF.md, never edited, never duplicated.
 *
 * Triggers (and no others): the session is ending or cannot continue with the task unfinished and validation not passed; ownership
 * is being transferred; validation is BLOCKED (a boundary only a person can resolve) and the task is unfinished; an A2 cannot be
 * asked about and work remains. A declined or unknown validation in a session that continues is recorded in TASK_STATE.md, which
 * is sufficient: a pause within a continuing session needs no new handoff.
 */
export function handoffDecision({ result, taskClass = null, taskStatus = 'in-progress', sessionEnding = false, ownershipTransfer = false, interactive = true, latestHandoffMatches = false, readOnly = false } = {}) {
  const none = (reason) => ({ required: false, reason, triggers: [] });
  if (readOnly) return none('read-only task');
  if (!result) return none('no validation result');
  if (taskStatus === 'done') return none('a completed task needs no handoff: the state file with status done is enough');
  if (result.status === 'PASS') return none('validation passed: nothing is unresolved');
  if (result.required === false) return none('validation was not required');
  const triggers = [];
  if (sessionEnding) triggers.push('session-ending-unfinished');
  if (ownershipTransfer) triggers.push('ownership-transfer');
  if (result.status === 'BLOCKED') triggers.push('blocked-on-resolution');
  if (!interactive && (result.notRun ?? []).some((id) => (result.actions ?? []).find((a) => a.id === id && /confirmation/.test(a.reason ?? '')))) triggers.push('confirmation-cannot-be-asked');
  if (!triggers.length) return none(['DECLINED', 'UNKNOWN'].includes(result.status) ? 'unresolved validation in a session that continues: TASK_STATE.md records it and is sufficient' : 'a failing check is fixed within scope or reported; no handoff trigger holds');
  if (latestHandoffMatches) return { required: false, reason: 'the latest handoff already matches the current state', triggers, duplicate: true };
  return {
    required: true,
    reason: triggers.join(', '),
    triggers,
    order: ['update TASK_STATE.md first (owner, status, remaining)', 'then write one new HANDOFF.md'],
    validationStatus: { depth: result.depth, status: result.status, passed: result.passed ?? [], failed: result.failed ?? [], notRun: [...(result.notRun ?? []), ...(result.declined ?? []), ...(result.blocked ?? []), ...(result.unknown ?? [])] },
  };
}

/**
 * The one decision for a validation outcome: whether TASK_STATE.md is written (or created) and whether a handoff is required, made
 * together so that they can never disagree. A handoff presupposes a current TASK_STATE.md (creation trigger "a handoff is about to
 * be written"), so a required handoff always makes the state required; and a task cannot be called done while its required
 * validation has not passed. Pure: it decides, nothing is written. The state is written by its owner only (the caller names one).
 * @returns {{ state: {write, create, reason, requiresOwner}, handoff, order: string[], consistent: boolean, completion: {allowed, reason} }}
 */
export function decideValidationStateAndHandoff({ result, taskClass = null, risk = 'LOW', taskStatus = 'in-progress', sessionEnding = false, ownershipTransfer = false, interactive = true, latestHandoffMatches = false, readOnly = false, stateExists = false, spansSessions = false } = {}) {
  const handoff = handoffDecision({ result, taskClass, taskStatus, sessionEnding, ownershipTransfer, interactive, latestHandoffMatches, readOnly });
  const needed = stateRequired({ taskClass, risk, spansSessions, blocked: result?.status === 'BLOCKED', handoffAhead: handoff.required });
  const hasResult = !!result && !readOnly;
  const write = hasResult && (stateExists || needed);
  const state = {
    write,
    create: write && !stateExists,
    requiresOwner: true,
    reason: !hasResult ? 'no validation result' : stateExists ? 'a state exists: validation completed is a canonical update point' : needed ? (handoff.required ? 'a handoff is required, so the state must exist first' : 'a canonical creation trigger holds') : 'no creation trigger holds and no state exists',
  };
  const completion = taskStatus === 'done' && hasResult && result.required !== false && result.status !== 'PASS'
    ? { allowed: false, reason: 'a task cannot be completed while its required validation is ' + result.status + ': report it, do not mark the task done' }
    : { allowed: true, reason: null };
  return { state, handoff, order: handoff.required ? ['TASK_STATE.md', 'HANDOFF.md'] : write ? ['TASK_STATE.md'] : [], consistent: !handoff.required || state.write, completion };
}

/**
 * The Phase 5A action record for a validation event. Counts and enumerated words only: no command output, no file content.
 * The canonical `result` words have no "unknown", so an UNKNOWN validation is `failed` there and stays UNKNOWN in `detail.status`.
 */
export function validationRecord({ phase = 'completed', plan = null, result = null, now } = {}) {
  const src = result ?? plan;
  const planned = phase === 'planned';
  const status = result?.status ?? null;
  const risk = plan?.risk ?? result?.risk ?? 'LOW';
  const reason = (RISK_RANK[risk] ?? 0) >= RISK_RANK.HIGH ? 'required-by-risk' : 'required-by-class';
  const needsYes = planned ? (plan?.confirmationRequired ?? []).some((p) => !p.declined) : false;
  const awaiting = (result?.actions ?? []).some((a) => a.reason === 'awaiting-confirmation');
  const resultWord = planned
    ? needsYes ? 'needs-confirmation' : 'ok'
    : status === 'PASS' ? (result.reused ? 'noop' : 'ok')
      : status === 'DECLINED' ? 'declined'
        : status === 'BLOCKED' ? 'refused'
          : status === 'NOT_RUN' ? (awaiting ? 'needs-confirmation' : 'noop')
            : 'failed';
  const level = (src?.actions ?? []).some((a) => a.level === 'A2') ? 'A2' : 'A1';
  return actionRecord({
    event: planned ? 'VALIDATION_REQUIRED' : 'VALIDATION_COMPLETED',
    action: 'validation',
    reason,
    level,
    result: resultWord,
    detail: planned
      ? { depth: src?.depth, planned: (src?.actions ?? []).length, automatic: (src?.automatic ?? []).length, proposed: (src?.confirmationRequired ?? []).length, prohibited: (src?.prohibited ?? []).length, unresolved: (src?.unresolved ?? []).length }
      : { depth: result.depth, status, executed: (result.executed ?? []).length, passed: (result.passed ?? []).length, failed: (result.failed ?? []).length, notRun: (result.notRun ?? []).length, declined: (result.declined ?? []).length, blocked: (result.blocked ?? []).length, unknown: (result.unknown ?? []).length },
    now,
  });
}
