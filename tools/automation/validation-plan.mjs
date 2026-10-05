/**
 * Automatic validation planning (ai/VALIDATION_PROTOCOL.md, ai/AUTOMATION_PROTOCOL.md → Validation). Pure: it receives the task,
 * the Phase 5D impact report, the Phase 5C routing result and the commands discovery found, and returns ONE plan. It reads no
 * file, runs no command, spawns nothing, writes nothing: a plan can always be made without executing anything.
 *
 * What it reuses and does not rebuild:
 *   depth V0..V4, class and risk floors   context-router.mjs (validationNeeds): the one place those rules live
 *   impact, tests, dimensions, public surface   the Phase 5D report (null stays unknown, never "none")
 *   automation levels, proposals          ai/AUTOMATION_PROTOCOL.md (A1 safe, A2 confirm, A3 never)
 *   command classification                validation-classify.mjs
 *   commands                              validation-discovery.mjs, from the project's own manifests; nothing is invented
 *
 * What it decides: the depth (never lowered), which checks, in which order (narrowest first), the level of each, which are
 * proposed (A2) and under which reason, which are prohibited (A3), what counts as success, and what stays unverified.
 *
 * Identity: `planId` is a SHA-256 over everything an action's permission depends on (see planIdOf): not only what would run but
 * also the digest of the script behind it, its classification, its level and the proposals that cover it. The script text itself
 * is never part of a plan, only its digest and a bounded, redacted summary.
 */
import { createHash } from 'node:crypto';
import { CLASSES, RISKS } from './refresh-decision.mjs';
import { validationNeeds } from './context-router.mjs';
import { ACTION_TYPES, A2_REASONS, NEVER_LOWERABLE, PATTERN_CHARS, PATTERN_RUNNERS, executionFor, summarizeScript } from './validation-classify.mjs';

export { effectiveArgv, executionFor, pinArgs } from './validation-classify.mjs';
import { RoutingInputError, cleanPath, isSecretPath } from './path-safety.mjs';

export { RoutingInputError };

/** Operational bounds (no canonical number exists); exceeding one is always reported, never silent. */
export const VALIDATION_BOUNDS = Object.freeze({ actions: 12, syntaxFiles: 8, testFiles: 20 });
export const RESULT_STATUSES = Object.freeze(['PASS', 'FAIL', 'NOT_RUN', 'DECLINED', 'BLOCKED', 'UNKNOWN']);

const RISK_RANK = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 });
const unique = (xs) => [...new Set(xs)];
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const depthNum = (d) => Number(String(d ?? 'V0').slice(1));
const maxRisk = (a, b) => ((RISK_RANK[b] ?? 0) > (RISK_RANK[a] ?? 0) ? b : a);
const bound = (limit, total, returned) => ({ limit, total, returned, omitted: total - returned, truncated: total > returned });
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// ---- identity -----------------------------------------------------------------------------------------------------------

/** Everything about one action that its permission depends on. */
const identityOf = (a) => [a.id, a.type, a.level, a.command ?? null, a.files ?? null, a.commandId ?? null, a.scriptDigest ?? null, a.classification ?? null, a.reasons ?? null, a.source ?? null, a.scope ?? null, a.scopePaths ?? null, a.hooks ?? null];

/** What else a plan's permission depends on: the proposals that cover its actions, whether it is required, what is prohibited or unresolved. */
export function bindingOf(plan) {
  return {
    proposals: (plan.confirmationRequired ?? []).map((p) => [p.id, p.reason, p.actionIds]),
    required: plan.required !== false,
    risk: plan.risk ?? null,
    class: plan.class ?? null,
    evaluated: plan.evaluated !== false,
    prohibited: (plan.prohibited ?? []).map((p) => p.id),
    unresolved: (plan.unresolved ?? []).map((u) => [u.type, u.reason, u.scope ?? null]),
  };
}

/** The identity of a plan: a SHA-256 over the depth, every action's identity and the binding. Two plans that differ in anything that decides what may run have different ids. */
export function planIdOf(depth, actions, binding = {}) {
  return sha256(JSON.stringify([depth, actions.map(identityOf), binding])).slice(0, 32);
}

// ---- opt-in (rule 3 of ai/AUTOMATION_PROTOCOL.md → Automation levels) --------------------------------------------------------

const SHA256 = /^[0-9a-f]{64}$/;
/** The canonical scope id of an action: "project", or "path:<dir>" for the directory of its manifest. */
export const scopeIdOf = (cwd) => (cwd === '.' ? 'project' : 'path:' + cwd);

/**
 * A standing opt-in lowers ONE named A2 action to A1 (rule 3 of ai/AUTOMATION_PROTOCOL.md: "for a named action and scope"):
 *   { commandId, scriptDigest, type, reason, scope }
 * commandId and scriptDigest name the command and the exact definition it was approved for (a changed script is another action),
 * type is its check type, reason is EXACTLY the set of A2 reasons the action has (neither more nor fewer), and scope is its
 * canonical scope id ("project" or "path:<dir>", exactly: neither broader nor narrower). It lowers nothing else and never an A3.
 * The V3/V4 set is authorized by its own identity (setIdOf): { type: 'validation-set', setId, depth, riskCeiling, scope: 'project' } names
 * ONE plan: its depth, its risk and every action in it (command id, definition digest, scope, reasons, planned files). Any change
 * to any of them is another set, and the old authorization does not apply. It is never persisted and is checked again at run time.
 */
