/**
 * Session continuity on the file system (ai/CONTINUITY.md): issue a handoff and receive one. The decisions live in the pure modules
 * (continuity-handoff, continuity-state, continuity-resume); this module reads what they need and writes the only two things they may
 * write: TASK_STATE.md and HANDOFF.md, each by an atomic replace, in the directory of the task state, and nothing else.
 *
 * Nothing here starts a process, runs a validation, replays a command or rebuilds an index. Resume means reconstructing context and
 * ownership, never repeating what the previous session did. Paths that match the secret patterns, leave the project or pass through a
 * link are never read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hashContent } from '../lib/fingerprint.mjs';
import { actionRecord } from './records.mjs';
import { isSecretPath } from './path-safety.mjs';
import { CHANGE_BATCH, LIMITS, agentNameOk, buildHandoff, handoffRequired, parseHandoff, pathIssue, renderHandoff } from './continuity-handoff.mjs';
import { mintTaskId, ownershipOf, parseTaskState, withContinuity, withOwner } from './continuity-state.mjs';
import { decideResume } from './continuity-resume.mjs';

export const STATE_FILE = 'TASK_STATE.md';
export const HANDOFF_FILE = 'HANDOFF.md';
/** The manifests whose change is a change of the task's commands or dependencies. Presence and content are bound; a new one is drift. */
export const CONFIG_MANIFESTS = Object.freeze(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pyproject.toml', 'Cargo.toml', 'Cargo.lock', 'go.mod', 'pom.xml', 'tsconfig.json', 'project-intel.config.json']);
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_HANDOFF_CHARS = 640 * 1024;
const MAX_STATE_CHARS = 1024 * 1024;
const readHandoff = (text, env) => (text.length > MAX_HANDOFF_CHARS ? { ok: false, code: 'too-large' } : parseHandoff(text, { env }));

const nowIso = (now) => now.toISOString().replace(/\.\d+Z$/, 'Z');

// ---- paths and files ---------------------------------------------------------------------------------------------------------------------

/** The absolute path of a project-relative path that stays inside the project, even through links; null otherwise. */
function inside(root, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
  return abs;
}

function realInside(root, abs) {
  try {
    let dir = path.dirname(abs);
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir); // the nearest directory that exists
    const real = fs.realpathSync(dir);
    const base = fs.realpathSync(root);
    const r = path.relative(base, real);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  } catch {
    return false;
  }
}

/** { state: 'present', fingerprint } | { state: 'deleted' } | { state: 'unreadable' }. A link, a directory, a secret path or a huge file is unreadable: never followed. */
export function fingerprintFile(root, rel) {
  const abs = inside(root, rel);
  if (!abs || pathIssue(rel) || !realInside(root, abs)) return { state: 'unreadable', fingerprint: null };
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (e) {
    return e.code === 'ENOENT' ? { state: 'deleted', fingerprint: null } : { state: 'unreadable', fingerprint: null };
  }
  if (!st.isFile() || st.size > MAX_BYTES) return { state: 'unreadable', fingerprint: null };
  try {
    return { state: 'present', fingerprint: hashContent(fs.readFileSync(abs)).hash };
  } catch {
    return { state: 'unreadable', fingerprint: null };
  }
}

/**
 * The key `validate` records for the content a validation covered (the same algorithm as bin/project-intel.mjs: a SHA-256 over each
 * changed path and its bytes, secret paths left out). Used only to notice that a recorded PASS no longer matches.
 */
export function contentKeyOf(root, paths) {
  const hash = createHash('sha256');
  for (const p of [...paths].filter((x) => !isSecretPath(x)).sort()) {
    hash.update(p + '\0');
    try {
      const abs = path.resolve(root, p);
      if (fs.statSync(abs).size <= 1048576) hash.update(fs.readFileSync(abs));
    } catch {
      hash.update('absent');
    }
  }
  return hash.digest('hex').slice(0, 16);
}

function atomicWrite(abs, text) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    // On Windows a rename onto a file another process is reading at that instant fails transiently (EPERM, EBUSY, EACCES): retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, abs);
        break;
      } catch (e) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 12) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
      }
    }
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing to clean up
    }
    throw e;
  }
}

