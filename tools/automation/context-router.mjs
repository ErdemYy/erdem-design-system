/**
 * Automatic context routing (ai/CONTEXT_PROTOCOL.md, ai/TASK_ROUTING.md, ai/AUTOMATION_PROTOCOL.md → Context
 * automation). Pure and read-only: it receives facts about the task, the session state of the intelligence and what the
 * agent already holds, and returns a compact read plan. It reads no file, runs no query, opens no secret and writes
 * nothing; the agent (or a thin adapter) performs the reads the plan names. The goal is the minimum sufficient context,
 * one level at a time, and a stop as soon as the five sufficiency questions are answered from evidence.
 *
 * Refreshing derived intelligence is not decided here: the plan only says which reliance tokens to pass to
 * `project-intel refresh` (automation/refresh.mjs) when stale or missing artifacts matter.
 */
import { directoryIndexRel } from '../lib/artifact-paths.mjs';
import { RoutingInputError, cleanPath, guardPaths, isSecretPath } from './path-safety.mjs';
import { CLASSES, RISKS, RELIANCE, pathKey, platformIsCaseInsensitive } from './refresh-decision.mjs';
import { actionRecord, classifyState } from './records.mjs';
import {
  CLASS_CEILING, CLASS_SCOPE, CLASS_VALIDATION_DEPTH, CONTEXT_LEVELS, DESIGN_CONCERNS, ESCALATION_REASONS, GRAPH_QUERIES,
  ORIENTATION_CANDIDATES, PLATFORM_IMPLIED_CONCERNS, PROFILE_KINDS, PLATFORM_SOURCES, SEARCH_FALLBACK, SECURITY_SOURCES, SUFFICIENCY_QUESTIONS, TASK_TYPES,
} from './context-sources.mjs';

export { RoutingInputError, cleanPath };

export const ROUTING_EVENTS = Object.freeze(['SESSION_START', 'TASK_RECEIVED', 'TASK_CLASSIFIED', 'CONTEXT_EXPANDED', 'INTELLIGENCE_CHECKED']);
export const INTELLIGENCE_STATES = Object.freeze(['current', 'stale', 'unverifiable', 'partial', 'missing', 'unavailable']);
export const EVIDENCE = Object.freeze(['read', 'search', 'graph', 'instruction', 'test']);
const GRAPH_EVIDENCE = ['search', 'graph'];
export const MAX_CONCERNS = 6;

/**
 * The most targets one plan names. No canonical document fixes a number (ai/CONTEXT_PROTOCOL.md defines no token figure);
 * this is an operational bound of the implementation, chosen so that one level's plan stays a short list
 * (ai/TOKEN_EFFICIENCY.md: read only what the task needs). Targets keep the caller's order, which is taken as priority:
 * the first MAX_TARGETS are planned, the rest are reported, never dropped silently, for the caller to batch by subsystem.
 */
export const MAX_TARGETS = 12;

const rank = (list, v) => list.indexOf(v);
const unique = (xs) => [...new Set(xs)];
/** How trustworthy an artifact is under the session state: trusted (current), provisional (unverifiable), hint (stale), none. */
const KIND_OF_STATUS = Object.freeze({ graph: 'graph', 'machine index': 'index', 'navigation map': 'index', 'file index': 'fileIndex', 'directory index': 'directoryIndex', 'file summary': 'summary', 'directory summary': 'summary' });
const WORST = ['MISSING', 'STALE', 'UNVERIFIABLE', 'CURRENT'];

/**
 * The intelligence argument built from a status result (pure): the session state and a state per artifact kind. A kind the
 * declared profile does not produce is 'not-expected' (no trust, and not reported as missing).
 */
export function intelligenceFromStatus(status, profile = null) {
  const state = classifyState(status);
  const expected = profile && PROFILE_KINDS[profile] ? PROFILE_KINDS[profile] : null;
  const seen = {};
  for (const a of status?.artifacts ?? []) {
    const k = KIND_OF_STATUS[a.kind];
    if (!k) continue;
    seen[k] = seen[k] && WORST.indexOf(seen[k]) < WORST.indexOf(a.state) ? seen[k] : a.state;
  }
  const artifacts = {};
  for (const k of KINDS) artifacts[k] = seen[k] ? seen[k].toLowerCase() : expected && !expected.includes(k) ? 'not-expected' : 'missing';
  return { state, artifacts };
}

const TRUST = Object.freeze({ current: 'trusted', unverifiable: 'provisional', stale: 'hint' });
const KINDS = ['graph', 'index', 'directoryIndex', 'fileIndex', 'summary'];

export function artifactTrust(intel) {
  const state = INTELLIGENCE_STATES.includes(intel?.state) ? intel.state : 'unavailable';
  const given = intel?.artifacts ?? {};
  const base = state === 'partial' ? 'unknown' : state;
  const states = Object.fromEntries(KINDS.map((k) => [k, given[k] ?? base]));
  const trust = Object.fromEntries(KINDS.map((k) => [k, TRUST[states[k]] ?? 'none']));
  const missingAreas = KINDS.filter((k) => states[k] === 'missing' || states[k] === 'unknown');
  if (state === 'missing') for (const k of KINDS) if (given[k] === undefined) states[k] = 'missing';
  return { state, states, trust, missingAreas };
}

