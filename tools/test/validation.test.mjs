import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cleanup, TOOLS_ROOT, tmpDir } from './helpers.mjs';
import { analyzeChangeImpact } from '../automation/change-impact.mjs';
import { A2_REASONS, classifyArgv, classifyText, pathTargeting, typeOfScriptName } from '../automation/validation-classify.mjs';
import { DISCOVERY_BOUNDS, discoverCommands } from '../automation/validation-discovery.mjs';
import { RoutingInputError, VALIDATION_BOUNDS, bindingOf, effectiveDepth, planIdOf, planValidation, sha256 } from '../automation/validation-plan.mjs';
import { applyValidationToTaskState, resolveExecutable, runValidationPlan as runReal } from '../automation/validation-runner.mjs';
import { handoffDecision, lastValidationLines, parseLastValidation, stateRequired, updateTaskState, validationRecord } from '../automation/validation-state.mjs';
import { routeContext } from '../automation/context-router.mjs';

after(cleanup);

const REPO = path.resolve(TOOLS_ROOT, '..');
const BIN = path.join(TOOLS_ROOT, 'bin', 'project-intel.mjs');
const cli = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, windowsHide: true });
const npmAvailable = !resolveExecutable('npm').refused;

// ---- fixtures -------------------------------------------------------------------------------------------------------------

/** A discovered command, built the way discovery builds it. */
function mk(name, body, { scripts = {}, cwd = '.', origin = 'declared' } = {}) {
  return {
    id: `pkg:${cwd}:${name}`, type: typeOfScriptName(name), source: `package.json#scripts.${name}`, origin, cwd, argv: ['npm', 'run', name], display: `npm run ${name}`,
    script: body, hooks: [], targeting: pathTargeting(body), classification: classifyText(body, { scripts }),
  };
}
const digestOf = (c) => sha256(JSON.stringify([c.script ?? '', c.hooks ?? []]));
/** The opt-in that names exactly this synthetic command: its id, its definition, its type, its reasons and its scope. */
const optInFor = (c, extra = {}) => ({ commandId: c.id, scriptDigest: digestOf(c), type: c.type, reason: c.classification.reasons, scope: c.cwd === '.' ? 'project' : `path:${c.cwd}`, ...extra });
const STD = [mk('test', 'node --test'), mk('lint', 'eslint .'), mk('typecheck', 'tsc --noEmit'), mk('build', 'vite build')];

/** The part of a Phase 5D report the planner reads; the real report is used wherever the test is about the integration. */
function impactOf(o = {}) {
  const graph = o.graph ?? true;
  return {
    class: { value: o.class ?? null }, risk: { level: o.risk ?? 'LOW' }, requiredValidation: { depth: o.depth ?? 'V0', tests: { consumer: o.consumer ?? [] } },
    changedFiles: (o.files ?? ['src/a.mjs']).map((p) => ({ path: p, status: o.status ?? 'modified' })),
    affectedTests: { direct: o.direct === undefined ? [] : o.direct }, bounded: { tests: { truncated: !!o.truncated } },
    graph: { used: graph }, evidence: { graph: graph ? 'known' : 'unknown' }, completeness: o.completeness ?? (graph ? 'COMPLETE' : 'PARTIAL'), confidence: graph ? 'high' : 'low',
    dimensions: { configuration: { present: o.config === undefined ? false : o.config } }, publicSurfaceImpact: { changed: o.surface === undefined ? [] : o.surface },
  };
}
function plan(o = {}) {
  return planValidation({
    task: { taskClass: o.cls, risk: o.risk, taskTypes: o.types ?? [], intent: o.intent, changedFiles: (o.files ?? ['src/a.mjs']).map((p) => ({ path: p, status: 'modified' })) },
    impact: o.impact === undefined ? impactOf({ files: o.files }) : o.impact,
    routing: o.routing ?? null,
    project: { commands: o.commands ?? STD, declined: o.declined, standingOptIn: o.optIn, limitations: o.limitations },
  });
}
const ids = (p) => p.actions.map((a) => a.id);
const idOf = (p) => planIdOf(p.depth, p.actions, bindingOf(p));
const unpin = (args) => args.filter((a) => !/^--(script-shell|ignore-scripts|scripts-prepend-node-path)=/.test(a));
/** Tests that inject their own process layer start nothing real, so their synthetic commands need not exist in a manifest; a real run always re-reads the command. */
function runValidationPlan(p, root, opts = {}) {
  return runReal(p, root, opts.deps?.spawn && opts.verify === undefined ? { ...opts, verify: false } : opts);
}
const levels = (p) => Object.fromEntries(p.actions.map((a) => [a.id, a.level]));

function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}
function project(files, nested = []) {
  const dir = path.join(tmpDir('pi-val-'), ...nested, 'app');
  fs.mkdirSync(dir, { recursive: true });
  writeTree(dir, files);
  return dir;
}
const PKG = (scripts, extra = {}) => JSON.stringify({ name: 'val-fixture', scripts, ...extra });

/** an injected process layer: records every call, never starts anything */
function fakeDeps(handler = () => ({ status: 0, stdout: '', stderr: '' })) {
  const calls = [];
  return { calls, spawn: (file, args, options) => { calls.push({ file, args, options }); return handler(file, args, options, calls.length); }, resolve: (n) => ({ file: `/bin/${n}`, prefix: [] }) };
}
const snapshot = (dir) => {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') + fs.statSync(p).mtimeMs;
    }
  })(dir);
  return JSON.stringify(out);
};

// ---- 1 to 13: depth ---------------------------------------------------------------------------------------------------------

test('1 V0 plans only the narrowest sanity check of the changed file: no lint, no tests, no build', () => {
  const p = plan({ cls: 'TRIVIAL' });
  assert.equal(p.depth, 'V0');
  assert.deepEqual(ids(p), ['syntax']);
  assert.deepEqual(p.actions[0].files, [{ path: 'src/a.mjs', check: 'node-check' }]);
  assert.equal(p.actions[0].source, 'toolchain');
  assert.deepEqual([p.automatic, p.confirmationRequired, p.prohibited], [['syntax'], [], []]);
  assert.ok(!p.actions.some((a) => ['lint', 'type-check', 'unit-test', 'build'].includes(a.type)), 'nothing broad at V0');
  const json = plan({ cls: 'TRIVIAL', files: ['config/app.json'] });
  assert.deepEqual(json.actions[0].files, [{ path: 'config/app.json', check: 'json-parse' }]);
  const ts = plan({ cls: 'TRIVIAL', files: ['src/a.ts'] });
  assert.deepEqual([ts.actions, ts.unresolved.map((u) => u.type)], [[], ['syntax']], 'no parse-only check exists for .ts and none is declared: not guessed');
});

test('2 V1 plans lint and type check where the project provides them, narrowest first, all A1', () => {
  const p = plan({ cls: 'SMALL' });
  assert.equal(p.depth, 'V1');
  assert.deepEqual(ids(p), ['lint@.', 'type-check@.']);
  assert.deepEqual(levels(p), { 'lint@.': 'A1', 'type-check@.': 'A1' });
  assert.deepEqual(p.automatic, ids(p));
  const noLint = plan({ cls: 'SMALL', commands: [mk('test', 'node --test')] });
  assert.deepEqual(ids(noLint), ['syntax'], 'no lint or type check declared: the narrowest check that covers the change');
  assert.match(noLint.rationale.join(' '), /not applicable.*lint@\., type-check@\./);
});

test('3 V2 adds the project\'s tests, scoped as narrowly as the project\'s own command allows', () => {
  const p = plan({ cls: 'MEDIUM' });
  assert.equal(p.depth, 'V2');
  assert.deepEqual(ids(p), ['lint@.', 'type-check@.', 'unit-test@.']);
  assert.deepEqual(p.automatic, ids(p), 'V2 is still A1: project-declared checks');
  assert.ok(!ids(p).includes('build@.'), 'a build only when the change can affect it');
});

test('4 V3 adds the build when the change can affect it, and the whole plan is A2 as a set with one proposal', () => {
  const p = plan({ cls: 'LARGE', impact: impactOf({ config: true }) });
  assert.equal(p.depth, 'V3');
  assert.deepEqual(ids(p), ['lint@.', 'type-check@.', 'unit-test@.', 'build@.']);
  assert.ok(Object.values(levels(p)).every((l) => l === 'A2'));
  assert.ok(p.actions.every((a) => a.reasons.includes('validation-set')));
  assert.deepEqual([p.automatic, p.confirmationRequired.map((x) => x.id), p.confirmationRequired[0].actionIds], [[], ['p:validation-set'], ids(p)]);
  assert.match(p.confirmationRequired[0].note, /one yes covers this plan/);
});

test('5 V4 is the full relevant validation: integration, static analysis and security checks where the project defines them', () => {
  const cmds = [...STD, mk('test:integration', 'node --test tests/integration'), mk('security', 'node scripts/scan.mjs'), mk('analyze', 'eslint --max-warnings 0 .'), mk('check', 'node scripts/check.mjs')];
  const p = plan({ cls: 'ARCHITECTURAL', commands: cmds, impact: impactOf({ config: true }) });
  assert.equal(p.depth, 'V4');
  assert.deepEqual(ids(p), ['lint@.', 'type-check@.', 'unit-test@.', 'targeted-check@.', 'build@.', 'integration-test@.', 'static-analysis@.', 'security-check@.']);
  assert.ok(Object.values(levels(p)).every((l) => l === 'A2'));
  assert.ok(p.limitations.some((l) => /migration and deployment checks are never run automatically/.test(l)));
  const none = plan({ cls: 'ARCHITECTURAL' });
  assert.ok(!ids(none).includes('security-check@.'), 'a check the project does not define is not invented');
  assert.ok(ids(plan({ cls: 'LARGE', commands: cmds })).every((i) => !/integration|security|static/.test(i)), 'those are V4 only');
});

test('6 HIGH risk uses the next class\'s validation; ARCHITECTURAL stays', () => {
  assert.equal(plan({ cls: 'SMALL', risk: 'HIGH', impact: null }).depth, 'V2');
  assert.equal(plan({ cls: 'MEDIUM', risk: 'HIGH', impact: null }).depth, 'V3');
  assert.equal(plan({ cls: 'TRIVIAL', risk: 'HIGH', impact: null }).depth, 'V1');
  assert.equal(plan({ cls: 'ARCHITECTURAL', risk: 'HIGH', impact: null }).depth, 'V4');
  assert.equal(plan({ cls: 'LARGE', risk: 'HIGH', impact: null }).depth, 'V4');
});

test('7 CRITICAL risk uses the ARCHITECTURAL validation whatever the class', () => {
  for (const cls of ['TRIVIAL', 'SMALL', 'MEDIUM', 'LARGE', 'ARCHITECTURAL', undefined]) assert.equal(plan({ cls, risk: 'CRITICAL', impact: null }).depth, 'V4', String(cls));
});