export function normalizeOptIn(list = []) {
  return (list ?? []).map((o) => {
    if (!o || typeof o !== 'object') throw new RoutingInputError('an opt-in is { commandId, scriptDigest, type, reason, scope }');
    if (![...ACTION_TYPES, 'validation-set'].includes(o.type)) throw new RoutingInputError('unknown opt-in type "' + String(o.type).slice(0, 40) + '" (known: ' + [...ACTION_TYPES, 'validation-set'].join(', ') + ')');
    const reasons = unique([].concat(o.reason ?? o.reasons ?? []).map(String)).sort(cmp);
    if (o.type !== 'validation-set' && !reasons.length) throw new RoutingInputError('an opt-in names the exact reasons it lowers: { commandId, scriptDigest, type, reason, scope }');
    const bad = o.type === 'validation-set' ? undefined : reasons.find((r) => !A2_REASONS.includes(r));
    if (bad) throw new RoutingInputError('unknown opt-in reason "' + bad.slice(0, 40) + '" (known: ' + A2_REASONS.join(', ') + ')');
    const never = reasons.find((r) => NEVER_LOWERABLE.includes(r));
    if (never) throw new RoutingInputError('"' + never + '" can never be lowered by an opt-in');
    const rawScope = [].concat(o.scope ?? []).map(String);
    if (rawScope.length !== 1) throw new RoutingInputError('an opt-in names exactly one scope: "project" or "path:<dir>"');
    if (o.type === 'validation-set') {
      if (rawScope[0] !== 'project') throw new RoutingInputError('a validation-set authorization has scope "project"');
      if (!/^[0-9a-f]{32}$/.test(String(o.setId ?? ''))) throw new RoutingInputError('a validation-set authorization names its plan: setId (32 hex digits, printed by the proposal)');
      if (!['V3', 'V4'].includes(o.depth)) throw new RoutingInputError('a validation-set authorization names its depth: V3 or V4');
      if (!RISKS.includes(o.riskCeiling)) throw new RoutingInputError('a validation-set authorization names its risk ceiling: ' + RISKS.join(', '));
      return { type: 'validation-set', setId: o.setId, depth: o.depth, riskCeiling: o.riskCeiling, reasons: ['validation-set'], scope: 'project' };
    }
    if (reasons.includes('validation-set')) throw new RoutingInputError('"validation-set" is the reason of the set, not of an action');
    if (typeof o.commandId !== 'string' || !o.commandId.trim() || o.commandId.length > 200) throw new RoutingInputError('an opt-in names the command it lowers: commandId');
    if (!SHA256.test(String(o.scriptDigest ?? ''))) throw new RoutingInputError('an opt-in names the definition it was approved for: scriptDigest (64 hex digits)');
    const raw = rawScope[0];
    const scope = raw === 'project' || raw.startsWith('path:') ? (raw === 'project' ? raw : 'path:' + cleanPath(raw.slice(5))) : 'path:' + cleanPath(raw);
    return { commandId: o.commandId, scriptDigest: o.scriptDigest, type: o.type, reasons, scope };
  });
}

/** The opt-in that names exactly this action (command, definition, type, the whole reason set, scope), or null. An A3 is never covered. */
export function optInCovers(optIns, action) {
  const c = action.classification;
  if (!c || c.level !== 'A2' || !c.reasons.length || c.reasons.some((r) => NEVER_LOWERABLE.includes(r))) return null;
  const reasons = [...c.reasons].sort(cmp);
  for (const o of optIns ?? []) {
    if (o.type === 'validation-set' || o.type !== action.type) continue;
    if (o.commandId !== action.commandId || o.scriptDigest !== action.scriptDigest) continue;
    if (o.reasons.length !== reasons.length || !o.reasons.every((r, i) => r === reasons[i])) continue;
    if (o.scope !== action.scope) continue;
    return o;
  }
  return null;
}

/**
 * The identity of the V3/V4 set a plan would be: SHA-256 over its depth, its risk, its scope and, for every action, the command id,
 * the digest of the definition, the type, the scope, the planned level and reasons (before any opt-in) and the planned files.
 * It does not depend on any opt-in, so the authorization can be produced from the proposal before the plan is lowered.
 */
export function setIdOf({ depth, risk, scope = 'project', actions }) {
  const bindings = actions.map((a) => [a.id, a.commandId ?? null, a.scriptDigest ?? null, a.type, a.scope, a.classification.level, [...a.classification.reasons].sort(cmp), a.files ?? null]).sort((x, y) => cmp(x[0], y[0]));
  return sha256(JSON.stringify(['validation-set', depth, risk, scope, bindings])).slice(0, 32);
}

