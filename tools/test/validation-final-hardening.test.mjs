import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanup, TOOLS_ROOT, tmpDir } from './helpers.mjs';
import { analyzeChangeImpact } from '../automation/change-impact.mjs';
import { classifyText, summarizeScript } from '../automation/validation-classify.mjs';
import { discoverCommands } from '../automation/validation-discovery.mjs';
import { RoutingInputError, appendedArgsFor, bindingOf, normalizeOptIn, planIdOf, planValidation, safeProjectPath } from '../automation/validation-plan.mjs';
import { resolveExecutable, runValidationPlan, supervisedSpawn } from '../automation/validation-runner.mjs';
import { decideValidationStateAndHandoff, handoffDecision, updateTaskState, validationRecord } from '../automation/validation-state.mjs';

after(cleanup);

const BIN = path.join(TOOLS_ROOT, 'bin', 'project-intel.mjs');
const cli = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, windowsHide: true });
const npmAvailable = !resolveExecutable('npm').refused;

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}
function project(files) {
  const dir = path.join(tmpDir('pi-val-f-'), 'app');
  fs.mkdirSync(dir, { recursive: true });
  write(dir, files);
  return dir;
}
const PKG = (scripts) => JSON.stringify({ name: 'fx', scripts });
const CHANGED = [{ path: 'src/a.mjs', status: 'modified' }];
const BASE = { 'src/a.mjs': 'export const a = 1;\n' };
const discover = (dir, files = ['src/a.mjs']) => discoverCommands(dir, { changedFiles: files });
function planFor(dir, o = {}) {
  const d = discover(dir, o.files);
  return planValidation({ task: { taskClass: o.cls ?? 'SMALL', risk: o.risk, taskTypes: o.types ?? [], changedFiles: o.changed ?? CHANGED }, impact: o.impact ?? null, project: { commands: d.commands, limitations: d.limitations, standingOptIn: o.optIn, declined: o.declined } });
}
function fake(handler = () => ({ status: 0, stdout: '', stderr: '' })) {
  const calls = [];
  return { calls, spawn: (file, args, options) => { calls.push({ file, args, options }); return handler(file, args, options); }, resolve: (n) => ({ file: `/bin/${n}`, prefix: [] }) };
}
const idOf = (p) => planIdOf(p.depth, p.actions, bindingOf(p));
const unpin = (args) => args.filter((a) => !/^--(script-shell|ignore-scripts|scripts-prepend-node-path)=/.test(a));
const forge = (p, edit) => {
  const f = JSON.parse(JSON.stringify(p));
  edit(f);
  f.planId = idOf(f);
  return f;
};
const impactWith = (direct, extra = {}) => ({
  class: { value: null }, risk: { level: 'LOW' }, requiredValidation: { depth: 'V0', tests: { consumer: [] } }, changedFiles: CHANGED, affectedTests: { direct }, bounded: { tests: { truncated: false } },
  graph: { used: true }, evidence: { graph: 'known' }, completeness: 'COMPLETE', confidence: 'high', dimensions: { configuration: { present: false } }, publicSurfaceImpact: { changed: [] }, ...extra,
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- R-A: the arguments after a command are exactly the planned files ---------------------------------------------------------

function targetedPlan(files) {
  const dir = project({ ...BASE, 'package.json': PKG({ test: 'vitest run' }) });
  const p = planFor(dir, { cls: 'MEDIUM', impact: impactWith(files) });
  const t = p.actions.find((a) => a.type === 'unit-test');
  assert.deepEqual(t.files, files, 'the plan targets exactly these files');
  return { dir, p, t };
}

test('R-A 1 7 exactly the planned arguments run, including a framework route path', () => {
  const route = 'app/[id]/page.test.tsx';
  const { dir, p, t } = targetedPlan([route, 'src/a.test.mjs', 'src/my dir/b.test.mjs']); // the planner orders them by path
  assert.deepEqual(t.command.argv, ['npm', 'run', 'test', route, 'src/a.test.mjs', 'src/my dir/b.test.mjs']);
  assert.deepEqual(t.command.baseArgv, ['npm', 'run', 'test'], 'the manifest command and the planned arguments are separate in the plan');
  const deps = fake();
  const r = runValidationPlan(p, dir, { execute: true, deps });
  assert.equal(r.status, 'PASS');
  const call = deps.calls.find((c) => c.args[0] === 'run');
  assert.deepEqual(unpin(call.args), ['run', 'test', route, 'src/a.test.mjs', 'src/my dir/b.test.mjs'], 'a bracketed route and a path with spaces are single, literal arguments');
  assert.deepEqual(appendedArgsFor([route], '.'), [route]);
  assert.equal(safeProjectPath(route), route);
});

test('R-A 2 3 4 an extra, a missing or a changed argument is refused, even when the forged plan carries a matching id', () => {
  const { dir, p } = targetedPlan(['src/a.test.mjs', 'src/b.test.mjs']);
  const attempt = (edit) => {
    const deps = fake();
    const r = runValidationPlan(forge(p, edit), dir, { execute: true, deps });
    const act = r.actions.find((a) => a.type === 'unit-test');
    return { act, calls: deps.calls.filter((c) => c.args[0] === 'run').length };
  };
  assert.equal(attempt((f) => f).act.status, 'PASS', 'the unmodified plan runs');
  for (const [name, edit] of Object.entries({
    'an extra option': (f) => { f.actions.find((a) => a.type === 'unit-test').command.argv.push('--update'); },
    'an extra path': (f) => { f.actions.find((a) => a.type === 'unit-test').command.argv.push('src/c.test.mjs'); },
    'a missing planned argument': (f) => { f.actions.find((a) => a.type === 'unit-test').command.argv.pop(); },
    'a changed argument': (f) => { const a = f.actions.find((x) => x.type === 'unit-test'); a.command.argv[a.command.argv.length - 1] = 'src/other.test.mjs'; },
    'a reordered pair': (f) => { const a = f.actions.find((x) => x.type === 'unit-test'); a.command.argv.splice(3, 2, a.command.argv[4], a.command.argv[3]); },
  })) {
    const { act, calls } = attempt(edit);
    assert.deepEqual([act.status, act.reason, calls], ['BLOCKED', 'appended-arguments-not-planned', 0], name);
  }
  // the original defect: options appended to a command that was planned without any argument
  const lint = project({ ...BASE, 'package.json': PKG({ lint: 'node --check src/a.mjs' }) });
  const lp = planFor(lint);
  const deps = fake();
  const r = runValidationPlan(forge(lp, (f) => { f.actions[0].command.argv.push('--fix', '--output-file', '../out.txt'); }), lint, { execute: true, deps });
  assert.deepEqual([r.actions[0].reason, deps.calls.length], ['appended-arguments-not-planned', 0]);
  const noVerify = runValidationPlan(forge(lp, (f) => { f.actions[0].command.argv.push('--fix'); }), lint, { execute: true, deps: fake(), verify: false });
  assert.equal(noVerify.actions[0].reason, 'appended-arguments-not-planned', 'also when verification is off (injected process layer)');
});

test('R-A 5 6 traversal, absolute and secret paths are refused even when argv and files agree with each other', () => {
  const { dir, p } = targetedPlan(['src/a.test.mjs']);
  for (const bad of ['../outside.test.mjs', 'src/../../x.test.mjs', '/etc/passwd', 'C:/Windows/x.test.mjs', 'C:\\Windows\\x.test.mjs', '.env', 'config/id_rsa', 'src//x.test.mjs']) {
    const f = forge(p, (x) => {
      const a = x.actions.find((y) => y.type === 'unit-test');
      a.files = [bad];
      a.command.argv = ['npm', 'run', 'test', bad];
    });
    const deps = fake();
    const r = runValidationPlan(f, dir, { execute: true, deps });
    const act = r.actions.find((a) => a.type === 'unit-test');
    assert.equal(act.status, 'BLOCKED', bad);
    assert.ok(['appended-argument-unsafe', 'a3-never-automatic'].includes(act.reason), bad + ': ' + act.reason); // a secret-named path is stopped by either rule
    assert.equal(deps.calls.filter((c) => c.args[0] === 'run').length, 0, bad);
    if (!/env|id_rsa/.test(bad)) assert.equal(act.reason, 'appended-argument-unsafe', bad);
  }
  assert.equal(appendedArgsFor(['../x'], '.'), null);
  assert.deepEqual(appendedArgsFor(['./-odd.test.mjs', 'packages/web/src/a.test.mjs'], 'packages/web'), ['./-odd.test.mjs'.replace('./', './'), 'src/a.test.mjs'], 'paths are relative to the command directory; an option-looking name gets ./');
});

test('R-A a real run: the planned test file runs through npm, passes, and a real failure is observed', { skip: !npmAvailable && 'npm cannot be run without a shell here' }, () => {
  const dir = project({
    ...BASE,
    'package.json': PKG({ test: 'node --test' }),
    'tests/ok.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n",
    'tests/bad.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('bad', () => assert.equal(1, 2));\n",
  });
  // node:test marks a child `node --test` as a subtest when it finds the parent's marker in the environment, which hides its exit status
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  const run = (file) => runValidationPlan(planFor(dir, { cls: 'MEDIUM', impact: impactWith([file]) }), dir, { execute: true });
  const ok = run('tests/ok.test.mjs');
  const unit = ok.actions.find((a) => a.type === 'unit-test');
  assert.deepEqual([unit.status, unit.evidence.exitCode], ['PASS', 0]);
  const bad = run('tests/bad.test.mjs');
  const bu = bad.actions.find((a) => a.type === 'unit-test');
  assert.deepEqual([bu.status, bu.evidence.exitCode], ['FAIL', 1]);
  assert.equal(bad.status, 'FAIL');
  assert.ok(!JSON.stringify(bad).includes(dir.replace(/\\/g, '/')), 'no absolute path leaves');
  if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
});

// ---- R-B: an opt-in names one action exactly --------------------------------------------------------------------------------------

const lowerable = (script, extra = {}) => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: script }), ...extra });
  const base = planFor(dir);
  return { dir, base, action: base.actions[0] };
};
const exactFor = (a, over = {}) => ({ commandId: a.commandId, scriptDigest: a.scriptDigest, type: a.type, reason: a.classification.reasons, scope: a.scope, ...over });