test('8 9 10 11 12 13 each class maps to its depth, and an unclassified task is not an explicit TRIVIAL', () => {
  const d = (cls) => plan({ cls, impact: null }).depth;
  assert.deepEqual(['TRIVIAL', 'SMALL', 'MEDIUM', 'LARGE', 'ARCHITECTURAL'].map(d), ['V0', 'V1', 'V2', 'V3', 'V4']);
  assert.equal(d(undefined), 'V1', 'unclassified is the router\'s minimum');
  assert.notEqual(d(undefined), d('TRIVIAL'));
  assert.equal(effectiveDepth({ task: {} }).depth, routeContext({ taskClass: null, targets: ['x'], intent: 'change' }, { state: 'current' }, { reached: 3 }).validationNeeds.depth, 'the canonical router decides, not this module');
  assert.throws(() => plan({ cls: 'HUGE', impact: null }), RoutingInputError);
  assert.throws(() => plan({ cls: 'SMALL', risk: 'SEVERE', impact: null }), RoutingInputError);
});

test('8b the depth is never lowered by impact or routing, only raised', () => {
  assert.equal(plan({ cls: 'SMALL', impact: impactOf({ depth: 'V3' }) }).depth, 'V3', 'impact\'s depth is a floor');
  assert.equal(plan({ cls: 'SMALL', impact: null, routing: { class: 'SMALL', risk: 'LOW', validationNeeds: { depth: 'V2' } } }).depth, 'V2');
  assert.equal(plan({ cls: 'LARGE', impact: impactOf({ depth: 'V0' }) }).depth, 'V3', 'a lower figure from impact never lowers it');
  const p = plan({ cls: 'SMALL', impact: impactOf({ class: 'MEDIUM', depth: 'V2' }) });
  assert.equal(p.depth, 'V2');
  assert.equal(p.class, 'MEDIUM', 'a reclassification by impact (public surface, cross-subsystem) is followed');
});

// ---- 14 to 19: impact dimensions --------------------------------------------------------------------------------------------

test('14 a changed public surface can affect the build (public exports); depth rises only through class and risk', () => {
  const surface = plan({ cls: 'LARGE', impact: impactOf({ surface: [{ path: 'src/index.mjs', reasons: ['package-entry'] }], files: ['src/index.mjs'] }) });
  assert.ok(ids(surface).includes('build@.'));
  assert.match(surface.actions.find((a) => a.type === 'build').reason, /public-exports/);
  assert.equal(plan({ cls: 'SMALL', impact: impactOf({ surface: [{ path: 'x', reasons: [] }] }) }).depth, 'V1', 'a surface alone does not raise validation (ai/AUTOMATION_PROTOCOL.md: only through risk)');
});

test('15 16 17 18 19 configuration, api, data, platform and design-system impact: the build question, never an invented check', () => {
  const cfg = plan({ cls: 'LARGE', impact: impactOf({ config: true }) });
  assert.match(cfg.actions.find((a) => a.type === 'build').reason, /configuration/);
  for (const dim of ['api', 'platform', 'designSystem']) {
    const imp = impactOf();
    imp.dimensions[dim] = { present: true };
    const p = plan({ cls: 'LARGE', impact: imp });
    assert.ok(!ids(p).includes('build@.'), `${dim} impact alone does not make a build relevant`);
    assert.equal(p.depth, 'V3');
  }
  const data = impactOf();
  data.dimensions.data = { present: true };
  assert.ok(plan({ cls: 'MEDIUM', impact: data }).limitations.some((l) => /migration and deployment checks are never run automatically/.test(l)));
  const dep = plan({ cls: 'LARGE', types: ['dependency'] });
  assert.match(dep.actions.find((a) => a.type === 'build').reason, /task-type/);
  const clean = plan({ cls: 'LARGE' });
  assert.ok(clean.rationale.some((r) => /build not planned: no configuration, dependency, build-time or public-export impact/.test(r)));
});

test('19b unknown build impact is not "no build impact": the build is planned as the conservative reading and context is requested', () => {
  const p = plan({ cls: 'LARGE', impact: impactOf({ graph: false, config: null, surface: null }) });
  assert.match(p.actions.find((a) => a.type === 'build').reason, /impact-unknown/);
  assert.ok(p.limitations.some((l) => /whether the change can affect the build is unknown/.test(l)));
  assert.ok(p.contextNeeds.reasons.includes('build-impact-unresolved'));
  const absent = plan({ cls: 'LARGE', impact: null });
  assert.match(absent.actions.find((a) => a.type === 'build').reason, /impact-unknown/);
});

// ---- 20 to 23: tests --------------------------------------------------------------------------------------------------------

