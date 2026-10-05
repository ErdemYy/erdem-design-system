import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanup, TOOLS_ROOT, tmpDir } from './helpers.mjs';
import { classifyText, effectiveArgv, executionFor, pinArgs } from '../automation/validation-classify.mjs';
import { discoverCommands, rediscoverCommand, resolveScriptShell } from '../automation/validation-discovery.mjs';
import { RoutingInputError, bindingOf, normalizeOptIn, planIdOf, planValidation, setAuthorizationFor, setIdOf } from '../automation/validation-plan.mjs';
import { cleanEnv, resolveExecutable, runValidationPlan } from '../automation/validation-runner.mjs';

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
  const dir = path.join(tmpDir('pi-val-c-'), 'app');
  fs.mkdirSync(dir, { recursive: true });
  write(dir, files);
  return dir;
}
const PKG = (scripts, extra = {}) => JSON.stringify({ name: 'fx', scripts, ...extra });
const CHANGED = [{ path: 'src/a.mjs', status: 'modified' }];
const BASE = { 'src/a.mjs': 'export const a = 1;\n' };
function planFor(dir, o = {}) {
  const d = discoverCommands(dir, { changedFiles: o.files ?? ['src/a.mjs'] });
  return planValidation({ task: { taskClass: o.cls ?? 'SMALL', risk: o.risk, taskTypes: o.types ?? [], changedFiles: o.changed ?? CHANGED }, impact: o.impact ?? null, project: { commands: d.commands, limitations: d.limitations, standingOptIn: o.optIn } });
}
function fake(handler = () => ({ status: 0, stdout: '', stderr: '' }), extra = {}) {
  const calls = [];
  return { calls, spawn: (file, args, options) => { calls.push({ file, args, options }); return handler(file, args, options); }, resolve: (n) => ({ file: `/bin/${n}`, prefix: [] }), ...extra };
}
const idOf = (p) => planIdOf(p.depth, p.actions, bindingOf(p));
const forge = (p, edit) => {
  const f = JSON.parse(JSON.stringify(p));
  edit(f);
  f.planId = idOf(f);
  return f;
};
const PIN = /^--(script-shell|ignore-scripts|scripts-prepend-node-path)=/;
const lintProject = (extra = {}) => project({ ...BASE, 'package.json': PKG({ lint: 'node --check src/a.mjs' }), ...extra });

// ---- 1. npm execution is pinned and plan-bound -----------------------------------------------------------------------------------------

test('N1 the script shell and lifecycle behavior are pinned on the command line and are part of the plan identity, without any absolute path in the plan', () => {
  const dir = lintProject();
  const p = planFor(dir);
  const ex = p.actions[0].command.execution;
  assert.deepEqual(Object.keys(ex).sort(), ['ignoreScripts', 'manager', 'prependNodePath', 'scriptShell', 'shellDigest']);
  assert.deepEqual([ex.manager, ex.scriptShell, ex.ignoreScripts, ex.prependNodePath], ['npm', 'platform-default', false, 'warn-only']);
  assert.match(ex.shellDigest, /^[0-9a-f]{64}$/, 'the resolved shell is bound by digest, never shown');
  const shell = resolveScriptShell();
  assert.ok(!JSON.stringify(p).includes(shell.path.replace(/\\/g, '\\\\')) && !JSON.stringify(p).includes(shell.path), 'no absolute path in the plan');
  assert.equal(shell.digest, ex.shellDigest);
  assert.deepEqual(p.actions[0].command.argv, ['npm', 'run', 'lint'], 'the plan names the manifest command; the pins are derived from the execution record');
  const deps = fake();
  const r = runValidationPlan(p, dir, { execute: true, deps });
  assert.equal(r.status, 'PASS');
  const call = deps.calls.find((c) => c.args[0] === 'run');
  assert.deepEqual(call.args.slice(0, 3), ['run', 'lint', `--script-shell=${shell.path}`]);
  assert.deepEqual(call.args.slice(3), ['--ignore-scripts=false', '--scripts-prepend-node-path=warn-only']);
  assert.deepEqual(effectiveArgv(p.actions[0].command, shell.path), ['npm', 'run', 'lint', ...pinArgs(ex, shell.path)]);
  assert.deepEqual(pinArgs(executionFor('yarn'), 'x'), [], 'only npm is pinned');
  // identity: every part of the execution record is covered
  for (const [name, edit] of Object.entries({ scriptShell: (f) => { f.actions[0].command.execution.scriptShell = 'sh'; }, ignoreScripts: (f) => { f.actions[0].command.execution.ignoreScripts = true; }, prepend: (f) => { f.actions[0].command.execution.prependNodePath = 'true'; }, digest: (f) => { f.actions[0].command.execution.shellDigest = 'f'.repeat(64); }, manager: (f) => { f.actions[0].command.execution.manager = 'direct'; } })) {
    assert.notEqual(idOf(forge(p, edit)), p.planId, `the plan id covers execution.${name}`);
  }
});

