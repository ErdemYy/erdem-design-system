import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, TOOLS_ROOT, tmpDir } from './helpers.mjs';
import { classifyText, NEVER_LOWERABLE } from '../automation/validation-classify.mjs';
import { discoverCommands } from '../automation/validation-discovery.mjs';
import { NPM_EXECUTION_NOTES, bindingOf, planIdOf, planValidation, setAuthorizationFor } from '../automation/validation-plan.mjs';
import { runValidationPlan } from '../automation/validation-runner.mjs';

after(cleanup);

function project(files) {
  const dir = path.join(tmpDir('pi-val-ff-'), 'app');
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}
const PKG = (scripts) => JSON.stringify({ name: 'fx', scripts });
const CHANGED = [{ path: 'src/a.mjs', status: 'modified' }];
const BASE = { 'src/a.mjs': 'export const a = 1;\n' };
function planFor(dir, o = {}) {
  const d = discoverCommands(dir, { changedFiles: ['src/a.mjs'] });
  return planValidation({ task: { taskClass: o.cls ?? 'SMALL', risk: o.risk, taskTypes: [], changedFiles: CHANGED }, impact: null, project: { commands: d.commands, limitations: d.limitations, standingOptIn: o.optIn } });
}
function fake() {
  const calls = [];
  return { calls, spawn: (file, args, options) => { calls.push({ file, args, options }); return { status: 0, stdout: '', stderr: '' }; }, resolve: (n) => ({ file: `/bin/${n}`, prefix: [] }) };
}
const idOf = (p) => planIdOf(p.depth, p.actions, bindingOf(p));
const forge = (p, edit) => {
  const f = JSON.parse(JSON.stringify(p));
  edit(f);
  f.planId = idOf(f);
  return f;
};
const lv = (text) => classifyText(text);

// ---- F1: only a genuine environment reference is exempt from validation ------------------------------------------------------------

test('F1 a malformed percent token is validated like any other token: it is no longer A1', () => {
  for (const c of ['eslint --rulesdir=%a .', 'black --check --weird=%a .', 'node --check --import=%a a.mjs', 'git diff --ext-diff%a', 'pytest --unknownflag=%a', 'eslint . %a', 'eslint --foo=%unknown .', 'eslint %a%']) {
    assert.notEqual(lv(c).level, 'A1', c);
  }
  assert.deepEqual(lv('eslint --rulesdir=%a .').reasons, ['unclear-command']);
});

test('F1 a percent inside a flag value or a positional value does not exempt it', () => {
  assert.equal(lv('eslint --max-warnings=%a .').level, 'A2');
  assert.equal(lv('eslint src/%a').level, 'A2');
  assert.equal(lv('pytest -k %a').level, 'A2');
});

test('F1 genuine environment references are A2 env-expansion and never lowerable', () => {
  for (const c of ['eslint --config=%CD%/x .', 'eslint $HOME/src', 'node --check ${FILE}', 'eslint --config=$env:HOME/x .']) {
    const r = lv(c);
    assert.equal(r.level, 'A2', c);
    assert.ok(r.reasons.includes('env-expansion'), c);
  }
  assert.ok(NEVER_LOWERABLE.includes('env-expansion'));
});

test('F1 verified A1 forms stay A1, including git format placeholders; one invalid token among valid ones is enough to refuse', () => {
  for (const c of ['eslint .', 'git log --format=%H', 'node --check src/a.mjs', 'pytest -q']) assert.equal(lv(c).level, 'A1', c);
  assert.equal(lv('eslint . --quiet --rulesdir=%a').level, 'A2');
  assert.equal(lv('git log --format=%H;x').level, 'A2');
});

// ---- F2: environment assignments are inspected ----------------------------------------------------------------------------------------