test('R-B 1 the exact named action is lowered, and the lowering is recorded with its binding', () => {
  const { dir, action } = lowerable('node tools/lint.mjs');
  assert.deepEqual(action.classification, { level: 'A2', reasons: ['project-script'] });
  const p = planFor(dir, { optIn: [exactFor(action)] });
  assert.deepEqual([p.actions[0].level, p.automatic], ['A1', ['lint@.']]);
  assert.deepEqual(Object.keys(p.actions[0].loweredBy).sort(), ['commandId', 'reasons', 'scope', 'scriptDigest', 'type']);
  assert.ok(p.rationale.some((r) => /lowered from A2 to A1 by an opt-in naming it exactly/.test(r)));
  const prop = planFor(dir).confirmationRequired[0].commands[0];
  assert.deepEqual(prop.optIn, exactFor(action), 'the proposal prints exactly the opt-in that would name this action');
});

test('R-B 2 3 8 the same type with a different script, the same id with a changed script, and a stale opt-in are not covered', () => {
  const { dir, action } = lowerable('node tools/lint.mjs');
  const optIn = [exactFor(action)];
  write(dir, { 'package.json': PKG({ lint: 'node tools/some-other-script.mjs' }) });
  const other = planFor(dir, { optIn });
  assert.equal(other.actions[0].commandId, action.commandId, 'same command id');
  assert.notEqual(other.actions[0].scriptDigest, action.scriptDigest);
  assert.deepEqual([other.actions[0].level, other.automatic], ['A2', []], 'a changed script is another action: the old opt-in is stale');
  write(dir, { 'package.json': JSON.stringify({ name: 'fx', scripts: { lint: 'node tools/lint.mjs', 'lint:other': 'node tools/other.mjs' } }) });
  assert.notEqual(planFor(dir, { optIn }).actions[0].scriptDigest, action.scriptDigest, 'an edit anywhere in the scripts table changes the definition');
  const sameDigestDifferentId = planFor(dir, { optIn: [exactFor(action, { commandId: 'pkg:.:lint:other' })] });
  assert.equal(sameDigestDifferentId.automatic.length, 0, 'a wrong command id');
  const otherType = planFor(dir, { optIn: [exactFor(action, { type: 'type-check' })] });
  assert.equal(otherType.automatic.length, 0, 'a wrong type');
});

test('R-B 4 5 an opt-in naming more reasons, or fewer, than the action has is not covered', () => {
  const { dir, action } = lowerable('node tools/x.mjs && npx eslint .');
  assert.deepEqual(action.classification.reasons, ['network-possible', 'project-script']);
  assert.equal(planFor(dir, { optIn: [exactFor(action)] }).automatic.length, 1, 'exactly the two reasons');
  assert.equal(planFor(dir, { optIn: [exactFor(action, { reason: ['project-script'] })] }).automatic.length, 0, 'a missing reason');
  assert.equal(planFor(dir, { optIn: [exactFor(action, { reason: ['network-possible'] })] }).automatic.length, 0);
  assert.equal(planFor(dir, { optIn: [exactFor(action, { reason: ['network-possible', 'project-script', 'mutating'] })] }).automatic.length, 0, 'an extra reason: a broader permission');
  assert.equal(planFor(dir, { optIn: [exactFor(action, { reason: ['network-possible', 'project-script', 'expensive', 'external-tool'] })] }).automatic.length, 0);
});

