/**
 * Validation execution (ai/AUTOMATION_PROTOCOL.md → Validation, Failure behavior). Planning is separate and pure
 * (validation-plan.mjs); this module only executes a finished plan, and only what the plan says:
 *
 *   - an action runs when it is A1, or A2 and the user's yes names THIS plan (confirmation is specific: one yes covers the plan it
 *     was given for, for this task, and nothing else); an A3 action never runs, whatever was confirmed before;
 *   - the plan must match its id, and right before an action runs its command is READ AGAIN from the project (rediscoverCommand):
 *     a script, hook or classification that changed since planning is refused, and the level is derived again from what is there
 *     now: stricter than planned is refused (unless an exact, scoped opt-in covers it), and A3 never runs;
 *   - a command runs as an argument vector with no shell (`shell: false`), from the project directory, with a time limit, an output
 *     limit and no stdin, under a supervisor that terminates the whole process tree on a timeout; a Windows `.cmd` or `.bat` shim
 *     is refused, never run through a shell;
 *   - nothing is retried, nothing is installed, nothing is changed to make a check pass, and a failure is reported, not hidden;
 *   - command output never enters the result beyond counts and a short, redacted excerpt of a failure, and no absolute path leaves.
 *
 * Results: PASS, FAIL, NOT_RUN, DECLINED, BLOCKED, UNKNOWN. None stands for another: not run is not a pass, declined is not a pass,
 * unknown is not a pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LEVEL_ORDER, classifyArgv } from './validation-classify.mjs';
import { rediscoverCommand, resolveScriptShell } from './validation-discovery.mjs';
import { RESULT_STATUSES, appendedArgsFor, bindingOf, effectiveArgv, normalizeOptIn, optInCovers, planIdOf, setAuthorized } from './validation-plan.mjs';
import { updateTaskState, validationRecord, STATE_FILE } from './validation-state.mjs';

export const RUN_LIMITS = Object.freeze({ timeoutMs: 120000, maxBuffer: 1024 * 1024, excerptLines: 8, excerptChars: 160, jsonBytes: 1024 * 1024 });
/**
 * The environment a child process gets: ours, without any npm_config_* variable (any case). Those variables are an execution-affecting
 * input that the plan does not bind (a script shell, hooks, workspaces); the settings that matter are pinned on the command line instead.
 */
export function cleanEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^npm_config_/i.test(k)));
}
const SUPERVISOR = fileURLToPath(new URL('./validation-supervisor.mjs', import.meta.url));
const WIN = (platform) => platform === 'win32';
const rank = (l) => LEVEL_ORDER.indexOf(l);

/**
 * Resolve an executable name to a real file. `node` is the running Node; `npm` on Windows is run as `node npm-cli.js`; a Windows
 * `.cmd` or `.bat` shim is refused (it could only be run through a shell). Returns { file, prefix } or { refused }.
 */
export function resolveExecutable(name, { platform = process.platform, env = process.env, execPath = process.execPath, exists = (p) => fs.existsSync(p) } = {}) {
  if (name === 'node') return { file: execPath, prefix: [] };
  if (name === 'npm' && WIN(platform)) {
    const cli = path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (exists(cli)) return { file: execPath, prefix: [cli] };
  }
  if (/[\\/]/.test(name) || /\.(cmd|bat)$/i.test(name)) return { refused: WIN(platform) && /\.(cmd|bat)$/i.test(name) ? 'windows-shim' : 'not-a-bare-name' };
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = WIN(platform) ? ['.exe', '.com'] : [''];
  let shim = false;
  for (const d of dirs) {
    for (const e of exts) if (exists(path.join(d, name + e))) return { file: path.join(d, name + e), prefix: [] };
    if (WIN(platform) && ['.cmd', '.bat'].some((e) => exists(path.join(d, name + e)))) shim = true;
  }
  return { refused: shim ? 'windows-shim' : 'not-found' };
}

/**
 * The default process layer: runs the command under validation-supervisor.mjs, which enforces the time and output limits and, on a
 * timeout, terminates the whole process tree and verifies it. Returns a spawnSync-shaped result (plus `treeTerminated`).
 */