test('F2 dangerous assignments are A2 env-assignment, never lowerable, before any A1 form is reached', () => {
  const bad = ['NODE_OPTIONS=--require=./evil.js node --check a.mjs', 'NODE_PATH=./x node --check a.mjs', 'PATH=./bin eslint .', 'LD_PRELOAD=./x.so black --check .', 'LD_LIBRARY_PATH=./l pytest -q', 'PYTHONPATH=./evil pytest -q', 'PYTHONSTARTUP=./x.py pytest -q', 'PYTHONINSPECT=1 pytest -q', 'GIT_EXTERNAL_DIFF=./x git diff', 'GIT_EXEC_PATH=./x git diff', 'npm_config_script_shell=x eslint .', 'NPM_CONFIG_SCRIPT_SHELL=x eslint .', 'BASH_ENV=./x eslint .', 'ENV=./x eslint .', 'cross-env NODE_OPTIONS=--require=./e.js node --check a.mjs', 'env PATH=./b eslint .', 'nohup NODE_OPTIONS=x eslint .'];
  for (const c of bad) {
    const r = lv(c);
    assert.equal(r.level, 'A2', c);
    assert.ok(r.reasons.includes('env-assignment'), c);
  }
  assert.ok(NEVER_LOWERABLE.includes('env-assignment'));
});

test('F2 inert assignments with plain values keep an A1 form A1, one or several', () => {
  for (const c of ['NODE_ENV=test jest', 'CI=1 vitest run', 'NODE_ENV=test CI=true FORCE_COLOR=1 eslint .', 'TZ=UTC jest', 'cross-env NODE_ENV=test jest', 'env NODE_ENV=test eslint .']) assert.equal(lv(c).level, 'A1', c);
});

test('F2 an inert value that is not plain, mixed inert and dangerous, and malformed assignments are A2', () => {
  for (const c of ['NODE_ENV=staging jest', 'NODE_ENV=test PATH=./b eslint .', 'CI=1 NODE_OPTIONS=x eslint .', '=x eslint .', 'FOO= eslint .', '1A=b eslint .', 'env -i eslint .', 'FOO=bar eslint .']) {
    const r = lv(c);
    assert.equal(r.level, 'A2', c);
    assert.ok(r.reasons.includes('env-assignment'), c);
  }
  assert.deepEqual(lv('FOO=$BAR jest').reasons, ['env-expansion']);
  assert.equal(lv('FOO=$API_KEY eslint .').level, 'A3');
});

// ---- F3: risk and class are part of the plan identity --------------------------------------------------------------------------------

test('F3 the audit exploit: a MEDIUM plan authorized, mutated to LOW, no longer passes integrity and nothing runs', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'mytool --x' }) });
  const p = planFor(dir, { cls: 'MEDIUM', risk: 'MEDIUM' });
  assert.equal(p.risk, 'MEDIUM');
  assert.ok(p.confirmationRequired.length > 0);
  const confirm = { planId: p.planId, proposals: p.confirmationRequired.map((x) => x.id) };
  const mutated = JSON.parse(JSON.stringify(p));
  mutated.risk = 'LOW';
  const deps = fake();
  const r = runValidationPlan(mutated, dir, { execute: true, deps, confirm });
  r.actions = r.actions.filter((a) => p.actions.some((x) => x.id === a.id));
  assert.equal(deps.calls.length, 0, 'nothing was started');
  assert.ok(r.actions.every((a) => a.status === 'BLOCKED' && a.reason === 'plan-integrity'));
  assert.ok(r.limitations.some((l) => /does not match its id/.test(l)));
  // the honest plan with the same authorization does run
  const ok = fake();
  assert.ok(runValidationPlan(p, dir, { execute: true, deps: ok, confirm }).actions.filter((a) => p.actions.some((x) => x.id === a.id)).every((a) => a.status === "PASS"));
  assert.ok(ok.calls.length > 0);
});

test('F3 inverse: LOW mutated to a higher risk, or a changed class, also fails integrity', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'eslint .' }) });
  const p = planFor(dir);
  for (const edit of [(f) => { f.risk = 'HIGH'; }, (f) => { f.risk = 'CRITICAL'; }, (f) => { f.class = 'TRIVIAL'; }, (f) => { f.class = 'ARCHITECTURAL'; }, (f) => { f.evaluated = false; }]) {
    const m = JSON.parse(JSON.stringify(p));
    edit(m);
    assert.notEqual(idOf(m), p.planId);
    const deps = fake();
    const r = runValidationPlan(m, dir, { execute: true, deps });
    assert.equal(deps.calls.length, 0);
    assert.ok(r.actions.every((a) => a.reason === 'plan-integrity'));
  }
});