test('R-B 6 7 the scope is exact: broader and narrower scopes are not covered', () => {
  const dir = project({ ...BASE, 'packages/web/src/a.mjs': 'export {};\n', 'package.json': PKG({ lint: 'node tools/root.mjs' }), 'packages/web/package.json': PKG({ lint: 'node tools/web.mjs' }) });
  const web = planFor(dir, { files: ['packages/web/src/a.mjs'], changed: [{ path: 'packages/web/src/a.mjs', status: 'modified' }] });
  const a = web.actions.find((x) => x.commandId === 'pkg:packages/web:lint');
  assert.equal(a.scope, 'path:packages/web');
  const lowerWith = (scope) => planFor(dir, { files: ['packages/web/src/a.mjs'], changed: [{ path: 'packages/web/src/a.mjs', status: 'modified' }], optIn: [exactFor(a, { scope })] }).actions.find((x) => x.commandId === 'pkg:packages/web:lint').level;
  assert.equal(lowerWith('path:packages/web'), 'A1', 'exactly the scope of the action');
  assert.equal(lowerWith('packages/web'), 'A1', 'a plain path is the same scope');
  assert.equal(lowerWith('project'), 'A2', 'a broader scope');
  assert.equal(lowerWith('path:packages'), 'A2', 'a broader directory');
  assert.equal(lowerWith('path:packages/web/src'), 'A2', 'a narrower, incomplete scope');
  assert.equal(lowerWith('path:packages/api'), 'A2', 'another scope');
  assert.throws(() => normalizeOptIn([exactFor(a, { scope: ['project', 'path:x'] })]), RoutingInputError, 'one scope only');
  assert.throws(() => normalizeOptIn([exactFor(a, { scope: '../x' })]), RoutingInputError);
});

test('R-B 8 an A3 is never lowered and an opt-in cannot name one; incomplete or never-lowerable opt-ins are refused', () => {
  const { dir, action } = lowerable('npm install');
  assert.equal(action.level, 'A3');
  const p = planFor(dir, { optIn: [exactFor(action, { reason: ['unclear-command'] })] });
  assert.deepEqual([p.actions[0].level, p.prohibited.map((x) => x.id)], ['A3', ['lint@.']]);
  const run = runValidationPlan(p, dir, { execute: true, deps: fake(), confirm: { planId: p.planId, proposals: [] }, standingOptIn: [exactFor(action, { reason: ['unclear-command'] })] });
  assert.equal(run.actions[0].reason, 'a3-never-automatic');
  for (const bad of [{ type: 'lint', reason: 'project-script', scope: 'project' }, exactFor(action, { commandId: '' }), exactFor(action, { scriptDigest: 'abc' }), exactFor(action, { reason: ['install'] }), exactFor(action, { reason: ['shell-construct'] }), exactFor(action, { reason: ['env-expansion'] }), exactFor(action, { reason: [] }), exactFor(action, { type: 'nope' }), exactFor(action, { reason: ['validation-set'] }), null]) {
    assert.throws(() => normalizeOptIn([bad]), RoutingInputError, JSON.stringify(bad));
  }
  const goodSet = { type: 'validation-set', setId: 'a'.repeat(32), depth: 'V3', riskCeiling: 'LOW', scope: 'project' };
  assert.deepEqual(normalizeOptIn([goodSet]), [{ type: 'validation-set', setId: 'a'.repeat(32), depth: 'V3', riskCeiling: 'LOW', reasons: ['validation-set'], scope: 'project' }]);
  for (const bad of [{ ...goodSet, scope: 'path:x' }, { ...goodSet, setId: 'xyz' }, { ...goodSet, depth: 'V2' }, { ...goodSet, riskCeiling: 'SEVERE' }, { type: 'validation-set', reason: 'validation-set', scope: 'project' }]) assert.throws(() => normalizeOptIn([bad]), RoutingInputError, JSON.stringify(bad));
});

test('R-B the command takes the exact opt-in the proposal prints, and nothing looser', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'node tools/lint.mjs' }) });
  const run = (...a) => cli(['validate', dir, '--modified', 'src/a.mjs', '--class', 'SMALL', '--fresh-graph', '--json', ...a], dir);
  const plain = JSON.parse(run().stdout).plan;
  const o = plain.confirmationRequired[0].commands[0].optIn;
  const entryOf = (over = {}) => { const x = { ...o, ...over }; return [x.commandId, x.scriptDigest, x.type, x.reason.join('+'), x.scope].join('|'); };
  const entry = entryOf();
  assert.deepEqual(JSON.parse(run('--opt-in', entry).stdout).plan.automatic, ['lint@.']);
  assert.deepEqual(JSON.parse(run('--opt-in', entryOf({ scriptDigest: 'f'.repeat(64) })).stdout).plan.automatic, [], 'a different definition');
  assert.deepEqual(JSON.parse(run('--opt-in', entryOf({ scope: 'path:src' })).stdout).plan.automatic, [], 'another scope');
  assert.deepEqual(JSON.parse(run('--opt-in', entryOf({ commandId: 'pkg:.:other' })).stdout).plan.automatic, [], 'another command');
  for (const bad of ['lint:project-script:project', 'a|b|c', `${entry}|extra`, entryOf({ reason: ['env-expansion'] })]) assert.equal(run('--opt-in', bad).status, 2, bad);
  assert.equal(JSON.parse(run('--opt-in', 'validation-set|' + 'a'.repeat(32) + '|V3|LOW|project').stdout).plan.automatic.length, 0, 'the set form is accepted and does nothing at V1');
  assert.equal(run('--opt-in', 'validation-set|project').status, 2, 'the old broad token is refused');
});

// ---- R-C: what impact could not establish survives into the plan ---------------------------------------------------------------------

const lintProject = () => project({ ...BASE, 'package.json': PKG({ lint: 'node --check src/a.mjs' }) });