// ---- task facts -----------------------------------------------------------------------------------------------

function normalizeTask(t = {}, reached = -1) {
  const sig = { ...(t.signals ?? {}) };
  const types = unique((t.taskTypes ?? []).map(String));
  const badType = types.find((x) => !TASK_TYPES[x]);
  if (badType) throw new RoutingInputError(`unknown task type "${badType}" (known: ${Object.keys(TASK_TYPES).join(', ')})`);
  if (t.taskClass !== undefined && t.taskClass !== null && !CLASSES.includes(t.taskClass)) throw new RoutingInputError(`unknown task class "${t.taskClass}"`);
  if (t.risk !== undefined && t.risk !== null && !RISKS.includes(t.risk)) throw new RoutingInputError(`unknown risk "${t.risk}"`);
  const guarded = guardPaths(unique((t.targets ?? []).map(cleanPath)));
  const withheld = [...guarded.withheld];
  const readable = guarded.ok.slice(0, MAX_TARGETS);
  const remaining = guarded.ok.slice(MAX_TARGETS);
  let between = null;
  const betweenGiven = Array.isArray(t.pathBetween) ? t.pathBetween.length : t.pathBetween === undefined || t.pathBetween === null ? 0 : -1;
  if (Array.isArray(t.pathBetween) && t.pathBetween.length === 2) {
    const ends = guardPaths(t.pathBetween.map(cleanPath));
    withheld.push(...ends.withheld);
    if (!ends.withheld.length) between = ends.ok;
  }
  const concerns = unique((t.concerns ?? []).map(String));
  const badConcern = concerns.find((c) => !DESIGN_CONCERNS[c]);
  if (badConcern) throw new RoutingInputError(`unknown design concern "${badConcern}" (known: ${Object.keys(DESIGN_CONCERNS).join(', ')})`);
  if (t.platform && !PLATFORM_SOURCES[t.platform]) throw new RoutingInputError(`unknown platform "${t.platform}" (known: ${Object.keys(PLATFORM_SOURCES).join(', ')})`);
  if (unique([...concerns, ...(PLATFORM_IMPLIED_CONCERNS[t.platform] ?? [])]).length > MAX_CONCERNS) throw new RoutingInputError(`name at most ${MAX_CONCERNS} design concerns: load only what the task needs (ai/CONTEXT_PROTOCOL.md, Design system selective loading)`);
  const kind = t.kind ?? (types.includes('ui') ? 'design' : 'implementation');
  if (!['design', 'implementation', 'mixed'].includes(kind)) throw new RoutingInputError(`unknown kind "${kind}"`);
  const queries = unique((t.queries ?? []).map(String));
  const badQuery = queries.find((q) => !GRAPH_QUERIES[q]);
  if (badQuery) throw new RoutingInputError(`unknown graph question "${badQuery}" (known: ${Object.keys(GRAPH_QUERIES).join(', ')})`);
  return {
    event: ROUTING_EVENTS.includes(t.event) ? t.event : reached >= 0 ? 'CONTEXT_EXPANDED' : 'TASK_RECEIVED',
    taskClass: t.taskClass ?? null,
    risk: t.risk ?? null,
    types, kind, platform: t.platform ?? null, concerns,
    targets: readable, remaining, withheld, between, betweenGiven,
    subsystem: t.subsystem && !isSecretPath(cleanPath(t.subsystem)) ? cleanPath(t.subsystem) : null,
    intent: t.intent === 'read-only' ? 'read-only' : 'change',
    sig, queries,
  };
}

/** Class and risk after the canonical floors; a class is only ever raised, never lowered (ai/TASK_ROUTING.md → Procedure). */
function effectiveClassAndRisk(n) {
  let cls = n.taskClass;
  const reclassified = [];
  const raise = (to, why) => {
    if (cls && rank(CLASSES, to) > rank(CLASSES, cls)) {
      reclassified.push({ from: cls, to, why });
      cls = to;
    }
  };
  if (n.sig.layerBoundary) raise('ARCHITECTURAL', 'layer-boundary');
  if (n.sig.crossSubsystem) raise('LARGE', 'cross-subsystem');
  if (n.sig.publicSurface) raise('MEDIUM', 'public-surface');
  let risk = n.risk ?? 'LOW';
  const floor = (to, why) => {
    if (rank(RISKS, to) > rank(RISKS, risk)) risk = to;
    return why;
  };
  if (n.sig.publicSurface) floor('MEDIUM');
  if (n.types.includes('dependency')) floor(n.sig.sharedDependency ? 'HIGH' : 'MEDIUM');
  if (n.types.includes('configuration') && n.sig.buildOrRuntime) floor('MEDIUM');
  if (n.types.includes('migration')) floor(n.sig.dataLoss ? 'CRITICAL' : 'HIGH');
  if (n.types.includes('security')) floor('HIGH');
  return { cls, risk, reclassified };
}