test('F3 the binding carries risk and class, and the set id stays bound to the unlowered plan', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'node --test' }) });
  const p = planFor(dir, { cls: 'LARGE' });
  const b = bindingOf(p);
  assert.equal(b.risk, p.risk);
  assert.equal(b.class, p.class);
  const auth = setAuthorizationFor({ depth: p.depth, risk: p.risk, actions: p.actions });
  const lowered = planFor(dir, { cls: 'LARGE', optIn: [auth] });
  assert.ok(lowered.actions.every((a) => a.level === 'A1'));
  assert.equal(setAuthorizationFor({ depth: lowered.depth, risk: lowered.risk, actions: lowered.actions }).setId, auth.setId, 'the set id does not depend on the lowering');
  assert.equal(lowered.risk, p.risk);
});

test('F3 a forged plan with a recomputed id is integrity, not authentication: it is indistinguishable from an honest plan (documented limit)', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'eslint .' }) });
  const p = planFor(dir, { risk: 'MEDIUM' });
  const forged = forge(p, (f) => { f.risk = 'LOW'; });
  assert.equal(idOf(forged), forged.planId);
  assert.notEqual(forged.planId, p.planId, 'but it cannot reuse the id of the plan that was authorized');
  const deps = fake();
  const r = runValidationPlan(forged, dir, { execute: true, deps, confirm: { planId: p.planId, proposals: p.confirmationRequired.map((x) => x.id) } });
  assert.ok(!r.actions.some((a) => a.status === 'PASS' && a.level === 'A2'), 'an authorization for the original plan does not confirm the forged one');
});

// ---- F4: the set authorization covers syntax actions too ------------------------------------------------------------------------------

function setPlan(kinds, { level = 'A1' } = {}) {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'eslint .', typecheck: 'tsc --noEmit' }) });
  const base = planFor(dir, { cls: 'LARGE' });
  const proc = base.actions[0];
  const mkSyntax = (id) => ({ ...JSON.parse(JSON.stringify(proc)), id, type: 'syntax', command: undefined, commandId: undefined, scriptDigest: undefined, files: [{ path: 'src/a.mjs', check: 'node-check' }], scope: 'project', classification: { level, reasons: ['validation-set'] }, level });
  const mkProc = (a) => ({ ...JSON.parse(JSON.stringify(a)), level, classification: { level, reasons: ['validation-set'] } });
  const actions = [];
  for (const k of kinds) actions.push(k === 'syntax' ? mkSyntax('syntax' + actions.length) : mkProc(base.actions[actions.length % base.actions.length]));
  actions.forEach((a, i) => { if (a.command) a.id = a.id + '#' + i; });
  const plan = forge(base, (f) => { f.actions = actions; f.automatic = actions.map((a) => a.id); f.confirmationRequired = []; f.unresolved = []; });
  return { dir, plan };
}
const authFor = (plan, over = {}) => ({ ...setAuthorizationFor({ depth: plan.depth, risk: plan.risk, actions: plan.actions }), ...over });
const run = (plan, dir, optIn) => { const deps = fake(); return { deps, r: runValidationPlan(plan, dir, { execute: true, deps, verify: false, standingOptIn: optIn }) }; };

test('F4 a lowered syntax action runs with the exact set authorization and is refused without it', () => {
  const { dir, plan } = setPlan(['syntax']);
  const ok = run(plan, dir, [authFor(plan)]);
  assert.equal(ok.r.actions[0].status, 'PASS');
  const none = run(plan, dir, []);
  assert.equal(none.r.actions[0].status, 'BLOCKED');
  assert.equal(none.r.actions[0].reason, 'runtime-classification-stricter');
  assert.equal(none.deps.calls.length, 0);
});