test('R-C limitations, completeness and bounds of the impact report are carried, in order and bounded', () => {
  const dir = lintProject();
  const impact = impactWith([], { completeness: 'BOUNDED_COMPLETE', confidence: 'medium', limitations: ['file-level analysis: a superset', '2 changed file(s) are not in the graph: search for their consumers', '15 more direct dependent(s) are not listed (limit 30)'], bounded: { tests: { truncated: false }, truncatedLists: ['transitive', 'directDependents'] }, batching: { required: true, remainingChangedFiles: 0 } });
  const p = planFor(dir, { impact });
  assert.deepEqual(p.impact.limitations, impact.limitations, 'every limitation, in order');
  for (const l of impact.limitations) assert.ok(p.limitations.includes('impact: ' + l), l);
  assert.deepEqual([p.impact.completeness, p.impact.confidence, p.impact.batchingRequired, p.impact.truncatedLists], ['BOUNDED_COMPLETE', 'medium', true, ['directDependents', 'transitive']]);
  assert.notEqual(p.confidence, 'high');
  const real = analyzeChangeImpact({ files: [{ path: 'src/a.mjs', status: 'modified' }], taskClass: 'SMALL' }, { state: 'missing' }, {});
  const q = planValidation({ task: { taskClass: 'SMALL' }, impact: real, project: { commands: discover(dir).commands } });
  assert.deepEqual(q.impact.limitations, real.limitations, 'a real report loses nothing');
  assert.ok(real.limitations.length >= 2);
  const many = planFor(dir, { impact: impactWith([], { limitations: Array.from({ length: 25 }, (_, i) => `limitation ${i}`) }) });
  assert.equal(many.impact.limitations.length, 20);
  assert.equal(many.impact.limitationsOmitted, 5);
  assert.ok(many.limitations.includes('impact: 5 more limitation(s) were not carried (limit 20)'), 'what is not carried is said');
});

test('R-C a hidden path inside a limitation never reaches the plan', () => {
  const impact = impactWith([], { limitations: ['src/a.mjs: partially parsed', 'could not read config/id_rsa or .env.production here', 'x'.repeat(500)] });
  const p = planFor(lintProject(), { impact });
  const text = JSON.stringify(p);
  assert.ok(!/id_rsa|\.env/.test(text));
  assert.match(p.impact.limitations[1], /could not read \[withheld\] or \[withheld\] here/);
  assert.equal(p.impact.limitations[2].length, 300);
  assert.equal(p.impact.limitations[0], 'src/a.mjs: partially parsed');
});

test('R-C an impact that was not established is not a clean PASS (V1 and up), remaining files stay unresolved, all-withheld stays UNKNOWN', () => {
  const dir = lintProject();
  const unknown = analyzeChangeImpact({ files: [{ path: 'src/a.mjs', status: 'modified' }], taskClass: 'SMALL' }, { state: 'missing' }, {});
  const p = planValidation({ task: { taskClass: 'SMALL' }, impact: unknown, project: { commands: discover(dir).commands } });
  assert.deepEqual(p.unresolved.map((u) => u.reason), ['impact-not-established']);
  const r = runValidationPlan(p, dir, { execute: true, deps: fake() });
  assert.deepEqual([r.status, r.unknown, r.passed], ['UNKNOWN', ['impact'], ['lint@.']], 'every check passed, yet what the change affects is unknown');
  assert.equal(r.confidence, 'low');
  const v0 = planValidation({ task: { taskClass: 'TRIVIAL' }, impact: analyzeChangeImpact({ files: [{ path: 'src/a.mjs', status: 'modified' }], taskClass: 'TRIVIAL' }, { state: 'missing' }, {}), project: { commands: discover(dir).commands } });
  assert.deepEqual(v0.unresolved, [], 'V0 is a sanity check of the changed file: it does not depend on impact');
  const known = planFor(dir, { impact: impactWith([]) });
  assert.equal(runValidationPlan(known, dir, { execute: true, deps: fake() }).status, 'PASS', 'an established impact still passes cleanly');
  const files = Array.from({ length: 25 }, (_, i) => ({ path: `src/m${i}.mjs`, status: 'modified' }));
  const batched = planValidation({ task: { taskClass: 'SMALL' }, impact: analyzeChangeImpact({ files, taskClass: 'SMALL' }, { state: 'current' }, {}), project: { commands: discover(dir).commands } });
  assert.ok(batched.unresolved.some((u) => u.type === 'coverage' && u.reason === 'changed-files-not-analyzed'));
  assert.equal(runValidationPlan(batched, dir, { execute: true, deps: fake() }).status, 'UNKNOWN');
  const secret = planValidation({ task: { taskClass: 'SMALL' }, impact: analyzeChangeImpact({ files: [{ path: '.env', status: 'modified' }], taskClass: 'SMALL' }, { state: 'current' }, {}), project: { commands: discover(dir).commands } });
  const rs = runValidationPlan(secret, dir, { execute: true, deps: fake() });
  assert.deepEqual([rs.status, rs.unknown], ['UNKNOWN', ['any']]);
});

// ---- R-D: an unconfirmed process tree is never a clean timeout ----------------------------------------------------------------------------

function timeoutRun(extra, dir = lintProject()) {
  const p = planFor(dir);
  return runValidationPlan(p, dir, { execute: true, deps: fake(() => ({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }), ...extra })) });
}

test('R-D 1 2 3 only a confirmed termination is a clean timeout; false and undefined are orphan risk', () => {
  const ok = timeoutRun({ treeTerminated: true });
  assert.deepEqual([ok.status, ok.actions[0].reason, ok.actions[0].evidence.treeTerminated, ok.limitations.some((l) => /orphan|may still be running/.test(l))], ['UNKNOWN', 'timed-out', true, false]);
  for (const [name, extra] of [['false', { treeTerminated: false }], ['undefined', {}], ['null', { treeTerminated: null }], ['a truthy non-boolean', { treeTerminated: 'yes' }]]) {
    const r = timeoutRun(extra);
    assert.deepEqual([name, r.status, r.actions[0].reason], [name, 'UNKNOWN', 'timed-out-orphan-risk']);
    assert.ok(r.limitations.some((l) => /process tree could not be confirmed terminated: a child process may still be running/.test(l)), name);
  }
  const overflow = (extra) => runValidationPlan(planFor(lintProject()), lintProject(), { execute: true, deps: fake(() => ({ status: null, error: Object.assign(new Error('o'), { code: 'ENOBUFS' }), ...extra })) });
  assert.equal(overflow({ treeTerminated: true }).actions[0].reason, 'output-limit');
  assert.equal(overflow({}).actions[0].reason, 'output-limit-orphan-risk', 'an output overflow is held to the same rule');
});

test('R-D 4 a supervisor that fails is an unconfirmed tree, never a clean result', () => {
  const r = timeoutRun({});
  assert.equal(r.actions[0].reason, 'timed-out-orphan-risk');
  const dir = lintProject();
  const failed = runValidationPlan(planFor(dir), dir, { execute: true, deps: fake(() => ({ status: null, signal: null, treeTerminated: false, supervisorFailed: true, error: Object.assign(new Error('s'), { code: 'ESUPERVISOR' }) })) });
  assert.deepEqual([failed.status, failed.actions[0].reason], ['UNKNOWN', 'supervisor-failed-orphan-risk']);
  assert.ok(failed.limitations.some((l) => /supervisor failed: a started process may still be running/.test(l)));
  const garbage = supervisedSpawn(process.execPath, ['-e', '1'], { cwd: dir, timeout: 5000, supervisorGraceMs: 20000 });
  assert.equal(garbage.status, 0, 'a healthy supervisor still reports a normal exit');
});