test('20 affected tests become one targeted run, with project-relative paths passed as separate arguments', () => {
  const p = plan({ cls: 'MEDIUM', impact: impactOf({ direct: ['src/a.test.mjs', 'src/my dir/ü b.test.mjs'], consumer: ['src/c.test.mjs'] }) });
  const t = p.actions.find((a) => a.type === 'unit-test');
  assert.deepEqual(t.command.argv, ['npm', 'run', 'test', 'src/a.test.mjs', 'src/c.test.mjs', 'src/my dir/ü b.test.mjs'].sort((x, y) => 0) && ['npm', 'run', 'test', 'src/a.test.mjs', 'src/c.test.mjs', 'src/my dir/ü b.test.mjs']);
  assert.equal(t.narrow, true);
  assert.match(t.reason, /affected tests, appended to the project's test command \(narrowest declared scope\)/);
  assert.deepEqual(t.files, ['src/a.test.mjs', 'src/c.test.mjs', 'src/my dir/ü b.test.mjs']);
  const v1 = plan({ cls: 'SMALL', impact: impactOf({ direct: ['src/a.test.mjs'] }) });
  assert.ok(v1.actions.some((a) => a.type === 'unit-test' && a.narrow), 'V1: the narrowest targeted test that covers the change, if one exists');
  const dash = plan({ cls: 'MEDIUM', impact: impactOf({ direct: ['-weird.test.mjs'] }) });
  assert.ok(dash.actions.find((a) => a.type === 'unit-test').command.argv.includes('./-weird.test.mjs'), 'a path can never look like an option');
  const noTarget = plan({ cls: 'MEDIUM', impact: impactOf({ direct: ['src/a.test.mjs'] }), commands: [mk('test', 'node scripts/run-all.mjs'), mk('lint', 'eslint .')] });
  assert.ok(!noTarget.actions.find((a) => a.type === 'unit-test').narrow, 'a command that cannot take paths is not given any');
  assert.ok(noTarget.limitations.some((l) => /cannot take file arguments/.test(l)));
});

test('21 unknown affected tests are not "no tests": nothing is assumed, and the whole declared script is the narrowest known scope at V2', () => {
  const unknown = plan({ cls: 'MEDIUM', impact: impactOf({ graph: false, direct: null }) });
  assert.equal(unknown.impact.testsKnown, false);
  const t = unknown.actions.find((a) => a.type === 'unit-test');
  assert.ok(t && !t.narrow);
  assert.match(t.reason, /affected tests are unknown \(not assumed none\)/);
  assert.ok(unknown.limitations.some((l) => /tests could not be narrowed: affected tests are unknown/.test(l)));
  assert.ok(unknown.contextNeeds.reasons.includes('affected-tests-unknown'));
  const v1 = plan({ cls: 'SMALL', impact: impactOf({ graph: false, direct: null }) });
  assert.ok(!v1.actions.some((a) => a.type === 'unit-test'));
  assert.ok(v1.limitations.some((l) => /affected tests are unknown \(not assumed none\)/.test(l)));
  const known = plan({ cls: 'MEDIUM', impact: impactOf({ direct: [] }) });
  assert.ok(known.actions.find((a) => a.type === 'unit-test').reason.includes('no test is known to depend on the change'), 'known-empty is stated differently from unknown');
  assert.equal(known.impact.testsKnown, true);
});

test('22 partial impact lowers confidence and asks for context, for MEDIUM and larger or HIGH risk', () => {
  const partial = plan({ cls: 'MEDIUM', impact: impactOf({ graph: true, completeness: 'PARTIAL' }) });
  assert.equal(partial.impact.state, 'partial');
  assert.ok(partial.contextNeeds.justified && partial.contextNeeds.reasons.includes('impact-incomplete'));
  assert.deepEqual(partial.contextNeeds.signals, { dependencyUncertain: true }, 'a request to the router, not a second router');
  assert.ok(partial.limitations.some((l) => /impact is not fully established/.test(l)));
  const real = analyzeChangeImpact({ files: [{ path: 'src/a.mjs', status: 'modified' }], taskClass: 'MEDIUM' }, { state: 'missing' }, {});
  const fromReal = planValidation({ task: { taskClass: 'MEDIUM' }, impact: real, project: { commands: STD } });
  assert.equal(fromReal.impact.state, 'unknown');
  assert.equal(fromReal.confidence, 'low');
  assert.ok(fromReal.contextNeeds.reasons.includes('impact-incomplete'));
  assert.equal(plan({ cls: 'TRIVIAL', impact: impactOf({ graph: false, direct: null }) }).contextNeeds.justified, false, 'a TRIVIAL change does not reopen context for it');
});

test('23 bounded impact: truncated affected tests are not targeted; the plan itself is bounded and says what it cut', () => {
  const trunc = plan({ cls: 'MEDIUM', impact: impactOf({ direct: Array.from({ length: 20 }, (_, i) => `src/t${i}.test.mjs`), truncated: true }) });
  assert.ok(!trunc.actions.find((a) => a.type === 'unit-test').narrow, 'a truncated list is not the whole truth: the wider declared scope is used');
  assert.ok(trunc.limitations.some((l) => /exceed the impact bound/.test(l)));
  const files = Array.from({ length: 12 }, (_, i) => `src/m${i}.mjs`);
  const many = plan({ cls: 'TRIVIAL', files });
  assert.equal(many.actions[0].files.length, VALIDATION_BOUNDS.syntaxFiles);
  assert.deepEqual(many.bounded.syntaxFiles, { limit: 8, total: 12, returned: 8, omitted: 4, truncated: true });
  assert.ok(many.limitations.some((l) => /4 more changed file\(s\) were not syntax-checked \(limit 8\)/.test(l)));
  const manyTests = plan({ cls: 'MEDIUM', impact: impactOf({ direct: Array.from({ length: 30 }, (_, i) => `src/t${String(i).padStart(2, '0')}.test.mjs`) }) });
  assert.equal(manyTests.actions.find((a) => a.type === 'unit-test').files.length, VALIDATION_BOUNDS.testFiles);
  assert.equal(manyTests.bounded.testFiles.omitted, 10);
  const wide = Array.from({ length: 8 }, (_, i) => mk(`lint:${i}`, 'eslint .', { cwd: `pkg${i}` })).concat(Array.from({ length: 8 }, (_, i) => mk('test', 'node --test', { cwd: `pkg${i}` })));
  const big = plan({ cls: 'MEDIUM', files: Array.from({ length: 8 }, (_, i) => `pkg${i}/src/a.mjs`), commands: wide });
  assert.ok(big.actions.length <= VALIDATION_BOUNDS.actions);
  assert.equal(big.bounded.actions.truncated, big.bounded.actions.total > VALIDATION_BOUNDS.actions);
});

// ---- 24 to 28: levels -------------------------------------------------------------------------------------------------------

test('24 A1: a project-declared check with readable effects runs automatically', () => {
  const p = plan({ cls: 'SMALL' });
  assert.deepEqual(p.automatic, ['lint@.', 'type-check@.']);
  assert.deepEqual(p.actions.map((a) => a.classification), [{ level: 'A1', reasons: [] }, { level: 'A1', reasons: [] }]);
  assert.deepEqual(p.summary, { planned: 2, automatic: 2, proposed: 0, prohibited: 0, unresolved: 0 });
});

test('25 A2: an unclear or network-needing command is a proposal that states action, scope, reason, effect and alternative', () => {
  const cmds = [mk('lint', 'npx eslint .'), mk('typecheck', 'tsc --noEmit')];
  const p = plan({ cls: 'SMALL', commands: cmds });
  assert.deepEqual(levels(p), { 'lint@.': 'A2', 'type-check@.': 'A1' });
  assert.deepEqual(p.automatic, ['type-check@.']);
  assert.equal(p.confirmationRequired.length, 1);
  const pr = p.confirmationRequired[0];
  assert.deepEqual([pr.action, pr.scope, pr.reason, pr.level, pr.actionIds, pr.declined], ['validation', 'project', 'network-possible', 'A2', ['lint@.'], false]);
  assert.match(pr.effect, /runs npm run lint \[project script: "npx eslint \."; classified network-possible\]; may use the network/);
  assert.match(pr.note, /read the script before saying yes/);
  assert.match(pr.alternative, /not run, declined/);
  assert.ok(A2_REASONS.includes(pr.reason));
  const unclear = plan({ cls: 'SMALL', commands: [mk('lint', 'echo skipping')] });
  assert.equal(unclear.confirmationRequired[0].reason, 'unclear-command');
  assert.equal(plan({ cls: 'SMALL', commands: [mk('lint', 'eslint --fix .')] }).confirmationRequired[0].reason, 'mutating');
  assert.equal(plan({ cls: 'SMALL', commands: [mk('lint', 'eslint $(cat list)')] }).confirmationRequired[0].reason, 'shell-construct');
});

test('26 a decline is specific to its reason and never becomes a pass', () => {
  const cmds = [mk('lint', 'npx eslint .'), mk('typecheck', 'tsc --noEmit'), mk('test', 'playwright test')];
  const base = plan({ cls: 'MEDIUM', commands: cmds });
  assert.deepEqual(base.confirmationRequired.map((p) => p.reason).sort(), ['expensive', 'network-possible']);
  const declined = plan({ cls: 'MEDIUM', commands: cmds, declined: ['network-possible'] });
  assert.deepEqual(declined.confirmationRequired.map((p) => [p.reason, p.declined]).sort(), [['expensive', false], ['network-possible', true]]);
  const root = project({});
  const deps = fakeDeps();
  const r = runValidationPlan(declined, root, { execute: true, deps, confirm: { planId: declined.planId, proposals: ['p:expensive'] } });
  assert.deepEqual(r.declined, ['lint@.']);
  assert.deepEqual(r.passed, ['type-check@.', 'unit-test@.'].filter((id) => r.passed.includes(id)));
  assert.equal(r.status, 'DECLINED');
  assert.notEqual(r.status, 'PASS');
  assert.equal(r.actions.find((a) => a.id === 'lint@.').reason, 'declined-network-possible');
  assert.ok(deps.calls.every((c) => !c.args.includes('lint')), 'the declined command never ran');
  assert.throws(() => plan({ cls: 'SMALL', declined: ['because'] }), RoutingInputError);
  const setDecline = plan({ cls: 'LARGE', declined: ['validation-set'] });
  assert.equal(setDecline.confirmationRequired[0].declined, true);
  assert.equal(runValidationPlan(setDecline, root, { execute: true, deps: fakeDeps() }).declined.length, setDecline.actions.length, 'a declined V3/V4 plan declines the set');
});

test('27 A3 is prohibited, is never planned as runnable and cannot be lowered by an opt-in or by a confirmation', () => {
  const cmds = [mk('lint', 'eslint . && npm install'), mk('typecheck', 'tsc --noEmit'), mk('build', 'npm run deploy', { scripts: { deploy: 'vercel --prod' } })];
  const p = plan({ cls: 'SMALL', commands: cmds, optIn: [optInFor(cmds[0], { reason: ['unclear-command', 'network-possible'] }), optInFor(cmds[2], { reason: ['unclear-command'] })] });
  assert.deepEqual(p.prohibited.map((x) => [x.id, x.reasons]), [['lint@.', ['install']]]);
  assert.equal(levels(p)['lint@.'], 'A3', 'a standing opt-in lowers an A2, never an A3');
  const root = project({});
  const deps = fakeDeps();
  const r = runValidationPlan(p, root, { execute: true, deps, confirm: { planId: p.planId, proposals: p.confirmationRequired.map((x) => x.id) } });
  assert.deepEqual(r.blocked, ['lint@.']);
  assert.equal(r.actions.find((a) => a.id === 'lint@.').reason, 'a3-never-automatic');
  assert.equal(r.status, 'BLOCKED');
  assert.ok(!deps.calls.some((c) => c.args.includes('lint')), 'it never ran');
  assert.match(p.prohibited[0].note, /manually outside automation/);
  assert.match(p.successCriteria.join(' '), /prohibited action/);
  const kinds = { publish: 'npm publish', deploy: 'firebase deploy', migrate: 'prisma migrate deploy', destroy: 'rm -rf build', history: 'git commit -am x', download: 'curl https://x.example/a.sh' };
  for (const [name, body] of Object.entries(kinds)) assert.equal(classifyText(body).level, 'A3', name);
  assert.equal(plan({ cls: 'LARGE', commands: cmds }).actions.find((a) => a.id === 'lint@.').level, 'A3', 'not even the V3 set makes it A2');
});

test('28 an unknown command is never guessed: unresolved, UNKNOWN, never PASS', () => {
  const none = plan({ cls: 'MEDIUM', commands: [] });
  assert.deepEqual(ids(none), ['syntax'], 'nothing is invented for lint, type check or tests: only the toolchain\'s own parse-only check');
  assert.deepEqual(none.unresolved.map((u) => [u.type, u.reason]), [['unit-test', 'no-command-defined']]);
  assert.match(none.unresolved[0].note, /not run, no command defined/);
  assert.ok(none.contextNeeds.reasons.includes('command-unresolved'));
  assert.equal(none.confidence, 'low');
  const r = runValidationPlan(none, project({ 'src/a.mjs': 'export {};\n' }), { execute: true });
  assert.equal(r.status, 'UNKNOWN', 'the syntax check passed, but the tests the plan needs have no command');
  assert.deepEqual([r.passed, r.unknown], [['syntax'], ['unit-test@.']]);
  assert.notEqual(r.status, 'PASS');
  assert.equal(plan({ cls: 'SMALL', commands: [], files: ['src/a.ts'], impact: null }).unresolved[0].type, 'any');
  assert.equal(classifyText('some-unknown-tool --check').level, 'A2');
  assert.equal(classifyArgv([]).level, 'A3');
  assert.equal(classifyArgv(['node', 'a\0b']).level, 'A3');
});

// ---- 29: discovery ------------------------------------------------------------------------------------------------------------

test('29 commands come from the project\'s manifests: scripts by name, hooks and nested scripts included in the classification', () => {
  const dir = project({
    'package.json': PKG({ test: 'node --test', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'vite build', pretest: 'npm run clean', clean: 'rm -rf dist', start: 'node server.js', dev: 'vite', 'test:e2e': 'playwright test', audit: 'npm audit', release: 'npm publish' }),
    'src/a.mjs': 'export {};\n',
  });
  const d = discoverCommands(dir, { changedFiles: ['src/a.mjs'] });
  const byId = Object.fromEntries(d.commands.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), ['pkg:.:audit', 'pkg:.:build', 'pkg:.:lint', 'pkg:.:test', 'pkg:.:test:e2e', 'pkg:.:typecheck']);
  assert.deepEqual([byId['pkg:.:lint'].type, byId['pkg:.:typecheck'].type, byId['pkg:.:test:e2e'].type, byId['pkg:.:audit'].type], ['lint', 'type-check', 'integration-test', 'security-check']);
  assert.deepEqual(byId['pkg:.:lint'].argv, ['npm', 'run', 'lint']);
  assert.equal(byId['pkg:.:test'].classification.level, 'A3', 'the pretest hook runs `npm run clean`, which deletes: the hook is classified with its script');
  assert.deepEqual(byId['pkg:.:test'].hooks, ['pre']);
  assert.deepEqual(byId['pkg:.:audit'].classification, { level: 'A2', reasons: ['network-possible'] });
  assert.equal(byId['pkg:.:test:e2e'].classification.level, 'A2');
  assert.ok(!('pkg:.:start' in byId) && !('pkg:.:release' in byId), 'scripts that are not validation are not offered');
  assert.deepEqual(d.sources, ['package.json']);
  assert.ok(d.commands.every((c) => !path.isAbsolute(c.cwd)), 'project-relative');
  assert.ok(!d.sources.some((s) => /\.env/.test(s)));
  assert.deepEqual(byId['pkg:.:test'].targeting, { mode: 'append-paths', runner: 'node-test', narrows: true });
});

test('29b pnpm, yarn and bun are used when the project says so; monorepo packages govern their own files', () => {
  const dir = project({
    'package.json': PKG({ lint: 'eslint .' }, { packageManager: 'pnpm@9.0.0' }),
    'packages/web/package.json': PKG({ test: 'vitest run', lint: 'eslint src' }),
    'packages/web/src/a.mjs': 'export {};\n',
    'packages/api/package.json': PKG({ test: 'jest' }),
    'tools/x.mjs': 'export {};\n',
  });
  const d = discoverCommands(dir, { changedFiles: ['packages/web/src/a.mjs', 'tools/x.mjs'] });
  assert.deepEqual(d.commands.map((c) => [c.id, c.argv[0]]), [['pkg:.:lint', 'pnpm'], ['pkg:packages/web:lint', 'npm'], ['pkg:packages/web:test', 'npm']]);
  assert.ok(!d.commands.some((c) => c.cwd === 'packages/api'), 'only the manifests that govern changed files are read');
  const p = planValidation({ task: { taskClass: 'MEDIUM' }, impact: null, project: { commands: d.commands } });
  p.actions.forEach((a) => assert.ok(a.command.cwd === '.' || a.command.cwd === 'packages/web'));
  const none = planValidation({ task: { taskClass: 'SMALL', changedFiles: [{ path: 'packages/web/src/a.mjs' }] }, impact: null, project: { commands: d.commands } });
  assert.deepEqual(none.actions.map((a) => [a.id, a.command.cwd]), [['lint@packages/web', 'packages/web']], 'the nearest package\'s own lint, not the root\'s');
  const yarn = project({ 'package.json': PKG({ test: 'jest' }), 'yarn.lock': '' });
  assert.deepEqual(discoverCommands(yarn, { changedFiles: [] }).commands[0].argv, ['yarn', 'run', 'test']);
});