/** NOT NEEDED, OPTIONAL, RECOMMENDED or REQUIRED (ai/AUTOMATION_PROTOCOL.md → Change impact). Only the need is decided here. */
export function impactNeed({ cls, risk, types, sig, intent }) {
  const hard = types.some((x) => ['dependency', 'migration', 'security'].includes(x)) || (types.includes('configuration') && sig.buildOrRuntime);
  const docOnly = types.length > 0 && types.every((x) => x === 'documentation');
  if (intent === 'read-only' && !sig.publicSurface) return 'not-needed';
  if (docOnly) return 'not-needed';
  if (cls && rank(CLASSES, cls) >= rank(CLASSES, 'MEDIUM')) return 'required';
  if (types.includes('refactor') || sig.publicSurface || rank(RISKS, risk) >= rank(RISKS, 'HIGH') || hard || sig.dependencyUncertain) return 'required';
  if (cls === 'SMALL' || types.includes('test') || types.includes('configuration')) return 'recommended';
  if (sig.maybeShared) return 'optional';
  return 'not-needed';
}

/**
 * Every condition that legitimately needs a given level, each with the reason it is stated under. The minimum and the
 * ceiling are both derived from this one list, so a plan can never claim a minimum above its ceiling, and any level
 * beyond the class default carries the real reason (ai/TASK_ROUTING.md type floors, ai/CHANGE_IMPACT.md, the escalation
 * conditions of ai/CONTEXT_PROTOCOL.md).
 */
export function levelDrivers({ cls, risk, types, sig }, need) {
  const d = [];
  const add = (reason, level) => d.push({ reason, level });
  if (need === 'required') {
    if (cls && rank(CLASSES, cls) >= rank(CLASSES, 'MEDIUM')) add('required-by-class', 4);
    if (types.includes('refactor')) add('task-type-floor', 4);
    if (sig.publicSurface) add('public-surface', 4);
    if (rank(RISKS, risk) >= rank(RISKS, 'HIGH')) add('required-by-risk', 4);
    if (types.some((x) => ['dependency', 'migration', 'security'].includes(x))) add('task-type-floor', 4);
    if (types.includes('configuration') && sig.buildOrRuntime) add('configuration-or-api-impact', 4);
    if (sig.dependencyUncertain) add('dependency-uncertainty', 4);
  }
  if (cls === 'ARCHITECTURAL' && (sig.layerBoundary || sig.architectureUnresolved)) add('architectural-dependency', 5);
  if (risk === 'CRITICAL' && (sig.securityBoundary || sig.architectureUnresolved || types.includes('migration'))) add(sig.securityBoundary ? 'security-boundary' : types.includes('migration') ? 'migration' : 'architectural-dependency', 5);
  return d;
}

/** Highest level this task may reach without a stated reason: the class default, raised by every driver. */
function ceilingOf({ cls, original, risk, sig, types }, drivers) {
  let c = cls ? CLASS_CEILING[cls] : 3;
  // ai/CHANGE_IMPACT.md: a public surface takes impact depth one step beyond the class default. A task that the public
  // surface itself raised to MEDIUM already got that step from the class.
  if (sig.publicSurface && original && rank(CLASSES, original) >= rank(CLASSES, 'MEDIUM')) c += 1;
  if (rank(RISKS, risk) >= rank(RISKS, 'HIGH')) c = Math.max(c, 4);
  if (risk === 'CRITICAL' && (sig.securityBoundary || sig.architectureUnresolved || types.includes('migration') || types.includes('security'))) c = 5;
  for (const d of drivers) c = Math.max(c, d.level);
  return Math.min(5, c);
}

/** The lowest level that can answer the five questions for this kind of task, before anything has been read. */
function minimumLevelOf({ intent, targets, subsystem }, drivers) {
  let m = 1;
  if (!targets.length && !subsystem) m = 2;
  if (intent === 'change' || targets.length) m = Math.max(m, 3);
  for (const d of drivers) m = Math.max(m, d.level);
  return m;
}

/** Validation depth (V0 to V4) the task will need, for sufficiency question 5. The checks themselves are not chosen here. */
export function validationNeeds(cls, risk) {
  let depth = cls ? CLASS_VALIDATION_DEPTH[cls] : 1;
  if (risk === 'HIGH') depth = Math.min(4, depth + 1);
  if (risk === 'CRITICAL') depth = 4;
  return { depth: `V${depth}`, basis: risk === 'HIGH' || risk === 'CRITICAL' ? 'class raised by risk (ai/VALIDATION_PROTOCOL.md)' : 'class (ai/VALIDATION_PROTOCOL.md)' };
}

// ---- sufficiency ----------------------------------------------------------------------------------------------

const UNRESOLVED_REASON = { 1: 'target unknown', 2: 'rationale unknown', 3: 'constraints unknown', 4: 'dependency uncertainty', 5: 'validation unknown' };
const REASON_CODE = { 1: 'sufficiency-q1', 2: 'sufficiency-q2', 3: 'sufficiency-q3', 4: 'sufficiency-q4', 5: 'sufficiency-q5' };

export const isValidEscalationReason = (r) => ESCALATION_REASONS.includes(r);

/**
 * @param {object} answers  { 1..5: { status: 'answered'|'open', evidence: 'read'|'search'|'graph'|'instruction'|'test'|'assumption' } }
 * @param {object} ctx      { risk, reached, ceiling, escalationReason, searched }
 * "Sufficient" means each answer rests on evidence that was read or searched, never on assumption. For HIGH or CRITICAL risk,
 * question 4 needs search or graph evidence (ai/CONTEXT_PROTOCOL.md → Sufficiency). "Might be useful" is not a reason.
 */