test('R-D 5 the supervisor\'s own outer timeout is reported as an unconfirmed tree', async () => {
  const dir = project({});
  const res = supervisedSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { cwd: dir, timeout: 600, supervisorGraceMs: -590 });
  assert.equal(res.error.code, 'ETIMEDOUT');
  assert.equal(res.treeTerminated, false, 'nothing confirmed that what the supervisor started has stopped');
  assert.equal(res.supervisorFailed, true);
  await sleep(4500); // let the harmless 4 s child end by itself
});

test('R-D 6 7 a real timeout through npm: the script really started, was still running at the limit, and its marker never appears', { skip: !npmAvailable && 'npm cannot be run without a shell here' }, async () => {
  const dir = project({
    ...BASE,
    'package.json': PKG({ lint: 'node slow.mjs' }),
    'slow.mjs': 'import fs from "node:fs";\nimport { spawn } from "node:child_process";\nfs.writeFileSync("STARTED", "yes");\nspawn(process.execPath, ["-e", "setTimeout(() => require(\'fs\').writeFileSync(\'GRANDCHILD_LATE\', \'x\'), 6000); setTimeout(() => {}, 20000)"], { stdio: "ignore" });\nsetTimeout(() => fs.writeFileSync("LATE", "the script survived"), 6000);\nsetTimeout(() => {}, 20000);\n',
  });
  const p = planFor(dir);
  assert.equal(p.actions[0].level, 'A2');
  const t0 = Date.now();
  const r = runValidationPlan(p, dir, { execute: true, timeoutMs: 3500, confirm: { planId: p.planId, proposals: p.confirmationRequired.map((x) => x.id) } });
  const ms = Date.now() - t0;
  assert.ok(fs.existsSync(path.join(dir, 'STARTED')), 'the script did start (so the timeout stopped a running process, not a slow npm)');
  assert.deepEqual([r.status, r.actions[0].reason, r.actions[0].evidence.treeTerminated, r.actions[0].evidence.timedOut], ['UNKNOWN', 'timed-out', true, true]);
  assert.ok(ms < 12000, `stopped near the limit (${ms} ms)`);
  await sleep(Math.max(0, 7500 - ms)); // past the moment either marker would have been written
  assert.ok(!fs.existsSync(path.join(dir, 'LATE')), 'the script did not survive');
  assert.ok(!fs.existsSync(path.join(dir, 'GRANDCHILD_LATE')), 'its child did not survive');
});

// ---- R-E: the classifier ---------------------------------------------------------------------------------------------------------------

test('R-E commands that install, fetch or write are never A1 (classified only, nothing is executed)', () => {
  const cases = {
    'mypy --install-types': ['A3', 'install'], 'mypy --install-types --non-interactive': ['A3', 'install'], 'flake8 --install-hook git': ['A3', 'install'],
    'eslint --init': ['A3', 'install'], 'python setup.py install': ['A3', 'install'], 'python3 setup.py develop': ['A3', 'install'], 'deno install -A x.ts': ['A3', 'install'],
    'ruff check --fix': ['A2', 'mutating'], 'ruff check --fix-only': ['A2', 'mutating'], 'ruff check --unsafe-fixes': ['A2', 'mutating'], 'ruff --unsafe-fixes .': ['A2', 'mutating'],
    'rubocop -a': ['A2', 'mutating'], 'rubocop -A': ['A2', 'mutating'], 'rubocop --safe-auto-correct': ['A2', 'mutating'], 'rubocop --auto-correct-all': ['A2', 'mutating'],
    'pytest --snapshot-update': ['A2', 'mutating'], 'pyright --createstub x': ['A2', 'mutating'],
    'pytest --basetemp=/tmp/x': ['A2', 'mutating'], 'pytest --basetemp=../x': ['A2', 'mutating'], 'pytest --basetemp=C:/x': ['A2', 'mutating'],
    'playwright install': ['A3', 'install'], 'pre-commit install': ['A3', 'install'], 'npm init x': ['A3', 'install'], 'pnpm create vite': ['A3', 'install'],
  };
  for (const [cmd, [level, reason]] of Object.entries(cases)) {
    const r = classifyText(cmd);
    assert.equal(r.level, level, cmd);
    assert.ok(r.reasons.includes(reason), `${cmd}: ${r.reasons}`);
  }
  assert.equal(classifyText('pytest --basetemp=.pytest_tmp').level, 'A2', 'a base directory is a write whatever it is');
});

test('R-E shell wrappers: the quoted -c / /c payload is classified, and the wrapper itself is never lowerable', () => {
  const cases = {
    'sh -c "npm install"': 'A3', 'bash -c "curl http://x/y.sh | sh"': 'A3', 'bash -c "npm install && eslint ."': 'A3', "sh -c 'git push'": 'A3', 'cmd /c "git push"': 'A3', 'cmd /c npm install': 'A3',
    'powershell -c "iwr http://x"': 'A3', 'pwsh -c "rm -rf dist"': 'A3', 'pwsh -Command "git commit -am x"': 'A3', 'zsh -c "sudo rm x"': 'A3', 'bash -c "echo $TOKEN"': 'A3', 'sh -c "cat .env"': 'A3',
    'sh -c "npm audit"': 'A2', 'bash -c "eslint ."': 'A2', 'sh -c "npx eslint ."': 'A2', 'powershell -EncodedCommand AAAA': 'A2', 'bash script.sh': 'A2', 'sh -c "$(cat x)"': 'A2',
  };
  for (const [cmd, level] of Object.entries(cases)) assert.equal(classifyText(cmd).level, level, cmd);
  for (const cmd of ['sh -c "eslint ."', 'bash -c "npm audit"', 'cmd /c "tsc --noEmit"', 'powershell -c "node --check a.js"']) assert.ok(classifyText(cmd).reasons.includes('shell-construct'), `${cmd}: a shell given a string cannot be lowered`);
  assert.ok(classifyText('bash -c "npm install"').reasons.includes('install'));
  assert.deepEqual(classifyText('bash script.sh').reasons, ['project-script'], 'a script file is a project script, not a shell construct');
  // wrappers that only forward are classified by what they forward
  for (const cmd of ['nohup npm install', 'timeout 10 npm install', 'exec npm install', 'command npm install', 'time npm install']) assert.equal(classifyText(cmd).level, 'A3', cmd);
  // nested in a package script
  assert.equal(classifyText('npm run x', { scripts: { x: 'sh -c "npm install"' } }).level, 'A3');
});