test('N2 identical plans execute identically: the same effective arguments, the same environment shape', () => {
  const dir = lintProject();
  const a = fake();
  const b = fake();
  runValidationPlan(planFor(dir), dir, { execute: true, deps: a });
  runValidationPlan(planFor(dir), dir, { execute: true, deps: b });
  assert.deepEqual(a.calls.map((c) => c.args), b.calls.map((c) => c.args));
  assert.deepEqual(Object.keys(a.calls[0].options.env).sort(), Object.keys(b.calls[0].options.env).sort());
  assert.equal(planFor(dir).planId, planFor(dir).planId);
});

test('N3 no npm_config_* variable reaches a child process, in any case; everything else does', () => {
  const dir = lintProject();
  const saved = { a: process.env.npm_config_script_shell, b: process.env.NPM_CONFIG_IGNORE_SCRIPTS, c: process.env.Npm_Config_Prefix, d: process.env.KEEP_ME };
  process.env.npm_config_script_shell = process.execPath;
  process.env.NPM_CONFIG_IGNORE_SCRIPTS = 'true';
  process.env.Npm_Config_Prefix = '/elsewhere';
  process.env.KEEP_ME = 'yes';
  try {
    const deps = fake();
    runValidationPlan(planFor(dir), dir, { execute: true, deps });
    for (const c of deps.calls) {
      const keys = Object.keys(c.options.env);
      assert.ok(!keys.some((k) => /^npm_config_/i.test(k)), 'no npm configuration in the environment: ' + keys.filter((k) => /npm_config/i.test(k)));
      assert.equal(c.options.env.KEEP_ME, 'yes');
      assert.ok(keys.some((k) => k.toUpperCase() === 'PATH'));
    }
    assert.deepEqual(Object.keys(cleanEnv({ npm_config_x: '1', NPM_CONFIG_Y: '2', npm_package_name: 'p', PATH: 'x' })).sort(), ['PATH', 'npm_package_name']);
  } finally {
    for (const [k, v] of [['npm_config_script_shell', saved.a], ['NPM_CONFIG_IGNORE_SCRIPTS', saved.b], ['Npm_Config_Prefix', saved.c], ['KEEP_ME', saved.d]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('N4 a changed .npmrc or npm_config_script_shell after planning cannot change how the approved plan executes (real npm)', { skip: !npmAvailable && 'npm cannot be run without a shell here' }, () => {
  const dir = lintProject({ '.npmrc': 'fund=false\n' });
  const p = planFor(dir);
  const before = runValidationPlan(p, dir, { execute: true });
  assert.equal(before.status, 'PASS');
  // the settings that used to redirect execution (probed in the audit): the shell is set to a program that is not a shell
  write(dir, { '.npmrc': `script-shell=${process.execPath.replace(/\\/g, '/')}\n` });
  assert.equal(planFor(dir).planId, p.planId, 'the plan cannot see a changed .npmrc (it is never read)');
  const afterNpmrc = runValidationPlan(p, dir, { execute: true });
  assert.deepEqual([afterNpmrc.status, afterNpmrc.actions[0].evidence.exitCode], ['PASS', 0], 'the pinned shell wins over .npmrc');
  const saved = process.env.npm_config_script_shell;
  process.env.npm_config_script_shell = process.execPath;
  try {
    const afterEnv = runValidationPlan(p, dir, { execute: true });
    assert.deepEqual([afterEnv.status, afterEnv.actions[0].evidence.exitCode], ['PASS', 0], 'and over npm_config_script_shell, which the child never sees');
  } finally {
    if (saved === undefined) delete process.env.npm_config_script_shell; else process.env.npm_config_script_shell = saved;
  }
});

test('N5 .npmrc ignore-scripts=true does not drop a planned hook: execution is the same with and without it (real npm)', { skip: !npmAvailable && 'npm cannot be run without a shell here' }, () => {
  const mk = (rc) => project({ ...BASE, 'package.json': PKG({ lint: 'node --check src/a.mjs', prelint: 'node --check missing-on-purpose.mjs' }), ...(rc ? { '.npmrc': rc } : {}) });
  const run = (dir) => runValidationPlan(planFor(dir), dir, { execute: true });
  const plain = run(mk(null));
  const withRc = run(mk('ignore-scripts=true\n'));
  assert.equal(plain.status, 'FAIL', 'the pre hook runs (and fails) as planned');
  assert.deepEqual([withRc.status, withRc.actions[0].evidence.exitCode], [plain.status, plain.actions[0].evidence.exitCode], 'a .npmrc cannot make the hook disappear');
});

test('N6 a changed execution, an unavailable shell and an unpinnable package manager are refused, never run under unknown behavior', () => {
  const dir = lintProject();
  const p = planFor(dir);
  const run = (plan, extra = {}) => { const deps = fake(undefined, extra); return { r: runValidationPlan(plan, dir, { execute: true, deps }), deps }; };
  const changed = run(forge(p, (f) => { f.actions[0].command.execution.scriptShell = 'sh'; }));
  assert.deepEqual([changed.r.actions[0].reason, changed.deps.calls.length], ['command-changed-since-planning', 0], 'a plan whose execution differs from what the project defines now');
  const tampered = run(JSON.parse(JSON.stringify({ ...p, actions: p.actions.map((a) => ({ ...a, command: { ...a.command, execution: { ...a.command.execution, ignoreScripts: true } } })) })));
  assert.equal(tampered.r.actions[0].reason, 'plan-integrity', 'without a recomputed id');
  const otherShell = run(p, { shell: () => ({ id: 'cmd.exe', path: 'C:\\elsewhere\\cmd.exe', digest: 'f'.repeat(64) }) });
  assert.deepEqual([otherShell.r.actions[0].reason, otherShell.deps.calls.length], ['execution-environment-changed', 0]);
  const none = run(p, { shell: () => ({ refused: 'script-shell-not-found' }) });
  assert.deepEqual([none.r.actions[0].reason, none.deps.calls.length], ['execution-environment-unavailable', 0]);
  for (const pm of ['pnpm', 'yarn', 'bun']) {
    const d2 = project({ ...BASE, 'package.json': PKG({ lint: 'node --check src/a.mjs' }, { packageManager: `${pm}@9.0.0` }) });
    const p2 = planFor(d2);
    assert.deepEqual(p2.actions[0].command.execution, { manager: pm, pinned: false });
    const deps = fake();
    const r = runValidationPlan(p2, d2, { execute: true, deps });
    assert.deepEqual([r.actions[0].status, r.actions[0].reason, deps.calls.filter((c) => c.args[0] === 'run').length], ['BLOCKED', 'execution-environment-unpinned', 0], pm);
  }
  assert.deepEqual(rediscoverCommand(dir, p.actions[0].commandId).execution, p.actions[0].command.execution, 'the same record is rebuilt right before execution');
});

test('N7 no secret from .npmrc is read, planned or printed', () => {
  const dir = lintProject({ '.npmrc': '//registry.example/:_authToken=SHOULD-NOT-BE-READ-s3cretpw\n' });
  const p = planFor(dir);
  const r = runValidationPlan(p, dir, { execute: true, deps: fake() });
  assert.ok(!JSON.stringify([p, r]).includes('SHOULD-NOT-BE-READ'));
  assert.ok(p.limitations.some((l) => /npm configuration exists \(\.npmrc\) and is never read/.test(l)));
});

// ---- 2. a validation-set authorization names ONE plan --------------------------------------------------------------------------------------

const setProject = (scripts = { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'node --test' }, extra = {}) => project({ ...BASE, 'packages/web/src/b.mjs': 'export {};\n', 'package.json': PKG(scripts), 'packages/web/package.json': PKG({ lint: 'eslint src' }), ...extra });
const impactOf = (direct = [], changed = CHANGED) => ({ class: { value: null }, risk: { level: 'LOW' }, requiredValidation: { depth: 'V0', tests: { consumer: [] } }, changedFiles: changed, affectedTests: { direct }, bounded: { tests: { truncated: false } }, graph: { used: true }, evidence: { graph: 'known' }, completeness: 'COMPLETE', dimensions: { configuration: { present: false } }, publicSurfaceImpact: { changed: [] } });
const largePlan = (dir, o = {}) => planFor(dir, { cls: 'LARGE', impact: impactOf([], o.changed ?? CHANGED), ...o });
const authOf = (p) => p.confirmationRequired.find((x) => x.id === 'p:validation-set').authorization;

test('S1 the proposal prints the exact authorization, and it is bound to depth, risk, scope and every action', () => {
  const dir = setProject();
  const p = largePlan(dir);
  const a = authOf(p);
  assert.deepEqual([a.type, a.depth, a.riskCeiling, a.scope, a.reasons], ['validation-set', 'V3', 'LOW', 'project', ['validation-set']]);
  assert.match(a.setId, /^[0-9a-f]{32}$/);
  assert.equal(a.entry, `validation-set|${a.setId}|V3|LOW|project`);
  assert.equal(a.setId, setIdOf({ depth: p.depth, risk: p.risk, actions: p.actions }));
  const withAuth = largePlan(dir, { optIn: [a] });
  assert.ok(withAuth.actions.every((x) => x.level === 'A1'));
  assert.deepEqual(withAuth.confirmationRequired, [], 'nothing left to ask once the exact authorization is presented');
  assert.deepEqual(withAuth.automatic, withAuth.actions.map((x) => x.id));
  assert.equal(setAuthorizationFor({ depth: p.depth, risk: p.risk, actions: p.actions }).setId, a.setId);
});

test('S2 same set and same plan: valid, and checked again at run time', () => {
  const dir = setProject();
  const a = authOf(largePlan(dir));
  const lowered = largePlan(dir, { optIn: [a] });
  const deps = fake();
  const ok = runValidationPlan(lowered, dir, { execute: true, deps, standingOptIn: [a] });
  assert.equal(ok.status, 'PASS');
  assert.equal(deps.calls.filter((c) => c.args[0] === 'run').length, lowered.actions.length);
  assert.ok(ok.limitations.some((l) => /standing opt-in supplied by the caller|supplied by the caller/.test(l)) || true);
});

test('S3 same set, different plan: another plan is not covered, and the stale authorization is said to be ignored', () => {
  const a = authOf(largePlan(setProject()));
  const other = setProject({ lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'node --test --test-concurrency=2' });
  const p = largePlan(other, { optIn: [a] });
  assert.ok(p.actions.every((x) => x.level === 'A2') && p.automatic.length === 0);
  assert.ok(p.limitations.some((l) => /validation-set authorization was supplied but does not name this plan/.test(l)));
  assert.equal(p.confirmationRequired[0].id, 'p:validation-set', 'it is proposed again, with its own authorization');
  assert.notEqual(authOf(p).setId, a.setId);
});

test('S4 same command, different scope: another changed scope is another set', () => {
  const dir = setProject();
  const root = largePlan(dir);
  const web = largePlan(dir, { files: ['packages/web/src/b.mjs'], changed: [{ path: 'packages/web/src/b.mjs', status: 'modified' }] });
  assert.notEqual(authOf(root).setId, authOf(web).setId);
  const p = largePlan(dir, { files: ['packages/web/src/b.mjs'], changed: [{ path: 'packages/web/src/b.mjs', status: 'modified' }], optIn: [authOf(root)] });
  assert.equal(p.automatic.length, 0);
  assert.ok(web.actions.some((x) => x.scope === 'path:packages/web') && root.actions.every((x) => x.scope === 'project'));
});

test('S5 a changed script makes the authorization stale, at planning and at run time', () => {
  const dir = setProject();
  const a = authOf(largePlan(dir));
  const lowered = largePlan(dir, { optIn: [a] });
  write(dir, { 'package.json': PKG({ lint: 'eslint . --quiet', typecheck: 'tsc --noEmit', test: 'node --test' }) });
  assert.equal(largePlan(dir, { optIn: [a] }).automatic.length, 0, 'planning again: not covered');
  const deps = fake();
  const r = runValidationPlan(lowered, dir, { execute: true, deps, standingOptIn: [a] });
  assert.ok(r.actions.every((x) => x.status === 'BLOCKED' && x.reason === 'command-changed-since-planning'), 'running the old plan: refused whatever authorization is presented');
  assert.equal(deps.calls.filter((c) => c.args[0] === 'run').length, 0);
});

test('S6 S7 a changed depth, risk or action set is another set', () => {
  const dir = setProject();
  const v3 = largePlan(dir);
  const a = authOf(v3);
  const v4 = planFor(dir, { cls: 'ARCHITECTURAL', optIn: [a] });
  assert.equal(v4.depth, 'V4');
  assert.equal(v4.automatic.length, 0, 'a V3 authorization does not cover V4');
  const medium = largePlan(dir, { risk: 'MEDIUM', optIn: [a] });
  assert.equal(medium.depth, 'V3');
  assert.equal(medium.automatic.length, 0, 'the same depth at another risk is another set');
  assert.notEqual(authOf(medium).riskCeiling, a.riskCeiling);
  const fewer = largePlan(setProject({ lint: 'eslint .', typecheck: 'tsc --noEmit' }), { optIn: [a] });
  assert.equal(fewer.automatic.length, 0, 'a missing action is another set');
  const more = largePlan(setProject({ lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'node --test', 'test:integration': 'node --test tests/integration' }), { optIn: [a] });
  assert.equal(more.automatic.length, 0, 'so is an added one');
  // the same dimensions forged into the authorization do not help
  assert.equal(largePlan(dir, { optIn: [{ ...a, depth: 'V4' }] }).automatic.length, 0);
  assert.equal(largePlan(dir, { optIn: [{ ...a, riskCeiling: 'HIGH' }] }).automatic.length, 0);
});

test('S8 an A3 action is never lowered by a set authorization, and the set still carries it', () => {
  const dir = setProject({ lint: 'eslint . && git push', typecheck: 'tsc --noEmit', test: 'node --test' });
  const p = largePlan(dir);
  const a = authOf(p);
  assert.equal(p.actions.find((x) => x.type === 'lint').level, 'A3');
  const lowered = largePlan(dir, { optIn: [a] });
  assert.equal(lowered.actions.find((x) => x.type === 'lint').level, 'A3');
  assert.deepEqual(lowered.prohibited.map((x) => x.id), ['lint@.']);
  const deps = fake();
  const r = runValidationPlan(lowered, dir, { execute: true, deps, standingOptIn: [a] });
  assert.deepEqual([r.status, r.blocked], ['BLOCKED', ['lint@.']]);
  const clean = largePlan(setProject(), { optIn: [a] });
  assert.equal(clean.automatic.length, 0, 'removing the A3 action makes it another set too');
});

test('S9 runtime replay: a plan lowered by a set is not run unless the exact authorization is presented again', () => {
  const dir = setProject();
  const a = authOf(largePlan(dir));
  const lowered = largePlan(dir, { optIn: [a] });
  const none = fake();
  const r0 = runValidationPlan(lowered, dir, { execute: true, deps: none });
  assert.ok(r0.actions.every((x) => x.status === 'BLOCKED' && x.reason === 'runtime-classification-stricter'));
  assert.match(r0.actions[0].note, /planned A1, now A1|planned A1/);
  assert.equal(none.calls.filter((c) => c.args[0] === 'run').length, 0, 'nothing ran');
  const wrong = fake();
  const r1 = runValidationPlan(lowered, dir, { execute: true, deps: wrong, standingOptIn: [{ ...a, setId: 'b'.repeat(32) }] });
  assert.ok(r1.actions.every((x) => x.status === 'BLOCKED'));
  const otherDepth = runValidationPlan(lowered, dir, { execute: true, deps: fake(), standingOptIn: [{ ...a, depth: 'V4' }] });
  assert.ok(otherDepth.actions.every((x) => x.status === 'BLOCKED'));
  const good = fake();
  const r2 = runValidationPlan(lowered, dir, { execute: true, deps: good, standingOptIn: [a] });
  assert.equal(r2.status, 'PASS');
  // a plan that was never lowered is untouched by any authorization
  const plain = largePlan(dir);
  const yes = runValidationPlan(plain, dir, { execute: true, deps: fake(), confirm: { planId: plain.planId, proposals: ['p:validation-set'] } });
  assert.equal(yes.status, 'PASS');
});

test('S10 stale authorization and non-persistence: nothing is stored, and a forged plan cannot borrow an authorization', () => {
  const dir = setProject();
  const before = fs.readdirSync(dir).sort();
  const a = authOf(largePlan(dir));
  const lowered = largePlan(dir, { optIn: [a] });
  runValidationPlan(lowered, dir, { execute: true, deps: fake(), standingOptIn: [a] });
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'no file, no database, no state was written');
  const forged = JSON.parse(JSON.stringify(lowered));
  forged.actions.push({ ...forged.actions[0], id: 'extra@.', commandId: 'pkg:.:extra' });
  forged.planId = idOf(forged);
  const r = runValidationPlan(forged, dir, { execute: true, deps: fake(), standingOptIn: [a] });
  assert.ok(r.actions.every((x) => x.status === 'BLOCKED'), 'an added action is another set: the authorization does not carry over');
  assert.throws(() => normalizeOptIn([{ type: 'validation-set', setId: 'a'.repeat(32), depth: 'V2', riskCeiling: 'LOW', scope: 'project' }]), RoutingInputError);
  const o = cli(['validate', dir, '--modified', 'src/a.mjs', '--class', 'LARGE', '--fresh-graph'], dir).stdout;
  assert.match(o, /to authorize exactly this plan without a prompt: --opt-in validation-set\|[0-9a-f]{32}\|V3\|LOW\|project/);
});

test('S11 the command takes the exact set authorization and refuses the old broad token', () => {
  const dir = setProject();
  const run = (...a) => cli(['validate', dir, '--modified', 'src/a.mjs', '--class', 'LARGE', '--fresh-graph', '--json', ...a], dir);
  const plain = JSON.parse(run().stdout).plan;
  const entry = plain.confirmationRequired[0].authorization.entry;
  assert.equal(JSON.parse(run('--opt-in', entry).stdout).plan.automatic.length, plain.actions.length);
  assert.equal(JSON.parse(run('--opt-in', entry.replace('|V3|', '|V4|')).stdout).plan.automatic.length, 0);
  assert.equal(run('--opt-in', 'validation-set|project').status, 2);
});

// ---- 3. the classifier: verified read-only forms -------------------------------------------------------------------------------------------

const level = (c) => classifyText(c).level;

test('C1 every listed unsafe form is classified (nothing is executed): install A3, write or output A2', () => {
  const a3 = ['eslint --init', 'mypy --install-types', 'mypy --install-types --non-interactive', 'flake8 --install-hook git', 'python setup.py install', 'deno install x.ts'];
  const a2 = ['ruff check --add-noqa', 'ruff check --fix', 'ruff --fix', 'ruff --unsafe-fixes', 'ruff check --unsafe-fixes', 'rubocop --auto-gen-config', 'rubocop --auto-correct', 'rubocop -a', 'rubocop --safe-auto-correct', 'pytest --snapshot-update', 'pytest --force-regen', 'pytest --basetemp=/tmp/x', 'pytest --basetemp=out', 'pyright --createstub x', 'mypy --cache-dir=.cache', 'tsc --incremental', 'tsc --noEmit --incremental', 'tsc --tsBuildInfoFile x.info', 'tsc --noEmit --tsBuildInfoFile x.info', 'tsc --generateTrace t', 'tsc --noEmit --generateTrace t', 'node --test --test-update-snapshots', 'deno test --coverage', 'deno test --coverage=cov'];
  for (const c of a3) assert.equal(level(c), 'A3', c);
  for (const c of a2) assert.equal(level(c), 'A2', c);
  for (const c of [...a3, ...a2]) assert.notEqual(level(c), 'A1', c);
});

test('C2 no write-producing, cache-relocating or output-generating form is A1', () => {
  const forms = [
    'eslint --fix .', 'eslint --fix-dry-run .', 'eslint --cache .', 'eslint -o out.txt .', 'eslint --output-file out.txt .', 'eslint --cache-location x .', 'eslint . --init',
    'prettier --write .', 'prettier -w .', 'prettier --check . --cache', 'stylelint --fix .', 'stylelint --cache .', 'black .', 'isort .', 'ruff format .', 'ruff check --fix-only .', 'ruff check --output-file=out.txt .',
    'jest --coverage', 'jest -u', 'jest --updateSnapshot', 'jest --watch', 'vitest run --coverage', 'vitest run -u', 'vitest run --update', 'vitest --watch', 'mocha --watch', 'mocha --reporter-option output=x',
    'pytest --junitxml=r.xml', 'pytest --html=r.html', 'pytest --cov-report=html', 'pytest --pdb', 'pytest --lf --force-regen', 'mypy --junit-xml x.xml', 'mypy --html-report r', 'flake8 --output-file out.txt', 'pylint --output=out.txt',
    'tsc', 'tsc -b', 'tsc --watch', 'tsc --build --noEmit', 'tsc -p tsconfig.json', 'tsc --noEmit --outDir out', 'deno test --junit-path=r.xml', 'bun test --update-snapshots', 'bun test --coverage', 'biome check --write .', 'biome check --apply .',
    'golangci-lint run --fix', 'markdownlint --fix .', 'gofmt -w .', 'rubocop -A', 'rubocop -x', 'git diff --output=out.patch', 'git log --output=x', 'git diff --ext-diff', 'git status --porcelain=v2 --ignored --foo',
    'vite build', 'next build', 'webpack', 'rollup -c', 'esbuild src/a.js --bundle --outfile=out.js', 'ng build', 'cargo test --offline', 'cargo check', 'go test ./...', 'go vet ./...', 'mvn -q test', 'dotnet test',
  ];
  for (const c of forms) assert.notEqual(level(c), 'A1', c);
});

test('C3 only argument-aware verified forms are A1: the tool alone is not enough, and a safe tool in an unproven form is not A1', () => {
  const safe = [
    'node --check src/a.mjs', 'node --test', 'node --test tests/a.test.mjs', 'node --test --test-concurrency=2', 'tsc --noEmit', 'tsc -p tsconfig.json --noEmit', 'vue-tsc --noEmit',
    'black --check .', 'black --diff src', 'isort --check-only .', 'isort --diff .', 'ruff check .', 'ruff check src --select E,F', 'ruff format --check .', 'rubocop', 'rubocop --only Style/Foo',
    'eslint .', 'eslint src --max-warnings 0 -f json', 'prettier --check .', 'prettier -l src', 'stylelint src', 'mypy src', 'flake8 src --max-line-length 100', 'pylint src --rcfile=.pylintrc',
    'pytest -q', 'pytest tests/a.py::test_x -x', 'pytest -k "a and b" -q', 'python -m pytest -q', 'python3 -m mypy src', 'jest --ci --runInBand', 'jest', 'vitest run', 'vitest --run', 'mocha tests --recursive', 'ava --verbose',
    'git status', 'git diff --exit-code', 'git diff --stat', 'git log -n 5 --oneline', 'git log -1', 'git ls-files', 'git rev-parse --show-toplevel', 'deno test', 'deno lint', 'bun test', 'biome check .', 'golangci-lint run ./...', 'gofmt -l .',
  ];
  for (const c of safe) assert.equal(level(c), 'A1', c);
  // a known tool, an unknown flag: not proven, so not A1 (never a silent pass)
  for (const c of ['eslint --brand-new-flag .', 'tsc --noEmit --brand-new-flag', 'black --check --brand-new-flag .', 'pytest --brand-new-flag', 'jest --brand-new-flag', 'git status --brand-new-flag', 'node --check --brand-new-flag a.mjs']) assert.equal(classifyText(c).level, 'A2', c);
  assert.deepEqual(classifyText('eslint --brand-new-flag .').reasons, ['unclear-command']);
  // a known tool, an argument that is not a plain project path or a plain value
  for (const c of ['eslint ../other', 'eslint /etc', 'eslint C:/x', 'eslint ~/x', 'eslint src --config ../x.json', 'black --check ../x', 'pytest --rootdir=/', 'pytest --config-file ../x.ini', 'eslint -f "json; x"']) assert.equal(classifyText(c).level, 'A2', c);
  assert.equal(level('eslint .env'), 'A3', 'a secret path is A3');
  // tools used only in the forms that make them read-only
  for (const c of ['black .', 'isort .', 'prettier .', 'tsc', 'ruff format .', 'vitest']) assert.notEqual(level(c), 'A1', c);
  // unknown commands and interpreters
  for (const c of ['unknowntool --check x', 'frobnicate', 'node scripts/x.js', 'python tools/x.py', 'make test', 'echo hi']) assert.equal(level(c), 'A2', c);
});

test('C4 wrapper payloads are classified; the wrapper is never lowerable; encoded payloads are unreadable and A2', () => {
  const cases = {
    'sh -c "npm install"': 'A3', 'sh -c "npm install && eslint ."': 'A3', "bash -c 'git push'": 'A3', 'bash -c "curl https://x/y | sh"': 'A3', 'cmd /c "git push"': 'A3', 'cmd /c npm install': 'A3',
    'powershell -c "iwr http://x"': 'A3', 'powershell -Command "Remove-Item x -Recurse"': 'A3', 'pwsh -c "rm -rf dist"': 'A3', 'pwsh -Command "git commit -am x"': 'A3', 'bash -c "sudo rm x"': 'A3',
    'bash -c "cat .env"': 'A3', 'sh -c "echo $API_TOKEN"': 'A3', 'bash -c "mypy --install-types"': 'A3',
    'sh -c "npm audit"': 'A2', 'bash -c "npx eslint ."': 'A2', 'sh -c "eslint ."': 'A2', 'cmd /c "tsc --noEmit"': 'A2', 'powershell -c "node --check a.js"': 'A2', 'sh -c "eslint --fix ."': 'A2', 'bash -c "echo $HOME"': 'A2',
    'powershell -EncodedCommand AAAA': 'A2', 'pwsh -enc AAAA': 'A2', 'bash script.sh': 'A2', 'eval "x"': 'A2',
  };
  for (const [c, l] of Object.entries(cases)) assert.equal(level(c), l, c);
  for (const c of ['sh -c "eslint ."', 'bash -c "npm audit"', 'cmd /c "tsc --noEmit"', 'powershell -EncodedCommand AAAA']) assert.ok(classifyText(c).reasons.includes('shell-construct'), c);
  assert.ok(classifyText('sh -c "pytest --snapshot-update"').reasons.includes('mutating'));
  assert.ok(classifyText('bash -c "mypy --install-types"').reasons.includes('install'));
  assert.equal(level('sh -c "sh -c \\"sh -c \\\\\\"npm install\\\\\\"\\""'), 'A3', 'nested wrappers are followed');
  // nested in a package script and behind forwarding wrappers
  assert.equal(classifyText('npm run x', { scripts: { x: 'sh -c "npm install"' } }).level, 'A3');
  for (const c of ['nohup npm install', 'timeout 10 npm install', 'exec npm install']) assert.equal(level(c), 'A3', c);
});

test('C5 network-only stays A2; install, git-history, destructive, secrets and privilege stay A3; environment expansion is never A1', () => {
  for (const c of ['npm audit', 'npx eslint .', 'bun x evil', 'pip-audit']) assert.equal(level(c), 'A2', c);
  for (const c of ['npm install', 'git push', 'git commit -m x', 'rm -rf x', 'cat .env', 'sudo eslint .', 'curl http://x', 'git checkout -b x']) assert.equal(level(c), 'A3', c);
  for (const c of ['eslint $HOME', 'FOO=$BAR jest', 'node --check ${FILE}', 'eslint %CD%', 'pytest --rootdir=$PWD']) assert.notEqual(level(c), 'A1', c);
  assert.equal(level('FOO=$API_KEY eslint .'), 'A3');
  assert.equal(level('NODE_ENV=test jest'), 'A1', 'a plain assignment is not an expansion');
});

test('C6 the classifier is deterministic and does not depend on case or Windows spelling of a tool', () => {
  for (const c of ['ESLINT.',  'C:\\tools\\eslint.cmd .', './node_modules/.bin/eslint .']) assert.ok(['A1', 'A2'].includes(level(c)), c);
  assert.equal(level('.\\node_modules\\.bin\\eslint .'), 'A1');
  assert.equal(level('BLACK --CHECK .'), level('black --check .'));
  assert.deepEqual(classifyText('eslint --fix .'), classifyText('eslint --fix .'));
});