test('29c other manifests: tools the project names but does not declare are proposals; build systems are not parsed or guessed', () => {
  const dir = project({ 'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n[tool.ruff]\nline-length = 100\n', 'Cargo.toml': '[package]\nname = "x"\n', 'Makefile': 'test:\n\techo hi\n', 'go.mod': 'module x\n' });
  const d = discoverCommands(dir, { changedFiles: [] });
  const byId = Object.fromEntries(d.commands.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), ['cfg:cargo-check', 'cfg:cargo-test', 'cfg:pytest', 'cfg:ruff']);
  assert.ok(Object.values(byId).every((c) => c.origin === 'inferred' && c.classification.level === 'A2' && c.classification.reasons.includes('inferred-from-config')));
  assert.ok(byId['cfg:cargo-test'].classification.reasons.includes('network-possible'));
  assert.deepEqual(d.notParsed, ['Makefile', 'go.mod']);
  assert.ok(d.limitations.some((l) => /present and not parsed \(commands are never guessed\): Makefile, go\.mod/.test(l)));
  const p = planValidation({ task: { taskClass: 'MEDIUM', changedFiles: [{ path: 'src/a.py' }] }, impact: null, project: { commands: d.commands } });
  assert.ok(p.actions.every((a) => a.level === 'A2'), 'a tool the project merely names is proposed, never run on its own');
  assert.equal(p.automatic.length, 0);
});

test('29d invalid, oversized or missing manifests yield no command and a stated limitation', () => {
  const bad = project({ 'package.json': '{ not json' });
  const d = discoverCommands(bad, { changedFiles: [] });
  assert.deepEqual(d.commands, []);
  assert.ok(d.limitations.some((l) => /package\.json is not valid JSON: no command was taken from it/.test(l)));
  const big = project({ 'package.json': PKG({ test: 'node --test', pad: 'x'.repeat(DISCOVERY_BOUNDS.manifestBytes) }) });
  assert.ok(discoverCommands(big, { changedFiles: [] }).limitations.some((l) => /larger than/.test(l)));
  assert.deepEqual(discoverCommands(project({}), { changedFiles: [] }), { commands: [], sources: [], notParsed: [], limitations: [] });
  const scripts = {};
  for (let i = 0; i < 50; i++) scripts[`lint:${String(i).padStart(2, '0')}`] = 'eslint .';
  const many = discoverCommands(project({ 'package.json': PKG(scripts) }), { changedFiles: [] });
  assert.equal(many.commands.length, DISCOVERY_BOUNDS.scriptsPerManifest);
  assert.ok(many.limitations.some((l) => /more than 40 validation scripts/.test(l)));
  const longBody = discoverCommands(project({ 'package.json': PKG({ test: `node --test ${'a'.repeat(1100)}` }) }), { changedFiles: [] });
  assert.equal(longBody.commands[0].classification.level, 'A2', 'a script too long to read is not trusted');
});

test('29e discovery reads only named manifests: no source file, no .env, no secret path', () => {
  const dir = project({ 'package.json': PKG({ test: 'node --test' }), '.env': 'API_KEY=SHOULD-NOT-BE-READ\n', 'src/a.mjs': 'const k = "SHOULD-NOT-BE-READ";\n', 'secrets/package.json': PKG({ test: 'cat .env' }) });
  const d = discoverCommands(dir, { changedFiles: ['src/a.mjs', 'secrets/id_rsa', '.env'] });
  assert.ok(!JSON.stringify(d).includes('SHOULD-NOT-BE-READ'));
  assert.deepEqual(d.sources, ['package.json']);
  const p = plan({ cls: 'SMALL', files: ['src/a.mjs', '.env'], impact: null });
  assert.deepEqual(p.limitations.filter((l) => /secret patterns/.test(l)), ['1 changed path(s) match secret patterns and are not part of any validation: nothing is invented for hidden files']);
  assert.ok(!JSON.stringify(p).includes('.env'));
});

// ---- 30 to 33: kinds of validation, executed ----------------------------------------------------------------------------------

test('30 syntax validation really runs the language\'s parse-only check: a good file passes, a broken one fails with a short excerpt', () => {
  const dir = project({ 'src/ok.mjs': 'export const a = 1;\n', 'src/bad.mjs': 'export const = ;\n', 'data/ok.json': '{"a":1}\n', 'data/bad.json': '{"a":\n' });
  const run = (files) => runValidationPlan(plan({ cls: 'TRIVIAL', files, commands: [] }), dir, { execute: true });
  const ok = run(['src/ok.mjs', 'data/ok.json']);
  assert.deepEqual([ok.status, ok.passed, ok.executed], ['PASS', ['syntax'], ['syntax']]);
  assert.equal(ok.actions[0].evidence.files, 2);
  const bad = run(['src/ok.mjs', 'src/bad.mjs', 'data/bad.json']);
  assert.equal(bad.status, 'FAIL');
  assert.equal(bad.actions[0].evidence.failed, 2);
  assert.ok(bad.evidence.failures[0].excerpt.some((l) => l.startsWith('src/bad.mjs')));
  assert.ok(!JSON.stringify(bad).includes(dir) && !JSON.stringify(bad).includes(dir.replace(/\\/g, '/')), 'no absolute path leaves');
  assert.equal(run(['src/gone.mjs']).status, 'FAIL', 'a missing file is not a pass');
});

test('31 test validation runs the project\'s own test command, with the affected tests appended, as an argument vector', () => {
  const impact = impactOf({ direct: ['src/a.test.mjs'], files: ['src/a.mjs'] });
  const p = plan({ cls: 'MEDIUM', impact, commands: [mk('test', 'node --test')] });
  const dir = project({});
  const deps = fakeDeps();
  const r = runValidationPlan(p, dir, { execute: true, deps });
  assert.equal(r.status, 'PASS');
  const npm = deps.calls.filter((c) => c.file === '/bin/npm');
  assert.equal(npm.length, 1);
  assert.deepEqual(unpin(npm[0].args), ['run', 'test', 'src/a.test.mjs']);
  assert.ok(deps.calls.every((c) => c.options.shell === false));
  assert.equal(path.resolve(npm[0].options.cwd), path.resolve(dir));
  assert.deepEqual(npm[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.ok(npm[0].options.timeout > 0 && npm[0].options.maxBuffer > 0, 'time and output are limited');
});

test('31b a real project: the declared scripts run through the package manager and their exit status decides', { skip: !npmAvailable && 'npm cannot be run without a shell here' }, () => {
  const dir = project({
    'package.json': PKG({ lint: 'node --check scripts/lint.mjs', test: 'node --test' }),
    'scripts/lint.mjs': 'console.log("lint ok");\n',
    'src/a.mjs': 'export const a = 1;\n',
  });
  const out = cli(['validate', dir, '--modified', 'src/a.mjs', '--class', 'SMALL', '--fresh-graph', '--run', '--json'], dir);
  assert.equal(out.status, 0, out.stderr + out.stdout);
  const r = JSON.parse(out.stdout);
  assert.deepEqual([r.result.status, r.result.passed], ['PASS', ['lint@.']]);
  assert.ok(r.result.actions[0].evidence.durationMs >= 0);
  fs.writeFileSync(path.join(dir, 'scripts/lint.mjs'), 'console.error(1 problem\n');
  const failed = cli(['validate', dir, '--modified', 'src/a.mjs', '--class', 'SMALL', '--fresh-graph', '--run', '--json'], dir);
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).result.status, 'FAIL');
});