/** The authorization (the exact opt-in) that would lower the set of this plan, for the proposal to print. */
export function setAuthorizationFor({ depth, risk, actions }) {
  const setId = setIdOf({ depth, risk, actions });
  return { type: 'validation-set', setId, depth, riskCeiling: risk, scope: 'project', reasons: ['validation-set'], entry: ['validation-set', setId, depth, risk, 'project'].join('|') };
}

/** Whether one of the authorizations names exactly this set: same set id, same depth, same risk. */
export function setAuthorized(optIns, { depth, risk, actions }) {
  const setId = setIdOf({ depth, risk, actions });
  return (optIns ?? []).some((o) => o.type === 'validation-set' && o.setId === setId && o.depth === depth && o.riskCeiling === risk);
}

// ---- effective depth ----------------------------------------------------------------------------------------------------

/**
 * The class and risk the plan is for, and the depth. The class is the HIGHEST of every authoritative input (the task, the
 * router, the impact report), the risk likewise, and impact and routing may only raise the depth that the canonical rule
 * (VALIDATION_PROTOCOL.md: HIGH uses the next class's validation, CRITICAL the ARCHITECTURAL one) gives: nothing lowers it.
 */
export function effectiveDepth({ task = {}, impact = null, routing = null } = {}) {
  if (task.taskClass != null && !CLASSES.includes(task.taskClass)) throw new RoutingInputError(`unknown task class "${task.taskClass}"`);
  if (task.risk != null && !RISKS.includes(task.risk)) throw new RoutingInputError(`unknown risk "${task.risk}"`);
  const classes = [task.taskClass, routing?.class, impact?.class?.value].filter((c) => c != null && CLASSES.includes(c));
  const cls = classes.length ? classes.reduce((a, b) => (CLASSES.indexOf(b) > CLASSES.indexOf(a) ? b : a)) : null;
  const risk = [task.risk, impact?.risk?.level, routing?.risk].reduce((r, x) => (x ? maxRisk(r, x) : r), 'LOW');
  const own = validationNeeds(cls, risk);
  const floors = [impact?.requiredValidation?.depth, routing?.validationNeeds?.depth].filter(Boolean);
  const n = Math.max(depthNum(own.depth), ...floors.map(depthNum));
  const raisedBy = floors.some((f) => depthNum(f) > depthNum(own.depth)) ? 'impact or routing' : null;
  return { class: cls, risk, depth: `V${n}`, basis: own.basis, raisedBy };
}

// ---- helpers ------------------------------------------------------------------------------------------------------------

