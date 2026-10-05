/**
 * The canonical handoff (ai/SESSION_HANDOFF.md, ai/AUTOMATION_PROTOCOL.md → HANDOFF, ai/CONTINUITY.md): schema, identity, rendering,
 * parsing and the safety rules a handoff must satisfy. Pure: no file access, no process, no network, no clock (the caller passes `now`).
 *
 * A handoff is an immutable transfer snapshot. Its one canonical record is a JSON object (below); the Markdown a person reads is rendered
 * from that record and must equal the render of it, so no text can say something the record does not. Its identity is a SHA-256 over every
 * semantic field (everything except the creation time), so changing what is transferred changes the id.
 *
 * Data, never instructions: every field is validated on the way in AND again when a handoff is read back, because a handoff found in a
 * repository is untrusted input. A field with a secret, an environment value, a command or a structure marker is refused, not redacted.
 */
import { createHash } from 'node:crypto';
import { cleanPath, isSecretPath } from './path-safety.mjs';

export const HANDOFF_SCHEMA = 'erdem.handoff/2';
export const HANDOFF_REASONS = Object.freeze(['session-ending', 'ownership-transfer', 'blocked', 'context-too-large', 'user-request']);
export const TASK_STATUSES = Object.freeze(['not-started', 'in-progress', 'blocked', 'done']);
export const CLASS_VALUES = Object.freeze(['TRIVIAL', 'SMALL', 'MEDIUM', 'LARGE', 'ARCHITECTURAL']);
export const RISK_VALUES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const INTELLIGENCE_VALUES = Object.freeze(['current', 'stale', 'unverifiable', 'partial', 'missing', 'unavailable']);
export const VALIDATION_STATUSES = Object.freeze(['PASS', 'FAIL', 'NOT_RUN', 'DECLINED', 'BLOCKED', 'UNKNOWN']);
export const REF_KINDS = Object.freeze(['file', 'index', 'decision']);
export const LIMITS = Object.freeze({ text: 240, list: 12, changedFiles: 400, refs: 16, config: 12, goal: 200 });
/** A changed-file set is carried whole, in ordered batches of this many files, each batch bound by a digest (so no batch can silently go missing or change). */
export const CHANGE_BATCH = 40;