export function evaluateSufficiency(answers = {}, ctx = {}) {
  const risk = ctx.risk ?? 'LOW';
  const reached = Number.isInteger(ctx.reached) ? ctx.reached : 0;
  const ceiling = Number.isInteger(ctx.ceiling) ? ctx.ceiling : 3;
  const unresolved = [];
  let riskEvidence = false;
  for (const q of [1, 2, 3, 4, 5]) {
    const a = answers[q];
    const ok = a && a.status === 'answered' && EVIDENCE.includes(a.evidence);
    if (!ok) unresolved.push(q);
    else if (q === 4 && rank(RISKS, risk) >= rank(RISKS, 'HIGH') && !GRAPH_EVIDENCE.includes(a.evidence)) {
      unresolved.push(q);
      riskEvidence = true;
    }
  }
  if (!unresolved.length) return { sufficient: true, unresolved: [], reason: 'all five questions answered from evidence', nextLevel: null, action: 'stop' };

  const q = unresolved[0];
  const reason = q === 4 && riskEvidence ? 'dependency evidence required by risk' : UNRESOLVED_REASON[q];
  const base = { sufficient: false, unresolved, reason, code: q === 4 && riskEvidence ? 'required-by-risk' : REASON_CODE[q] };
  if (ctx.escalationReason !== undefined && !isValidEscalationReason(ctx.escalationReason)) return { ...base, nextLevel: null, action: 'refuse', reason: `"${String(ctx.escalationReason).slice(0, 40)}" is not a valid reason to read more` };
  const next = reached + 1;
  if (next > 5) return { ...base, nextLevel: null, action: ctx.searched ? 'ask' : 'search' };
  if (next <= ceiling) return { ...base, nextLevel: next, action: 'deepen' };
  // Beyond the ceiling a reason must be stated. A caller may state one of the listed reasons; otherwise only the open
  // question itself can serve (dependency uncertainty, validation, risk), and only one step past the ceiling.
  const own = q === 4 ? (riskEvidence ? 'risk' : 'dependency-uncertainty') : q === 5 ? 'validation' : null;
  if (ctx.escalationReason) return { ...base, nextLevel: next, action: 'deepen', beyondCeiling: true, escalationReason: ctx.escalationReason };
  if (own && next <= ceiling + 1) return { ...base, nextLevel: next, action: 'deepen', beyondCeiling: true, escalationReason: own };
  return { ...base, nextLevel: null, action: ctx.searched ? 'ask' : 'search' };
}

// ---- the plan -------------------------------------------------------------------------------------------------

function designSources(n, level) {
  if (n.kind === 'implementation') return [];
  const concerns = unique([...(n.concerns.length ? n.concerns : ['principles']), ...(PLATFORM_IMPLIED_CONCERNS[n.platform] ?? [])]);
  const out = [];
  for (const c of concerns) for (const p of DESIGN_CONCERNS[c]) out.push({ path: p, root: 'design-system', why: `design concern: ${c}`, level });
  for (const p of n.platform ? PLATFORM_SOURCES[n.platform] : []) out.push({ path: p, root: 'design-system', why: `target platform: ${n.platform}`, level });
  return out;
}

function protocolSources(c, level) {
  const out = [];
  const add = (path, why) => out.push({ path, root: 'design-system', why, level });
  const rankClass = c.cls ? rank(CLASSES, c.cls) : 0;
  if (level === 1 && !c.n.taskClass) add('ai/TASK_ROUTING.md', 'the task is not classified yet');
  if (level === 3) {
    const sensitive = c.n.types.some((x) => ['architecture', 'dependency', 'migration', 'security', 'configuration'].includes(x)) || c.n.sig.publicSurface;
    if (c.n.intent === 'change' && (rankClass >= rank(CLASSES, 'MEDIUM') || rank(RISKS, c.risk) >= rank(RISKS, 'HIGH') || sensitive)) add('ai/SAFE_MODIFICATION.md', 'a change with class, risk or sensitivity above the trivial');
    if (c.n.types.includes('security')) for (const p of SECURITY_SOURCES) add(p, 'security-sensitive task');
  }
  if (level === 4) {
    if (c.need === 'required' || c.need === 'recommended') add('ai/CHANGE_IMPACT.md', `impact ${c.need}`);
    if (c.n.queries.length) add('ai/GRAPH_PROTOCOL.md', 'graph questions asked for');
    if (c.validation.depth !== 'V0' && c.validation.depth !== 'V1') add('ai/VALIDATION_PROTOCOL.md', `validation ${c.validation.depth}`);
  }
  return out;
}