export function supervisedSpawn(file, args, options = {}) {
  const timeoutMs = options.timeout ?? RUN_LIMITS.timeoutMs;
  const grace = options.supervisorGraceMs ?? 20000;
  const request = JSON.stringify({ file, args, cwd: options.cwd, env: options.env, timeoutMs, maxBytes: options.maxBuffer ?? RUN_LIMITS.maxBuffer });
  const r = spawnSync(process.execPath, [SUPERVISOR], { input: request, encoding: 'utf8', shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: Math.max(1, timeoutMs + grace), maxBuffer: 4 * 1024 * 1024 });
  const err = (code, message) => Object.assign(new Error(message), { code });
  // The supervisor itself failed or did not finish: whatever it started may still be running, and nothing confirms otherwise.
  if (r.error) return { status: null, signal: r.signal ?? null, stdout: '', stderr: '', treeTerminated: false, supervisorFailed: true, error: err(r.error.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : r.error.code ?? 'ESUPERVISOR', 'the supervisor did not finish') };
  let res;
  try {
    res = JSON.parse(String(r.stdout).trim().split('\n').pop());
  } catch {
    return { status: null, signal: null, stdout: '', stderr: '', treeTerminated: false, supervisorFailed: true, error: err('ESUPERVISOR', 'the supervisor answered nothing readable') };
  }
  return {
    status: res.timedOut || res.overflow ? null : res.status,
    signal: res.signal ?? (res.timedOut ? 'SIGTERM' : null),
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    stdoutLines: res.stdoutLines,
    stderrLines: res.stderrLines,
    treeTerminated: res.treeTerminated,
    error: res.timedOut ? err('ETIMEDOUT', 'timed out') : res.overflow ? err('ENOBUFS', 'output limit') : res.error ? err(res.error, String(res.error)) : undefined,
  };
}

const SECRETISH = /(secret|token|passw(or)?d|passwd|pwd|api[_-]?key|authorization|bearer|private key|credential|-----BEGIN)|[A-Za-z0-9+/_-]{32,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\beyJ[A-Za-z0-9_-]{10,}\.|\bsk-[A-Za-z0-9]{16,}|[A-Za-z0-9._~-]+:[^\s:@/]+@[A-Za-z0-9.-]+|\b[a-z]+:\/\/[^\s/]*:[^\s/@]*@/i;
/** A short excerpt of a failure: redacted, bounded, project-relative. Never stored in state or records. */
function excerptOf(text, root) {
  const rootFwd = root.replace(/\\/g, '/');
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter(Boolean)
    .slice(-RUN_LIMITS.excerptLines)
    .map((l) => {
      let line = l.split(root).join('<project>').split(rootFwd).join('<project>');
      if (SECRETISH.test(line)) line = '[redacted]';
      return line.slice(0, RUN_LIMITS.excerptChars);
    });
}

const inside = (root, rel) => {
  const abs = path.resolve(root, ...String(rel).split('/'));
  const r = path.relative(root, abs);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) ? abs : null;
};

function lineCount(s) {
  return s ? String(s).split(/\r?\n/).filter(Boolean).length : 0;
}

/** Run one argument vector. Never a shell. */
function runProcess(argv, cwdAbs, root, deps, opts) {
  const exe = deps.resolve(argv[0]);
  if (exe.refused) return { status: 'BLOCKED', reason: exe.refused };
  const t0 = Date.now();
  const r = deps.spawn(exe.file, [...exe.prefix, ...argv.slice(1)], { cwd: cwdAbs, env: cleanEnv(process.env), shell: false, windowsHide: true, encoding: 'utf8', timeout: opts.timeoutMs, maxBuffer: RUN_LIMITS.maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
  const evidence = { exitCode: r.status ?? null, signal: r.signal ?? null, durationMs: Date.now() - t0, stdoutLines: r.stdoutLines ?? lineCount(r.stdout), stderrLines: r.stderrLines ?? lineCount(r.stderr) };
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM') {
      const orphanRisk = r.treeTerminated !== true; // only a confirmed termination is a clean timeout
      return {
        status: 'UNKNOWN',
        reason: orphanRisk ? 'timed-out-orphan-risk' : 'timed-out',
        evidence: { ...evidence, timedOut: true, treeTerminated: r.treeTerminated ?? null },
        ...(orphanRisk ? { limitation: 'a check timed out and its process tree could not be confirmed terminated: a child process may still be running' } : {}),
      };
    }
    if (r.error.code === 'ENOENT' || r.error.code === 'EACCES' || r.error.code === 'EINVAL') return { status: 'BLOCKED', reason: 'failed-to-start', evidence };
    if (r.error.code === 'ENOBUFS') {
      const risk = r.treeTerminated !== true;
      return { status: 'UNKNOWN', reason: risk ? 'output-limit-orphan-risk' : 'output-limit', evidence: { ...evidence, treeTerminated: r.treeTerminated ?? null }, ...(risk ? { limitation: 'a check exceeded the output limit and its process tree could not be confirmed terminated: a child process may still be running' } : {}) };
    }
    if (r.supervisorFailed || r.error.code === 'ESUPERVISOR') return { status: 'UNKNOWN', reason: 'supervisor-failed-orphan-risk', evidence, limitation: 'the process supervisor failed: a started process may still be running' };
    return { status: 'UNKNOWN', reason: 'spawn-error', evidence };
  }
  if (r.status === 0) return { status: 'PASS', evidence };
  if (r.status === null) return { status: 'UNKNOWN', reason: `terminated-by-${r.signal ?? 'signal'}`, evidence };
  return { status: 'FAIL', reason: `exit-status-${r.status}`, evidence: { ...evidence, excerpt: excerptOf(`${r.stderr ?? ''}\n${r.stdout ?? ''}`, root) } };
}

