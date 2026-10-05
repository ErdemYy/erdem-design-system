import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanup, FIXTURES, TOOLS_ROOT, tmpDir } from './helpers.mjs';
import { RoutingInputError, cleanPath, evaluateSufficiency, impactNeed, intelligenceFromStatus, isValidEscalationReason, routeContext, validationNeeds } from '../automation/context-router.mjs';
import { CLASS_CEILING, CLASS_SCOPE, CLASS_VALIDATION_DEPTH, CONTEXT_LEVELS, DESIGN_CONCERNS, GRAPH_QUERIES, PLATFORM_SOURCES, SUFFICIENCY_QUESTIONS, TASK_TYPES } from '../automation/context-sources.mjs';
import { RELIANCE } from '../automation/refresh-decision.mjs';

after(cleanup);

const REPO = path.resolve(TOOLS_ROOT, '..');
const BIN = path.join(TOOLS_ROOT, 'bin', 'project-intel.mjs');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const cli = (args, cwd, env) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, windowsHide: true, env: env ?? process.env });
const CURRENT = { state: 'current' };

/** What the agent knows after reading up to a level: question -> the level that answers it, with its evidence. */
const answersAt = (reached, byQuestion = { 1: [3, 'read'], 2: [1, 'instruction'], 3: [2, 'instruction'], 4: [4, 'graph'], 5: [3, 'test'] }) => {
  const out = {};
  for (const [q, [level, evidence]] of Object.entries(byQuestion)) out[q] = reached >= level ? { status: 'answered', evidence } : { status: 'open' };
  return out;
};

/**
 * Drives the router the way an agent would: read what the plan names, report what it learned, ask again. This is a
 * test harness around the real router, not a runner for the specification.
 */
function drive(task, intel, script = answersAt, project = {}, max = 10) {
  let reached = -1;
  const loaded = [];
  const trace = [];
  for (let i = 0; i < max; i++) {
    const answers = reached >= 0 ? script(reached) : undefined;
    const r = routeContext(task, intel, { ...project, reached, answers, loaded: [...loaded] });
    trace.push(r);
    if (r.stop || r.level === null) break;
    for (const s of r.requiredSources) loaded.push({ path: s.path, unchanged: true });
    reached = r.level;
  }
  return trace;
}
const levelsOf = (trace) => trace.filter((r) => r.level !== null).map((r) => r.level);
const pathsOf = (trace) => trace.flatMap((r) => r.requiredSources.map((s) => s.path));
const T = (over) => ({ taskClass: 'SMALL', taskTypes: ['bugfix'], targets: ['src/util.ts'], ...over });

// ---- task classes ---------------------------------------------------------------------------------------------

test('1 TRIVIAL: minimal context, no impact, no protocol documents; the walk reaches only Level 3', () => {
  const trace = drive(T({ taskClass: 'TRIVIAL', taskTypes: ['documentation'], targets: ['src/copy.ts'] }), CURRENT, (reached) => answersAt(reached, { 1: [3, 'read'], 2: [1, 'instruction'], 3: [2, 'instruction'], 4: [3, 'search'], 5: [3, 'test'] }));
  const first = trace[0];
  assert.deepEqual([first.class, first.scope, first.minimumLevel, first.ceiling, first.impact.need, first.validationNeeds.depth], ['TRIVIAL', 'MINIMAL', 3, 3, 'not-needed', 'V0']);
  assert.deepEqual(levelsOf(trace), [0, 3], 'Levels 1 and 2 are skipped, each with a stated reason');
  assert.deepEqual(trace[1].skipped.map((s) => s.level), [1, 2]);
  assert.ok(trace.at(-1).stop);
  assert.deepEqual(pathsOf(trace), ['.ai/AI_INDEX.md', 'src/copy.ts'], 'the index for orientation and the target, nothing else');
  assert.ok(trace.every((r) => r.requiredQueries.length === 0));
});

test('2 SMALL: target-level context; impact is recommended, not required', () => {
  const r = routeContext(T(), CURRENT, { reached: 2 });
  assert.deepEqual([r.class, r.scope, r.minimumLevel, r.ceiling, r.impact.need, r.validationNeeds.depth, r.level], ['SMALL', 'TARGETED', 3, 3, 'recommended', 'V1', 3]);
  const deeper = routeContext(T(), CURRENT, { reached: 3 });
  assert.equal(deeper.level, null, 'the planned minimum is reached: the questions are asked before reading more');
  assert.equal(deeper.evaluation.action, 'evaluate');
  assert.equal(deeper.requiredQueries.length, 0);
});

test('3 MEDIUM: impact is required and answered with the graph query; the route does not reach Level 5', () => {
  const trace = drive(T({ taskClass: 'MEDIUM', taskTypes: ['feature'] }), CURRENT, (reached) => answersAt(reached));
  assert.deepEqual([trace[0].minimumLevel, trace[0].ceiling, trace[0].impact.need, trace[0].validationNeeds.depth], [4, 4, 'required', 'V2']);
  assert.deepEqual(levelsOf(trace), [0, 2, 3, 4], 'MEDIUM reads the subsystem (Level 2); only Level 1 is skipped');
  assert.deepEqual(trace.find((r) => r.level === 2).skipped.map((k) => k.level), [1]);
  const l4 = trace.find((r) => r.level === 4);
  assert.deepEqual(l4.requiredQueries.map((q) => [q.op, q.via, q.command.join(' ')]), [['impact', 'cli', 'impact src/util.ts --json']]);
  assert.ok(l4.requiredSources.some((s) => s.path === 'ai/CHANGE_IMPACT.md'));
  assert.ok(!levelsOf(trace).includes(5));
});