function queryPlan(c) {
  const { n, intel } = c;
  const graphOk = intel.trust.graph === 'trusted';
  const out = [];
  const unresolved = [];
  const targets = n.targets.length ? n.targets : [];
  const wantsPath = n.queries.includes('shortest-path');
  const others = n.queries.filter((q) => q !== 'shortest-path');
  const asked = c.need === 'not-needed' && !others.length ? [] : unique(['impact', ...others]);
  const need = c.need === 'required' ? 'required' : 'optional';
  for (const t of targets) {
    for (const q of asked) {
      const cap = GRAPH_QUERIES[q];
      const queryNeed = q === 'impact' ? need : 'required';
      if (graphOk && cap.cli) {
        out.push({ op: q, target: t, via: 'cli', command: cap.cli.map((a) => (a === '<target>' ? t : a)), effect: 'read-only', need: queryNeed });
      } else if (graphOk && cap.library) {
        out.push({ op: q, target: t, via: 'library', function: cap.library, effect: 'read-only', need: queryNeed, note: 'library-only: no command form (tools/analyze/README.md); without the library read graph.json or search, and say no query ran' });
      } else {
        const how = SEARCH_FALLBACK[q === 'dependents' || q === 'impact' ? 'dependents' : q] ?? SEARCH_FALLBACK.dependents;
        out.push({ op: q, target: t, via: 'search', effect: 'read-only', need: queryNeed, how, fallbackFor: graphOk ? 'no read-only command form' : `graph ${intel.states.graph}` });
      }
    }
  }
  if (wantsPath) {
    // A path needs both endpoints. They are never guessed from the targets; without two usable ones the requirement is returned.
    if (n.between) {
      const [from, to] = n.between;
      if (graphOk) out.push({ op: 'shortest-path', from, to, via: 'library', function: 'shortestPath', args: [from, to], effect: 'read-only', need: 'required', note: 'library-only: no command form (tools/analyze/README.md); without the library read graph.json or search, and say no query ran' });
      else out.push({ op: 'shortest-path', from, to, via: 'search', effect: 'read-only', need: 'required', how: 'trace the import chain from the first file to the second by search; say that no path query ran', fallbackFor: `graph ${intel.states.graph}` });
    } else {
      unresolved.push({ op: 'shortest-path', requires: 'two project-relative endpoints: from and to', given: n.betweenGiven > 0 ? n.betweenGiven : 0, why: n.betweenGiven === 2 ? 'an endpoint was withheld as a secret path' : 'pass exactly two paths (--between from,to)' });
    }
  }
  if (c.need !== 'not-needed') {
    for (const [flag, dim] of [['configImpact', 'config'], ['apiImpact', 'api'], ['dataImpact', 'data'], ['platformImpact', 'platform'], ['designSystemImpact', 'design-system']]) {
      // These signals select which impact dimensions to search at Level 4 (ai/CHANGE_IMPACT.md, Dimensions). They are query
      // hints: the canonical documents set depth through class, risk, public surface and dependency uncertainty, not through them.
      if (n.sig[flag]) out.push({ op: `search-${dim}`, via: 'search', effect: 'read-only', need: 'required', how: SEARCH_FALLBACK[dim] });
    }
  }
  return { queries: out, unresolved };
}

function levelPlan(level, c) {
  const { n, intel, project } = c;
  const sources = [];
  const queries = [];
  const notes = [];
  const unresolved = [];
  const withheld = [];
  const push = (s) => sources.push({ root: 'project', ...s, level });

  if (level === 0) {
    const t = intel.trust.index;
    if (t !== 'none') push({ path: '.ai/AI_INDEX.md', why: 'root orientation', trust: t });
    else {
      const names = (project.rootFiles ?? []).filter((f) => ORIENTATION_CANDIDATES.some((re) => re.test(f)));
      if (names.length) for (const f of names.slice(0, 4)) push({ path: cleanPath(f), why: 'root orientation without an index', trust: 'source' });
      else queries.push({ op: 'list', target: '.', via: 'read', effect: 'read-only', need: 'required', how: 'one non-recursive directory listing of the project root' });
    }
    if (project.hasTaskState) push({ path: '.ai/TASK_STATE.md', why: 'work in progress', trust: 'state' });
    if (project.hasHandoff) push({ path: '.ai/HANDOFF.md', why: project.continuing ? 'the task continues earlier work' : 'learn that it exists', headerOnly: !project.continuing, trust: 'state' });
  }
  if (level === 1) {
    sources.push(...protocolSources(c, 1));
    if (!n.targets.length && !n.subsystem) queries.push({ op: 'search', for: 'terms from the request, to find the target area', via: 'search', effect: 'read-only', need: 'required' });
  }
  if (level === 2) {
    const sub = n.subsystem ?? (n.targets[0] ? n.targets[0].split('/').slice(0, -1).join('/') : null);
    if (sub && intel.trust.directoryIndex === 'trusted') push({ path: `${c.outputDir}/${directoryIndexRel(sub)}`, why: 'subsystem structure', trust: 'trusted' });
    else queries.push({ op: 'list', target: sub ?? '.', via: 'read', effect: 'read-only', need: 'required', how: 'list the directory; do not read file contents broadly', fallbackFor: `directory index ${intel.states.directoryIndex}` });
    if (n.types.some((x) => ['architecture', 'feature', 'refactor', 'migration', 'security'].includes(x)) && project.hasDecisions !== false) queries.push({ op: 'search-decisions', in: '.ai/DECISIONS.md', via: 'search', effect: 'read-only', need: 'required', how: 'search by the task\'s terms; do not read the file whole' });
    if (c.designLevel === 2) sources.push(...designSources(n, 2));
  }
  if (level === 3) {
    for (const t of n.targets) push({ path: t, why: 'the target', region: 'search, then read a range', trust: 'source' });
    if (!n.targets.length) queries.push({ op: 'search', for: 'the target within the subsystem', via: 'search', effect: 'read-only', need: 'required' });
    // TRIVIAL is the target region only; from SMALL on the target's direct dependencies belong to the scope (ai/TASK_ROUTING.md).
    if (c.cls && c.cls !== 'TRIVIAL') for (const t of n.targets) queries.push({ op: 'read-imports', target: t, via: 'read', effect: 'read-only', need: 'required', how: 'the target\'s import region: its direct dependencies' });
    sources.push(...protocolSources(c, 3));
    if (c.designLevel === 3) sources.push(...designSources(n, 3));
  }
  if (level === 4) {
    const q = queryPlan(c);
    queries.push(...q.queries);
    unresolved.push(...q.unresolved);
    sources.push(...protocolSources(c, 4));
    if (n.targets.length === 0) notes.push('no target known: impact cannot be planned until Level 3 names one');
  }
  if (level === 5) {
    if (intel.trust.graph === 'trusted') push({ path: '.ai/graph/graph.mmd', why: 'overview of relationships (an existing derived file, bounded by the graph\'s node limit)', trust: 'trusted' });
    queries.push({ op: 'search-architecture', via: 'search', effect: 'read-only', need: 'required', how: 'architecture documents and decisions that name the touched layers; not a repository-wide read' });
    if (project.architectureDocs) {
      // Filter first, then bound: withheld paths must not use up the slots of ordinary documents.
      const docs = guardPaths(unique(project.architectureDocs.map(cleanPath)));
      withheld.push(...docs.withheld);
      for (const d of docs.ok.slice(0, 5)) push({ path: d, why: 'architecture document named by the project', trust: 'source' });
    }
    notes.push('Level 5 is a bounded read of the layers the change touches, never the whole repository');
  }
  return { level, name: CONTEXT_LEVELS[level].name, sources, queries, notes, unresolved, withheld };
}