/** The toolchain's own parse-only checks of the changed files, one process per JavaScript file, in-process for JSON. */
function runSyntax(action, root, deps, opts) {
  let ok = 0;
  const failures = [];
  const t0 = Date.now();
  for (const f of action.files ?? []) {
    const abs = inside(root, f.path);
    if (!abs) return { status: 'BLOCKED', reason: 'path-outside-project' };
    if (f.check === 'json-parse') {
      try {
        const st = fs.statSync(abs);
        if (st.size > RUN_LIMITS.jsonBytes) return { status: 'UNKNOWN', reason: 'file-too-large', evidence: { files: action.files.length } };
        JSON.parse(fs.readFileSync(abs, 'utf8'));
        ok++;
      } catch (e) {
        if (e.code === 'ENOENT') failures.push(`${f.path}: file not found`);
        else failures.push(`${f.path}: ${String(e.message).split('\n')[0].slice(0, 120)}`);
      }
    } else {
      const r = runProcess(['node', '--check', f.path.startsWith('-') ? `./${f.path}` : f.path], root, root, deps, opts);
      if (r.status === 'PASS') ok++;
      else if (r.status === 'FAIL') failures.push(`${f.path}: ${(r.evidence.excerpt ?? []).slice(0, 2).join(' ')}`);
      else return { ...r, evidence: { ...(r.evidence ?? {}), files: action.files.length, checked: ok } };
    }
  }
  const evidence = { files: action.files.length, passed: ok, failed: failures.length, durationMs: Date.now() - t0, ...(failures.length ? { excerpt: failures.slice(0, RUN_LIMITS.excerptLines).map((l) => (SECRETISH.test(l) ? '[redacted]' : l)) } : {}) };
  return failures.length ? { status: 'FAIL', reason: `${failures.length} file(s) do not parse`, evidence } : { status: 'PASS', evidence };
}

const PRECEDENCE = ['FAIL', 'BLOCKED', 'DECLINED', 'UNKNOWN', 'NOT_RUN', 'PASS'];

/**
 * Read the command of an action again and decide whether it may still run as planned.
 * @returns {{ok: true, runtime: {level, reasons}} | {ok: false, reason: string, note?: string}}
 */