test('4 LARGE and the ceiling: an open dependency question may go one step past it on its own account; anything else needs a stated reason', () => {
  const task = T({ taskClass: 'LARGE', taskTypes: ['feature'], signals: { crossSubsystem: true } });
  const open = (q, level = 9) => (reached) => answersAt(reached, { 1: [3, 'read'], 2: [1, 'instruction'], 3: [2, 'instruction'], 4: [4, 'graph'], 5: [3, 'test'], [q]: [level, 'read'] });
  assert.deepEqual([routeContext(task, CURRENT, { reached: 0 }).ceiling, routeContext(task, CURRENT, { reached: 0 }).scope], [4, 'CROSS-SYSTEM']);
  const q4 = routeContext(task, CURRENT, { reached: 4, answers: open(4)(4) });
  assert.deepEqual([q4.level, q4.beyondCeiling, q4.evaluation.escalationReason], [5, true, 'dependency-uncertainty'], 'the open question is the stated reason');
  const q1 = routeContext(task, CURRENT, { reached: 4, answers: open(1)(4) });
  assert.deepEqual([q1.level, q1.evaluation.action], [null, 'search'], 'an unknown target is not a reason to read architecture: search first');
  assert.equal(routeContext(task, CURRENT, { reached: 4, answers: open(1)(4), searched: true }).evaluation.action, 'ask', 'then ask');
  const small = T();
  const smallAt4 = routeContext(small, CURRENT, { reached: 4, answers: open(4)(4) });
  assert.deepEqual([smallAt4.level, smallAt4.evaluation.action], [null, 'search'], 'two steps past the ceiling needs a reason the caller states');
  const stated = routeContext(small, CURRENT, { reached: 4, answers: open(4)(4), escalationReason: 'architectural-dependency' });
  assert.deepEqual([stated.level, stated.beyondCeiling], [5, true]);
  const lazy = routeContext(small, CURRENT, { reached: 4, answers: open(4)(4), escalationReason: 'it might be useful' });
  assert.deepEqual([lazy.level, lazy.evaluation.action], [null, 'refuse']);
  assert.equal(isValidEscalationReason('might be useful'), false);
  assert.equal(isValidEscalationReason('dependency-uncertainty'), true);
});

test('5 ARCHITECTURAL: Level 5 only when the situation needs it, never as a repository-wide read', () => {
  const plain = drive(T({ taskClass: 'ARCHITECTURAL', taskTypes: ['architecture'] }), CURRENT);
  assert.deepEqual([plain[0].minimumLevel, plain[0].ceiling, plain[0].validationNeeds.depth], [4, 5, 'V4']);
  assert.deepEqual(levelsOf(plain), [0, 2, 3, 4]);
  assert.ok(!levelsOf(plain).includes(5), 'an architectural task whose questions are answered at Level 4 stops there');
  const needing = drive(T({ taskClass: 'ARCHITECTURAL', taskTypes: ['architecture'], signals: { layerBoundary: true } }), CURRENT, (reached) => answersAt(reached, { 1: [3, 'read'], 2: [1, 'instruction'], 3: [5, 'read'], 4: [4, 'graph'], 5: [3, 'test'] }));
  assert.equal(needing[0].minimumLevel, 5);
  assert.deepEqual(levelsOf(needing), [0, 2, 3, 4, 5]);
  const l5 = needing.find((r) => r.level === 5);
  assert.ok(l5.notes.some((n) => /never the whole repository/.test(n)));
  assert.ok(l5.requiredSources.every((s) => !/\/$/.test(s.path) && s.path !== '.' && !s.path.includes('*')));
});

test('class never overrides sufficiency: a MEDIUM task stops at Level 2 when everything is known, an ARCHITECTURAL one at Level 3', () => {
  const known = Object.fromEntries([1, 2, 3, 4, 5].map((q) => [q, { status: 'answered', evidence: q === 4 ? 'graph' : 'read' }]));
  const medium = routeContext(T({ taskClass: 'MEDIUM', taskTypes: ['feature'] }), CURRENT, { reached: 2, answers: known });
  assert.deepEqual([medium.stop, medium.level, medium.evaluation.sufficient], [true, null, true]);
  const arch = routeContext(T({ taskClass: 'ARCHITECTURAL', taskTypes: ['architecture'] }), CURRENT, { reached: 3, answers: known });
  assert.deepEqual([arch.stop, arch.level], [true, null]);
});

// ---- risk -----------------------------------------------------------------------------------------------------

test('6 and 7 and 8 risk: low stays shallow, high and critical deepen and demand dependency evidence from search or graph', () => {
  const low = routeContext(T({ risk: 'LOW' }), CURRENT, { reached: 2 });
  assert.deepEqual([low.risk, low.minimumLevel, low.impact.need, low.validationNeeds.depth], ['LOW', 3, 'recommended', 'V1']);
  const high = routeContext(T({ risk: 'HIGH' }), CURRENT, { reached: 2 });
  assert.deepEqual([high.risk, high.minimumLevel, high.ceiling, high.impact.need, high.validationNeeds.depth], ['HIGH', 4, 4, 'required', 'V2']);
  assert.ok(high.reasons.includes('required-by-risk'));
  const critical = routeContext(T({ risk: 'CRITICAL' }), CURRENT, { reached: 2 });
  assert.deepEqual([critical.minimumLevel, critical.validationNeeds.depth], [4, 'V4']);
  const security = routeContext(T({ risk: 'CRITICAL', taskTypes: ['security'], signals: { securityBoundary: true } }), CURRENT, { reached: 2 });
  assert.deepEqual([security.minimumLevel, security.ceiling], [5, 5]);
  const estimated = answersAt(4, { 1: [3, 'read'], 2: [1, 'instruction'], 3: [2, 'instruction'], 4: [3, 'read'], 5: [3, 'test'] });
  const ev = evaluateSufficiency(estimated, { risk: 'HIGH', reached: 4, ceiling: 4 });
  assert.deepEqual([ev.sufficient, ev.unresolved, ev.reason], [false, [4], 'dependency evidence required by risk']);
  assert.equal(evaluateSufficiency(estimated, { risk: 'LOW', reached: 4, ceiling: 4 }).sufficient, true, 'the same evidence is enough at low risk');
  assert.equal(evaluateSufficiency({ ...estimated, 4: { status: 'answered', evidence: 'search' } }, { risk: 'CRITICAL', reached: 4, ceiling: 4 }).sufficient, true);
  assert.equal(evaluateSufficiency({ ...estimated, 4: { status: 'answered', evidence: 'assumption' } }, { risk: 'LOW', reached: 4, ceiling: 4 }).sufficient, false, 'an assumption is never evidence');
});

// ---- intelligence states --------------------------------------------------------------------------------------