/**
 * The refresh reliance tokens (automation/refresh-decision.mjs, RELIANCE) for derived artifacts the plan uses as a hint, or
 * would use if it could trust them, where a refresh could help: stale or missing, never current (nothing to refresh) and
 * never unverifiable (a refresh cannot fix that). A level that reads only source (Level 3) relies on none.
 */
function relianceFrom(plan) {
  const out = [];
  for (const x of plan.sources) {
    if (x.trust !== 'hint') continue;
    if (x.path === '.ai/AI_INDEX.md') out.push('index');
    else if (/^[^/]+\/directories\//.test(x.path)) out.push('directory-index');
    else if (/^[^/]+\/graph\//.test(x.path)) out.push('graph');
  }
  const OP = { impact: 'impact', dependents: 'dependents', dependencies: 'dependencies', risk: 'risk', cycles: 'cycles', 'public-surface': 'public-surface', tests: 'impact' };
  for (const q of plan.queries) {
    const why = typeof q.fallbackFor === 'string' ? q.fallbackFor : '';
    const refreshable = (state) => state === 'stale' || state === 'missing' || state === 'unknown';
    if (why.startsWith('graph ') && refreshable(why.slice(6))) out.push(OP[q.op] ?? 'graph');
    else if (why.startsWith('directory index ') && refreshable(why.slice(16))) out.push('directory-index');
  }
  return unique(out).filter((t) => RELIANCE[t]);
}

/** Drop what the agent already holds unchanged; flag what may have changed; merge duplicates. */
function dedupe(plan, loaded, ci) {
  const held = new Map((loaded ?? []).map((l) => [pathKey(l.path, ci), l]));
  const seen = new Map();
  const skip = [];
  const sources = [];
  for (const s of plan.sources) {
    const key = pathKey(s.path, ci);
    const have = held.get(key);
    if (have && have.unchanged === true) {
      skip.push({ path: s.path, reason: 'already-loaded-unchanged' });
      continue;
    }
    if (seen.has(key)) {
      seen.get(key).why += `; ${s.why}`;
      continue;
    }
    const entry = have ? { ...s, recheck: true, why: `${s.why} (held, may have changed: re-check its fingerprint before relying on it)` } : { ...s };
    seen.set(key, entry);
    sources.push(entry);
  }
  return { ...plan, sources, skip };
}

/**
 * Route the context for a task.
 * @param {object} task         see normalizeTask: taskClass, risk, taskTypes, kind, platform, concerns, targets, subsystem, intent, signals, queries, event
 * @param {object} intelligence { state, artifacts? } the session state (adapters/GENERIC.md section 3) and optional per-artifact states
 * @param {object} project      { reached, answers, escalationReason, searched, loaded, rootFiles, hasTaskState, hasHandoff, continuing, hasDecisions, architectureDocs, caseInsensitive }
 * @returns a read plan: paths, queries and checks, never contents.
 */
/** The Phase 5A action-record reason code (ai/AUTOMATION_PROTOCOL.md, Observability) for a router reason. */
export function recordCode(reason) {
  if (/^sufficiency-q[1-5]$/.test(reason ?? '')) return reason;
  const map = { 'required-by-risk': 'required-by-risk', 'public-surface': 'public-surface', 'scope-growth': 'scope-growth', 'dependency-uncertainty': 'sufficiency-q4', 'configuration-or-api-impact': 'sufficiency-q4', 'security-boundary': 'required-by-risk', migration: 'required-by-risk', 'architectural-dependency': 'required-by-class', 'task-type-floor': 'required-by-class', 'class-default': 'required-by-class', 'required-by-class': 'required-by-class', unclassified: 'required-by-class' };
  return map[reason] ?? 'required-by-class';
}

export function routeContext(task = {}, intelligence = {}, project = {}) {
  const reached = Number.isInteger(project.reached) ? project.reached : -1;
  if (reached < -1 || reached > 5) throw new RoutingInputError('reached must be -1 (nothing yet) to 5');
  if (task.event !== undefined && !ROUTING_EVENTS.includes(task.event)) throw new RoutingInputError(`unknown event "${String(task.event).slice(0, 40)}" (known: ${ROUTING_EVENTS.join(', ')})`);
  for (const d of project.architectureDocs ?? []) cleanPath(d); // invalid input fails at once, not only when Level 5 is planned
  const n = normalizeTask(task, reached);
  const intel = artifactTrust(intelligence);
  const ci = project.caseInsensitive ?? platformIsCaseInsensitive();

  const refresh = (reliesOn) => (intel.state === 'stale' || intel.state === 'partial' || intel.state === 'missing') && reliesOn.length ? { consider: 'project-intel refresh', reliesOn: unique(reliesOn).filter((r) => RELIANCE[r]), note: 'the refresh decision is separate (ai/AUTOMATION_PROTOCOL.md); routing does not refresh' } : null;
  const intelligenceOut = (extra = {}) => ({ state: intel.state, trust: intel.trust, missingAreas: intel.state === 'partial' ? intel.missingAreas : [], ...extra });

  // Session start: light orientation only, no task yet.
  if (n.event === 'SESSION_START') {
    const c = { n, intel, project, cls: null, risk: 'LOW', need: 'not-needed', minimum: 0, validation: validationNeeds(null, 'LOW'), designLevel: 3, outputDir: cleanPath(project.outputDir ?? '.ai') };
    const plan = dedupe(levelPlan(0, c), project.loaded, ci);
    return finish({ n, plan, level: 0, minimumLevel: 0, ceiling: 0, reasons: ['session-start'], intelligence: intelligenceOut({ use: 'status and orientation only', refresh: refresh(relianceFrom(plan)) }), validation: null, need: 'not-needed', evaluation: null, skipped: [], reclassified: [], stop: false });
  }

  const { cls, risk, reclassified } = effectiveClassAndRisk(n);
  const need = impactNeed({ cls, risk, types: n.types, sig: n.sig, intent: n.intent });
  const drivers = cls ? levelDrivers({ cls, risk, types: n.types, sig: n.sig }, need) : [];
  const minimum = cls ? minimumLevelOf({ intent: n.intent, targets: n.targets, subsystem: n.subsystem }, drivers) : 1;
  const ceiling = Math.max(cls ? ceilingOf({ cls, original: n.taskClass, risk, sig: n.sig, types: n.types }, drivers) : 3, minimum);
  const validation = validationNeeds(cls, risk);
  const designLevel = minimum >= 3 ? 3 : 2;
  const c = { n, intel, project, cls, risk, need, minimum, validation, designLevel, outputDir: cleanPath(project.outputDir ?? '.ai') };

  const reasons = cls ? [] : ['unclassified'];
  for (const d of drivers) reasons.push(d.reason);
  if (cls && rank(RISKS, risk) >= rank(RISKS, 'HIGH')) reasons.push('required-by-risk');
  if (cls && n.sig.publicSurface) reasons.push('public-surface');
  if (reclassified.length) reasons.push('scope-growth');
  if (cls && !reasons.length) reasons.push('class-default');

  // Stop or deepen: evaluated only when the caller reports answers.
  let evaluation = null;
  if (project.answers) {
    evaluation = evaluateSufficiency(project.answers, { risk, reached: Math.max(reached, 0), ceiling, escalationReason: project.escalationReason, searched: project.searched });
    if (evaluation.sufficient) return finish({ n, plan: null, level: null, minimumLevel: minimum, ceiling, reasons, intelligence: intelligenceOut({ use: 'none further' }), validation, need, evaluation, skipped: [], reclassified, stop: true, cls, risk });
    if (evaluation.nextLevel === null) return finish({ n, plan: null, level: null, minimumLevel: minimum, ceiling, reasons: [...reasons, evaluation.code], intelligence: intelligenceOut(), validation, need, evaluation, skipped: [], reclassified, stop: false, cls, risk });
  }

  // The next level is one deeper than what is held. Only Levels 1 and 2 may be skipped, each with a stated reason.
  let next = evaluation ? evaluation.nextLevel : reached + 1;
  if (!project.answers && reached >= minimum) {
    return finish({ n, plan: null, level: null, minimumLevel: minimum, ceiling, reasons, intelligence: intelligenceOut(), validation, need, evaluation: { sufficient: null, action: 'evaluate', reason: 'the planned minimum is reached: answer the five questions before reading more' }, skipped: [], reclassified, stop: false, cls, risk });
  }
  const skipped = [];
  const scopeKnown = !!(n.targets.length || n.subsystem);
  if (next === 1 && cls && scopeKnown) {
    skipped.push({ level: 1, reason: 'scope-known-from-request' });
    next = 2;
  }
  const smallClass = !cls || cls === 'TRIVIAL' || cls === 'SMALL';
  const sensitive = n.types.some((x) => ['architecture', 'migration', 'security'].includes(x));
  if (next === 2 && scopeKnown && smallClass && !sensitive && minimum >= 3) {
    skipped.push({ level: 2, reason: 'subsystem-known' });
    next = 3;
  }
  if (next > 5) throw new RoutingInputError('nothing deeper than Level 5');
  const plan = dedupe(levelPlan(next, c), project.loaded, ci);
  if (evaluation && evaluation.code) reasons.push(evaluation.code);
  return finish({
    n, plan, level: next, minimumLevel: minimum, ceiling, reasons: unique(reasons),
    intelligence: intelligenceOut({ use: intel.trust.graph === 'trusted' ? 'index and graph where trusted' : intel.state === 'unavailable' ? 'source inspection only; no retry' : 'source inspection; derived data as a hint only', refresh: refresh(relianceFrom(plan)) }),
    validation, need, evaluation, skipped, reclassified, stop: false, cls, risk, beyondCeiling: next > ceiling,
  });

  function finish(o) {
    const sufficiencyChecks = [1, 2, 3, 4, 5].map((q) => ({ q, question: SUFFICIENCY_QUESTIONS[q], evidence: q === 4 && rank(RISKS, o.risk ?? 'LOW') >= rank(RISKS, 'HIGH') ? 'search or graph' : 'read, search, instruction or test' }));
    const stopConditions = ['all five sufficiency questions are answered from evidence, not assumption', 'the class ceiling is reached: justify a deeper level with a stated reason, search, or ask', 'a level never repeats a read of an unchanged file'];
    // The shared path-safety filter is applied to every path the plan names, whatever put it there.
    const withheld = [...o.n.withheld, ...(o.plan?.withheld ?? [])];
    const sources = [];
    for (const x of o.plan ? o.plan.sources : []) {
      if (isSecretPath(x.path)) withheld.push(x.path);
      else sources.push(x);
    }
    const queries = (o.plan ? o.plan.queries : []).filter((q) => {
      const named = [q.target, q.from, q.to].filter(Boolean);
      if (named.some(isSecretPath)) {
        withheld.push(...named.filter(isSecretPath));
        return false;
      }
      return true;
    });
    const bySubsystem = {};
    for (const p of o.n.remaining) {
      const top = p.split('/').length > 1 ? p.split('/').slice(0, 2).join('/') : '.';
      bySubsystem[top] = (bySubsystem[top] ?? 0) + 1;
    }
    const targets = {
      targetLimit: MAX_TARGETS,
      planned: o.n.targets.length,
      truncated: o.n.remaining.length > 0,
      remainingTargets: o.n.remaining.length,
      remainingBySubsystem: Object.fromEntries(Object.entries(bySubsystem).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      batchingRequired: o.n.remaining.length > 0,
    };
    const out = {
      version: 1,
      event: o.n.event,
      class: o.cls ?? null,
      scope: o.cls ? CLASS_SCOPE[o.cls] : null,
      risk: o.risk ?? null,
      kind: o.n.kind,
      reclassified: o.reclassified,
      minimumLevel: o.minimumLevel,
      ceiling: o.ceiling,
      level: o.level,
      stop: o.stop,
      reasons: o.reasons,
      skipped: o.skipped,
      beyondCeiling: !!o.beyondCeiling,
      targets,
      requiredSources: sources,
      requiredQueries: queries.filter((q) => q.need === 'required'),
      optionalQueries: queries.filter((q) => q.need !== 'required'),
      skip: o.plan ? o.plan.skip : [],
      withheld: unique(withheld).sort(),
      unresolvedRequirements: o.plan ? o.plan.unresolved ?? [] : [],
      impact: { need: o.need },
      validationNeeds: o.validation,
      intelligence: o.intelligence,
      sufficiencyChecks,
      stopConditions,
      evaluation: o.evaluation,
      notes: [...(o.plan ? o.plan.notes : []), ...(targets.truncated ? [`${targets.remainingTargets} more target(s) are not planned (limit ${MAX_TARGETS}): route them in batches, grouped by subsystem (remainingBySubsystem)`] : [])],
    };
    out.record = actionRecord({
      event: o.n.event,
      action: 'context-route',
      reason: `${o.n.event === 'SESSION_START' ? 'session-start' : recordCode(o.evaluation?.code ?? o.reasons[0])}: ${o.stop ? 'sufficient' : o.level === null ? (o.evaluation?.action ?? 'none') : `level ${o.level}`}`,
      level: 'A1',
      result: o.evaluation?.action === 'refuse' ? 'refused' : 'ok',
      detail: { level: o.level, class: o.cls ?? 'none', sources: out.requiredSources.length, queries: queries.length, intelligence: intel.state },
    });
    return out;
  }
}