function recheck(a, root, verify, optIns, ctx) {
  const argvLevel = classifyArgv(a.command.argv).level; // only an A3 reading of the bare argv is conclusive (it cannot see scripts)
  if (argvLevel === 'A3' || a.level === 'A3') return { ok: false, reason: 'a3-never-automatic', blockedReasons: a.classification?.reasons ?? [] };
  let runtime = a.classification ?? { level: 'A2', reasons: ['unclear-command'] };
  let baseArgv = null;
  let freshExecution = null;
  if (verify) {
    const fresh = rediscoverCommand(root, a.commandId);
    if (!fresh) return { ok: false, reason: 'command-no-longer-defined' };
    const same = fresh.scriptDigest === a.scriptDigest && fresh.cwd === a.command.cwd && JSON.stringify(a.command.argv.slice(0, fresh.argv.length)) === JSON.stringify(fresh.argv);
    if (!same) return { ok: false, reason: 'command-changed-since-planning', note: 'the script, a hook, the manifest or the command differs from what was planned: plan again' };
    runtime = fresh.classification;
    baseArgv = fresh.argv;
    freshExecution = fresh.execution ?? null;
  }
  // The only arguments that may follow the command are the plan's own files, project-relative, exactly as the planner derives them.
  const expected = appendedArgsFor(a.files ?? [], a.command.cwd);
  if (expected === null) return { ok: false, reason: 'appended-argument-unsafe', note: 'a planned file is absolute, leaves the project, or matches a secret pattern' };
  // argv is the manifest command (named in the plan, and read again from the manifest) followed by exactly those arguments, nothing else
  const base = a.command.baseArgv;
  if (!Array.isArray(base) || !base.length || base.some((x) => typeof x !== 'string') || (baseArgv && JSON.stringify(base) !== JSON.stringify(baseArgv))) return { ok: false, reason: 'command-changed-since-planning', note: 'the command to run is not the one the manifest defines' };
  if (JSON.stringify(a.command.argv) !== JSON.stringify([...base, ...expected])) return { ok: false, reason: 'appended-arguments-not-planned', note: 'the arguments after the command are not exactly the planned files' };
  // How a package manager is executed must be pinned and must be what the plan says: an unpinned manager is not run at all.
  let shellPath = null;
  const exe0 = a.command.argv[0];
  if (['npm', 'yarn', 'pnpm', 'bun'].includes(exe0)) {
    const ex = a.command.execution;
    if (!ex || ex.manager !== exe0 || ex.pinned === false || exe0 !== 'npm') return { ok: false, reason: 'execution-environment-unpinned', note: exe0 + ' cannot be pinned (its configuration decides what a script runs under): not run' };
    if (verify && JSON.stringify(freshExecution) !== JSON.stringify(ex)) return { ok: false, reason: 'command-changed-since-planning', note: 'the way the command is executed differs from what was planned' };
    const sh = ctx.shell();
    if (sh.refused) return { ok: false, reason: 'execution-environment-unavailable', note: 'the script shell to pin could not be determined: not run under unknown behavior' };
    if (ex.shellDigest && sh.digest !== ex.shellDigest) return { ok: false, reason: 'execution-environment-changed', note: 'the script shell is not the one that was planned' };
    shellPath = sh.path;
  }
  if (argvLevel === 'A3') runtime = { level: 'A3', reasons: [...new Set([...runtime.reasons, 'unclear-command'])].sort() };
  if (runtime.level === 'A3' || a.level === 'A3') return { ok: false, reason: 'a3-never-automatic', blockedReasons: runtime.reasons };
  // Never silently upgrade a permission: a level now stricter than the planned one is refused, unless an exact, scoped opt-in covers it.
  let effective = runtime.level;
  if (effective === 'A2' && optInCovers(optIns, { ...a, classification: runtime })) effective = 'A1';
  // At V3 and V4 an action is A1 only when the authorization of THIS set is presented again: a plan lowered by a set cannot be replayed.
  if (ctx.n >= 3 && effective === 'A1' && !ctx.setOk) effective = 'A2';
  if (rank(effective) > rank(a.level)) return { ok: false, reason: 'runtime-classification-stricter', note: `planned ${a.level}, now ${runtime.level} (${runtime.reasons.join(', ')})` };
  return { ok: true, runtime, shellPath };
}

/**
 * Execute a plan. Nothing outside the plan runs.
 * @param {object} plan   from planValidation
 * @param {string} root   the project root (absolute)
 * @param {object} opts   { execute (default false), confirm: { planId, proposals: [ids] } | null, standingOptIn: [{type, reason, scope}] (the same
 *                          list the plan was made with), timeoutMs, continueAfterFailure, previous: { planId, contentKey, status }, contentKey,
 *                          deps: { spawn, resolve }, verify (false only together with an injected spawn: nothing real runs) }
 */