/**
 * Optimistic concurrency for the state file. A writer takes a short-lived sibling lock (exclusive create: it is not an OS-level file lock),
 * re-reads the state while holding it, and decides again from what it finds: whoever wins the race writes, the loser is told it lost.
 * A lock older than LOCK_STALE_MS is a crashed writer's and is cleared. Writers that bypass the tool (a person editing the file) are not
 * covered: single-writer remains the protocol (ai/CONTINUITY.md).
 */
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 3000;
function acquireLock(stateAbs) {
  if (!fs.existsSync(path.dirname(stateAbs))) return { path: null }; // nothing to protect: the caller reports the missing state
  const lock = stateAbs + '.lock';
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid) + ' ' + Date.now());
      fs.closeSync(fd);
      return { path: lock };
    } catch (e) {
      if (e.code !== 'EEXIST') return { path: null, error: e.code };
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // it vanished: try again
      }
      if (Date.now() > deadline) return { path: null, busy: true };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
const releaseLock = (l) => {
  if (!l?.path) return;
  try {
    fs.rmSync(l.path, { force: true });
  } catch {
    // a stale lock is cleared by the next writer
  }
};

/** The text of a file, or null when it is not there. A read that fails because another writer is replacing the file at that instant (EPERM, EBUSY, EACCES on Windows) is retried briefly, never mistaken for a missing file. */
const readText = (abs) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(abs, 'utf8');
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 8) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1));
    }
  }
};

/** The two canonical files: TASK_STATE.md (given or in the output directory) and HANDOFF.md beside it. */
export function resolveFiles(root, { outputDir = '.ai', taskState, handoff } = {}) {
  const stateRel = (taskState ?? `${outputDir}/${STATE_FILE}`).replace(/\\/g, '/');
  const handoffRel = (handoff ?? `${path.posix.dirname(stateRel)}/${HANDOFF_FILE}`).replace(/\\/g, '/');
  const stateAbs = inside(root, stateRel);
  const handoffAbs = inside(root, handoffRel);
  if (!stateAbs || path.basename(stateAbs) !== STATE_FILE) return { error: 'the task state must be a TASK_STATE.md inside the project' };
  if (!handoffAbs || path.basename(handoffAbs) !== HANDOFF_FILE) return { error: 'the handoff must be a HANDOFF.md inside the project' };
  if (!realInside(root, stateAbs) || !realInside(root, handoffAbs)) return { error: 'the state and handoff paths must not pass through a link' };
  return { stateRel, handoffRel, stateAbs, handoffAbs };
}

/** The intelligence state now (a read-only status check), or the one the caller holds. Never refreshes anything. */
export async function intelligenceNow(root, { state, configPath } = {}) {
  if (state) return state;
  try {
    const { loadConfig } = await import('../lib/config.mjs');
    const { runStatus } = await import('../lib/pipeline.mjs');
    const { declaredProfile } = await import('./refresh.mjs');
    const { intelligenceFromStatus } = await import('./context-router.mjs');
    const cfg = loadConfig(root, { configPath });
    return intelligenceFromStatus(runStatus(root, { configPath }).status, declaredProfile(root, cfg.outputDir)).state;
  } catch {
    return 'unavailable';
  }
}

// ---- issue a handoff -----------------------------------------------------------------------------------------------------------------------

const refuse = (code, note, extra = {}) => ({ result: 'refused', code, note, ...extra });
const withRecord = (r, { event = 'HANDOFF_REQUIRED', action = 'handoff-write', reason = 'trigger-handoff', level = 'A1', now, detail = {} }) => ({
  ...r,
  record: actionRecord({
    event, action, reason, level,
    result: ['created', 'accepted', 'repaired', 'ok', 'resume', 'no-handoff'].includes(r.result) ? 'ok' : ['noop', 'not-required'].includes(r.result) ? 'noop' : ['needs-confirmation', 'reconcile'].includes(r.result) ? 'needs-confirmation' : 'refused',
    detail: { ...detail, ...(r.code ? { code: r.code } : {}) },
    now,
  }),
});

/**
 * Issue a handoff for the task in TASK_STATE.md. Order (ai/AUTOMATION_PROTOCOL.md → HANDOFF): the state first (it records that a handoff is
 * pending, and for whom), then one new HANDOFF.md. Repeating it for an unchanged state is a noop. The owner stays the owner, and the single
 * writer, until the receiver accepts.
 * @param {string} root
 * @param {object} o { owner, reason, to, nextAction, active, caveats, decisions, contextFiles, indexes, contextLevel, taskState, handoff, outputDir, intelligenceState, env, now }
 */