const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{32}$/;
const TASK_ID = /^[0-9a-f]{12}$/;
const SHORT = /^[0-9a-f]{1,8}$/;
const AGENT = /^[A-Za-z0-9._-](?:[A-Za-z0-9._ -]{0,22}[A-Za-z0-9._-])?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// ---- text safety ----------------------------------------------------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /\b(?:pass(?:word|wd)?|secret|token|api[_-]?key|apikey|auth(?:orization)?|credentials?|private[_-]?key|access[_-]?key)\b\s*[:=]\s*\S{3,}/i,
  /:\/\/[^\s/@:]+:[^\s/@]+@/,
];
const ENV_ASSIGNMENT = /(?:^|[\s;&|(])(?:export\s+|set\s+)?[A-Z][A-Z0-9_]{2,}=\S/;
const COMMAND_MARKERS = /`|\$\(|\$\{|&&|\|\||[|;<>]|\\x[0-9a-f]{2}|\bcurl\b[^\n]*\|\s*(?:sh|bash)/i;
/** Control, line-separator, zero-width and bidirectional characters: none of them has a place in a one-line field. */
const CONTROL_RANGES = [[0, 31], [127, 127], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]];
const CONTROL = { test: (s) => { for (const ch of s) { const c = ch.codePointAt(0); if (CONTROL_RANGES.some(([a, b]) => c >= a && c <= b)) return true; } return false; } };

/** A long mixed letter-and-digit token that is not a plain hash: treated as a probable credential. */
function highEntropyToken(s) {
  for (const m of s.matchAll(/[A-Za-z0-9+_=-]{32,}/g)) {
    const t = m[0];
    if (/^[0-9a-f]+$/i.test(t)) continue; // a hash or a fingerprint
    if (/[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t)) return true; // mixed case and digits
    if (!/[-_]/.test(t) && /[g-z]/i.test(t) && /\d/.test(t)) return true; // one unbroken alphanumeric run with digits: not a word
  }
  return false;
}

/**
 * Why a piece of free text may not enter a handoff, or null. Codes only: the text itself is never echoed.
 * @param {string} s
 * @param {{ env?: Record<string,string|undefined> }} [ctx]  the environment whose secret-looking values must not appear
 */
export function textIssue(s, ctx = {}) {
  if (typeof s !== 'string') return 'not-text';
  if (CONTROL.test(s)) return 'control-character';
  if (s.length > LIMITS.text) return 'too-long';
  if (/^\s*(?:#|-{3}|```|<!--)/.test(s) || /(?:^|\s)<!--/.test(s) || /```/.test(s)) return 'structure-marker';
  if (SECRET_PATTERNS.some((re) => re.test(s)) || highEntropyToken(s)) return 'secret-like';
  if (ENV_ASSIGNMENT.test(s)) return 'environment-value';
  for (const [k, v] of Object.entries(ctx.env ?? {})) {
    if (typeof v === 'string' && v.length >= 8 && /key|token|secret|pass|cred|auth|private/i.test(k) && s.includes(v)) return 'environment-value';
  }
  if (COMMAND_MARKERS.test(s)) return 'command-marker';
  return null;
}

/** A project-relative path a handoff may name: plain, not a glob, no ":" (the readable form is "path: reason"), not a secret-pattern path, not an option. */
export function pathIssue(p) {
  if (typeof p !== 'string' || p.length > 200) return 'bad-path';
  let c;
  try {
    c = cleanPath(p);
  } catch {
    return 'bad-path';
  }
  if (c !== p || c.includes(':') || c.startsWith('-') || CONTROL.test(c)) return 'bad-path';
  if (isSecretPath(c)) return 'secret-path';
  return null;
}

export const agentNameOk = (n) => typeof n === 'string' && AGENT.test(n);

// ---- the record ------------------------------------------------------------------------------------------------------------------------

const KEYS = ['schema', 'task', 'from', 'to', 'reason', 'objective', 'completed', 'active', 'blockers', 'nextAction', 'decisions', 'caveats', 'changedFiles', 'changeSet', 'config', 'intelligence', 'context', 'validation', 'previous', 'generatedAt'];
const batchDigest = (files) => sha256(JSON.stringify(files.map((f) => [f.path, f.reason, f.state, f.fingerprint]))).slice(0, 32);

/** The batches of a changed-file list: { total, batchSize, batches: [{ n, count, digest }] }, in list order. Deterministic. */
export function changeSetOf(files) {
  const batches = [];
  for (let i = 0; i < files.length; i += CHANGE_BATCH) {
    const part = files.slice(i, i + CHANGE_BATCH);
    batches.push({ n: batches.length + 1, count: part.length, digest: batchDigest(part) });
  }
  return { total: files.length, batchSize: CHANGE_BATCH, batches };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (o, keys) => isObj(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/**
 * Check a record completely. Returns the first problem as { code, field } (no content), or null when the record is valid.
 * Used for a handoff being built and for a handoff being read back.
 */
export function recordIssue(r, ctx = {}) {
  const bad = (code, field) => ({ code, field });
  if (!exactKeys(r, KEYS)) return bad('shape', 'record');
  if (r.schema !== HANDOFF_SCHEMA) return bad('schema', 'schema');
  const t = r.task;
  if (!exactKeys(t, ['id', 'goal', 'class', 'risk', 'status'])) return bad('shape', 'task');
  if (typeof t.id !== 'string' || !TASK_ID.test(t.id)) return bad('shape', 'task.id');
  if (typeof t.goal !== 'string' || !t.goal || t.goal.length > LIMITS.goal) return bad('shape', 'task.goal');
  if (textIssue(t.goal, ctx)) return bad(textIssue(t.goal, ctx), 'task.goal');
  if (t.class !== null && !CLASS_VALUES.includes(t.class)) return bad('shape', 'task.class');
  if (t.risk !== null && !RISK_VALUES.includes(t.risk)) return bad('shape', 'task.risk');
  if (!TASK_STATUSES.includes(t.status)) return bad('shape', 'task.status');
  if (!agentNameOk(r.from)) return bad('shape', 'from');
  if (r.to !== 'any' && !agentNameOk(r.to)) return bad('shape', 'to');
  if (!HANDOFF_REASONS.includes(r.reason)) return bad('shape', 'reason');
  for (const f of ['objective', 'nextAction']) {
    if (typeof r[f] !== 'string' || !r[f]) return bad('shape', f);
    const i = textIssue(r[f], ctx);
    if (i) return bad(i, f);
  }
  for (const f of ['completed', 'active', 'blockers', 'decisions', 'caveats']) {
    if (!Array.isArray(r[f]) || r[f].length > LIMITS.list) return bad('shape', f);
    for (const s of r[f]) {
      const i = typeof s === 'string' && s ? textIssue(s, ctx) : 'not-text';
      if (i) return bad(i, f);
    }
  }
  if (!Array.isArray(r.changedFiles) || r.changedFiles.length > LIMITS.changedFiles) return bad('shape', 'changedFiles');
  for (const c of r.changedFiles) {
    if (!exactKeys(c, ['path', 'reason', 'state', 'fingerprint'])) return bad('shape', 'changedFiles');
    const pi = pathIssue(c.path);
    if (pi) return bad(pi, 'changedFiles');
    const ri = textIssue(c.reason, ctx);
    if (ri || !c.reason) return bad(ri ?? 'shape', 'changedFiles');
    if (!['present', 'deleted', 'unreadable'].includes(c.state)) return bad('shape', 'changedFiles');
    if (c.fingerprint !== null && !(typeof c.fingerprint === 'string' && SHA256.test(c.fingerprint))) return bad('shape', 'changedFiles');
    if (c.state === 'present' && c.fingerprint === null) return bad('shape', 'changedFiles');
    if (c.state !== 'present' && c.fingerprint !== null) return bad('shape', 'changedFiles');
  }
  if (new Set(r.changedFiles.map((c) => c.path)).size !== r.changedFiles.length) return bad('duplicate-file', 'changedFiles');
  if (JSON.stringify(r.changeSet) !== JSON.stringify(changeSetOf(r.changedFiles))) return bad('shape', 'changeSet'); // a batch is missing, altered, duplicated or out of order
  if (!Array.isArray(r.config) || r.config.length > LIMITS.config) return bad('shape', 'config');
  for (const c of r.config) {
    if (!exactKeys(c, ['path', 'fingerprint'])) return bad('shape', 'config');
    const pi = pathIssue(c.path);
    if (pi) return bad(pi, 'config');
    if (typeof c.fingerprint !== 'string' || !SHA256.test(c.fingerprint)) return bad('shape', 'config');
  }
  if (!exactKeys(r.intelligence, ['state', 'reliedOn']) || !INTELLIGENCE_VALUES.includes(r.intelligence.state) || typeof r.intelligence.reliedOn !== 'boolean') return bad('shape', 'intelligence');
  const c = r.context;
  if (!exactKeys(c, ['level', 'refs']) || !Number.isInteger(c.level) || c.level < 0 || c.level > 5 || !Array.isArray(c.refs) || c.refs.length > LIMITS.refs) return bad('shape', 'context');
  for (const x of c.refs) {
    if (!exactKeys(x, ['kind', 'path', 'why', 'fingerprint']) || !REF_KINDS.includes(x.kind)) return bad('shape', 'context');
    const pi = pathIssue(x.path);
    if (pi) return bad(pi, 'context');
    const wi = textIssue(x.why, ctx);
    if (wi || !x.why) return bad(wi ?? 'shape', 'context');
    if (typeof x.fingerprint !== 'string' || !SHA256.test(x.fingerprint)) return bad('shape', 'context');
  }
  if (r.validation !== null) {
    const v = r.validation;
    if (!exactKeys(v, ['depth', 'status', 'plan', 'content']) || !/^V[0-4]$/.test(v.depth) || !VALIDATION_STATUSES.includes(v.status)) return bad('shape', 'validation');
    if (typeof v.plan !== 'string' || !SHORT.test(v.plan) || (v.content !== null && !(typeof v.content === 'string' && SHORT.test(v.content)))) return bad('shape', 'validation');
  }
  if (r.previous !== null && !(typeof r.previous === 'string' && ID.test(r.previous))) return bad('shape', 'previous');
  if (typeof r.generatedAt !== 'string' || !ISO.test(r.generatedAt)) return bad('shape', 'generatedAt');
  return null;
}

/** The identity of a handoff: a SHA-256 over every semantic field. Only the creation time is left out. */
export function handoffIdOf(r) {
  const { generatedAt: _t, ...semantic } = r;
  void _t;
  return sha256(JSON.stringify(['erdem.handoff.id', semantic])).slice(0, 32);
}

// ---- when a handoff exists at all --------------------------------------------------------------------------------------------------------

/**
 * Whether a handoff is warranted (HANDOFF_REQUIRED). Decided, not written. A completed task needs none; a handoff exists only for a real
 * continuity need, and the state must already say so (a blocked handoff needs a blocked state: the state is authoritative).
 */
export function handoffRequired({ reason, status, remaining = 0, blockers = 0, to = 'any', ownerSet = true } = {}) {
  const none = (why) => ({ required: false, reason: why });
  if (!HANDOFF_REASONS.includes(reason)) return { required: false, refused: 'unknown-reason', reason: `reason must be one of ${HANDOFF_REASONS.join(', ')}` };
  if (!TASK_STATUSES.includes(status)) return { required: false, refused: 'state-status-unknown', reason: 'TASK_STATE.md has no recognizable status' };
  if (!ownerSet) return { required: false, refused: 'state-unowned', reason: 'the task state has no owner: ownership is taken first (ai/CONTINUITY.md)' };
  if (status === 'done' && reason !== 'user-request') return none('a completed task needs no handoff: the state file with status done is enough');
  if (status === 'not-started' && reason !== 'user-request') return none('nothing has been started: there is nothing to hand over');
  if (reason === 'blocked') return status === 'blocked' && blockers > 0 ? { required: true, reason } : { required: false, refused: 'state-not-blocked', reason: 'a blocked handoff needs TASK_STATE.md to say blocked, with what it waits on: update the state first' };
  if (reason === 'ownership-transfer') return to !== 'any' ? { required: true, reason } : { required: false, refused: 'receiver-missing', reason: 'an ownership transfer names its receiver (--to)' };
  if (reason === 'session-ending' || reason === 'context-too-large') return remaining > 0 || status === 'blocked' ? { required: true, reason } : none('no unfinished work is recorded: nothing remains to hand over');
  return { required: true, reason };
}

// ---- build -------------------------------------------------------------------------------------------------------------------------------

/**
 * Build the record from already-gathered facts and check it. `facts` carries everything (the io layer reads files; this stays pure).
 * @returns {{ ok: true, record, id } | { ok: false, code, field }}
 */
export function buildHandoff(facts, { now = new Date(), env = {} } = {}) {
  const generatedAt = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const record = {
    schema: HANDOFF_SCHEMA,
    task: { id: facts.taskId, goal: facts.goal, class: facts.class ?? null, risk: facts.risk ?? null, status: facts.status },
    from: facts.from,
    to: facts.to ?? 'any',
    reason: facts.reason,
    objective: facts.objective ?? facts.goal,
    completed: facts.completed ?? [],
    active: facts.active ?? [],
    blockers: facts.blockers ?? [],
    nextAction: facts.nextAction,
    decisions: facts.decisions ?? [],
    caveats: facts.caveats ?? [],
    changedFiles: facts.changedFiles ?? [],
    changeSet: changeSetOf(facts.changedFiles ?? []),
    config: facts.config ?? [],
    intelligence: { state: facts.intelligence?.state ?? 'unavailable', reliedOn: !!facts.intelligence?.reliedOn },
    context: { level: facts.context?.level ?? 0, refs: facts.context?.refs ?? [] },
    validation: facts.validation ?? null,
    previous: facts.previous ?? null,
    generatedAt,
  };
  const issue = recordIssue(record, { env });
  if (issue) return { ok: false, ...issue };
  return { ok: true, record, id: handoffIdOf(record) };
}

// ---- render and parse ---------------------------------------------------------------------------------------------------------------------

const bullets = (list, none = 'none') => (list.length ? list.map((s) => `- ${s}`) : [`- ${none}`]);

/** The Markdown of a handoff: the template layout (so existing readers keep working) plus the canonical record. LF line endings. */
export function renderHandoff(r, id = handoffIdOf(r)) {
  const changed = r.changedFiles.map((c) => `- ${c.path}: ${c.reason}${c.state === 'present' ? ` [fingerprint: ${c.fingerprint}]` : ` [${c.state}]`}`);
  const refs = r.context.refs.map((x) => `- ${x.path}: ${x.kind}, ${x.why} [fingerprint: ${x.fingerprint}]`);
  const v = r.validation;
  const lines = [
    '---',
    `generatedAt: ${r.generatedAt}`,
    'source: project-intel handoff',
    'scope: session',
    `from: ${r.from}`,
    `to: ${r.to}`,
    `handoffId: ${id}`,
    `schema: ${r.schema}`,
    '---',
    '# Handoff',
    '',
    '## Objective',
    r.objective,
    '',
    '## Completed',
    ...bullets(r.completed),
    '',
    '## Changed files',
    ...(changed.length ? changed : ['- none']),
    '',
    '## Current state',
    `- task ${r.task.id} (${r.task.status}${r.task.class ? `, ${r.task.class}` : ''}${r.task.risk ? `, ${r.task.risk}` : ''}); handed over because: ${r.reason}`,
    `- change set: ${r.changeSet.total} file(s) in ${r.changeSet.batches.length} batch(es) of up to ${r.changeSet.batchSize}, each bound by a digest`,
    ...r.active.map((s) => `- ${s}`),
    '',
    '## Next action',
    r.nextAction,
    '',
    '## Open issues',
    ...bullets(r.blockers),
    '',
    '## Required user decisions',
    ...bullets(r.decisions),
    '',
    '## Validation status',
    ...(v ? [`- ${v.depth} plan ${v.plan}${v.content ? ` content ${v.content}` : ''}: ${v.status}`] : ['- not recorded']),
    ...r.caveats.map((s) => `- caveat: ${s}`),
    '',
    '## Relevant indexes',
    `- intelligence at handoff: ${r.intelligence.state}${r.intelligence.reliedOn ? ' (relied on)' : ''}; context level reached: ${r.context.level}`,
    ...refs,
    '',
    '## Transfer record (canonical)',
    '',
    '```json',
    JSON.stringify(r, null, 2),
    '```',
    '',
  ];
  return lines.join('\n');
}