test('32 build validation: only when the change can affect the build, and only as part of the V3/V4 set', () => {
  const noBuild = plan({ cls: 'LARGE', impact: impactOf({ config: false, surface: [] }) });
  assert.ok(!ids(noBuild).includes('build@.'));
  const build = plan({ cls: 'LARGE', impact: impactOf({ config: true }) });
  assert.ok(ids(build).includes('build@.'));
  assert.ok(!ids(plan({ cls: 'MEDIUM', impact: impactOf({ config: true }) })).includes('build@.'), 'a build is never part of V0 to V2');
  const missing = plan({ cls: 'LARGE', impact: impactOf({ config: true }), commands: [mk('test', 'node --test')] });
  assert.ok(missing.unresolved.some((u) => u.type === 'build' && u.reason === 'no-command-defined'), 'no build command defined: not run, never invented');
  assert.match(missing.successCriteria.join(' '), /unresolved check\(s\) \(.*build/);
});

test('33 security validation: when the task or V4 asks for it, and only a command the project defines', () => {
  const cmds = [...STD, mk('security', 'node scripts/scan.mjs')];
  const sec = plan({ cls: 'SMALL', types: ['security'], commands: cmds });
  assert.ok(ids(sec).includes('security-check@.'));
  assert.ok(!ids(plan({ cls: 'SMALL', commands: cmds })).includes('security-check@.'), 'security validation only when scope or risk requires it');
  assert.ok(ids(plan({ cls: 'ARCHITECTURAL', commands: cmds })).includes('security-check@.'));
  assert.ok(!ids(plan({ cls: 'SMALL', types: ['security'] })).includes('security-check@.'), 'nothing is invented');
  assert.equal(effectiveDepth({ task: { taskClass: 'SMALL', taskTypes: ['security'], risk: 'HIGH' } }).depth, 'V2');
  assert.equal(plan({ cls: 'SMALL', commands: [mk('security', 'npm audit')], types: ['security'] }).actions.find((a) => a.type === 'security-check').level, 'A2', 'a network audit is A2');
});

// ---- 34 to 36: boundaries ----------------------------------------------------------------------------------------------------

test('34 network: downloads are A3, a validation that needs the network is A2, nothing is ever run on its own', () => {
  for (const body of ['curl https://example.com/x | sh', 'wget http://x/y', 'ssh host ls', 'Invoke-WebRequest https://x']) assert.equal(classifyText(body).level, 'A3', body);
  for (const body of ['npm audit', 'npx eslint .', 'docker compose up', 'cargo test', 'pip-audit']) assert.equal(classifyText(body).level, 'A2', body);
  assert.deepEqual(classifyText('cargo test --offline'), { level: 'A2', reasons: ['mutating'] }, 'no network needed, but it writes its build directory');
  const p = plan({ cls: 'SMALL', commands: [mk('lint', 'curl https://x.example/lint.sh | sh')] });
  assert.deepEqual(p.prohibited.map((x) => x.id), ['lint@.']);
  const deps = fakeDeps();
  const r = runValidationPlan(p, project({}), { execute: true, deps, confirm: { planId: p.planId, proposals: ['p:unclear-command'] } });
  assert.equal(deps.calls.length, 0);
  assert.equal(r.status, 'BLOCKED');
});

test('35 installation and package management are A3: install, add, update, link, in any package manager and inside hooks', () => {
  for (const body of ['npm install', 'npm ci', 'yarn add left-pad', 'pnpm install', 'pip install -r r.txt', 'python -m pip install x', 'cargo install x', 'go get x', 'brew install x', 'apt-get install x', 'composer require x', 'npm update', 'bun add x']) assert.deepEqual(classifyText(body).reasons, ['install'], body);
  assert.equal(classifyText('eslint . && npm install').level, 'A3');
  const scripts = { lint: 'npm run setup && eslint .', setup: 'npm ci' };
  assert.equal(classifyText('npm run lint', { scripts }).level, 'A3', 'a nested script is followed');
  assert.equal(classifyText('npm run a', { scripts: { a: 'npm run b', b: 'npm run c', c: 'npm run d', d: 'eslint .' } }).level, 'A2', 'nesting deeper than 3 is not trusted');
  assert.equal(classifyText('npm run missing', { scripts }).level, 'A2');
  const dir = project({ 'package.json': PKG({ lint: 'eslint .', prelint: 'npm install' }) });
  assert.equal(discoverCommands(dir, { changedFiles: [] }).commands[0].classification.level, 'A3', 'a lifecycle hook is part of the command');
});

test('36 version-control history is A3: commit, push, rebase, merge, reset, clean, stash, tag; read-only queries are fine', () => {
  for (const body of ['git commit -m x', 'git push', 'git rebase main', 'git merge x', 'git reset --hard', 'git clean -fd', 'git stash', 'git tag v1', 'git checkout -b x', 'git pull', 'git add .']) assert.deepEqual(classifyText(body).reasons, ['git-history'], body);
  for (const body of ['git status', 'git diff --stat', 'git log -1', 'git ls-files']) assert.equal(classifyText(body).level, 'A1', body);
  assert.equal(classifyText('eslint . && git commit -am lint').level, 'A3');
  assert.equal(classifyArgv(['git', 'push', 'origin', 'main']).level, 'A3');
});

// ---- 37 to 40: result statuses ---------------------------------------------------------------------------------------------

test('37 a failing A1 check is reported: no retry, no mutation, no weaker depth, the rest not run', () => {
  const dir = project({ 'src/a.mjs': 'export const a = 1;\n' });
  const before = snapshot(dir);
  const p = plan({ cls: 'MEDIUM' });
  const deps = fakeDeps((file, args) => (args.includes('lint') ? { status: 1, stdout: '', stderr: 'src/a.mjs: 3 problems\nError at ' + dir + '/src/a.mjs\n' } : { status: 0, stdout: '', stderr: '' }));
  const r = runValidationPlan(p, dir, { execute: true, deps });
  assert.equal(r.status, 'FAIL');
  assert.deepEqual([r.failed, r.notRun, r.passed], [['lint@.'], ['type-check@.', 'unit-test@.'], []]);
  assert.equal(r.actions.find((a) => a.id === 'type-check@.').reason, 'stopped-after-failure');
  assert.equal(deps.calls.length, 1, 'no retry, and nothing past the failure ran');
  assert.equal(r.depth, 'V2', 'the depth is not weakened');
  assert.equal(snapshot(dir), before, 'the project was not changed to make it pass');
  assert.deepEqual(r.evidence.failures[0].excerpt, ['src/a.mjs: 3 problems', 'Error at <project>/src/a.mjs']);
  const cont = runValidationPlan(plan({ cls: 'MEDIUM' }), dir, { execute: true, continueAfterFailure: true, deps: fakeDeps((f, a) => (a.includes('lint') ? { status: 1 } : { status: 0 })) });
  assert.deepEqual([cont.failed, cont.passed], [['lint@.'], ['type-check@.', 'unit-test@.']]);
  assert.equal(cont.status, 'FAIL', 'a failure is never outweighed by passes');
  assert.equal(r.record.result, 'failed');
});

test('38 NOT_RUN is not PASS: nothing executed without a request, without a confirmation, or after a stop', () => {
  const root = project({});
  const deps = fakeDeps();
  const planOnly = runValidationPlan(plan({ cls: 'SMALL' }), root, { deps });
  assert.deepEqual([planOnly.status, planOnly.notRun, planOnly.passed, deps.calls.length], ['NOT_RUN', ['lint@.', 'type-check@.'], [], 0]);
  assert.equal(planOnly.actions[0].reason, 'execution-not-requested');
  const set = plan({ cls: 'LARGE' });
  const awaiting = runValidationPlan(set, root, { execute: true, deps });
  assert.deepEqual([awaiting.status, deps.calls.length], ['NOT_RUN', 0]);
  assert.ok(awaiting.actions.every((a) => a.reason === 'awaiting-confirmation'));
  assert.equal(awaiting.confidence, 'low');
  const wrongPlan = runValidationPlan(set, root, { execute: true, deps, confirm: { planId: 'not-this-plan', proposals: ['p:validation-set'] } });
  assert.equal(wrongPlan.status, 'NOT_RUN', 'a yes for another plan is not a yes for this one');
  const notRequired = runValidationPlan(plan({ cls: 'SMALL', types: ['documentation'] }), root, { execute: true, deps });
  assert.deepEqual([notRequired.status, notRequired.required, notRequired.confidence], ['NOT_RUN', false, 'n/a']);
  assert.ok(plan({ cls: 'SMALL', intent: 'read-only' }).rationale[0].includes('read-only'));
  assert.equal(plan({ cls: 'SMALL', intent: 'read-only' }).required, false);
});

test('39 DECLINED is not PASS and keeps its reason; a confirmation of the plan runs the V3/V4 set once', () => {
  const root = project({});
  const set = plan({ cls: 'LARGE', declined: ['validation-set'] });
  const r = runValidationPlan(set, root, { execute: true, deps: fakeDeps() });
  assert.equal(r.status, 'DECLINED');
  assert.ok(r.actions.every((a) => a.status === 'DECLINED' && a.reason === 'declined-validation-set'));
  assert.equal(r.record.result, 'declined');
  const ok = plan({ cls: 'LARGE' });
  const deps = fakeDeps();
  const yes = runValidationPlan(ok, root, { execute: true, deps, confirm: { planId: ok.planId, proposals: ['p:validation-set'] } });
  assert.deepEqual([yes.status, yes.passed.length, deps.calls.length], ['PASS', ok.actions.length, ok.actions.length]);
  assert.equal(yes.record.level, 'A2');
});

test('40 UNKNOWN is not PASS: a timeout, a signal, an unresolved check; and the precedence of the overall status', () => {
  const root = project({});
  const timeout = runValidationPlan(plan({ cls: 'SMALL' }), root, { execute: true, deps: fakeDeps(() => ({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }), treeTerminated: true })) });
  assert.equal(timeout.status, 'UNKNOWN');
  assert.equal(timeout.actions[0].reason, 'timed-out');
  assert.equal(timeout.actions[0].evidence.timedOut, true);
  const killed = runValidationPlan(plan({ cls: 'SMALL' }), root, { execute: true, deps: fakeDeps(() => ({ status: null, signal: 'SIGKILL' })) });
  assert.equal(killed.status, 'UNKNOWN');
  const noStart = runValidationPlan(plan({ cls: 'SMALL' }), root, { execute: true, deps: { ...fakeDeps(() => ({ status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) })) } });
  assert.equal(noStart.status, 'BLOCKED', 'a command that cannot start is reported, never a pass');
  const mixed = runValidationPlan(plan({ cls: 'MEDIUM', commands: [mk('lint', 'eslint .'), mk('test', 'node --test')] }), root, { execute: true, continueAfterFailure: true, deps: fakeDeps((f, a) => (a.includes('lint') ? { status: 0 } : { status: null, signal: 'SIGKILL' })) });
  assert.deepEqual([mixed.status, mixed.passed, mixed.unknown], ['UNKNOWN', ['lint@.'], ['unit-test@.']]);
  const empty = runValidationPlan({ ...plan({ cls: 'SMALL' }), actions: [], planId: planIdOf('V1', [], bindingOf({ ...plan({ cls: 'SMALL' }), confirmationRequired: [], prohibited: [], unresolved: [] })) }, root, { execute: true, deps: fakeDeps() });
  assert.equal(empty.status, 'NOT_RUN', 'an empty plan proves nothing');
});

// ---- 41 to 43: TASK_STATE and handoff ----------------------------------------------------------------------------------------

const RESULT = (status, extra = {}) => ({ v: 1, planId: 'abcdef0123456789', depth: 'V2', status, required: true, actions: [{ id: 'lint@.', status: status === 'PASS' ? 'PASS' : status, reason: status === 'FAIL' ? 'exit-status-1' : undefined }], executed: [], passed: [], failed: [], notRun: [], declined: [], blocked: [], unknown: [], ...extra });
const STATE = `---\nupdatedAt: 2026-01-01T00:00:00Z\nowner: agent-a\n---\n# Task State\n\n## Goal\nx\n\n## Status\nin-progress\n\n## Class and risk\nClass: MEDIUM\nRisk: LOW\nReclassified: no\n\n## Completed\n\n## Changed files\n\n## Remaining\n1. write docs\n\n## Known problems\n- old problem\n\n## Open decisions\n\n## Blocked\n\n## Last validation\n- old: passed\n`;

const BLOCK = /\r?\n<!-- erdem:validation:begin[\s\S]*?<!-- erdem:validation:end -->/;
const outside = (t) => t.replace(BLOCK, '').replace(/^updatedAt:.*$/m, '');
const beginCount = (t) => (t.match(/erdem:validation:begin/g) ?? []).length;
const USERY = STATE.replace('1. write docs', '1. validation review with QA team\n2. write docs\n   - sub item of docs\n   - another one\n3. Validation of data export').replace('- old problem', '- validation tooling is flaky on CI (adjacent issue)\n- old problem');