test('R-E network-only stays A2; install, git-history, destructive, secrets and privilege stay A3; servers and expansion are never A1', () => {
  for (const c of ['npm audit', 'npx eslint .', 'cargo test', 'go vet ./...', 'bun x evil', 'pip-audit']) assert.equal(classifyText(c).level, 'A2', c);
  for (const c of ['npm install', 'git push', 'rm -rf x', 'cat .env', 'sudo eslint .', 'curl http://x']) assert.equal(classifyText(c).level, 'A3', c);
  for (const c of ['vite', 'next dev', 'webpack serve', 'python -m http.server', 'vitest', 'jest --watch', 'eslint --watch']) assert.ok(!['A1'].includes(classifyText(c).level), c);
  for (const c of ['eslint $HOME/src', 'FOO=$BAR jest', 'node --check ${FILE}', 'eslint %CD%']) assert.notEqual(classifyText(c).level, 'A1', c);
  assert.equal(classifyText('FOO=$API_KEY eslint .').level, 'A3');
});

test('R-E proven read-only forms stay A1: no tool-name blacklist', () => {
  for (const c of ['tsc --noEmit', 'tsc -p tsconfig.json --noEmit', 'node --check src/a.mjs', 'node --test', 'node --test tests/a.test.mjs', 'eslint .', 'eslint src --max-warnings 0', 'black --check .', 'isort --check-only .', 'ruff check .', 'ruff format --check .', 'rubocop', 'pytest -q', 'mypy src', 'flake8 src', 'prettier --check .', 'jest', 'vitest run', 'git diff --exit-code', 'deno test', 'bun test']) assert.equal(classifyText(c).level, 'A1', c);
  for (const c of ['tsc', 'tsc -b', 'black .', 'isort .', 'ruff format .', 'prettier --write .', 'eslint --fix .']) assert.equal(classifyText(c).level, 'A2', c);
});

// ---- R-F: no secret value on any output surface ---------------------------------------------------------------------------------------------

const SECRETS = ['s3cretpw', 'hunter2', 'AKIAIOSFODNN7EXAMPLE', 'sk_live_abcdef123456', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'admin:s3cretpw', 'p4ssw0rd-positional'];
const leaks = (text) => SECRETS.filter((x) => String(text).includes(x));