const IMPACT_LIMITATIONS_CARRIED = 20;
/** What the execution of an npm action does and does not bind (they never change a plan's confidence: they are standing facts). */
export const NPM_EXECUTION_NOTES = Object.freeze([
  'pinned and bound: the script shell, whether lifecycle scripts run and where the node path goes are passed on the command line and are part of the plan identity; npm_config_* variables are removed from the child environment',
  'not pinned: workspace selection and any other npm setting a .npmrc or the environment may supply; npm itself may still read a .npmrc',
  'not bound: a user-level .npmrc, a global .npmrc, NODE_OPTIONS and the rest of the inherited environment',
]);
/** The impact report's limitations: at most 20, each at most 300 characters, any word that is a secret path replaced. */
function carryLimitations(list) {
  const all = (list ?? []).map(String);
  const clean = (l) => l.split(/(\s+)/).map((tok) => (isSecretPath(tok.replace(/^[("'`]+|[)"'`,.;:]+$/g, '')) ? '[withheld]' : tok)).join('').slice(0, 300);
  return { shown: all.slice(0, IMPACT_LIMITATIONS_CARRIED).map(clean), omitted: Math.max(0, all.length - IMPACT_LIMITATIONS_CARRIED) };
}

const SYNTAX_EXT = { '.js': 'node-check', '.mjs': 'node-check', '.cjs': 'node-check', '.json': 'json-parse' };
const extOf = (p) => (p.includes('.') ? p.slice(p.lastIndexOf('.')).toLowerCase() : '');

/** The command (project-declared) that governs a path: the nearest manifest directory above it, else the root. */
function cwdFor(file, cwds) {
  let best = '.';
  for (const c of cwds) if (c !== '.' && (file === c || file.startsWith(`${c}/`)) && c.length > best.length) best = c;
  return best;
}

const PREFER = { 'unit-test': ['test', 'test:unit', 'unit'], lint: ['lint'], 'type-check': ['typecheck', 'type-check', 'tsc', 'types'], build: ['build'], 'integration-test': ['test:integration', 'integration', 'test:e2e', 'e2e'] };
function pickCommand(commands, type, cwd) {
  const mine = commands.filter((c) => c.type === type && c.cwd === cwd);
  if (!mine.length) return null;
  const nameOf = (c) => c.id.split(':').slice(2).join(':');
  for (const p of PREFER[type] ?? []) {
    const hit = mine.find((c) => nameOf(c) === p);
    if (hit) return hit;
  }
  return [...mine].sort((a, b) => cmp(a.id, b.id))[0];
}

/** A2 reason that names a proposal: the first applicable, in a fixed order, so that a decline is specific to it. */
const A2_ORDER = ['network-possible', 'external-tool', 'expensive', 'mutating', 'shell-construct', 'env-expansion', 'env-assignment', 'long-running', 'inferred-from-config', 'project-script', 'unclear-command'];
const primaryReason = (reasons) => A2_ORDER.find((r) => reasons.includes(r)) ?? 'unclear-command';

/** Why a build can be affected (VALIDATION_PROTOCOL.md: configuration, dependencies, build-time code, public exports). Unknown is not "none". */
function buildRelevance(task, impact) {
  const reasons = [];
  const types = task.taskTypes ?? [];
  if (types.some((t) => ['dependency', 'configuration', 'build', 'migration'].includes(t))) reasons.push('task-type');
  if (impact?.dimensions?.configuration?.present === true) reasons.push('configuration');
  if ((impact?.publicSurfaceImpact?.changed ?? []).length) reasons.push('public-exports');
  const unknown = !impact || impact.dimensions?.configuration?.present === null || impact.publicSurfaceImpact?.changed === null;
  if (!reasons.length && unknown) reasons.push('impact-unknown');
  return reasons;
}

/** A project-relative path in its canonical form, or null when it is absolute, leaves the project, is empty, has control characters or matches a secret pattern. */
export function safeProjectPath(p) {
  let t = String(p ?? '').replace(/\\/g, '/');
  while (t.startsWith('./')) t = t.slice(2);
  if (!t || t.startsWith('/') || /^[A-Za-z]:/.test(t) || /[\0-\x1f]/.test(t) || t.split('/').includes('..') || t.split('/').includes('') || isSecretPath(t)) return null;
  return t;
}

const toCwdRelative = (p, cwd) => {
  const rel = cwd === '.' ? p : p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p;
  return rel.startsWith('-') ? './' + rel : rel;
};

/**
 * The ONLY arguments a plan may append to a project command: its planned test files, project-relative, relative to the
 * directory the command runs in. The runner computes this again from the plan's files and refuses any other argument list.
 * Returns null when a planned file is not a safe project path.
 */
export function appendedArgsFor(files, cwd) {
  const out = [];
  for (const f of files ?? []) {
    const c = safeProjectPath(f);
    if (c === null) return null;
    out.push(toCwdRelative(c, cwd));
  }
  return out;
}

// ---- the plan -----------------------------------------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {object} input.task      { taskClass, risk, taskTypes, intent ('change'|'read-only'), changedFiles: [{path, status}] }
 * @param {object} [input.impact]  the Phase 5D report (analyzeChangeImpact), or null
 * @param {object} [input.routing] the Phase 5C result (routeContext), or null
 * @param {object} [input.project] { commands (validation-discovery.mjs), standingOptIn: [{type, reason, scope}], declined: [reason], limitations }
 */
export function planValidation({ task = {}, impact = null, routing = null, project = {} } = {}) {
  const eff = effectiveDepth({ task, impact, routing });
  const depth = eff.depth;
  const n = depthNum(depth);
  const optIns = normalizeOptIn(project.standingOptIn);
  const limitations = [...(project.limitations ?? [])];
  const rationale = [];
  const commands = project.commands ?? [];
  const intent = task.intent === 'read-only' ? 'read-only' : 'change';
  const types = task.taskTypes ?? [];
  const docOnly = types.length > 0 && types.every((t) => t === 'documentation');

  // The changed files: from the impact report (which already withheld secret paths) or the task; never a secret path.
  const rawFiles = (impact?.changedFiles ?? task.changedFiles ?? []).map((f) => ({ path: cleanPath(f.path), status: f.status ?? 'modified' }));
  const files = rawFiles.filter((f) => !isSecretPath(f.path));
  const impactWithheld = (impact?.withheld ?? []).map((p) => String(p));
  const withheldCount = rawFiles.length - files.length + impactWithheld.length;
  const remainingChanged = Number(impact?.batching?.remainingChangedFiles ?? 0) || 0;
  // Every requested path withheld: nothing could be evaluated. That is unknown, never "not required".
  const allWithheld = impact?.evidence?.allWithheld === true || (files.length === 0 && withheldCount > 0);
  const existing = files.filter((f) => f.status !== 'deleted').map((f) => f.path);

  const required = intent !== 'read-only' && !(docOnly && !allWithheld) && (files.length > 0 || allWithheld);
  const notRequiredWhy = intent === 'read-only' ? 'read-only task: validation does not fire' : docOnly && !allWithheld ? 'documentation-only change: nothing executable changed' : !files.length && !allWithheld ? 'no changed file' : null;
  if (notRequiredWhy) rationale.push(notRequiredWhy);
  if (withheldCount) limitations.push(`${withheldCount} changed path(s) match secret patterns and are not part of any validation: nothing is invented for hidden files`);

  // What the impact report really established about tests (null = unknown, never "none").
  const testsKnown = !!impact && impact.affectedTests?.direct !== null && impact.affectedTests?.direct !== undefined;
  const testsTruncated = !!impact?.bounded?.tests?.truncated;
  const impactState = !impact ? 'absent' : impact.graph?.used === false || impact.evidence?.graph === 'unknown' ? 'unknown' : impact.completeness === 'PARTIAL' ? 'partial' : impact.completeness === 'BOUNDED_COMPLETE' ? 'bounded' : 'complete';

  const actions = [];
  const unresolved = [];
  const absent = [];
  const addAction = (a) => actions.push({ order: actions.length + 1, ...a });
  const cwds = unique(commands.map((c) => c.cwd));
  const fromCommand = (cmd, type, extra) => ({
    id: `${type}@${cmd.cwd}`,
    type,
    source: cmd.origin,
    sourceRef: cmd.source,
    commandId: cmd.id,
    scriptDigest: cmd.scriptDigest ?? sha256(JSON.stringify([cmd.script ?? '', cmd.hooks ?? []])),
    scriptSummary: cmd.scriptSummary ?? summarizeScript(cmd.script ?? ''),
    hooks: cmd.hooks ?? [],
    npmConfig: cmd.npmConfig ?? [],
    scope: cmd.cwd === '.' ? 'project' : `path:${cmd.cwd}`,
    scopePaths: extra?.files?.length ? extra.files : [cmd.cwd === '.' ? 'project' : cmd.cwd],
    command: { kind: 'process', execution: cmd.execution ?? executionFor(cmd.argv[0]), baseArgv: [...cmd.argv], argv: [...cmd.argv, ...(extra?.append ?? [])], cwd: cmd.cwd, display: [cmd.display, ...(extra?.append ?? [])].join(' ') },
    classification: cmd.classification,
    // a run is called narrow only when the runner is known to replace, not merely extend, what the script runs
    narrow: !!(extra?.append && cmd.targeting?.narrows),
    ...(extra?.append ? { files: extra.files } : {}),
    reason: extra?.reason,
  });
  const resolve = (type, cwd, reason, extra) => {
    const cmd = pickCommand(commands, type, cwd);
    if (!cmd) return null;
    if (actions.some((a) => a.id === `${type}@${cmd.cwd}`)) return null;
    addAction(fromCommand(cmd, type, { ...extra, reason }));
    return cmd;
  };
  const groups = unique(existing.map((p) => cwdFor(p, cwds)));
  if (!groups.length && required && !allWithheld) groups.push('.');

  if (allWithheld && required) {
    unresolved.push({ type: 'any', reason: 'all-paths-withheld', note: 'every changed path was withheld as a secret path: validation could not be evaluated from them, and it is not "not required"' });
    rationale.push('all changed paths were withheld: validation is unevaluated (unknown), not skipped');
  } else if (required) {
    // 1. syntax: the narrowest sanity check of the changed files, from the language's own parse-only mode (no project command is guessed).
    const syntaxable = existing.filter((p) => SYNTAX_EXT[extOf(p)]);
    const syntaxFiles = syntaxable.slice(0, VALIDATION_BOUNDS.syntaxFiles);
    const syntaxBound = bound(VALIDATION_BOUNDS.syntaxFiles, syntaxable.length, syntaxFiles.length);
    const haveStatic = groups.some((g) => pickCommand(commands, 'lint', g) || pickCommand(commands, 'type-check', g));
    if (syntaxFiles.length && (n === 0 || !haveStatic)) {
      addAction({
        id: 'syntax', type: 'syntax', source: 'toolchain', sourceRef: 'the language\'s own parse-only mode', scope: 'project', scopePaths: syntaxFiles,
        command: null, files: syntaxFiles.map((p) => ({ path: p, check: SYNTAX_EXT[extOf(p)] })), classification: { level: 'A1', reasons: [] }, narrow: true,
        reason: n === 0 ? 'V0: targeted sanity check of the changed files' : 'no lint or type check is declared: the narrowest check that covers the change',
      });
      if (syntaxBound.truncated) limitations.push(`${syntaxBound.omitted} more changed file(s) were not syntax-checked (limit ${syntaxBound.limit}): check them in batches`);
    } else if (n === 0 && existing.length) {
      unresolved.push({ type: 'syntax', reason: 'no-check-for-file-kind', note: 'no parse-only check exists for these files and none is declared: not run, no command defined' });
    }

    // 2. lint, type check (V1 and up, "where the project provides them").
    if (n >= 1) for (const g of groups) {
      for (const type of ['lint', 'type-check']) {
        if (!resolve(type, g, `V${n}: ${type} where the project provides it`)) absent.push(`${type}@${g}`);
      }
    }

    // 3. tests.
    const direct = impact?.affectedTests?.direct ?? [];
    const consumer = impact?.requiredValidation?.tests?.consumer ?? [];
    const affected = unique([...direct, ...consumer]).filter((p) => !isSecretPath(p)).sort(cmp);
    for (const g of groups) {
      if (n === 0) break;
      const unit = pickCommand(commands, 'unit-test', g);
      const target = unit?.targeting?.mode === 'append-paths' ? unit : null;
      // jest reads paths as regular expressions, node and mocha and ava as globs: a path with pattern characters is not a literal there.
      const misread = target && PATTERN_RUNNERS.includes(target.targeting.runner) ? affected.filter((p) => PATTERN_CHARS.test(p)) : [];
      const targetable = affected.length > 0 && !!target && !testsTruncated && misread.length === 0;
      if (n === 1 || n === 2) {
        if (targetable) {
          const sel = affected.slice(0, VALIDATION_BOUNDS.testFiles);
          const guaranteed = target.targeting.narrows;
          resolve('unit-test', g, `V${n}: the affected tests, appended to the project's test command${guaranteed ? ' (narrowest declared scope)' : ' (narrowing is not guaranteed by this runner)'}`, { append: appendedArgsFor(sel, g) ?? [], files: sel });
        } else if (n === 2) {
          const whyNot = !testsKnown ? 'affected tests are unknown (not assumed none)' : testsTruncated ? 'the affected tests exceed the impact bound' : misread.length ? 'some affected test paths contain characters this runner would read as a pattern' : !affected.length ? 'no test is known to depend on the change' : 'the test command cannot take file arguments';
          if (!resolve('unit-test', g, `V2: the project's test script, the narrowest declared scope (${whyNot})`)) unresolved.push({ type: 'unit-test', reason: 'no-command-defined', scope: g, note: 'V2 needs the project\'s tests and none is declared: not run, no command defined' });
          else limitations.push(`tests could not be narrowed: ${whyNot}`);
        } else if (!testsKnown) {
          limitations.push('V1: affected tests are unknown (not assumed none): no targeted test was planned');
        } else if (affected.length && !target) {
          limitations.push('V1: affected tests are known but the declared test command cannot take file arguments: no targeted test was planned');
        } else if (misread.length) {
          limitations.push('V1: some affected test paths contain characters the runner would read as a pattern: no targeted test was planned');
        }
      } else if (!resolve('unit-test', g, `V${n}: the project's tests`)) {
        unresolved.push({ type: 'unit-test', reason: 'no-command-defined', scope: g, note: `V${n} needs the project's tests and none is declared: not run, no command defined` });
      }
    }

    // 4. other relevant checks.
    if (n >= 2) for (const g of groups) {
      const covered = pickCommand(commands, 'lint', g) || pickCommand(commands, 'type-check', g) || pickCommand(commands, 'unit-test', g);
      if (n >= 4 || !covered) resolve('targeted-check', g, n >= 4 ? 'V4: the full relevant validation' : 'V2: the project\'s declared check (no lint, type check or test is declared separately)');
    }
    if (n >= 3) {
      const why = buildRelevance(task, impact);
      if (why.length) {
        for (const g of groups) if (!resolve('build', g, `V${n}: the change can affect the build (${why.join(', ')})`)) unresolved.push({ type: 'build', reason: 'no-command-defined', scope: g, note: 'the change can affect the build and no build command is declared: not run, no command defined' });
        if (why.includes('impact-unknown')) limitations.push('whether the change can affect the build is unknown (impact not established): a build is planned as the conservative reading');
      } else rationale.push('build not planned: no configuration, dependency, build-time or public-export impact (established)');
    }
    if (n >= 4) for (const g of groups) for (const type of ['integration-test', 'static-analysis', 'security-check']) resolve(type, g, `V4: the full relevant validation includes ${type} where the project defines it`);
    else if (types.includes('security')) for (const g of groups) resolve('security-check', g, 'security work: the project\'s security check');
    if (n >= 4 || types.includes('migration') || impact?.dimensions?.data?.present === true) limitations.push('data migration and deployment checks are never run automatically (A3)');
    if (!actions.length && !unresolved.length) unresolved.push({ type: 'any', reason: 'no-command-defined', note: 'no validation command could be established for the changed files: not run, no command defined' });
  }

  // What impact analysis could not establish is carried, bounded and with hidden paths removed, never dropped.
  const impactLimits = carryLimitations(impact?.limitations);
  for (const l of impactLimits.shown) limitations.push('impact: ' + l);
  if (impactLimits.omitted) limitations.push('impact: ' + impactLimits.omitted + ' more limitation(s) were not carried (limit ' + IMPACT_LIMITATIONS_CARRIED + ')');
  const notEstablished = required && !allWithheld && ['unknown', 'partial'].includes(impactState) && n >= 1;
  if (notEstablished) unresolved.push({ type: 'impact', reason: 'impact-not-established', note: 'impact analysis could not establish what this change affects (' + impactState + '): the checks above ran, but unknown affected tests, public surface and dimensions are not "none", so this is not a clean pass' });
  const npmCfg = unique(actions.flatMap((a) => a.npmConfig ?? []));
  if (npmCfg.length) limitations.push('a project npm configuration exists (' + npmCfg.join(', ') + ') and is never read (secret pattern); npm itself may still read it for settings that are not pinned (for example workspace selection)');
  const npmActions = actions.some((a) => a.command?.execution?.manager === 'npm');

  // Changed files that impact analysis did not reach are not validated by anything here: said once, and the result cannot be a clean pass.
  if (required && remainingChanged > 0) {
    unresolved.push({ type: 'coverage', reason: 'changed-files-not-analyzed', note: `${remainingChanged} more changed file(s) were not analyzed by impact (limit ${impact?.bounded?.changedFiles?.limit ?? 20}): nothing in this plan validates them; validate them in batches` });
    limitations.push(`${remainingChanged} more changed file(s) were not analyzed by impact: validate them in batches`);
  }

  // Bound the plan: narrowest first, so what is cut is the widest.
  const total = actions.length;
  if (total > VALIDATION_BOUNDS.actions) {
    const cut = actions.splice(VALIDATION_BOUNDS.actions);
    limitations.push(`${cut.length} more action(s) were not planned (limit ${VALIDATION_BOUNDS.actions}): plan them in batches by subsystem`);
  }
  const nSyntax = existing.filter((p) => SYNTAX_EXT[extOf(p)]).length;
  const nTests = unique([...(impact?.affectedTests?.direct ?? []), ...(impact?.requiredValidation?.tests?.consumer ?? [])]).length;
  const bounded = { actions: bound(VALIDATION_BOUNDS.actions, total, actions.length), syntaxFiles: bound(VALIDATION_BOUNDS.syntaxFiles, nSyntax, Math.min(nSyntax, VALIDATION_BOUNDS.syntaxFiles)), testFiles: bound(VALIDATION_BOUNDS.testFiles, nTests, Math.min(nTests, VALIDATION_BOUNDS.testFiles)) };

  // Levels: V3 and V4 are A2 as a set (the plan is listed once and one yes covers it); an A3 command is never planned as runnable.
  const setOptIn = n >= 3 && setAuthorized(optIns, { depth, risk: eff.risk, actions });
  if (n >= 3 && optIns.some((o) => o.type === 'validation-set') && !setOptIn) limitations.push('a validation-set authorization was supplied but does not name this plan (another plan, depth, risk or action set, or a changed script): it is ignored');
  for (const a of actions) {
    const reasons = [...a.classification.reasons];
    let level = a.classification.level;
    const lowered = level === 'A2' ? optInCovers(optIns, a) : null;
    if (lowered) {
      level = 'A1'; // rule 3: a named, scoped standing opt-in lowers this A2, and only this one; never an A3
      a.loweredBy = { commandId: lowered.commandId, scriptDigest: lowered.scriptDigest, type: lowered.type, reasons: lowered.reasons, scope: lowered.scope };
    }
    if (level !== 'A3' && n >= 3 && !setOptIn) {
      if (level === 'A1') reasons.push('validation-set');
      level = 'A2';
      if (!reasons.includes('validation-set')) reasons.push('validation-set');
    }
    a.level = level;
    a.reasons = unique(reasons).sort(cmp);
  }

  // Proposals (A2): one per reason, or one for the whole V3/V4 plan; a decline is specific to its reason.
  const declinedReasons = new Set(project.declined ?? []);
  for (const r of declinedReasons) if (!A2_REASONS.includes(r)) throw new RoutingInputError(`unknown decline reason "${r}" (known: ${A2_REASONS.join(', ')})`);
  const proposals = [];
  const a2 = actions.filter((a) => a.level === 'A2');
  if (n >= 3 && a2.length) {
    proposals.push({ id: 'p:validation-set', action: 'validation', reason: 'validation-set', scope: 'project', level: 'A2', actionIds: a2.map((a) => a.id), authorization: setAuthorizationFor({ depth, risk: eff.risk, actions }) });
  } else {
    for (const reason of unique(a2.map((a) => primaryReason(a.reasons)))) {
      proposals.push({ id: `p:${reason}`, action: 'validation', reason, scope: 'project', level: 'A2', actionIds: a2.filter((a) => primaryReason(a.reasons) === reason).map((a) => a.id) });
    }
  }
  for (const p of proposals) {
    const mine = actions.filter((a) => p.actionIds.includes(a.id));
    p.commands = mine.map((a) => ({ id: a.id, display: a.command?.display ?? `${a.type} (${a.files?.length ?? 0} file(s))`, summary: a.scriptSummary ?? null, hooks: a.hooks ?? [], reasons: a.reasons, commandId: a.commandId ?? null, scriptDigest: a.scriptDigest ?? null, optIn: a.commandId && a.classification.level === 'A2' && !a.classification.reasons.some((r) => NEVER_LOWERABLE.includes(r)) ? { commandId: a.commandId, scriptDigest: a.scriptDigest, type: a.type, reason: a.classification.reasons, scope: a.scope } : null }));
    const describeCmd = (a) => (a.command ? `${a.command.display}${a.scriptSummary ? ` [project script: "${a.scriptSummary}"${a.hooks?.length ? `; also runs its ${a.hooks.join(' and ')} hook` : ''}; classified ${a.reasons.join(', ') || 'by the set'}]` : ''}` : `${a.type} (${a.files?.length ?? 0} file(s))`);
    p.effect = `runs ${mine.map(describeCmd).join('; ')}${mine.some((a) => a.reasons.includes('network-possible')) ? '; may use the network' : ''}${mine.some((a) => a.reasons.includes('mutating')) ? '; may write files' : ''}; no version-tracked file is changed by the plan itself`;
    p.note = `${p.reason === 'validation-set' ? `V${n} validation is A2 as a set: one yes covers this plan for the task. ` : `classified ${p.reason}: ${mine.map((a) => a.id).join(', ')}. `}${mine.some((a) => a.command && a.scriptSummary) ? 'A project script runs whatever its body and hooks say, including side effects this summary cannot show: read the script before saying yes.' : ''}`.trim();
    p.alternative = 'not run, declined: the result is reported as unverified; no narrower check is substituted silently';
    p.declined = declinedReasons.has(p.reason);
  }
  const prohibited = actions.filter((a) => a.level === 'A3').map((a) => ({ id: a.id, reasons: a.reasons, display: a.command?.display ?? a.type, summary: a.scriptSummary ?? null, note: 'A3: never automatic, whatever the user said before; run it manually outside automation if it is really wanted' }));

  // Context the plan cannot do without (a request to the router, never a second router).
  const ctx = [];
  if (required) {
    if (unresolved.some((u) => u.reason === 'no-command-defined' || u.reason === 'no-check-for-file-kind')) ctx.push('command-unresolved');
    if (['partial', 'unknown'].includes(impactState) && (n >= 2 || RISK_RANK[eff.risk] >= RISK_RANK.HIGH)) ctx.push('impact-incomplete');
    if (impactState === 'absent' && n >= 2) ctx.push('impact-absent');
    if (!testsKnown && n >= 2) ctx.push('affected-tests-unknown');
    if (n >= 3 && buildRelevance(task, impact).includes('impact-unknown')) ctx.push('build-impact-unresolved');
    if (remainingChanged > 0) ctx.push('changed-files-not-analyzed');
  }
  if (impactState === 'unknown' || impactState === 'partial') limitations.push('impact is not fully established: unknown affected tests, public surface and dimensions are not treated as none');

  const successCriteria = required
    ? [
      'every planned action ends PASS (exit status 0) and none is NOT_RUN, DECLINED, BLOCKED or UNKNOWN',
      ...(unresolved.length ? [`the unresolved check(s) (${unresolved.map((u) => u.type).join(', ')}) are resolved`] : []),
      ...(prohibited.length ? [`the prohibited action(s) (${prohibited.map((p) => p.id).join(', ')}) are handled manually outside automation`] : []),
    ]
    : [];
  const partialEvidence = remainingChanged > 0 || withheldCount > 0 || impact?.completeness === 'PARTIAL';
  const confidence = !required ? 'n/a' : allWithheld || unresolved.length || (impactState === 'absent' && n >= 1) || (impactState === 'unknown' && n >= 1) ? 'low' : impactState === 'complete' && !limitations.length && !partialEvidence ? 'high' : 'medium';
  rationale.push(`depth ${depth} from class ${eff.class ?? 'unclassified'} and risk ${eff.risk}${eff.raisedBy ? ` (raised by ${eff.raisedBy})` : ''}: ${eff.basis}`);
  if (absent.length) rationale.push(`not applicable (the project declares no such command): ${absent.sort(cmp).join(', ')}`);
  for (const a of actions) if (a.loweredBy) rationale.push(`${a.id} lowered from A2 to A1 by an opt-in naming it exactly (${a.loweredBy.type}: ${a.loweredBy.reasons.join(', ')}; scope ${a.loweredBy.scope})`);

  const planned = actions.filter((a) => a.level !== 'A3');
  const plan = {
    v: 1,
    planId: null,
    depth,
    class: eff.class,
    risk: eff.risk,
    intent,
    required,
    evaluated: !allWithheld,
    actions,
    automatic: actions.filter((a) => a.level === 'A1').map((a) => a.id),
    confirmationRequired: proposals,
    prohibited,
    unresolved,
    rationale,
    successCriteria,
    limitations: unique(limitations),
    executionNotes: npmActions ? NPM_EXECUTION_NOTES : [],
    contextNeeds: { justified: ctx.length > 0, reasons: ctx, signals: ctx.length ? { dependencyUncertain: true } : {} },
    impact: {
      state: impactState, completeness: impact?.completeness ?? null, confidence: impact?.confidence ?? null, testsKnown,
      remainingChangedFiles: remainingChanged, withheld: withheldCount, allWithheld, batchingRequired: !!impact?.batching?.required || remainingChanged > 0,
      truncatedLists: [...(impact?.bounded?.truncatedLists ?? [])].map(String).sort(cmp),
      limitations: impactLimits.shown, limitationsOmitted: impactLimits.omitted,
    },
    bounded,
    confidence,
    summary: { planned: planned.length, automatic: actions.filter((a) => a.level === 'A1').length, proposed: proposals.length, prohibited: prohibited.length, unresolved: unresolved.length },
  };
  plan.planId = planIdOf(depth, actions, bindingOf(plan));
  return plan;
}