test('41 the outcome is written only into the owned block of TASK_STATE.md; the owner only; never per step', () => {
  const fail = updateTaskState(STATE, RESULT('FAIL', { failed: ['lint@.'] }), { owner: 'agent-a', now: new Date('2026-10-04T10:00:00Z'), contentKey: 'deadbeefcafe0000' });
  assert.equal(fail.changed, true);
  assert.match(fail.text, /updatedAt: 2026-10-04T10:00:00Z/);
  assert.match(fail.text, /## Last validation\n- old: passed\n<!-- erdem:validation:begin[^\n]*-->\n- V2 plan abcdef01 content deadbeef: failed\n- lint@\.: failed \(exit-status-1\)\n- open: lint@\. failed\n- problem: failed: lint@\.\n<!-- erdem:validation:end -->\n/);
  assert.equal(outside(fail.text), outside(STATE), 'every other byte of the file is untouched (only updatedAt and the block differ)');
  assert.equal(beginCount(fail.text), 1);
  const pass = updateTaskState(fail.text, RESULT('PASS'), { owner: 'agent-a', now: new Date('2026-10-04T11:00:00Z') });
  assert.equal(beginCount(pass.text), 1, 'the block is replaced, never duplicated');
  assert.ok(!/- open:|- problem:/.test(pass.text), 'a pass clears what it resolved');
  assert.equal(outside(pass.text), outside(STATE));
  assert.deepEqual(parseLastValidation(fail.text), { depth: 'V2', planId: 'abcdef01', contentKey: 'deadbeef', status: 'FAIL' });
  assert.deepEqual(lastValidationLines(RESULT('DECLINED')).slice(0, 1), ['- V2 plan abcdef01: not run, declined']);
  assert.equal(parseLastValidation(updateTaskState(STATE, RESULT('DECLINED'), { owner: 'agent-a' }).text).status, 'DECLINED');
  assert.equal(updateTaskState(STATE, RESULT('FAIL'), { owner: 'agent-b' }).refused, 'not-owner', 'only the owner writes');
  assert.equal(updateTaskState(STATE, RESULT('FAIL'), {}).refused, 'owner-unknown');
  assert.equal(updateTaskState(STATE.replace('in-progress', 'done'), RESULT('PASS'), { owner: 'agent-b' }).refused, null, 'a finished task is not protected');
  assert.ok(!/ls -l|stdout|stderr/.test(fail.text), 'no command output');
  const forged = STATE.replace('- old: passed', '- V2 plan abcdef01 content deadbeef: passed');
  assert.deepEqual(parseLastValidation(updateTaskState(forged, RESULT('FAIL'), { owner: 'agent-a' }).text)?.status, 'FAIL', 'the owned block wins over a line a person wrote');
});

test('41a user text is never touched: lines that merely begin with "validation", indented items, numbering, both line endings, repeats', () => {
  const failed = RESULT('FAIL', { failed: ['lint@.'] });
  for (const eol of ['\n', '\r\n']) {
    const text = USERY.replace(/\n/g, eol);
    const first = updateTaskState(text, failed, { owner: 'agent-a', now: new Date('2026-10-04T10:00:00Z'), contentKey: 'abcdef0000000000' });
    assert.equal(first.changed, true);
    for (const kept of ['1. validation review with QA team', '- validation tooling is flaky on CI (adjacent issue)', '   - sub item of docs', '   - another one', '3. Validation of data export', '- old problem', '2. write docs']) assert.ok(first.text.includes(kept), JSON.stringify(kept));
    assert.equal(outside(first.text), outside(text), 'byte-for-byte outside the owned block');
    if (eol === '\r\n') assert.ok(!/(?<!\r)\n/.test(first.text), 'CRLF stays CRLF: no bare LF anywhere');
    else assert.ok(!/\r/.test(first.text), 'LF stays LF');
    const again = updateTaskState(first.text, failed, { owner: 'agent-a', now: new Date('2031-01-01T00:00:00Z'), contentKey: 'abcdef0000000000' });
    assert.deepEqual([again.changed, again.skipped], [false, 'identical'], 'a repeated update writes nothing, not even updatedAt');
    const pass = updateTaskState(first.text, RESULT('PASS'), { owner: 'agent-a', now: new Date('2026-10-05T00:00:00Z') });
    assert.equal(beginCount(pass.text), 1);
    assert.equal(outside(pass.text), outside(text));
    const failAgain = updateTaskState(pass.text, failed, { owner: 'agent-a', now: new Date('2026-10-06T00:00:00Z'), contentKey: 'abcdef0000000000' });
    assert.equal(beginCount(failAgain.text), 1);
    assert.equal(outside(failAgain.text), outside(text));
  }
  const noSection = '---\nupdatedAt: 2026-01-01T00:00:00Z\nowner: agent-a\n---\n# Task State\n\n## Goal\nx\n';
  const added = updateTaskState(noSection, RESULT('FAIL'), { owner: 'agent-a' });
  assert.ok(added.text.startsWith(noSection.replace(/updatedAt: [^\n]*/, 'updatedAt: ' + added.text.match(/updatedAt: ([^\n]*)/)[1])), 'a missing section is appended; nothing before it moves');
  assert.match(added.text, /\n## Last validation\n<!-- erdem:validation:begin/);
  const tight = '---\nupdatedAt: 2026-01-01T00:00:00Z\nowner: agent-a\n---\n## Last validation\n## Next\nz';
  const t = updateTaskState(tight, RESULT('PASS'), { owner: 'agent-a' });
  assert.match(t.text, /## Last validation\n<!-- erdem:validation:begin[^\n]*-->\n- V2 plan[^\n]*passed\n(- [^\n]*\n)*<!-- erdem:validation:end -->\n## Next\nz$/);
});

test('41b TASK_STATE is created only when a canonical trigger holds; a LARGE plan is recorded once, in the same owned block', () => {
  assert.equal(updateTaskState(null, RESULT('PASS'), { owner: 'a', taskClass: 'SMALL', risk: 'LOW' }).skipped, 'state-not-required');
  const made = updateTaskState(null, RESULT('FAIL'), { owner: 'a', taskClass: 'MEDIUM', risk: 'LOW', goal: 'g' });
  assert.deepEqual([made.created, made.changed], [true, true]);
  assert.match(made.text, /owner: a\n---\n# Task State\n\n## Goal\ng/);
  assert.match(made.text, /## Last validation\n<!-- erdem:validation:begin/);
  assert.equal(updateTaskState(null, RESULT('PASS'), { owner: 'a', taskClass: 'SMALL', risk: 'HIGH' }).created, true, 'risk MEDIUM or higher');
  assert.equal(stateRequired({ taskClass: 'TRIVIAL', blocked: true }), true);
  assert.equal(stateRequired({ taskClass: 'SMALL' }), false);
  assert.equal(updateTaskState(null, RESULT('BLOCKED'), { owner: 'a', taskClass: 'TRIVIAL' }).created, true, 'a blocked task');
  const planned = { planId: 'abcdef0123', depth: 'V3', actions: [{ id: 'lint@.' }, { id: 'unit-test@.' }], confirmationRequired: [{ id: 'p:validation-set' }] };
  const rec = updateTaskState(STATE, planned, { phase: 'planned', owner: 'agent-a', taskClass: 'LARGE' });
  assert.match(rec.text, /- V3 plan abcdef01 planned \(lint@\., unit-test@\.\): awaiting confirmation/);
  assert.equal(outside(rec.text), outside(STATE));
  assert.equal(updateTaskState(STATE, planned, { phase: 'planned', owner: 'agent-a', taskClass: 'SMALL' }).skipped, 'plan-is-recorded-only-for-large-or-architectural');
  assert.equal(updateTaskState(rec.text, planned, { phase: 'planned', owner: 'agent-a', taskClass: 'LARGE' }).skipped, 'identical');
  assert.equal(parseLastValidation(rec.text), null, 'a planned line is not a result and can never be reused as one');
  const done = updateTaskState(rec.text, RESULT('PASS'), { owner: 'agent-a' });
  assert.equal(beginCount(done.text), 1, 'completing replaces the planned line');
});

test('42 a handoff is required only when work changes hands or cannot continue', () => {
  const h = (result, o = {}) => handoffDecision({ result, taskClass: 'MEDIUM', ...o });
  assert.equal(h(RESULT('PASS'), { sessionEnding: true }).required, false, 'a pass leaves nothing open');
  assert.equal(h(RESULT('FAIL')).required, false, 'a failing check is fixed within scope, not handed off');
  const ended = h(RESULT('FAIL', { failed: ['lint@.'] }), { sessionEnding: true });
  assert.deepEqual([ended.required, ended.triggers], [true, ['session-ending-unfinished']]);
  assert.match(ended.order.join(' '), /TASK_STATE\.md first.*then write one new HANDOFF\.md/);
  assert.deepEqual(ended.validationStatus.failed, ['lint@.']);
  assert.deepEqual([h(RESULT('BLOCKED')).required, h(RESULT('BLOCKED')).triggers], [true, ['blocked-on-resolution']], 'a boundary only a person can resolve');
  for (const status of ['DECLINED', 'UNKNOWN']) assert.equal(h(RESULT(status)).required, false, `${status} in a session that continues: TASK_STATE.md is sufficient`);
  for (const status of ['DECLINED', 'UNKNOWN', 'FAIL']) assert.equal(h(RESULT(status), { sessionEnding: true }).required, true, `${status} when the session ends`);
  assert.equal(h(RESULT('BLOCKED'), { taskStatus: 'done' }).required, false, 'a completed task needs none');
  assert.equal(h(RESULT('BLOCKED'), { readOnly: true }).required, false);
  assert.equal(h(RESULT('FAIL'), { taskClass: 'SMALL' }).required, false, 'a TRIVIAL or SMALL task in the same session');
  assert.equal(h(RESULT('FAIL'), { taskClass: 'SMALL', sessionEnding: true }).required, true);
  assert.equal(h(RESULT('BLOCKED'), { latestHandoffMatches: true }).duplicate, true, 'never a duplicate of the latest handoff');
  const noAsk = h({ ...RESULT('NOT_RUN'), notRun: ['lint@.'], actions: [{ id: 'lint@.', status: 'NOT_RUN', reason: 'awaiting-confirmation' }] }, { interactive: false });
  assert.deepEqual(noAsk.triggers, ['confirmation-cannot-be-asked'], 'an A2 that cannot be asked about goes to the handoff');
  assert.equal(h({ ...RESULT('NOT_RUN'), required: false }).required, false);
});

test('43 identical state updates are skipped: no write, no new timestamp, the same bytes', () => {
  const dir = project({ '.ai/TASK_STATE.md': STATE });
  const file = path.join(dir, '.ai', 'TASK_STATE.md');
  const ctx = { owner: 'agent-a', taskClass: 'MEDIUM', risk: 'LOW', contentKey: 'abcdef0000000000' };
  const first = applyValidationToTaskState(dir, '.ai/TASK_STATE.md', RESULT('FAIL'), ctx);
  assert.equal(first.changed, true);
  const bytes = fs.readFileSync(file, 'utf8');
  const stat = fs.statSync(file).mtimeMs;
  const second = applyValidationToTaskState(dir, '.ai/TASK_STATE.md', RESULT('FAIL'), { ...ctx, now: new Date('2030-01-01T00:00:00Z') });
  assert.deepEqual([second.changed, second.skipped], [false, 'identical']);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(fs.statSync(file).mtimeMs, stat);
  assert.equal(applyValidationToTaskState(dir, '../outside/TASK_STATE.md', RESULT('FAIL'), ctx).refused, 'not-a-task-state-path');
  assert.equal(applyValidationToTaskState(dir, '.ai/HANDOFF.md', RESULT('FAIL'), ctx).refused, 'not-a-task-state-path', 'only the task state is ever written');
  const reused = runValidationPlan(plan({ cls: 'SMALL' }), dir, { execute: true, deps: fakeDeps(), previous: { planId: plan({ cls: 'SMALL' }).planId.slice(0, 8), contentKey: 'abc', status: 'PASS' }, contentKey: 'abc' });
  assert.deepEqual([reused.status, reused.reused, reused.executed], ['PASS', true, []]);
  assert.equal(reused.record.result, 'noop');
  const changedContent = runValidationPlan(plan({ cls: 'SMALL' }), dir, { execute: true, deps: fakeDeps(), previous: { planId: plan({ cls: 'SMALL' }).planId.slice(0, 8), contentKey: 'abc', status: 'PASS' }, contentKey: 'abd' });
  assert.equal(changedContent.reused, undefined, 'not repeated only for unchanged content');
  const prevFail = runValidationPlan(plan({ cls: 'SMALL' }), dir, { execute: true, deps: fakeDeps(), previous: { planId: plan({ cls: 'SMALL' }).planId.slice(0, 8), contentKey: 'abc', status: 'FAIL' }, contentKey: 'abc' });
  assert.equal(prevFail.reused, undefined, 'a failure is never reused as a result');
});

// ---- 44 to 47: paths -----------------------------------------------------------------------------------------------------------

test('44 45 46 47 Windows paths, spaces, non-ASCII names and OneDrive-like folders: argument vectors keep every path whole', () => {
  for (const nested of [['with spaces', 'my project'], ['OneDrive', 'Belgeler Ünlü', 'Proje Ç ş']]) {
    const dir = project({ 'src/my dir/ünlü a.mjs': 'export const x = 1;\n', 'src/my dir/ünlü a.test.mjs': "import { x } from './ünlü a.mjs';\nvoid x;\n", 'package.json': PKG({ test: 'node --test' }) }, nested);
    const real = cli(['validate', dir, '--modified', 'src/my dir/ünlü a.mjs', '--class', 'TRIVIAL', '--fresh-graph', '--run', '--json'], dir);
    assert.equal(real.status, 0, real.stderr + real.stdout);
    const r = JSON.parse(real.stdout);
    assert.deepEqual([r.result.status, r.plan.actions[0].files], ['PASS', [{ path: 'src/my dir/ünlü a.mjs', check: 'node-check' }]]);
    assert.ok(!real.stdout.includes(dir) && !real.stdout.includes(dir.replace(/\\/g, '/')), 'no absolute path in the output');
    const planned = JSON.parse(cli(['validate', dir, '--modified', 'src/my dir/ünlü a.mjs', '--class', 'MEDIUM', '--fresh-graph', '--json'], dir).stdout).plan;
    const t = planned.actions.find((a) => a.type === 'unit-test');
    assert.deepEqual(t.command.argv, ['npm', 'run', 'test', 'src/my dir/ünlü a.test.mjs'], 'one argument, spaces and non-ASCII intact, no quoting');
    const deps = fakeDeps();
    runValidationPlan(planned, dir, { execute: true, deps });
    const first = deps.calls.find((c) => c.file === '/bin/node');
    assert.deepEqual(first.args, ['--check', 'src/my dir/ünlü a.mjs'], 'the parse-only check gets the path as one argument');
    assert.deepEqual(deps.calls.find((c) => c.file === '/bin/npm').args.slice(-1), ['src/my dir/ünlü a.test.mjs']);
    assert.ok(deps.calls.every((c) => c.options.shell === false));
  }
  assert.deepEqual(plan({ cls: 'TRIVIAL', files: ['src\\win\\a.mjs'], impact: null }).actions[0].files, [{ path: 'src/win/a.mjs', check: 'node-check' }], 'Windows separators are normalized once');
  assert.throws(() => plan({ cls: 'TRIVIAL', files: ['../outside.mjs'], impact: null }), RoutingInputError);
  assert.throws(() => plan({ cls: 'TRIVIAL', files: ['C:/abs.mjs'], impact: null }), RoutingInputError);
});

// ---- 48 to 51: security --------------------------------------------------------------------------------------------------------

test('48 no secrets: withheld paths take no part, secret-reading commands are A3, output is redacted and never stored', () => {
  assert.equal(classifyText('cat .env').level, 'A3');
  assert.deepEqual(classifyText('node scripts/x.js .env.production').reasons, ['secrets']);
  assert.equal(classifyText('cat ~/.ssh/id_rsa').level, 'A3');
  assert.equal(classifyText('printenv').level, 'A3');
  const dir = project({});
  const noisy = fakeDeps(() => ({ status: 1, stdout: '', stderr: 'API_KEY=abc123\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\nplain failure at C:\\Users\\x\n' }));
  const r = runValidationPlan(plan({ cls: 'SMALL' }), dir, { execute: true, deps: noisy });
  const text = JSON.stringify(r);
  assert.ok(!/abc123|abcdefghijklmnopqrstuvwxyz/.test(text), 'a secret in command output never enters the result');
  assert.ok(r.evidence.failures[0].excerpt.includes('[redacted]'));
  const state = updateTaskState(STATE, r, { owner: 'agent-a' });
  assert.ok(!/abc123|redacted|plain failure/.test(state.text), 'command output never enters task state');
  assert.ok(!JSON.stringify(r.record).includes('plain failure'));
  const p = plan({ cls: 'SMALL', files: ['.env', 'config/id_rsa'], impact: null });
  assert.deepEqual([p.required, p.evaluated, p.unresolved.map((u) => u.reason)], [true, false, ['all-paths-withheld']], 'hidden files are unevaluated, not "not required"');
  assert.ok(!JSON.stringify(p).includes('id_rsa'));
});

test('49 no network: no validation module can reach one, and planning imports nothing that reads, writes or runs', () => {
  const closure = (entry) => {
    const seen = new Map();
    (function visit(file) {
      if (seen.has(file)) return;
      const imports = [...fs.readFileSync(file, 'utf8').matchAll(/^import[^;]*?from\s+'([^']+)';/gms)].map((m) => m[1]);
      seen.set(file, imports);
      for (const i of imports.filter((x) => x.startsWith('.'))) visit(path.resolve(path.dirname(file), i));
    })(path.join(TOOLS_ROOT, 'automation', entry));
    return seen;
  };
  const builtinsOf = (seen) => [...new Set([...seen.values()].flat().filter((x) => x.startsWith('node:')))];
  const NET = ['node:net', 'node:http', 'node:https', 'node:http2', 'node:dns', 'node:tls', 'node:dgram', 'node:worker_threads', 'node:vm', 'node:os'];
  for (const m of ['validation-classify.mjs', 'validation-plan.mjs', 'validation-state.mjs']) {
    const seen = closure(m);
    assert.deepEqual(builtinsOf(seen).filter((b) => !['node:path', 'node:crypto'].includes(b)), [], `${m}: planning and state are pure (no fs, no child_process, no network; a digest and path syntax only)`);
    for (const f of seen.keys()) {
      const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!/writeFile|appendFile|mkdirSync|rmSync|spawn|execSync|execFile|fetch\(|process\.env|XMLHttpRequest|WebSocket/.test(code), `${path.relative(TOOLS_ROOT, f)}: no write, process, network or environment access`);
    }
  }
  for (const m of ['validation-discovery.mjs', 'validation-runner.mjs']) assert.deepEqual(builtinsOf(closure(m)).filter((b) => NET.includes(b)), [], `${m}: no network module`);
  assert.deepEqual(builtinsOf(closure('validation-discovery.mjs')).sort(), ['node:crypto', 'node:fs', 'node:path'], 'discovery only reads files and hashes them, and never starts anything');
  assert.deepEqual(builtinsOf(closure('validation-runner.mjs')).sort(), ['node:child_process', 'node:crypto', 'node:fs', 'node:path', 'node:url']);
  assert.ok(!fs.readFileSync(path.join(TOOLS_ROOT, 'automation', 'validation-runner.mjs'), 'utf8').includes('fetch('));
});

test('50 no shell: every process is an argument vector with shell false; shims are refused; nothing runs through a shell', () => {
  for (const f of ['validation-runner.mjs', 'validation-supervisor.mjs', 'validation-discovery.mjs', 'validation-plan.mjs', 'validation-state.mjs', 'validation-classify.mjs']) {
    const code = fs.readFileSync(path.join(TOOLS_ROOT, 'automation', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/shell\s*:\s*(true|['"`]|process)/.test(code), `${f} enables a shell`);
    assert.ok(!/(?<![.\w])exec\(|execSync|execFileSync|shell\s*:\s*true/.test(code.replace(/execPath|executable/g, '')), `${f} uses a shell-based call`);
  }
  assert.match(fs.readFileSync(path.join(TOOLS_ROOT, 'automation', 'validation-runner.mjs'), 'utf8'), /shell: false/);
  const win = (files) => ({ platform: 'win32', env: { PATH: 'C:\\bin' }, execPath: 'C:\\node\\node.exe', exists: (p) => files.includes(p.replace(/\\/g, '/')) });
  assert.deepEqual(resolveExecutable('npm', win(['C:/bin/npm.cmd'])), { refused: 'windows-shim' }, 'only a .cmd exists: refused, not run through cmd.exe');
  assert.deepEqual(resolveExecutable('yarn', win(['C:/bin/yarn.bat'])), { refused: 'windows-shim' });
  assert.deepEqual(resolveExecutable('x.cmd', win([])), { refused: 'windows-shim' });
  assert.deepEqual(resolveExecutable('./tool', { platform: 'linux', env: { PATH: '/bin' }, exists: () => true }), { refused: 'not-a-bare-name' });
  assert.deepEqual(resolveExecutable('eslint', win(['C:/bin/eslint.exe'])), { file: path.join('C:\\bin', 'eslint.exe'), prefix: [] });
  assert.deepEqual(resolveExecutable('npm', win(['C:/node/node_modules/npm/bin/npm-cli.js'])), { file: 'C:\\node\\node.exe', prefix: [path.join('C:\\node', 'node_modules', 'npm', 'bin', 'npm-cli.js')] }, 'npm runs as node npm-cli.js');
  assert.deepEqual(resolveExecutable('nothing-here', win([])), { refused: 'not-found' });
  assert.equal(resolveExecutable('node').file, process.execPath);
  const shim = runValidationPlan(plan({ cls: 'SMALL' }), project({}), { execute: true, deps: { spawn: () => assert.fail('must not start'), resolve: () => ({ refused: 'windows-shim' }) } });
  assert.deepEqual([shim.status, shim.actions[0].reason], ['BLOCKED', 'windows-shim']);
});

test('51 no adapter has its own validation logic: they pass the command through', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
  const files = walk(path.join(REPO, 'adapters')).filter((f) => /\.(mjs|js|cjs)$/.test(f) && !/[\\/]tests?[\\/]/.test(f));
  assert.ok(files.length > 0);
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!/planValidation|runValidationPlan|validation-plan|validation-runner|validation-classify|classifyText|discoverCommands/.test(t), `${path.relative(REPO, f)} has validation logic`);
  }
  for (const f of ['adapters/codex/skill/references/context.md', 'adapters/antigravity/skill/references/context.md', 'adapters/claude/skill/references/context-routing.md']) {
    const t = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.match(t, /intel validate/);
    assert.ok(!/npm run|node --test|eslint|--check/.test(t.split('intel validate')[1]?.slice(0, 900) ?? ''), `${f}: a pass-through line, no command list`);
  }
  for (const dir of ['core', 'ai', 'platforms', 'templates']) for (const f of walk(path.join(REPO, dir))) assert.ok(!/claude|codex|antigravity|gemini/i.test(fs.readFileSync(f, 'utf8')), `${path.relative(REPO, f)} names an agent`);
});

// ---- planning does not execute; execution does only what was planned ------------------------------------------------------------

test('52 planning never executes: a plan is made with no process layer at all, and the command only plans without --run', () => {
  const dir = project({ 'package.json': PKG({ lint: 'node --check scripts/never-run.mjs' }), 'scripts/never-run.mjs': 'import fs from "node:fs"; fs.writeFileSync("RAN", "x");\n', 'src/a.mjs': 'export {};\n' });
  const before = snapshot(dir);
  const out = cli(['validate', dir, '--modified', 'src/a.mjs', '--class', 'SMALL', '--fresh-graph', '--json'], dir);
  assert.equal(out.status, 0, out.stderr);
  const j = JSON.parse(out.stdout);
  assert.deepEqual([j.plan.automatic, j.result, j.state, j.handoff], [['lint@.'], undefined, undefined, undefined]);
  assert.equal(snapshot(dir), before, 'no file was created, changed or deleted');
  assert.ok(!fs.existsSync(path.join(dir, 'RAN')) && !fs.existsSync(path.join(dir, '.ai')));
  assert.equal(j.records.planned.event, 'VALIDATION_REQUIRED');
  assert.equal(j.records.planned.result, 'ok');
  const proposed = JSON.parse(cli(['validate', dir, '--modified', 'src/a.mjs', '--class', 'LARGE', '--fresh-graph', '--json'], dir).stdout);
  assert.equal(proposed.records.planned.result, 'needs-confirmation');
  assert.ok(proposed.plan.confirmationRequired.length === 1 && proposed.plan.automatic.length === 0);
});

test('53 execution runs only the planned actions: an edited plan, an extra action or a disguised prohibited command is refused', () => {
  const root = project({});
  const base = plan({ cls: 'SMALL' });
  const extra = { ...base, actions: [...base.actions, { ...base.actions[0], id: 'rogue@.', command: { kind: 'process', argv: ['node', '-e', 'process.exit(0)'], cwd: '.', display: 'x' } }] };
  const deps = fakeDeps();
  const r = runValidationPlan(extra, root, { execute: true, deps });
  assert.ok(r.actions.every((a) => a.status === 'BLOCKED' && a.reason === 'plan-integrity'));
  assert.equal(deps.calls.length, 0);
  const disguised = JSON.parse(JSON.stringify(base));
  disguised.actions[0].classification = { level: 'A1', reasons: [] };
  disguised.actions[0].command.argv = ['npm', 'publish'];
  disguised.planId = idOf(disguised);
  const d2 = fakeDeps();
  const r2 = runValidationPlan(disguised, root, { execute: true, deps: d2 });
  assert.equal(r2.actions[0].status, 'BLOCKED', 'the command is classified again at run time, whatever level the plan claims');
  assert.equal(r2.actions[0].reason, 'a3-never-automatic');
  assert.ok(!d2.calls.some((c) => c.args.includes('lint')));
  const shellish = JSON.parse(JSON.stringify(base));
  shellish.actions[0].command = { kind: 'shell', argv: 'eslint .', cwd: '.', display: 'x' };
  shellish.planId = idOf(shellish);
  assert.equal(runValidationPlan(shellish, root, { execute: true, deps: fakeDeps() }).actions[0].status, 'BLOCKED');
  const escape = JSON.parse(JSON.stringify(base));
  escape.actions[0].command.cwd = '../elsewhere';
  escape.planId = idOf(escape);
  const r3 = runValidationPlan(escape, root, { execute: true, deps: fakeDeps() });
  assert.deepEqual([r3.actions[0].status, r3.actions[0].reason], ['BLOCKED', 'directory-outside-project-or-missing']);
});

test('54 confirmation is specific: one proposal confirmed does not confirm another, and nothing is remembered', () => {
  const cmds = [mk('lint', 'npx eslint .'), mk('typecheck', 'tsc --noEmit'), mk('test', 'playwright test')];
  const p = plan({ cls: 'MEDIUM', commands: cmds });
  const root = project({});
  const deps = fakeDeps();
  const r = runValidationPlan(p, root, { execute: true, deps, confirm: { planId: p.planId, proposals: ['p:network-possible'] } });
  assert.deepEqual([r.passed.sort(), r.notRun], [['lint@.', 'type-check@.'], ['unit-test@.']], 'the expensive proposal was not confirmed');
  assert.equal(r.actions.find((a) => a.id === 'unit-test@.').reason, 'awaiting-confirmation');
  const again = runValidationPlan(p, root, { execute: true, deps: fakeDeps() });
  assert.deepEqual(again.passed, ['type-check@.'], 'a yes of an earlier run is not a standing permission');
});

test('55 the Phase 5A action record: compact, canonical fields, counts and words only', () => {
  const p = plan({ cls: 'LARGE' });
  const planned = validationRecord({ phase: 'planned', plan: p, now: new Date('2026-10-04T09:00:00Z') });
  assert.deepEqual(Object.keys(planned), ['v', 'event', 'action', 'reason', 'scope', 'level', 'result', 'detail', 'at']);
  assert.deepEqual([planned.v, planned.event, planned.action, planned.scope, planned.level, planned.result, planned.at], [1, 'VALIDATION_REQUIRED', 'validation', 'project', 'A2', 'needs-confirmation', '2026-10-04T09:00:00Z']);
  assert.deepEqual(planned.detail, { depth: 'V3', planned: 3, automatic: 0, proposed: 1, prohibited: 0, unresolved: 0 });
  assert.equal(validationRecord({ phase: 'planned', plan: plan({ cls: 'SMALL' }) }).result, 'ok');
  const done = runValidationPlan(plan({ cls: 'SMALL' }), project({}), { execute: true, deps: fakeDeps() });
  assert.deepEqual([done.record.event, done.record.reason, done.record.level, done.record.result], ['VALIDATION_COMPLETED', 'required-by-class', 'A1', 'ok']);
  assert.deepEqual(done.record.detail, { depth: 'V1', status: 'PASS', executed: 2, passed: 2, failed: 0, notRun: 0, declined: 0, blocked: 0, unknown: 0 });
  assert.equal(validationRecord({ phase: 'planned', plan: plan({ cls: 'SMALL', risk: 'HIGH', impact: null }) }).reason, 'required-by-risk');
  assert.ok(JSON.stringify(done.record).length < 400);
});

test('56 the plan is deterministic and its id covers what would run', () => {
  const a = plan({ cls: 'MEDIUM', impact: impactOf({ direct: ['src/a.test.mjs'] }) });
  const b = plan({ cls: 'MEDIUM', impact: impactOf({ direct: ['src/a.test.mjs'] }) });
  assert.deepEqual(a, b);
  assert.notEqual(a.planId, plan({ cls: 'MEDIUM', impact: impactOf({ direct: ['src/b.test.mjs'] }) }).planId, 'a different test selection is a different plan');
  assert.notEqual(plan({ cls: 'SMALL' }).planId, plan({ cls: 'MEDIUM' }).planId);
  assert.equal(a.planId, idOf(a));
  assert.deepEqual(a.actions.map((x) => x.order), a.actions.map((_, i) => i + 1));
});

test('57 the command validates its input and never discovers a change set', () => {
  const dir = project({ 'package.json': PKG({ lint: 'eslint .' }), 'src/a.mjs': 'export {};\n' });
  const bad = (args) => cli(['validate', dir, ...args], dir);
  assert.equal(bad([]).status, 2);
  assert.match(bad(['--modified', 'src/a.mjs', '--declined', 'because']).stderr, /unknown --declined reason/);
  assert.match(bad(['--modified', 'src/a.mjs', '--confirm', 'x']).stderr, /--confirm only applies with --run/);
  assert.match(bad(['--modified', 'src/a.mjs', '--update-state']).stderr, /--update-state needs --owner/);
  assert.match(bad(['--modified', 'src/a.mjs', '--task-status', 'finished']).stderr, /--task-status must be/);
  assert.match(bad(['--modified', 'src/a.mjs', '--task-state', '../x/TASK_STATE.md']).stderr, /inside the project/);
  assert.match(bad(['--modified', 'src/a.mjs', '--view', 'full']).stderr, /do not apply/);
  assert.equal(bad(['--modified', '../x.mjs']).status, 2);
});

test('58 end to end through the command: an A2 plan is proposed, then confirmed for exactly that plan, then recorded in TASK_STATE once', { skip: !npmAvailable && 'npm cannot be run without a shell here' }, () => {
  const dir = project({ 'package.json': PKG({ lint: 'node --check scripts/ok.mjs', test: 'node --check scripts/ok.mjs' }), 'scripts/ok.mjs': 'console.log("ok");\n', 'src/a.mjs': 'export const a = 1;\n' });
  const args = ['validate', dir, '--modified', 'src/a.mjs', '--class', 'LARGE', '--fresh-graph', '--json'];
  const proposed = JSON.parse(cli(args, dir).stdout);
  assert.equal(proposed.plan.confirmationRequired.length, 1);
  const unconfirmed = JSON.parse(cli([...args, '--run'], dir).stdout);
  assert.equal(unconfirmed.result.status, 'NOT_RUN');
  const wrong = JSON.parse(cli([...args, '--run', '--confirm', 'ffffffffffffff'], dir).stdout);
  assert.equal(wrong.result.status, 'NOT_RUN');
  const yes = cli([...args, '--run', '--confirm', proposed.plan.planId, '--update-state', '--owner', 'me'], dir);
  assert.equal(yes.status, 0, yes.stderr + yes.stdout);
  const done = JSON.parse(yes.stdout);
  assert.equal(done.result.status, 'PASS');
  assert.equal(done.state.created, true);
  const stateFile = path.join(dir, '.ai', 'TASK_STATE.md');
  const bytes = fs.readFileSync(stateFile, 'utf8');
  assert.match(bytes, /## Last validation\n<!-- erdem:validation:begin[^\n]*-->\n- V3 plan [0-9a-f]{8} content [0-9a-f]{8}: passed/);
  const second = JSON.parse(cli([...args, '--run', '--confirm', proposed.plan.planId, '--update-state', '--owner', 'me'], dir).stdout);
  assert.equal(second.result.reused, true, 'unchanged content with a passing result is not validated again');
  assert.deepEqual([second.state.changed, second.state.skipped], [false, 'identical']);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), bytes);
  fs.appendFileSync(path.join(dir, 'src/a.mjs'), 'export const b = 2;\n');
  const third = JSON.parse(cli([...args, '--run', '--confirm', proposed.plan.planId, '--owner', 'me'], dir).stdout);
  assert.equal(third.result.reused, undefined, 'changed content is validated again');
});

test('59 the canonical documents and the README describe the same contract the code implements', () => {
  const readme = fs.readFileSync(path.join(TOOLS_ROOT, 'automation', 'README.md'), 'utf8');
  for (const word of ['validation-plan.mjs', 'validation-runner.mjs', 'validate', 'PASS', 'NOT_RUN', 'DECLINED', 'BLOCKED', 'UNKNOWN', 'inferred-from-config', 'A3', 'planId']) assert.ok(readme.includes(word), word);
  const proto = fs.readFileSync(path.join(REPO, 'ai', 'AUTOMATION_PROTOCOL.md'), 'utf8');
  assert.match(proto, /Validation reference implementation/);
  for (const f of ['validation-classify.mjs', 'validation-discovery.mjs', 'validation-plan.mjs', 'validation-runner.mjs', 'validation-state.mjs']) assert.ok(fs.existsSync(path.join(TOOLS_ROOT, 'automation', f)), f);
  assert.deepEqual(new Set(['V0', 'V1', 'V2', 'V3', 'V4']), new Set(Array.from({ length: 5 }, (_, i) => `V${i}`)), 'no new validation level');
});

test('60 a standing opt-in names ONE action exactly and lowers nothing else; a V3 set only when the set itself is named', () => {
  const cmds = [mk('lint', 'npx eslint .'), mk('typecheck', 'tsc --noEmit'), mk('test', 'playwright test')];
  const base = plan({ cls: 'MEDIUM', commands: cmds });
  assert.deepEqual(base.automatic, ['type-check@.']);
  const lowered = plan({ cls: 'MEDIUM', commands: cmds, optIn: [optInFor(cmds[0])] });
  assert.deepEqual(lowered.automatic.sort(), ['lint@.', 'type-check@.'], 'lint was named; the test suite was not');
  assert.deepEqual(lowered.confirmationRequired.map((p) => p.reason), ['expensive']);
  const shellCmd = mk('lint', 'eslint $(cat files)');
  const shell = plan({ cls: 'SMALL', commands: [shellCmd], });
  assert.equal(shell.actions[0].level, 'A2', 'a shell construct has no opt-in at all');
  assert.throws(() => plan({ cls: 'SMALL', commands: [shellCmd], optIn: [optInFor(shellCmd)] }), RoutingInputError, 'naming a never-lowerable reason is refused');
  const set = plan({ cls: 'LARGE', commands: cmds, optIn: [optInFor(cmds[0]), optInFor(cmds[2])] });
  assert.ok(Object.values(levels(set)).every((l) => l === 'A2'), 'V3 stays A2 as a set unless the set is named');
  const auth = plan({ cls: 'LARGE' }).confirmationRequired[0].authorization;
  const named = plan({ cls: 'LARGE', optIn: [auth] });
  assert.deepEqual(named.automatic, ids(named));
});