export function runValidationPlan(plan, root, opts = {}) {
  const deps = { spawn: opts.deps?.spawn ?? supervisedSpawn, resolve: opts.deps?.resolve ?? ((n) => resolveExecutable(n)) };
  const verify = opts.verify !== false || !opts.deps?.spawn; // real processes are never started without re-reading the command
  const optIns = normalizeOptIn(opts.standingOptIn);
  const depthN = Number(String(plan.depth ?? 'V0').slice(1));
  const rctx = { n: depthN, setOk: depthN >= 3 && setAuthorized(optIns, { depth: plan.depth, risk: plan.risk, actions: plan.actions ?? [] }), shell: opts.deps?.shell ?? (() => resolveScriptShell()) };
  const shellOf = new Map();
  const o = { timeoutMs: opts.timeoutMs ?? RUN_LIMITS.timeoutMs };
  const out = [];
  const limitations = [...(plan.limitations ?? [])];
  const base = { id: null, type: null, level: null, status: 'NOT_RUN' };
  const push = (a, extra) => {
    if (extra.limitation) limitations.push(extra.limitation);
    const { limitation, ...rest } = extra;
    out.push({ ...base, id: a.id, type: a.type, level: a.level, ...rest });
  };
  const required = plan.required !== false;

  const integrity = planIdOf(plan.depth, plan.actions ?? [], bindingOf(plan)) === plan.planId;
  // A reused result is trusted only while the plan is intact and every command is still defined as it was.
  const stillTrustworthy = () => integrity && (!verify || (plan.actions ?? []).every((a) => !a.command || rediscoverCommand(root, a.commandId)?.scriptDigest === a.scriptDigest));
  // Unchanged content, plan already passed: the check is not repeated (a noop, never an error). Nothing is executed by a reused result.
  if (required && opts.previous && opts.previous.status === 'PASS' && opts.contentKey && opts.previous.contentKey && String(opts.contentKey).startsWith(String(opts.previous.contentKey)) && String(plan.planId).startsWith(String(opts.previous.planId)) && stillTrustworthy()) {
    return finishResult(plan, (plan.actions ?? []).map((a) => ({ id: a.id, type: a.type, level: a.level, status: 'PASS', reason: 'unchanged-content', reused: true })), limitations, { reused: true, required, previous: opts.previous });
  }

  if (!integrity) limitations.push('the plan does not match its id: nothing was run');
  const confirmedPlan = !!opts.confirm && opts.confirm.planId === plan.planId;
  const confirmedProposals = new Set(confirmedPlan ? opts.confirm.proposals ?? [] : []);
  const proposalOf = (a) => (plan.confirmationRequired ?? []).find((p) => p.actionIds.includes(a.id));
  let stop = false;

  if (required) {
    for (const a of plan.actions ?? []) {
      if (!integrity) { push(a, { status: 'BLOCKED', reason: 'plan-integrity' }); continue; }
      if (a.level === 'A3') { push(a, { status: 'BLOCKED', reason: 'a3-never-automatic', blockedReasons: a.reasons }); continue; }
      if (a.level !== 'A1' && a.level !== 'A2') { push(a, { status: 'BLOCKED', reason: 'unknown-level' }); continue; }
      const isProc = !(a.type === 'syntax' && !a.command);
      // At V3 and V4 an action planned as A1 was lowered by a set authorization: every kind of action needs it again, not only a process.
      if (!isProc && rctx.n >= 3 && a.level === 'A1' && !rctx.setOk) { push(a, { status: 'BLOCKED', reason: 'runtime-classification-stricter', note: 'planned A1 by a validation-set authorization that was not presented again for this exact set' }); continue; }
      if (isProc && (!a.command || a.command.kind !== 'process' || !Array.isArray(a.command.argv) || a.command.argv.some((x) => typeof x !== 'string'))) { push(a, { status: 'BLOCKED', reason: 'not-an-argument-vector' }); continue; }
      // 1. Every action is classified again here, from the command as it is NOW; the plan's word is not enough.
      if (isProc) {
        const c = recheck(a, root, verify, optIns, rctx);
        if (c.ok) shellOf.set(a.id, c.shellPath);
        if (!c.ok) { push(a, { status: 'BLOCKED', reason: c.reason, ...(c.note ? { note: c.note } : {}), ...(c.blockedReasons ? { blockedReasons: c.blockedReasons } : {}) }); continue; }
      }
      // 2. A2 needs a yes that names this plan; a decline is specific to its reason.
      if (a.level === 'A2') {
        const p = proposalOf(a);
        if (!p) { push(a, { status: 'BLOCKED', reason: 'a2-without-proposal' }); continue; }
        if (p.declined) { push(a, { status: 'DECLINED', reason: `declined-${p.reason}` }); continue; }
        if (!confirmedProposals.has(p.id)) { push(a, { status: 'NOT_RUN', reason: 'awaiting-confirmation', proposal: p.id }); continue; }
      }
      if (!opts.execute) { push(a, { status: 'NOT_RUN', reason: 'execution-not-requested' }); continue; }
      if (stop) { push(a, { status: 'NOT_RUN', reason: 'stopped-after-failure' }); continue; }
      // 3. Run exactly this action.
      let r;
      if (!isProc) r = runSyntax(a, root, deps, o);
      else {
        const cwd = inside(root, a.command.cwd ?? '.');
        r = cwd && fs.existsSync(cwd) ? runProcess(effectiveArgv(a.command, shellOf.get(a.id)), cwd, root, deps, o) : { status: 'BLOCKED', reason: 'directory-outside-project-or-missing' };
      }
      push(a, r);
      if (r.status === 'FAIL' && !opts.continueAfterFailure) stop = true;
    }
    for (const u of plan.unresolved ?? []) out.push({ ...base, id: u.scope ? `${u.type}@${u.scope}` : u.type, type: u.type, level: null, status: 'UNKNOWN', reason: u.reason, note: u.note });
  }
  if (out.some((x) => x.evidence && x.level === 'A2')) limitations.push('an A2 action ran on a confirmation supplied by the caller: this tool cannot verify that the user gave it (the adapter must obtain the yes)');
  if ((plan.actions ?? []).some((a) => a.loweredBy && out.some((x) => x.id === a.id && x.evidence))) limitations.push('an action ran under a standing opt-in supplied by the caller: this tool cannot verify its source');
  return finishResult(plan, out, limitations, { required, executeRequested: !!opts.execute });
}