export async function createHandoff(root, o = {}) {
  const files = resolveFiles(root, o);
  if (files.error) return createHandoffUnlocked(root, o);
  const lock = acquireLock(files.stateAbs);
  if (lock.busy) return withRecord(refuse('state-busy', 'another writer holds the task state right now: nothing was written, try again'), { reason: o.reason === 'user-request' ? 'user-request' : 'trigger-handoff', now: o.now ?? new Date(), detail: { reason: o.reason ?? null } });
  try {
    return await createHandoffUnlocked(root, o);
  } finally {
    releaseLock(lock);
  }
}

async function createHandoffUnlocked(root, o = {}) {
  const now = o.now ?? new Date();
  const rec = (r, extra = {}) => withRecord(r, { reason: o.reason === 'user-request' ? 'user-request' : 'trigger-handoff', now, detail: { reason: o.reason ?? null, ...extra } });
  const files = resolveFiles(root, o);
  if (files.error) return rec(refuse('bad-path', files.error));
  const stateText = readText(files.stateAbs);
  if (stateText === null) return rec(refuse('state-missing', 'there is no TASK_STATE.md: a handoff presupposes a current task state'));
  if (stateText.length > MAX_STATE_CHARS) return rec(refuse('state-too-large', 'TASK_STATE.md is larger than a task state should be: it is not read'));
  const state = parseTaskState(stateText);
  if (!agentNameOk(o.owner)) return rec(refuse('owner-invalid', '--owner names the agent that currently owns the task (letters, digits, . _ - and spaces; at most 24)'));
  if (state.owner && state.owner !== o.owner) return rec(refuse('not-owner', 'only the current owner writes TASK_STATE.md and issues its handoff: ask the owner, or take the task over by a handoff'));
  const to = o.to ?? 'any';
  if (to !== 'any' && !agentNameOk(to)) return rec(refuse('receiver-invalid', '--to names the receiving agent (or is left out for any)'));
  const decision = handoffRequired({ reason: o.reason, status: state.status, remaining: state.remaining.length, blockers: state.blocked.length, to, ownerSet: !!state.owner });
  if (decision.refused) return rec({ ...refuse(decision.refused, decision.reason), decision });
  if (!decision.required) return rec({ result: 'not-required', note: decision.reason, decision });
  if (state.continuity?.malformed) return rec(refuse('state-continuity-malformed', 'the continuity block of TASK_STATE.md cannot be read: repair or remove it'));
  if (!state.goal) return rec(refuse('state-goal-missing', 'TASK_STATE.md has no goal'));
  const nextAction = o.nextAction ?? state.remaining[0];
  if (!nextAction) return rec(refuse('next-action-missing', 'a handoff carries one concrete next action (--next-action)'));
  if (state.changedFiles.length > LIMITS.changedFiles) return rec(refuse('too-many-files', `the state lists more than ${LIMITS.changedFiles} changed files: keep a manifest file in the project and list that instead`));
  if (new Set(state.changedFiles.map((c) => c.path)).size !== state.changedFiles.length) return rec(refuse('duplicate-file', 'a changed file is listed twice in the state: list each file once'));

  // what is pointed at, with the fingerprint each had now
  const changedFiles = [];
  for (const c of state.changedFiles) {
    const pi = pathIssue(c.path);
    if (pi) return rec(refuse(pi, `a changed file of the state cannot be named in a handoff (${pi})`));
    const fp = fingerprintFile(root, c.path);
    changedFiles.push({ path: c.path, reason: c.text || 'changed', state: fp.state, fingerprint: fp.fingerprint });
  }
  const config = [];
  for (const name of CONFIG_MANIFESTS) {
    const fp = fingerprintFile(root, name);
    if (fp.state === 'present') config.push({ path: name, fingerprint: fp.fingerprint });
  }
  const refs = [];
  const addRef = (kind, p, why, { explicit }) => {
    const pi = pathIssue(p);
    if (pi) return refuse(pi, `a context reference cannot be named in a handoff (${pi})`);
    const fp = fingerprintFile(root, p);
    if (fp.state !== 'present') return explicit ? refuse('ref-unavailable', 'a named context file is missing or unreadable') : null;
    if (!refs.some((x) => x.path === p && x.kind === kind)) refs.push({ kind, path: p, why, fingerprint: fp.fingerprint });
    return null;
  };
  for (const e of o.contextFiles ?? []) {
    const i = e.indexOf('=');
    const bad = addRef('file', i > 0 ? e.slice(0, i) : e, i > 0 ? e.slice(i + 1) : 'context for the next action', { explicit: true });
    if (bad) return rec(bad);
  }
  for (const p of o.indexes ?? []) {
    const bad = addRef('index', p, 'derived index relied on', { explicit: true });
    if (bad) return rec(bad);
  }
  let omitted = 0;
  for (const rf of state.relevantFiles) {
    if (refs.length >= LIMITS.refs) {
      omitted++;
      continue;
    }
    if (pathIssue(rf.path) === 'secret-path') return rec(refuse('secret-path', 'a relevant file of the state is a secret-pattern path: it is not named in a handoff'));
    addRef('file', rf.path, 'listed in the task state', { explicit: false });
  }
  if ((o.contextFiles ?? []).length + (o.indexes ?? []).length > LIMITS.refs) return rec(refuse('too-many-refs', `at most ${LIMITS.refs} context references`));
  const contextLevel = o.contextLevel === undefined ? 0 : Number(o.contextLevel);
  if (!Number.isInteger(contextLevel) || contextLevel < 0 || contextLevel > 5) return rec(refuse('bad-context-level', '--context-level is 0 to 5'));

  // validation as TASK_STATE.md records it; a PASS is carried only with the doubt that applies
  const lv = state.lastValidation;
  const validation = lv && lv.status ? { depth: lv.depth, status: lv.status, plan: lv.planId, content: lv.contentKey } : null;
  const caveats = [...(o.caveats ?? [])];
  if (validation && validation.status === 'PASS' && validation.content) {
    const key = contentKeyOf(root, state.changedFiles.map((c) => c.path));
    if (!key.startsWith(validation.content)) caveats.push('the recorded PASS does not match the changed files as they are now: validation is required again');
  }
  if (validation && ['DECLINED', 'BLOCKED', 'UNKNOWN'].includes(validation.status)) caveats.push(`validation was ${validation.status.toLowerCase()}: it needs a decision or an authorization, and a handoff grants neither`);

  const goalNow = state.goal;
  const taskId = state.continuity?.taskId ?? mintTaskId(goalNow, nowIso(now));
  const existingText = readText(files.handoffAbs);
  let existing = null;
  if (existingText !== null) {
    const p = readHandoff(existingText, o.env ?? process.env);
    if (!p.ok) return rec(refuse(p.code === 'not-canonical' ? 'legacy-handoff-present' : 'existing-handoff-invalid', p.code === 'not-canonical' ? 'a HANDOFF.md that this tool did not issue exists: move it aside, it is not overwritten' : `the existing HANDOFF.md failed its checks (${p.code}): it is not overwritten`));
    existing = p;
  }
  const intelligence = { state: o.intelligenceState ?? (await intelligenceNow(root, { state: o.intelligenceState, configPath: o.configPath })), reliedOn: refs.some((x) => x.kind === 'index') };
  const facts = {
    taskId, goal: goalNow, class: state.class, risk: state.risk, status: state.status, from: o.owner, to, reason: o.reason,
    objective: goalNow, completed: state.completed.slice(-LIMITS.list), active: o.active ?? [], blockers: state.blocked,
    nextAction, decisions: [...state.openDecisions, ...(o.decisions ?? [])], caveats, changedFiles, config,
    intelligence, context: { level: contextLevel, refs }, validation, previous: existing ? existing.record.previous : null,
  };
  const env = o.env ?? process.env;
  let built = buildHandoff(facts, { now, env });
  if (!built.ok) return rec(refuse(built.code === 'shape' ? 'invalid-field' : `unsafe-${built.code}`, `the handoff would not be safe or valid (${built.code} in ${built.field}): nothing was written`, { field: built.field }));
  const stateNeeds = state.continuity?.handoff !== built.id || state.continuity?.ownership !== 'handoff-pending' || state.continuity?.receiver !== to;
  if (existing && existing.id === built.id) {
    if (!stateNeeds) return rec({ result: 'noop', note: 'the latest handoff already matches the current state', handoff: { id: built.id, path: files.handoffRel, to, reason: o.reason }, decision });
  } else {
    built = buildHandoff({ ...facts, previous: existing ? existing.id : null }, { now, env });
    if (!built.ok) return rec(refuse('invalid-field', `the handoff would not be valid (${built.code} in ${built.field})`));
  }
  const text = renderHandoff(built.record, built.id);
  // the state first, then the handoff
  const nextState = withContinuity(stateText, { taskId, ownership: 'handoff-pending', handoff: built.id, receiver: to, transferred: state.continuity?.transferred ?? null }, now);
  atomicWrite(files.stateAbs, nextState);
  const repaired = !!existing && existing.id === built.id;
  if (!repaired) atomicWrite(files.handoffAbs, text);
  return rec({
    result: repaired ? 'repaired' : 'created',
    handoff: { id: built.id, path: files.handoffRel, to, reason: o.reason, previous: built.record.previous },
    state: { path: files.stateRel, ownership: 'handoff-pending', owner: o.owner },
    decision,
    ...(omitted ? { notes: [`${omitted} relevant file(s) beyond the limit of ${LIMITS.refs} were not referenced`] } : {}),
  }, { files: changedFiles.length, refs: refs.length });
}