test('9 missing intelligence: orientation and impact from the repository, no index command, no refresh', () => {
  const task = T({ taskClass: 'MEDIUM', taskTypes: ['feature'] });
  const l0 = routeContext(task, { state: 'missing' }, { reached: -1, rootFiles: ['README.md', 'package.json', 'src', 'node_modules'] });
  assert.deepEqual(l0.requiredSources.map((s) => s.path), ['README.md', 'package.json']);
  assert.ok(!l0.requiredSources.some((s) => s.path.startsWith('.ai/AI_INDEX')));
  const noFiles = routeContext(task, { state: 'missing' }, { reached: -1 });
  assert.deepEqual(noFiles.requiredQueries.map((q) => [q.op, q.target, q.via]), [['list', '.', 'read']], 'one non-recursive listing when nothing else is known');
  const l4 = routeContext(task, { state: 'missing' }, { reached: 3 });
  assert.deepEqual(l4.requiredQueries.map((q) => [q.op, q.via]), [['impact', 'search']]);
  assert.ok(l4.requiredQueries.every((q) => !q.command), 'no engine command is planned');
  assert.ok(JSON.stringify(l4).indexOf('"index"') === -1 || !/project-intel index|\["index"/.test(JSON.stringify(l4)), 'no index run is planned');
  assert.equal(l4.intelligence.refresh.consider, 'project-intel refresh');
  assert.match(l4.intelligence.refresh.note, /does not refresh/);
});

test('10 stale intelligence is a hint: impact falls back to source search, and the refresh decision is left to its own command', () => {
  const task = T({ taskClass: 'MEDIUM', taskTypes: ['feature'] });
  const l0 = routeContext(task, { state: 'stale' }, { reached: -1 });
  assert.equal(l0.requiredSources[0].trust, 'hint');
  const l4 = routeContext(task, { state: 'stale' }, { reached: 3 });
  assert.deepEqual(l4.requiredQueries.map((q) => [q.via, q.fallbackFor]), [['search', 'graph stale']]);
  assert.deepEqual(l4.intelligence.refresh.reliesOn, ['impact']);
  assert.ok(Object.keys(RELIANCE).includes(l4.intelligence.refresh.reliesOn[0]), 'a token project-intel refresh accepts');
});

test('11 partial intelligence: trusted artifacts are used, missing areas are named', () => {
  const task = T({ taskClass: 'MEDIUM', taskTypes: ['feature'], subsystem: 'src' });
  const partial = { state: 'partial', artifacts: { graph: 'current', index: 'current', directoryIndex: 'missing', fileIndex: 'not-expected', summary: 'not-expected' } };
  const l2 = routeContext(task, partial, { reached: 1 });
  assert.equal(l2.level, 2);
  assert.deepEqual(l2.requiredQueries.filter((q) => q.op === 'list').map((q) => [q.op, q.via]), [['list', 'read']], 'the missing directory index is replaced by a listing');
  assert.deepEqual(l2.intelligence.missingAreas, ['directoryIndex']);
  assert.deepEqual(routeContext(task, partial, { reached: 3 }).requiredQueries.map((q) => q.via), ['cli'], 'the current graph is used');
  const noGraph = { state: 'partial', artifacts: { graph: 'missing', index: 'current', directoryIndex: 'current' } };
  assert.deepEqual(routeContext(task, noGraph, { reached: 3 }).requiredQueries.map((q) => q.via), ['search']);
  assert.deepEqual(routeContext(task, noGraph, { reached: 3 }).intelligence.missingAreas, ['graph', 'fileIndex', 'summary']);
});

test('12 unverifiable intelligence is provisional and never used for impact; no refresh is suggested', () => {
  const task = T({ taskClass: 'MEDIUM', taskTypes: ['feature'] });
  const l0 = routeContext(task, { state: 'unverifiable' }, { reached: -1 });
  assert.equal(l0.requiredSources[0].trust, 'provisional');
  const l4 = routeContext(task, { state: 'unverifiable' }, { reached: 3 });
  assert.deepEqual(l4.requiredQueries.map((q) => q.via), ['search']);
  assert.equal(l4.intelligence.refresh, null, 'a refresh cannot make a source verifiable');
});

test('13 unavailable intelligence: source inspection only, no index, no retry', () => {
  const task = T({ taskClass: 'MEDIUM', taskTypes: ['feature'] });
  const l0 = routeContext(task, { state: 'unavailable' }, { reached: -1, rootFiles: ['README.md'] });
  assert.deepEqual(l0.requiredSources.map((s) => s.path), ['README.md']);
  const l4 = routeContext(task, { state: 'unavailable' }, { reached: 3 });
  assert.deepEqual(l4.requiredQueries.map((q) => q.via), ['search']);
  assert.equal(l4.intelligence.refresh, null);
  assert.match(l4.intelligence.use, /no retry/);
  assert.equal(routeContext(task, {}, { reached: 3 }).intelligence.state, 'unavailable', 'unknown input is treated as unavailable');
});

// ---- impact, public surface, design ---------------------------------------------------------------------------

test('14 dependency uncertainty makes impact required even for a SMALL task', () => {
  assert.equal(routeContext(T(), CURRENT, { reached: 2 }).impact.need, 'recommended');
  const r = routeContext(T({ signals: { dependencyUncertain: true } }), CURRENT, { reached: 3 });
  assert.deepEqual([r.impact.need, r.minimumLevel, r.level], ['required', 4, 4]);
  assert.equal(r.requiredQueries.length, 1);
});

test('15 a public surface raises class, risk and impact depth, but does not force architecture context', () => {
  const r = routeContext(T({ taskClass: 'TRIVIAL', taskTypes: ['bugfix'], signals: { publicSurface: true } }), CURRENT, { reached: 2 });
  assert.deepEqual([r.class, r.risk, r.impact.need, r.minimumLevel, r.ceiling], ['MEDIUM', 'MEDIUM', 'required', 4, 4]);
  assert.deepEqual(r.reclassified, [{ from: 'TRIVIAL', to: 'MEDIUM', why: 'public-surface' }]);
  assert.ok(r.reasons.includes('public-surface'));
  const already = routeContext(T({ taskClass: 'MEDIUM', taskTypes: ['feature'], signals: { publicSurface: true } }), CURRENT, { reached: 2 });
  assert.deepEqual([already.ceiling, already.minimumLevel], [5, 4], 'one step beyond the class default is allowed, not planned');
  const trace = drive(T({ taskClass: 'MEDIUM', taskTypes: ['feature'], signals: { publicSurface: true } }), CURRENT);
  assert.ok(!levelsOf(trace).includes(5));
});

test('16 a design task loads only the concerns it names and the target platform; an implementation task loads none', () => {
  const design = drive(T({ taskTypes: ['ui'], concerns: ['spacing', 'components'], platform: 'web' }), CURRENT);
  const docs = pathsOf(design).filter((p) => /^(core|platforms)\//.test(p));
  assert.deepEqual(docs.sort(), ['core/COMPONENT_SYSTEM.md', 'core/SPACING_SYSTEM.md', 'platforms/WEB.md']);
  assert.deepEqual(pathsOf(drive(T({ taskTypes: ['ui'] }), CURRENT)).filter((p) => /^core\//.test(p)), ['core/DESIGN_PRINCIPLES.md'], 'no concern named: the entry point only');
  assert.deepEqual(pathsOf(drive(T({ taskTypes: ['bugfix'], platform: 'mobile' }), CURRENT)).filter((p) => /^(core|platforms)\//.test(p)), [], 'unrelated documents stay unloaded');
  const mixed = pathsOf(drive(T({ taskTypes: ['feature'], kind: 'mixed', concerns: ['color'] }), CURRENT)).filter((p) => /^core\//.test(p));
  assert.deepEqual(mixed, ['core/COLOR_SYSTEM.md']);
});

test('17 and 18 and 19 platform routing: mobile, Flutter and 3D load only their own guidance', () => {
  const docs = (platform, concerns = []) => pathsOf(drive(T({ taskTypes: ['ui'], platform, concerns }), CURRENT)).filter((p) => /^(core|platforms)\//.test(p)).sort();
  assert.deepEqual(docs('mobile', ['layout']), ['core/LAYOUT_SYSTEM.md', 'platforms/MOBILE.md']);
  assert.deepEqual(docs('flutter', ['layout']), ['core/LAYOUT_SYSTEM.md', 'platforms/FLUTTER.md', 'platforms/MOBILE.md']);
  assert.deepEqual(docs('react-native'), ['core/DESIGN_PRINCIPLES.md', 'platforms/MOBILE.md', 'platforms/REACT_NATIVE.md']);
  assert.deepEqual(docs('webgl-3d'), ['core/ACCESSIBILITY.md', 'core/DESIGN_PRINCIPLES.md', 'core/MOTION_SYSTEM.md', 'platforms/WEBGL_3D.md']);
  for (const p of Object.keys(PLATFORM_SOURCES)) assert.ok(docs(p).filter((d) => d.startsWith('platforms/')).length <= 2, `${p} loads at most its own and its toolkit file`);
  assert.ok(!docs('mobile').some((d) => /WEB\.md|DESKTOP|WEBGL/.test(d)));
});

test('20 a security-sensitive task routes to the safety, validation and secrets protocols, with impact required and no design documents', () => {
  const trace = drive(T({ taskTypes: ['security'], risk: 'LOW', platform: 'web' }), CURRENT, (reached) => answersAt(reached));
  assert.equal(trace[0].risk, 'HIGH', 'the type floor of ai/TASK_ROUTING.md');
  assert.equal(trace[0].impact.need, 'required');
  const paths = pathsOf(trace);
  for (const p of ['ai/SAFE_MODIFICATION.md', 'ai/VALIDATION_PROTOCOL.md', 'ai/TOKEN_EFFICIENCY.md', 'ai/CHANGE_IMPACT.md']) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some((p) => /^(core|platforms)\//.test(p)));
});

// ---- sufficiency and escalation -------------------------------------------------------------------------------

test('21 22 23 24 sufficiency decides the depth: Level 2, Level 3, Level 4 and Level 5', () => {
  const all = (evidence4 = 'graph') => Object.fromEntries([1, 2, 3, 4, 5].map((q) => [q, { status: 'answered', evidence: q === 4 ? evidence4 : 'read' }]));
  const medium = T({ taskClass: 'MEDIUM', taskTypes: ['feature'] });
  assert.equal(routeContext(medium, CURRENT, { reached: 2, answers: all() }).stop, true, 'Level 2');
  const small = T();
  assert.equal(routeContext(small, CURRENT, { reached: 3, answers: all() }).stop, true, 'Level 3');
  const open4 = { ...all(), 4: { status: 'open' } };
  const need4 = routeContext(small, CURRENT, { reached: 3, answers: open4 });
  assert.deepEqual([need4.stop, need4.level, need4.evaluation.reason, need4.evaluation.unresolved], [false, 4, 'dependency uncertainty', [4]], 'Level 4');
  assert.deepEqual(need4.reasons.filter((r) => r.startsWith('sufficiency')), ['sufficiency-q4']);
  const arch = T({ taskClass: 'ARCHITECTURAL', taskTypes: ['architecture'], signals: { architectureUnresolved: true } });
  const open3 = { ...all(), 3: { status: 'open' } };
  const need5 = routeContext(arch, CURRENT, { reached: 4, answers: open3 });
  assert.deepEqual([need5.level, need5.evaluation.reason], [5, 'constraints unknown'], 'Level 5');
  const unanswered = evaluateSufficiency({}, { reached: 0, ceiling: 3 });
  assert.deepEqual([unanswered.sufficient, unanswered.unresolved, unanswered.nextLevel], [false, [1, 2, 3, 4, 5], 1]);
  assert.deepEqual([1, 2, 3, 4, 5].map((q) => evaluateSufficiency({ ...all(), [q]: { status: 'open' } }, { reached: 2, ceiling: 4 }).reason), ['target unknown', 'rationale unknown', 'constraints unknown', 'dependency uncertainty', 'validation unknown']);
});

test('25 no multi-level jump: only Levels 1 and 2 can be skipped, each with a stated reason', () => {
  const tasks = [
    T({ taskClass: 'TRIVIAL' }), T(), T({ taskClass: 'MEDIUM', taskTypes: ['feature'] }), T({ taskClass: 'LARGE', taskTypes: ['feature'], signals: { crossSubsystem: true } }),
    T({ taskClass: 'ARCHITECTURAL', taskTypes: ['architecture'], signals: { layerBoundary: true } }), T({ targets: [], subsystem: 'src' }), T({ targets: [], subsystem: null }),
  ];
  for (const task of tasks) {
    const never = (reached) => answersAt(reached, { 1: [9, 'read'], 2: [9, 'read'], 3: [9, 'read'], 4: [9, 'read'], 5: [9, 'read'] });
    const trace = drive(task, CURRENT, never, {}, 8);
    let last = -1;
    for (const r of trace.filter((x) => x.level !== null)) {
      const gap = r.level - last;
      assert.ok(gap >= 1, 'levels only deepen');
      const skippedLevels = r.skipped.map((s) => s.level);
      assert.deepEqual([...Array(gap - 1).keys()].map((i) => last + 1 + i + 1 - 1 + 1 - 1).length, skippedLevels.length, 'every skipped level is documented');
      for (const l of skippedLevels) assert.ok(l === 1 || l === 2, `Level ${l} may not be skipped`);
      assert.ok(r.skipped.every((s) => typeof s.reason === 'string' && s.reason.length > 0));
      last = r.level;
    }
    assert.ok(last <= 5);
  }
  assert.deepEqual(levelsOf(drive(T({ targets: [], subsystem: null }), CURRENT, (r) => answersAt(r, { 1: [9, 'read'], 2: [9, 'read'], 3: [9, 'read'], 4: [9, 'read'], 5: [9, 'read'] }), {}, 6)).slice(0, 4), [0, 1, 2, 3], 'nothing known: every level is walked');
});

test('26 no whole-repository read: every source is a specific file, plans stay small, nothing is a glob or a directory', () => {
  const tasks = [T(), T({ taskClass: 'MEDIUM', taskTypes: ['feature'] }), T({ taskTypes: ['ui'], platform: 'webgl-3d', concerns: Object.keys(DESIGN_CONCERNS).slice(0, 4) }), T({ taskClass: 'ARCHITECTURAL', taskTypes: ['architecture'], signals: { layerBoundary: true } })];
  for (const task of tasks) for (const intel of [CURRENT, { state: 'missing' }, { state: 'stale' }, { state: 'unavailable' }]) {
    const trace = drive(task, intel, () => answersAt(-1), { rootFiles: ['README.md', 'AGENTS.md', 'package.json', 'src'] }, 8);
    for (const r of trace) {
      assert.ok(r.requiredSources.length <= 12, `at most 12 sources per level, got ${r.requiredSources.length}`);
      for (const s of r.requiredSources) assert.ok(s.path && !/[*?]/.test(s.path) && !s.path.endsWith('/') && s.path !== '.' && s.path !== '.ai', s.path);
      for (const q of [...r.requiredQueries, ...r.optionalQueries]) if (q.op === 'list') assert.ok(q.how && /non-recursive|do not read file contents/.test(q.how), 'a listing is bounded');
    }
  }
});

test('26b the whole design system cannot be requested: more than six design concerns is an error', () => {
  assert.throws(() => routeContext(T({ taskTypes: ['ui'], concerns: Object.keys(DESIGN_CONCERNS) }), CURRENT), /name at most 6 design concerns/);
  assert.doesNotThrow(() => routeContext(T({ taskTypes: ['ui'], concerns: Object.keys(DESIGN_CONCERNS).slice(0, 6) }), CURRENT, { reached: 2 }));
  assert.throws(() => routeContext(T({ taskTypes: ['ui'], platform: 'webgl-3d', concerns: Object.keys(DESIGN_CONCERNS).slice(2, 8) }), CURRENT), /name at most/, 'implied concerns count too');
});

test('27 no duplicate context read: held unchanged files are skipped, changed or unknown ones are re-checked, and a walk never repeats a source', () => {
  const task = T({ taskClass: 'MEDIUM', taskTypes: ['feature'], taskId: undefined });
  const held = routeContext(task, CURRENT, { reached: -1, loaded: [{ path: '.ai/AI_INDEX.md', unchanged: true }] });
  assert.deepEqual([held.requiredSources.length, held.skip], [0, [{ path: '.ai/AI_INDEX.md', reason: 'already-loaded-unchanged' }]]);
  for (const state of [false, 'unknown']) {
    const r = routeContext(task, CURRENT, { reached: -1, loaded: [{ path: '.ai/AI_INDEX.md', unchanged: state }] });
    assert.equal(r.requiredSources[0].recheck, true);
    assert.match(r.requiredSources[0].why, /re-check its fingerprint/);
  }
  const ci = routeContext(task, CURRENT, { reached: -1, loaded: [{ path: '.AI\\ai_index.md', unchanged: true }], caseInsensitive: true });
  assert.equal(ci.skip.length, 1, 'path comparison follows the file system');
  const trace = drive(T({ taskClass: 'MEDIUM', taskTypes: ['feature'], taskId: undefined }), CURRENT, (reached) => answersAt(reached, { 1: [9, 'read'], 2: [9, 'read'], 3: [9, 'read'], 4: [9, 'read'], 5: [9, 'read'] }), {}, 8);
  const paths = pathsOf(trace);
  assert.equal(new Set(paths).size, paths.length, 'the same file is never planned twice in one walk');
  const dup = routeContext(T({ targets: ['src/util.ts', 'src/util.ts'] }), CURRENT, { reached: 2 });
  assert.equal(dup.requiredSources.filter((s) => s.path === 'src/util.ts').length, 1);
});

// ---- paths, secrets, writes ----------------------------------------------------------------------------------

test('28 29 30 paths with spaces, OneDrive-like folders and non-ASCII names pass through unchanged', () => {
  for (const target of ['src/with spaces/my file.ts', 'OneDrive/Belgeler Ünlü/Proje Ç ş/dosya.tsx', 'src/日本語/コンポーネント.ts']) {
    const r = routeContext(T({ targets: [target] }), CURRENT, { reached: 2 });
    assert.deepEqual(r.requiredSources.filter((s) => s.why === 'the target').map((s) => s.path), [target]);
    const l4 = routeContext(T({ taskClass: 'MEDIUM', taskTypes: ['feature'], targets: [target] }), CURRENT, { reached: 3 });
    assert.deepEqual(l4.requiredQueries[0].command, ['impact', target, '--json'], 'one argument, no quoting');
  }
  assert.equal(cleanPath('.\\src\\a b\\c.ts'), 'src/a b/c.ts');
  for (const bad of ['/etc/passwd', 'C:\\Users\\x', '..\\x', 'a/../../b', '', '.', 'src/*.ts']) assert.throws(() => cleanPath(bad), RoutingInputError, bad);
});

test('28b the command line works in directories with spaces, OneDrive-like and non-ASCII names', () => {
  const base = tmpDir('pi-route-');
  for (const nested of [['with spaces', 'my project'], ['OneDrive', 'Belgeler Ünlü', 'Proje Ç ş']]) {
    const dir = path.join(base, ...nested);
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(path.join(FIXTURES, 'app'), dir, { recursive: true });
    assert.equal(cli(['index', dir], dir).status, 0);
    const r = cli(['route', dir, '--json', '--class', 'MEDIUM', '--types', 'feature', '--targets', 'src/components/Button.tsx', '--reached', '3'], dir);
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.intelligence.state, 'current');
    assert.deepEqual(plan.requiredQueries.map((q) => q.via), ['cli']);
    assert.ok(!r.stdout.includes(dir), 'no absolute path in the plan');
  }
});

test('31 secrets: secret-pattern targets are withheld and never planned, and no secret value can appear because nothing is read', () => {
  const r = routeContext(T({ targets: ['.env', 'config/id_rsa', 'certs/server.pem', 'src/ok.ts'] }), CURRENT, { reached: 2 });
  assert.deepEqual(r.withheld.sort(), ['.env', 'certs/server.pem', 'config/id_rsa']);
  assert.deepEqual(r.requiredSources.filter((s) => s.why === 'the target').map((s) => s.path), ['src/ok.ts']);
  const SECRET = 'sk-test-ROUTER-9f8e7d-NEVER-PRINT';
  const dir = tmpDir('pi-route-secret-');
  fs.cpSync(path.join(FIXTURES, 'app'), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), `API_KEY=${SECRET}\n`);
  fs.writeFileSync(path.join(dir, 'id_rsa'), `-----BEGIN PRIVATE KEY-----\n${SECRET}\n`);
  assert.equal(cli(['index', dir], dir).status, 0);
  const out = cli(['route', dir, '--json', '--class', 'SMALL', '--types', 'bugfix', '--targets', '.env,id_rsa,src/util.ts', '--reached', '2'], dir, { ...process.env, OPENAI_API_KEY: SECRET });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(!out.stdout.includes(SECRET) && !out.stderr.includes(SECRET));
  assert.deepEqual(JSON.parse(out.stdout).withheld.sort(), ['.env', 'id_rsa']);
});

test('32 routing writes nothing: the project and the working directory are unchanged, and the router has no write or process calls', () => {
  const dir = tmpDir('pi-route-ro-');
  fs.cpSync(path.join(FIXTURES, 'app'), dir, { recursive: true });
  assert.equal(cli(['index', dir], dir).status, 0);
  const home = tmpDir('pi-route-home-');
  const snap = (d) => JSON.stringify(Object.fromEntries((function walk(x) { return fs.readdirSync(x, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(x, e.name)) : [[path.relative(d, path.join(x, e.name)), fs.statSync(path.join(x, e.name)).mtimeMs + ':' + fs.readFileSync(path.join(x, e.name), 'latin1').length]])); })(d)));
  const before = snap(dir);
  const env = { ...process.env, TEMP: home, TMP: home, TMPDIR: home };
  for (const args of [['--class', 'MEDIUM', '--types', 'feature', '--targets', 'src/util.ts', '--reached', '3'], ['--event', 'SESSION_START'], ['--class', 'LARGE', '--signals', 'crossSubsystem', '--reached', '4', '--answers', '1=read,4=open']]) {
    assert.equal(cli(['route', dir, '--json', ...args], home, env).status, 0, args.join(' '));
  }
  assert.equal(snap(dir), before);
  assert.deepEqual(fs.readdirSync(home), []);
  for (const f of ['context-router.mjs', 'context-sources.mjs']) {
    const code = fs.readFileSync(path.join(TOOLS_ROOT, 'automation', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/node:fs|node:child_process|writeFile|appendFile|mkdirSync|rmSync|spawn|exec\(|fetch\(|node:net|node:http/.test(code), `${f} reads, writes, spawns nothing`);
  }
});

// ---- adapters and canonical agreement -------------------------------------------------------------------------

test('33 the adapters hold no routing logic: they pass the command through', () => {
  const offenders = [];
  for (const adapter of ['claude', 'codex', 'antigravity']) {
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'tests' && e.name !== 'node_modules') walk(abs);
        } else if (e.name.endsWith('.mjs') && /routeContext|evaluateSufficiency|minimumLevel|context-router|impactNeed|ESCALATION_REASONS/.test(fs.readFileSync(abs, 'utf8'))) offenders.push(path.relative(REPO, abs));
      }
    })(path.join(REPO, 'adapters', adapter));
  }
  assert.deepEqual(offenders, []);
  for (const f of ['codex/skill/references/context.md', 'antigravity/skill/references/context.md', 'claude/skill/references/context-routing.md']) assert.match(read('adapters', f), /intel route/, `${f} points to the canonical command`);
});

test('34 the task classes, ceilings, scopes and types agree with ai/TASK_ROUTING.md', () => {
  const rows = read('ai', 'TASK_ROUTING.md').split(/\r?\n/).map((l) => l.split('|').map((c) => c.trim()));
  const classes = Object.fromEntries(rows.filter((c) => /^(TRIVIAL|SMALL|MEDIUM|LARGE|ARCHITECTURAL)$/.test(c[1] ?? '')).map((c) => [c[1], { level: Number(/Level (\d)/.exec(c[3])[1]), scope: c[4] }]));
  assert.deepEqual(Object.keys(classes), Object.keys(CLASS_CEILING));
  for (const [cls, v] of Object.entries(classes)) assert.deepEqual([CLASS_CEILING[cls], CLASS_SCOPE[cls]], [v.level, v.scope], cls);
  const typeRows = rows.filter((c) => c.length > 4 && c[2] && /^(UI change|bug fix|feature|refactor|performance|architecture|documentation|dependency|configuration|migration|test|security)$/.test(c[1] ?? '')).map((c) => c[1]);
  assert.deepEqual(typeRows.sort(), Object.values(TASK_TYPES).sort());
  const generic = read('ai', 'AUTOMATION_PROTOCOL.md');
  for (const [cls, depth] of Object.entries(CLASS_VALIDATION_DEPTH)) assert.ok(new RegExp(`\\| V${depth} \\| ${cls}`).test(generic), `${cls} maps to V${depth} in the automation contract`);
  assert.deepEqual([validationNeeds('SMALL', 'HIGH').depth, validationNeeds('MEDIUM', 'CRITICAL').depth, validationNeeds('ARCHITECTURAL', 'HIGH').depth, validationNeeds('TRIVIAL', 'LOW').depth], ['V2', 'V4', 'V4', 'V0']);
});

test('35 the context levels and sufficiency questions agree with ai/CONTEXT_PROTOCOL.md', () => {
  const text = read('ai', 'CONTEXT_PROTOCOL.md');
  const levels = [...text.matchAll(/^\| ([0-5]) \| ([^|]+) \|/gm)].map((m) => [Number(m[1]), m[2].trim()]);
  assert.deepEqual(levels, CONTEXT_LEVELS.map((l) => [l.level, l.name]));
  const section = text.slice(text.indexOf('## Sufficiency'), text.indexOf('## Uncertainty'));
  const questions = [...section.matchAll(/^(\d)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2].trim()]);
  assert.deepEqual(questions, Object.entries(SUFFICIENCY_QUESTIONS).map(([q, t]) => [Number(q), t]));
  const selective = text.slice(text.indexOf('## Design system selective loading'));
  for (const doc of ['core/SPACING_SYSTEM.md', 'core/COMPONENT_SYSTEM.md', 'platforms/MOBILE.md', 'platforms/WEBGL_3D.md', 'core/MOTION_SYSTEM.md', 'core/ACCESSIBILITY.md']) assert.ok(selective.includes(doc), `${doc} is named by the canonical selective-loading table`);
});

test('36 every document the router can name exists, and the graph questions agree with the capability matrix', () => {
  for (const docs of [...Object.values(DESIGN_CONCERNS), ...Object.values(PLATFORM_SOURCES)]) for (const d of docs) assert.ok(fs.existsSync(path.join(REPO, d)), d);
  const readme = read('tools', 'analyze', 'README.md');
  const section = readme.slice(readme.indexOf('## Capability matrix'), readme.indexOf('## Limits'));
  const matrix = section.split(/\r?\n/).filter((l) => l.startsWith('| ')).map((l) => l.split(/(?<!\\)\|/).map((c) => c.trim()));
  for (const [key, cap] of Object.entries(GRAPH_QUERIES)) {
    const row = matrix.find((c) => c[1] && c[1].startsWith(cap.matrixRow));
    assert.ok(row, `${key}: matrix row "${cap.matrixRow}"`);
    const cliCell = row[2];
    if (cap.cli || cap.cliWritesDerived) assert.ok(!/^\*{0,2}unavailable/.test(cliCell), `${key}: the matrix gives a CLI form`);
    else assert.match(cliCell, /unavailable|data/, `${key}: no CLI form in the matrix`);
    if (cap.library) assert.ok(row[3].includes(cap.library), `${key}: library function ${cap.library}`);
  }
  const shortest = routeContext(T({ taskClass: 'MEDIUM', taskTypes: ['feature'], queries: ['shortest-path'], pathBetween: ['src/a.ts', 'src/b.ts'] }), CURRENT, { reached: 3 });
  const q = shortest.requiredQueries.find((x) => x.op === 'shortest-path');
  assert.deepEqual([q.via, q.function], ['library', 'shortestPath'], 'library-only is not presented as a command');
  assert.ok(!q.command);
  const nb = routeContext(T({ taskClass: 'MEDIUM', taskTypes: ['feature'], queries: ['neighborhood'] }), CURRENT, { reached: 3 });
  assert.ok(nb.requiredQueries.filter((x) => x.op === 'neighborhood').every((x) => x.via === 'library' && x.effect === 'read-only'), 'a command form that writes derived files is never planned');
  const stale = routeContext(T({ taskClass: 'MEDIUM', taskTypes: ['feature'], queries: ['shortest-path'], pathBetween: ['src/a.ts', 'src/b.ts'] }), { state: 'stale' }, { reached: 3 });
  assert.equal(stale.requiredQueries.find((x) => x.op === 'shortest-path').via, 'search', 'with an untrusted graph even a library query falls back to source');
});

test('37 session start is light; events are validated; observability records follow the 5A format and carry no content', () => {
  const s = routeContext({ event: 'SESSION_START' }, CURRENT, { hasTaskState: true, hasHandoff: true });
  assert.deepEqual([s.level, s.class, s.requiredQueries.length], [0, null, 0]);
  assert.deepEqual(s.requiredSources.map((x) => [x.path, x.headerOnly ?? false]), [['.ai/AI_INDEX.md', false], ['.ai/TASK_STATE.md', false], ['.ai/HANDOFF.md', true]], 'the handoff header only, unless the task continues earlier work');
  assert.equal(routeContext({ event: 'SESSION_START' }, CURRENT, { hasHandoff: true, continuing: true }).requiredSources.at(-1).headerOnly, false);
  const r = routeContext(T({ taskClass: 'MEDIUM', taskTypes: ['feature'] }), CURRENT, { reached: 3 });
  assert.deepEqual(Object.keys(r.record), ['v', 'event', 'action', 'reason', 'scope', 'level', 'result', 'detail', 'at']);
  assert.deepEqual([r.record.v, r.record.event, r.record.action, r.record.scope, r.record.level, r.record.result], [1, 'CONTEXT_EXPANDED', 'context-route', 'project', 'A1', 'ok']);
  assert.ok(!JSON.stringify(r.record).includes('src/util.ts'), 'the record names no file');
  assert.equal(routeContext(T(), CURRENT, { reached: -1 }).record.event, 'TASK_RECEIVED');
  assert.throws(() => routeContext(T({ taskClass: 'HUGE' }), CURRENT), RoutingInputError);
  assert.throws(() => routeContext(T({ risk: 'SEVERE' }), CURRENT), RoutingInputError);
  assert.throws(() => routeContext(T({ taskTypes: ['telepathy'] }), CURRENT), RoutingInputError);
  assert.throws(() => routeContext(T({ platform: 'toaster' }), CURRENT), RoutingInputError);
  assert.throws(() => routeContext(T({ event: 'LUNCH' }), CURRENT), RoutingInputError);
  assert.throws(() => routeContext(T(), CURRENT, { reached: 9 }), RoutingInputError);
});

test('38 deterministic and pure: the same input gives the same plan and the input is not changed', () => {
  const task = T({ taskClass: 'MEDIUM', taskTypes: ['feature'], signals: { publicSurface: true } });
  const project = { reached: 3, loaded: [{ path: 'src/util.ts', unchanged: true }] };
  const frozen = JSON.stringify([task, project]);
  const strip = (p) => ({ ...p, record: { ...p.record, at: undefined } });
  const a = strip(routeContext(task, CURRENT, project));
  for (let i = 0; i < 10; i++) assert.deepEqual(strip(routeContext(task, CURRENT, project)), a);
  assert.equal(JSON.stringify([task, project]), frozen);
});

test('39 the router reuses the refresh vocabulary and never refreshes: it only names the reliance tokens', () => {
  for (const state of ['stale', 'partial', 'missing']) {
    const r = routeContext(T({ taskClass: 'MEDIUM', taskTypes: ['feature'] }), { state }, { reached: 3 });
    assert.ok(r.intelligence.refresh.reliesOn.every((t) => Object.keys(RELIANCE).includes(t)));
    assert.ok(!JSON.stringify(r).includes('--rehash'));
  }
  const src = fs.readFileSync(path.join(TOOLS_ROOT, 'automation', 'context-router.mjs'), 'utf8');
  assert.ok(!/runIndex|runGraph|autoRefresh|shouldAutoRefresh/.test(src), 'no refresh implementation in the router');
  assert.deepEqual(intelligenceFromStatus({ counts: { CURRENT: 3, STALE: 0, UNVERIFIABLE: 0, MISSING: 0 }, artifacts: [{ kind: 'graph', state: 'CURRENT' }, { kind: 'navigation map', state: 'CURRENT' }, { kind: 'machine index', state: 'CURRENT' }] }, 'lite'), { state: 'current', artifacts: { graph: 'current', index: 'current', directoryIndex: 'not-expected', fileIndex: 'not-expected', summary: 'not-expected' } });
  assert.equal(impactNeed({ cls: 'TRIVIAL', risk: 'LOW', types: ['documentation'], sig: {}, intent: 'change' }), 'not-needed');
  assert.equal(impactNeed({ cls: 'TRIVIAL', risk: 'LOW', types: ['bugfix'], sig: { maybeShared: true }, intent: 'change' }), 'optional');
  assert.equal(impactNeed({ cls: 'MEDIUM', risk: 'LOW', types: ['feature'], sig: {}, intent: 'read-only' }), 'not-needed', 'a read-only question needs no impact');
});

test('40 the command line: validation, status reuse, and a full walk', () => {
  const dir = tmpDir('pi-route-cli-');
  fs.cpSync(path.join(FIXTURES, 'app'), dir, { recursive: true });
  const bad = (args, pattern) => {
    const r = cli(['route', dir, ...args], dir);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, pattern, args.join(' '));
  };
  bad(['--class', 'HUGE'], /--class must be one of/);
  bad(['--state', 'fine'], /--state must be one of/);
  bad(['--signals', 'vibes'], /unknown --signals/);
  bad(['--types', 'telepathy'], /unknown task type/);
  bad(['--platform', 'toaster'], /unknown platform/);
  bad(['--targets', '../x'], /project-relative/);
  bad(['--targets', '/etc/passwd'], /project-relative/);
  bad(['--answers', '9=read'], /question numbers/);
  bad(['--answers', '1=guess'], /--answers values/);
  bad(['--reached', '9'], /--reached/);
  bad(['--loaded', 'src/a.ts=maybe'], /--loaded entries/);
  bad(['--view', 'full'], /do not apply to route/);
  bad(['--declined', 'x'], /do not apply to route/);
  assert.ok(!fs.existsSync(path.join(dir, '.ai')), 'argument errors write nothing');
  const noIntel = cli(['route', dir, '--json', '--class', 'SMALL', '--types', 'bugfix', '--targets', 'src/util.ts'], dir);
  assert.equal(noIntel.status, 0);
  assert.equal(JSON.parse(noIntel.stdout).intelligence.state, 'missing', 'no .ai/: missing, and nothing was created');
  assert.ok(!fs.existsSync(path.join(dir, '.ai')));
  const reuse = JSON.parse(cli(['route', dir, '--json', '--state', 'stale', '--artifacts', 'graph=stale', '--class', 'MEDIUM', '--types', 'feature', '--targets', 'src/util.ts', '--reached', '3'], dir).stdout);
  assert.equal(reuse.intelligence.state, 'stale');
  assert.deepEqual(reuse.requiredQueries.map((q) => q.via), ['search']);
  const stop = JSON.parse(cli(['route', dir, '--json', '--state', 'current', '--class', 'SMALL', '--types', 'bugfix', '--targets', 'src/util.ts', '--reached', '3', '--answers', '1=read,2=instruction,3=instruction,4=graph,5=test'], dir).stdout);
  assert.deepEqual([stop.stop, stop.level], [true, null]);
  const text = cli(['route', dir, '--state', 'current', '--class', 'SMALL', '--types', 'bugfix', '--targets', 'src/util.ts', '--reached', '2'], dir);
  assert.match(text.stdout, /^level 3 \(class SMALL/);
  assert.ok(os.platform().length > 0);
});