test('R-F summaries show the executable, option names and plain paths, and never a positional or assigned value', () => {
  const cases = [
    ['curl -u admin:s3cretpw https://x', 'curl -u [redacted] [url]'],
    ['mycli login hunter2', 'mycli [arg] [arg]'],
    ['db-cli connect p4ssw0rd-positional', 'db-cli [arg] [arg]'],
    ['aws s3 cp x s3://bucket --profile prod', 'aws [arg] [arg] x [url] --profile [arg]'],
    ['deploy --key AKIAIOSFODNN7EXAMPLE', 'deploy --key [arg]'],
    ['API_TOKEN=sk_live_abcdef123456 DB=postgres://u:pw@h/db node --test', 'API_TOKEN=[redacted] DB=[redacted] node --test'],
    ['eslint . --api-key abc --token=xyz --max-warnings 0 --cache=true', 'eslint . --api-key [arg] --token=[redacted] --max-warnings 0 --cache=true'],
    ['psql postgres://u:pw@h/db -c "select 1"', 'psql [url] -c [arg]'],
    ['node tools/lint.mjs src/**/*.ts', 'node tools/lint.mjs src/**/*.ts'],
    ['npx eslint . && npm run lint:css', 'npx eslint . && npm run lint:css'],
    ['eslint ' + 'A'.repeat(64), 'eslint [arg]'],
    ['node a.js $HOME ${TARGET} %CD%', 'node a.js $HOME ${TARGET} %CD%'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123 eslint .', '[arg] [arg] .'.replace('[arg] [arg] .', summarizeScript('ghp_abcdefghijklmnopqrstuvwxyz0123 eslint .'))],
  ];
  for (const [input, expected] of cases) {
    const s = summarizeScript(input);
    assert.equal(s, expected, input);
    assert.deepEqual(leaks(s), [], input);
  }
  assert.ok(summarizeScript('eslint ' + 'src/some/long/path '.repeat(40)).length <= 160);
  assert.equal(summarizeScript(undefined), '');
});

test('R-F no raw secret in the plan, its JSON, the A2 proposal, the prohibited list, the text output, the record or a failure excerpt', () => {
  const scripts = { lint: 'curl -u admin:s3cretpw https://x', test: 'mycli login hunter2 --token=sk_live_abcdef123456', typecheck: 'node tools/check.mjs p4ssw0rd-positional', build: 'API_KEY=ghp_abcdefghijklmnopqrstuvwxyz0123 vite build' };
  const dir = project({ ...BASE, 'package.json': PKG(scripts) });
  for (const cls of ['SMALL', 'MEDIUM', 'LARGE']) {
    const p = planFor(dir, { cls });
    const surfaces = [JSON.stringify(p), JSON.stringify(p.confirmationRequired), JSON.stringify(p.prohibited), JSON.stringify(p.actions), JSON.stringify(validationRecord({ phase: 'planned', plan: p })), JSON.stringify(p.limitations)];
    for (const surface of surfaces) assert.deepEqual(leaks(surface), [], `${cls}: ${surface.slice(0, 80)}`);
    assert.ok(p.prohibited.length + p.confirmationRequired.length > 0);
  }
  const med = planFor(dir, { cls: 'MEDIUM' });
  assert.ok(med.prohibited.some((x) => x.summary === 'curl -u [redacted] [url]'), 'the prohibited entry says what it is without the credential');
  for (const args of [['--json'], []]) {
    const o = cli(['validate', dir, '--modified', 'src/a.mjs', '--class', 'MEDIUM', '--fresh-graph', ...args], dir);
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(leaks(o.stdout + o.stderr), [], args.join(' ') || 'text');
  }
  // a failing command that echoes secrets: the excerpt, the result, the record and the state carry none of them
  const lint = project({ ...BASE, 'package.json': PKG({ lint: 'node --check src/a.mjs' }) });
  const p = planFor(lint);
  const noisy = fake(() => ({ status: 1, stdout: 'connecting as admin:s3cretpw@db.example\nusing AKIAIOSFODNN7EXAMPLE\nPassword: hunter2\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123\nplain line at src/a.mjs:3\n', stderr: 'Authorization: Bearer sk_live_abcdef123456\n' }));
  const r = runValidationPlan(p, lint, { execute: true, deps: noisy });
  assert.deepEqual(leaks(JSON.stringify(r)), []);
  assert.ok(r.evidence.failures[0].excerpt.includes('plain line at src/a.mjs:3'), 'harmless lines survive');
  const state = updateTaskState('---\nupdatedAt: 2026-01-01T00:00:00Z\nowner: a\n---\n## Last validation\n', r, { owner: 'a' });
  assert.deepEqual(leaks(state.text), []);
  assert.deepEqual(leaks(JSON.stringify(r.record)), []);
});

// ---- R-G: one decision for TASK_STATE and HANDOFF ------------------------------------------------------------------------------------------

const RESULT = (status, extra = {}) => ({ v: 1, planId: 'abcdef0123456789', depth: 'V1', status, required: true, actions: [{ id: 'lint@.', status, reason: status === 'NOT_RUN' ? 'awaiting-confirmation' : undefined }], executed: [], passed: [], failed: [], notRun: [], declined: [], blocked: [], unknown: [], ...extra });
const decide = (o) => decideValidationStateAndHandoff({ taskClass: 'SMALL', risk: 'LOW', ...o });

test('R-G 1 2 a declined A2: in a continuing session the state is sufficient; at the end the state comes first and the handoff follows', () => {
  const smallMid = decide({ result: RESULT('DECLINED'), taskClass: 'SMALL' });
  assert.deepEqual([smallMid.handoff.required, smallMid.state.write, smallMid.state.create, smallMid.consistent, smallMid.order], [false, false, false, true, []], 'SMALL, continuing: no handoff and no state: nothing to be inconsistent about');
  const smallEnd = decide({ result: RESULT('DECLINED'), taskClass: 'SMALL', sessionEnding: true });
  assert.deepEqual([smallEnd.handoff.required, smallEnd.state.write, smallEnd.state.create, smallEnd.consistent, smallEnd.order], [true, true, true, true, ['TASK_STATE.md', 'HANDOFF.md']]);
  assert.match(smallEnd.state.reason, /a handoff is required, so the state must exist first/);
  const mediumMid = decide({ result: RESULT('DECLINED'), taskClass: 'MEDIUM' });
  assert.deepEqual([mediumMid.handoff.required, mediumMid.state.write, mediumMid.state.create, mediumMid.order], [false, true, true, ['TASK_STATE.md']], 'MEDIUM: the state is created by its own trigger, no handoff');
  const mediumEnd = decide({ result: RESULT('DECLINED'), taskClass: 'MEDIUM', sessionEnding: true });
  assert.deepEqual([mediumEnd.handoff.required, mediumEnd.state.write, mediumEnd.consistent], [true, true, true]);
});

test('R-G 3 4 BLOCKED and UNKNOWN on unfinished work', () => {
  const blocked = decide({ result: RESULT('BLOCKED'), taskClass: 'SMALL' });
  assert.deepEqual([blocked.handoff.required, blocked.handoff.triggers, blocked.state.create, blocked.consistent], [true, ['blocked-on-resolution'], true, true], 'a boundary only a person can resolve: state first, then handoff');
  const unknownMid = decide({ result: RESULT('UNKNOWN'), taskClass: 'MEDIUM' });
  assert.deepEqual([unknownMid.handoff.required, unknownMid.state.create], [false, true]);
  const unknownSmall = decide({ result: RESULT('UNKNOWN'), taskClass: 'SMALL' });
  assert.deepEqual([unknownSmall.handoff.required, unknownSmall.state.write], [false, false]);
  const unknownEnd = decide({ result: RESULT('UNKNOWN'), taskClass: 'SMALL', sessionEnding: true });
  assert.deepEqual([unknownEnd.handoff.required, unknownEnd.state.create, unknownEnd.consistent], [true, true, true]);
  assert.equal(decide({ result: RESULT('FAIL'), taskClass: 'LARGE' }).handoff.required, false, 'a failing check is fixed within scope');
});

test('R-G 5 6 7 8 session end, a completed task, a continuing success and a pause', () => {
  assert.equal(decide({ result: RESULT('FAIL'), sessionEnding: true }).handoff.required, true, 'session-ending unfinished');
  assert.equal(decide({ result: RESULT('FAIL'), ownershipTransfer: true }).handoff.triggers[0], 'ownership-transfer');
  const done = decide({ result: RESULT('PASS'), taskClass: 'LARGE', taskStatus: 'done', sessionEnding: true });
  assert.deepEqual([done.handoff.required, done.completion.allowed], [false, true], 'a completed task needs no handoff');
  const doneFail = decide({ result: RESULT('FAIL'), taskClass: 'MEDIUM', taskStatus: 'done', sessionEnding: true });
  assert.equal(doneFail.completion.allowed, false, 'a task cannot be completed with a failing required validation');
  assert.match(doneFail.completion.reason, /cannot be completed while its required validation is FAIL/);
  assert.equal(decide({ result: RESULT('DECLINED'), taskStatus: 'done' }).completion.allowed, false);
  assert.equal(decide({ result: { ...RESULT('NOT_RUN'), required: false }, taskStatus: 'done' }).completion.allowed, true, 'validation was not required');
  const okMid = decide({ result: RESULT('PASS'), taskClass: 'MEDIUM' });
  assert.deepEqual([okMid.handoff.required, okMid.state.write, okMid.order], [false, true, ['TASK_STATE.md']], 'a continuing success: state only');
  const pause = decide({ result: RESULT('DECLINED'), taskClass: 'MEDIUM', stateExists: true });
  assert.deepEqual([pause.handoff.required, pause.state.write, pause.state.create], [false, true, false], 'a pause within a continuing session: the existing state is enough');
  assert.equal(decide({ result: RESULT('DECLINED'), readOnly: true }).state.write, false, 'read-only work writes nothing');
});

test('R-G 9 10 a duplicate handoff is not required again; the state is written by its owner only', () => {
  const dup = decide({ result: RESULT('BLOCKED'), latestHandoffMatches: true });
  assert.deepEqual([dup.handoff.required, dup.handoff.duplicate, dup.consistent], [false, true, true]);
  assert.equal(handoffDecision({ result: RESULT('NOT_RUN', { notRun: ['lint@.'] }), interactive: false }).triggers[0], 'confirmation-cannot-be-asked');
  assert.equal(decide({ result: RESULT('PASS') }).state.requiresOwner, true);
  const STATE = '---\nupdatedAt: 2026-01-01T00:00:00Z\nowner: agent-a\n---\n# Task State\n\n## Status\nin-progress\n\n## Last validation\n';
  assert.equal(updateTaskState(STATE, RESULT('DECLINED'), { owner: 'agent-b' }).refused, 'not-owner');
  assert.equal(updateTaskState(STATE, RESULT('DECLINED'), {}).refused, 'owner-unknown');
  assert.equal(updateTaskState(null, RESULT('DECLINED'), { owner: 'a', taskClass: 'SMALL' }).skipped, 'state-not-required');
  assert.equal(updateTaskState(null, RESULT('DECLINED'), { owner: 'a', taskClass: 'SMALL', handoffAhead: true }).created, true, 'a handoff about to be written is a creation trigger');
  assert.equal(cli(['validate', project({ ...BASE, 'package.json': PKG({ lint: 'npx eslint .' }) }), '--modified', 'src/a.mjs', '--class', 'SMALL', '--run', '--update-state'], tmpDir('x')).status, 2, 'no owner, no write');
});

test('R-G the command applies the one decision: state first, then the handoff, never one without the other', () => {
  const mk = () => project({ ...BASE, 'package.json': PKG({ lint: 'npx eslint .' }) });
  const run = (dir, ...extra) => JSON.parse(cli(['validate', dir, '--modified', 'src/a.mjs', '--fresh-graph', '--run', '--declined', 'network-possible', '--update-state', '--owner', 'me', '--json', ...extra], dir).stdout);
  const smallMid = mk();
  const a = run(smallMid, '--class', 'SMALL');
  assert.deepEqual([a.result.status, a.handoff.required, a.state.skipped, a.decision.consistent, fs.existsSync(path.join(smallMid, '.ai'))], ['DECLINED', false, 'state-not-required', true, false]);
  const smallEnd = mk();
  const b = run(smallEnd, '--class', 'SMALL', '--session-ending');
  assert.deepEqual([b.handoff.required, b.state.created, b.decision.consistent, b.decision.order], [true, true, true, ['TASK_STATE.md', 'HANDOFF.md']]);
  const text = fs.readFileSync(path.join(smallEnd, '.ai', 'TASK_STATE.md'), 'utf8');
  assert.match(text, /<!-- erdem:validation:begin/);
  assert.match(text, /not run, declined/);
  const mediumMid = mk();
  const c = run(mediumMid, '--class', 'MEDIUM');
  assert.deepEqual([c.handoff.required, c.state.created], [false, true]);
  const done = cli(['validate', mk(), '--modified', 'src/a.mjs', '--class', 'SMALL', '--fresh-graph', '--run', '--declined', 'network-possible', '--task-status', 'done'], tmpDir('y'));
  assert.equal(done.status, 1);
});

// ---- minor follow-ups ----------------------------------------------------------------------------------------------------------------------

test('M npm configuration: .npmrc is never read (its existence is bound and said), other configuration is hashed', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'node --check src/a.mjs' }) });
  const plain = discover(dir).commands[0];
  assert.deepEqual(plain.npmConfig, []);
  write(dir, { '.npmrc': '//registry.example/:_authToken=SHOULD-NOT-BE-READ-s3cretpw\nscript-shell=sh\n' });
  const withRc = discover(dir).commands[0];
  assert.deepEqual(withRc.npmConfig, ['.npmrc']);
  assert.notEqual(withRc.scriptDigest, plain.scriptDigest, 'adding it changes the definition');
  write(dir, { '.npmrc': 'script-shell=something-else\n' });
  assert.equal(discover(dir).commands[0].scriptDigest, withRc.scriptDigest, 'its content is never read, so a content change cannot be seen: the limitation is stated instead');
  const p = planFor(dir);
  assert.ok(p.limitations.some((l) => /a project npm configuration exists \(\.npmrc\) and is never read \(secret pattern\); npm itself may still read it for settings that are not pinned/.test(l)));
  assert.ok(!JSON.stringify(p).includes('SHOULD-NOT-BE-READ'));
  write(dir, { '.yarnrc.yml': 'nodeLinker: node-modules\n' });
  const y1 = discover(dir).commands[0].scriptDigest;
  write(dir, { '.yarnrc.yml': 'nodeLinker: pnp\n' });
  assert.notEqual(discover(dir).commands[0].scriptDigest, y1, 'a configuration that is not secret is hashed');
  fs.rmSync(path.join(dir, '.npmrc'));
  assert.notEqual(discover(dir).commands[0].scriptDigest, withRc.scriptDigest, 'removing it changes the definition');
});