// ---- receive a handoff ---------------------------------------------------------------------------------------------------------------------

function driftOf(root, expected) {
  return expected.map((e) => {
    const now = fingerprintFile(root, e.path);
    let status;
    if (e.state === 'unreadable' || (e.state === 'present' && now.state === 'unreadable')) status = 'unverifiable';
    else if (e.state === 'deleted') status = now.state === 'deleted' ? 'unchanged' : now.state === 'present' ? 'reappeared' : 'unverifiable';
    else if (now.state === 'deleted') status = 'deleted';
    else status = now.fingerprint === e.fingerprint ? 'unchanged' : 'modified';
    return { path: e.path, status, ...(e.kind ? { kind: e.kind } : {}) };
  });
}

/**
 * Receive a handoff: verify, decide, and only when the decision allows it (and the user's yes names this handoff, and any drift is
 * acknowledged by its digest) take ownership. Idempotent: a second acceptance by the same agent is a noop. It never runs a validation,
 * a command or a refresh, and never repeats what the previous session did.
 * @param {string} root
 * @param {object} o { agent, accept, confirm, acknowledge, taskState, handoff, outputDir, intelligenceState, env, now }
 */
export async function resumeHandoff(root, o = {}) {
  const now = o.now ?? new Date();
  const env = o.env ?? process.env;
  const files = resolveFiles(root, o);
  const rec = (r, extra = {}) => withRecord(r, { event: 'SESSION_START', action: o.accept ? 'ownership-transfer' : 'handoff-resume', reason: o.accept ? 'user-request' : 'session-start', level: o.accept ? 'A2' : 'A1', now, detail: extra });
  if (files.error) return rec(refuse('bad-path', files.error));
  if (o.agent !== undefined && o.agent !== null && !agentNameOk(o.agent)) return rec(refuse('owner-invalid', '--owner names the agent that asks to continue (letters, digits, . _ - and spaces; at most 24)'));
  const stateText = readText(files.stateAbs);
  const handoffText = readText(files.handoffAbs);
  const state = stateText === null || stateText.length > MAX_STATE_CHARS ? null : parseTaskState(stateText);
  const parsed = handoffText === null ? null : readHandoff(handoffText, env);
  const r = parsed?.ok ? parsed.record : null;
  const drift = r
    ? {
      files: driftOf(root, r.changedFiles),
      config: [
        ...driftOf(root, r.config.map((c) => ({ path: c.path, state: 'present', fingerprint: c.fingerprint }))),
        ...CONFIG_MANIFESTS.filter((n) => !r.config.some((c) => c.path === n) && fingerprintFile(root, n).state === 'present').map((n) => ({ path: n, status: 'added' })),
      ],
      refs: driftOf(root, r.context.refs.map((x) => ({ path: x.path, state: 'present', fingerprint: x.fingerprint, kind: x.kind }))),
    }
    : { files: [], config: [], refs: [] };
  const intelligence = r ? await intelligenceNow(root, { state: o.intelligenceState, configPath: o.configPath }) : null;
  const facts = { agent: o.agent ?? null, state, handoff: { present: handoffText !== null, parsed }, drift, intelligence, accept: !!o.accept, confirm: o.confirm ?? null, acknowledge: o.acknowledge ?? null };
  const d = decideResume(facts);
  const base = {
    decision: d,
    drift: r ? { files: drift.files.length, moved: [...drift.files, ...drift.config, ...drift.refs].filter((x) => x.status !== 'unchanged').length } : null,
    changeSet: r ? { total: r.changeSet.total, batches: r.changeSet.batches.length, verified: true, batchesWithDrift: [...new Set(drift.files.map((x, i) => (x.status !== 'unchanged' ? Math.floor(i / CHANGE_BATCH) + 1 : 0)).filter(Boolean))] } : null,
    intelligence,
  };
  if (d.verdict !== 'stop' && r) {
    try {
      const { routeContext } = await import('./context-router.mjs');
      const plan = routeContext(
        { event: 'TASK_CLASSIFIED', taskClass: r.task.class ?? undefined, risk: r.task.risk ?? 'LOW', targets: r.changedFiles.filter((c) => c.state === 'present').map((c) => c.path).slice(0, 12), intent: 'change' },
        { state: intelligence ?? 'unavailable', artifacts: {} },
        { reached: 0, hasTaskState: true, hasHandoff: true, continuing: true, rootFiles: [] },
      );
      base.context = { handoffLevel: r.context.level, startedAt: 0, next: plan.level, minimum: plan.minimumLevel, ceiling: plan.ceiling, reads: plan.requiredSources.map((s) => s.path).slice(0, 8), rule: 'one level at a time: the router decides the next level; the handoff level is the minimum already known, not a jump' };
    } catch {
      base.context = null;
    }
  }
  if (d.verdict === 'noop') return rec({ result: 'noop', note: d.notes[0], ...base }, { verdict: d.verdict });
  if (!o.accept) return rec({ result: d.verdict, code: d.verdict === 'stop' ? d.stops[0]?.code : undefined, ...base }, { verdict: d.verdict });
  if (d.verdict === 'stop' || d.verdict === 'no-handoff') return rec(refuse(d.stops[0]?.code ?? 'no-handoff', d.stops[0]?.note ?? 'there is no handoff to accept', base), { verdict: d.verdict });
  if (!d.accept.allowed) return rec({ result: 'needs-confirmation', code: 'needs-' + d.accept.missing.join('+'), note: `ownership is not taken until: ${d.accept.missing.join(', ')}`, ...base }, { verdict: d.verdict });
  // the one write: ownership, taken explicitly, and only if nobody else got there first
  if (typeof o._beforeCommit === 'function') o._beforeCommit(); // test seam: a competing writer acts between the decision and the commit
  const lock = acquireLock(files.stateAbs);
  if (lock.busy) return rec(refuse('state-busy', 'another writer holds the task state right now: ownership was not taken, try again'), { verdict: d.verdict });
  try {
    const fresh = readText(files.stateAbs);
    let text = stateText;
    let cur = state;
    let dec = d;
    if (fresh !== stateText) {
      cur = fresh === null || fresh.length > MAX_STATE_CHARS ? null : parseTaskState(fresh);
      dec = decideResume({ ...facts, state: cur });
      if (dec.verdict === 'noop') return rec({ result: 'noop', note: 'this agent already holds the task: another writer got there first with the same result', ...base, decision: dec }, { verdict: dec.verdict });
      if (dec.verdict === 'stop' || dec.verdict === 'no-handoff' || !dec.accept.allowed) return rec(refuse(dec.stops[0]?.code ?? 'state-changed', 'the task state changed while ownership was being taken, and another writer won: ' + (dec.stops[0]?.note ?? 'ownership was not taken'), { ...base, decision: dec }), { verdict: dec.verdict });
      text = fresh;
    }
    const cont = cur.continuity;
    let next = withOwner(text, o.agent);
    if (next === null) return rec(refuse('state-owner-line-missing', 'TASK_STATE.md has no owner line to take over'), { verdict: dec.verdict });
    next = withContinuity(next, { taskId: cont.taskId, ownership: 'owned', handoff: dec.handoffId, receiver: null, transferred: { from: r.from, to: o.agent, via: dec.handoffId, at: nowIso(now), acknowledged: dec.driftDigest } }, now);
    atomicWrite(files.stateAbs, next);
    return rec({ result: 'accepted', note: `${o.agent} now owns the task (from ${r.from})`, ...base, state: { path: files.stateRel, owner: o.agent, ownership: 'owned' } }, { verdict: dec.verdict });
  } finally {
    releaseLock(lock);
  }
}

export { ownershipOf, parseTaskState };