function finishResult(plan, actions, limitations, extra) {
  const ids = (s) => actions.filter((a) => a.status === s).map((a) => a.id);
  const counts = Object.fromEntries(RESULT_STATUSES.map((s) => [s, ids(s).length]));
  const executed = actions.filter((a) => a.evidence && a.status !== 'BLOCKED').map((a) => a.id);
  let status;
  if (extra.required === false) status = 'NOT_RUN';
  else status = PRECEDENCE.find((s) => counts[s] > 0) ?? 'NOT_RUN';
  // Success needs every planned action to have passed AND nothing prohibited, unresolved or still waiting; an empty plan proves nothing.
  if (status === 'PASS' && (!actions.length || (plan.prohibited ?? []).length)) status = (plan.prohibited ?? []).length ? 'BLOCKED' : 'NOT_RUN';
  const confidence = status === 'PASS' ? plan.confidence ?? 'medium' : status === 'NOT_RUN' && extra.required === false ? 'n/a' : 'low';
  const result = {
    v: 1,
    planId: plan.planId,
    status,
    depth: plan.depth,
    risk: plan.risk,
    required: extra.required,
    ...(extra.reused ? { reused: true } : {}),
    actions,
    executed,
    passed: ids('PASS'),
    failed: ids('FAIL'),
    notRun: ids('NOT_RUN'),
    declined: ids('DECLINED'),
    blocked: [...ids('BLOCKED'), ...(plan.prohibited ?? []).filter((p) => !actions.some((a) => a.id === p.id)).map((p) => p.id)],
    unknown: ids('UNKNOWN'),
    evidence: {
      counts,
      failures: actions.filter((a) => a.status === 'FAIL').map((a) => ({ id: a.id, reason: a.reason, excerpt: a.evidence?.excerpt ?? [] })),
      ...(extra.reused ? { reused: { note: 'an earlier passing result for unchanged content was kept: nothing was executed in this invocation', planId: String(extra.previous.planId), contentKey: String(extra.previous.contentKey) } } : {}),
    },
    limitations: [...new Set(limitations)],
    confidence,
  };
  result.record = validationRecord({ phase: 'completed', plan, result });
  return result;
}

/**
 * Write the outcome into the project's TASK_STATE.md (A1 for the current owner; the one canonical state record): the file is read,
 * the pure update is computed, an identical result is skipped, and nothing but that one file in the project is written.
 */
export function applyValidationToTaskState(root, rel, result, ctx) {
  const target = rel ?? `.ai/${STATE_FILE}`;
  const abs = inside(root, target);
  if (!abs || path.basename(abs) !== STATE_FILE) return { refused: 'not-a-task-state-path', changed: false, created: false, skipped: null, text: null };
  let text = null;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    text = null;
  }
  const u = updateTaskState(text, result, ctx);
  if (u.changed && u.text) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, u.text);
  }
  return { ...u, text: undefined, path: target.replace(/\\/g, '/') };
}