test('M a reused PASS is trusted only while the plan and its commands are still what they were', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'node --check src/a.mjs' }) });
  const p = planFor(dir);
  const previous = { planId: p.planId.slice(0, 8), contentKey: 'abcd1234', status: 'PASS' };
  const reused = runValidationPlan(p, dir, { execute: true, deps: fake(), previous, contentKey: 'abcd1234ffff' });
  assert.deepEqual([reused.reused, reused.executed], [true, []]);
  const tampered = JSON.parse(JSON.stringify(p));
  tampered.actions[0].command.argv = ['npm', 'publish'];
  const t = runValidationPlan(tampered, dir, { execute: true, deps: fake(), previous, contentKey: 'abcd1234ffff' });
  assert.equal(t.reused, undefined, 'a plan that no longer matches its id gets no reused PASS');
  assert.equal(t.actions[0].reason, 'plan-integrity');
  write(dir, { 'package.json': PKG({ lint: 'node --check src/a.mjs && node --check src/b.mjs' }) });
  const changed = runValidationPlan(p, dir, { execute: true, deps: fake(), previous, contentKey: 'abcd1234ffff' });
  assert.equal(changed.reused, undefined, 'the command changed since: no reused PASS');
  assert.equal(changed.actions[0].reason, 'command-changed-since-planning');
});

test('M a confirmation or an opt-in is supplied by the caller: the result says so', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'npx eslint .' }) });
  const p = planFor(dir);
  const r = runValidationPlan(p, dir, { execute: true, deps: fake(), confirm: { planId: p.planId, proposals: p.confirmationRequired.map((x) => x.id) } });
  assert.equal(r.status, 'PASS');
  assert.ok(r.limitations.some((l) => /confirmation supplied by the caller: this tool cannot verify that the user gave it \(the adapter must obtain the yes\)/.test(l)));
  const lint = project({ ...BASE, 'package.json': PKG({ lint: 'node --check src/a.mjs' }) });
  assert.ok(!runValidationPlan(planFor(lint), lint, { execute: true, deps: fake() }).limitations.some((l) => /supplied by the caller/.test(l)), 'nothing to say when no yes or opt-in was involved');
});

test('real A3 refusal through the real runner: a prohibited script is blocked before any process starts', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'node --check src/a.mjs && git push' }) });
  const p = planFor(dir);
  assert.equal(p.actions[0].level, 'A3');
  const r = runValidationPlan(p, dir, { execute: true, confirm: { planId: p.planId, proposals: [] } });
  assert.deepEqual([r.status, r.actions[0].status, r.actions[0].reason, r.actions[0].evidence], ['BLOCKED', 'BLOCKED', 'a3-never-automatic', undefined], 'refused with no evidence of any run');
  assert.deepEqual(r.executed, []);
});