/**
 * Read a handoff back. It is checked as untrusted input: shape and safety of every field, the identity, and that the readable text is
 * exactly what the record renders to. The first failure is returned as a code.
 * @returns {{ ok: true, record, id } | { ok: false, code: string, field?: string }}
 */
export function parseHandoff(text, { env = {} } = {}) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(src);
  if (!fm || !/^handoffId:\s*[0-9a-f]{32}\s*$/m.test(fm[1])) return { ok: false, code: 'not-canonical' };
  const fence = /\n## Transfer record \(canonical\)\n\n```json\n([\s\S]*?)\n```\n$/.exec(src);
  if (!fence) return { ok: false, code: 'not-canonical' };
  let record;
  try {
    record = JSON.parse(fence[1]);
  } catch {
    return { ok: false, code: 'record-unreadable' };
  }
  const issue = recordIssue(record, { env });
  if (issue) return { ok: false, code: issue.code === 'shape' || issue.code === 'schema' ? 'record-invalid' : 'record-unsafe', field: issue.field };
  const id = handoffIdOf(record);
  const claimed = /^handoffId:\s*([0-9a-f]{32})\s*$/m.exec(fm[1])[1];
  if (claimed !== id) return { ok: false, code: 'identity-mismatch' };
  if (renderHandoff(record, id) !== src) return { ok: false, code: 'text-differs-from-record' };
  return { ok: true, record, id };
}