test('F4 process only, mixed, and multiple syntax actions follow the same rule', () => {
  for (const kinds of [['proc'], ['syntax', 'proc'], ['syntax', 'syntax'], ['proc', 'syntax', 'syntax']]) {
    const { dir, plan } = setPlan(kinds);
    const without = run(plan, dir, []);
    assert.ok(without.r.actions.every((a) => a.status === 'BLOCKED'), kinds.join());
    assert.equal(without.deps.calls.length, 0, kinds.join());
    const withAuth = run(plan, dir, [authFor(plan)]);
    assert.ok(withAuth.r.actions.every((a) => a.status === 'PASS'), kinds.join() + JSON.stringify(withAuth.r.actions));
  }
});

test('F4 a wrong set id or a wrong depth does not authorize a syntax action', () => {
  const { dir, plan } = setPlan(['syntax', 'syntax']);
  const right = authFor(plan);
  for (const bad of [{ ...right, setId: 'a'.repeat(32) }, { ...right, depth: 'V4' }, { ...right, riskCeiling: 'HIGH' }]) {
    const x = run(plan, dir, [bad]);
    assert.ok(x.r.actions.every((a) => a.status === 'BLOCKED'), JSON.stringify(bad));
    assert.equal(x.deps.calls.length, 0);
  }
  const other = setPlan(['syntax']);
  const x = run(plan, dir, [authFor(other.plan)]);
  assert.ok(x.r.actions.every((a) => a.status === 'BLOCKED'), 'the authorization of another set');
});

test('F4 an A3 action stays blocked even with the set authorization, and a syntax action is not authorized by a lowered A3', () => {
  const { dir, plan } = setPlan(['syntax', 'proc']);
  const a3 = forge(plan, (f) => { f.actions[1].level = 'A3'; f.actions[1].classification = { level: 'A3', reasons: ['secrets'] }; });
  const x = run(a3, dir, [authFor(a3)]);
  assert.equal(x.r.actions[1].status, 'BLOCKED');
  assert.equal(x.r.actions[1].reason, 'a3-never-automatic');
  assert.ok(!x.deps.calls.some((c) => c.args.includes('run')), 'the A3 action never started');
});

// ---- F5: the npm limitation is stated exactly --------------------------------------------------------------------------------------------

test('F5 the plan says what npm execution does and does not bind, without lowering confidence', () => {
  const dir = project({ ...BASE, '.npmrc': 'script-shell=x\n', 'package.json': PKG({ lint: 'eslint .' }) });
  const p = planFor(dir);
  assert.ok(p.limitations.some((l) => /a project npm configuration exists \(\.npmrc\) and is never read \(secret pattern\); npm itself may still read it for settings that are not pinned \(for example workspace selection\)/.test(l)));
  assert.ok(!p.limitations.some((l) => /script-shell are outside/.test(l)), 'the stale wording is gone');
  const notes = p.executionNotes.join('\n');
  assert.match(notes, /pinned and bound: the script shell/);
  assert.match(notes, /not pinned: workspace selection/);
  assert.match(notes, /not bound: a user-level \.npmrc, a global \.npmrc, NODE_OPTIONS and the rest of the inherited environment/);
  assert.deepEqual(p.executionNotes, [...NPM_EXECUTION_NOTES]);
  const clean = planFor(project({ ...BASE, 'package.json': PKG({ lint: 'eslint .' }) }));
  assert.equal(clean.confidence, p.confidence, 'standing notes do not change confidence');
});

test('F5 the README states the same limits', () => {
  const readme = fs.readFileSync(path.join(TOOLS_ROOT, 'automation', 'README.md'), 'utf8');
  assert.match(readme, /script shell is pinned and bound/i);
  assert.match(readme, /workspace selection/i);
  assert.match(readme, /user-level `\.npmrc`/);
  assert.match(readme, /global `\.npmrc`/);
  assert.match(readme, /`NODE_OPTIONS`/);
  assert.match(readme, /env-assignment/);
});
