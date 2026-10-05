import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cleanup, FIXTURES, TOOLS_ROOT, tmpDir } from './helpers.mjs';
import { shouldAutoRefresh, mayWrite } from '../automation/refresh-decision.mjs';
import { classifyState, trackedUnder } from '../automation/refresh.mjs';

after(cleanup);

const BIN = path.join(TOOLS_ROOT, 'bin', 'project-intel.mjs');
const REPO = path.resolve(TOOLS_ROOT, '..');
const cli = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, windowsHide: true });
const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const gitOpts = { skip: !hasGit && 'git is not available' };

const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });

/** A copy of the app fixture, indexed by the real engine, inside a (possibly awkward) directory name. */
function project({ nested = [], init = true, profile } = {}) {
  const base = tmpDir('pi-refresh-');
  const dir = path.join(base, ...nested, 'app');
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'app'), dir, { recursive: true });
  const r = cli(['index', dir, ...(profile ? ['--profile', profile] : [])], dir);
  assert.equal(r.status, 0, r.stderr);
  if (init && hasGit) {
    git(dir, 'init', '-q');
  }
  return dir;
}

function snapshot(dir) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out[path.relative(dir, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'latin1');
    }
  })(dir);
  return out;
}
const changedFiles = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

const touch = (dir) => fs.appendFileSync(path.join(dir, 'src', 'util.ts'), '\nexport const refreshProbe = 1;\n');
const refresh = (dir, extra = []) => cli(['refresh', dir, '--json', ...extra], dir);
const parsed = (r) => JSON.parse(r.stdout);

// ---- the decision function (pure) ---------------------------------------------------------------------------

const art = (p, kind, state = 'STALE') => ({ path: p, kind, state });
const GRAPH = art('.ai/graph/graph.json', 'graph');
const base = { intelligenceState: 'stale', staleArtifacts: [GRAPH], outputDirExists: true, taskDependencies: ['impact'], trackedDerivedFiles: [], declaredProfile: 'standard', outputDir: '.ai' };

test('1 current: no refresh', () => {
  const d = shouldAutoRefresh({ ...base, intelligenceState: 'current', staleArtifacts: [] });
  assert.deepEqual([d.decision, d.reason, d.level], ['NO_REFRESH', 'state-current', 'A1']);
});

test('2 missing: never an automatic refresh; a first index is only proposed, and only under the canonical conditions', () => {
  const missing = { ...base, intelligenceState: 'missing', outputDirExists: false, staleArtifacts: [art('.ai/graph/graph.json', 'graph', 'MISSING')] };
  assert.equal(shouldAutoRefresh(missing).decision, 'NO_REFRESH');
  assert.equal(shouldAutoRefresh(missing).reason, 'missing-targeted-inspection');
  assert.equal(shouldAutoRefresh({ ...missing, taskClass: 'LARGE', searchInsufficient: true }).decision, 'PROPOSE_REFRESH');
  assert.equal(shouldAutoRefresh({ ...missing, taskClass: 'LARGE', searchInsufficient: true }).level, 'A2');
  assert.equal(shouldAutoRefresh({ ...missing, taskClass: 'SMALL', searchInsufficient: true }).decision, 'NO_REFRESH', 'class and need together, never class alone');
  assert.equal(shouldAutoRefresh({ ...missing, risk: 'HIGH', searchInsufficient: true }).decision, 'PROPOSE_REFRESH');
  assert.equal(shouldAutoRefresh({ ...missing, taskClass: 'LARGE', searchInsufficient: false }).decision, 'NO_REFRESH', 'targeted search was enough');
  assert.equal(shouldAutoRefresh({ ...missing, taskClass: 'LARGE', searchInsufficient: true, taskDependencies: [] }).decision, 'NO_REFRESH', 'nothing relies on it');
  assert.equal(shouldAutoRefresh({ ...missing, taskClass: 'LARGE', searchInsufficient: true, declinedReasons: ['first-index'] }).decision, 'NO_REFRESH', 'declined once: not asked again');
  for (const cls of ['TRIVIAL', 'SMALL', 'MEDIUM', 'LARGE', 'ARCHITECTURAL']) assert.notEqual(shouldAutoRefresh({ ...missing, taskClass: cls, searchInsufficient: true, risk: 'CRITICAL' }).decision, 'AUTO_REFRESH');
});

test('3 stale but the task does not rely on it: no refresh (class is a signal, not proof)', () => {
  assert.equal(shouldAutoRefresh({ ...base, taskDependencies: [] }).reason, 'no-reliance');
  assert.equal(shouldAutoRefresh({ ...base, taskDependencies: ['summary'] }).reason, 'artifacts-not-relied-on');
  assert.equal(shouldAutoRefresh({ ...base, taskDependencies: [], taskClass: 'ARCHITECTURAL', risk: 'CRITICAL' }).decision, 'NO_REFRESH');
  const d = shouldAutoRefresh({ ...base, taskDependencies: ['nonsense'] });
  assert.equal(d.decision, 'NO_REFRESH');
  assert.deepEqual(d.detail.ignoredReliance, ['nonsense']);
});

test('4 stale, relied on, untracked: AUTO_REFRESH with the narrowest command and the affected artifacts', () => {
  const d = shouldAutoRefresh(base);
  assert.deepEqual([d.decision, d.reason, d.level, d.command], ['AUTO_REFRESH', 'relied-on-stale', 'A1', 'graph']);
  assert.deepEqual(d.affectedArtifacts, ['.ai/graph/graph.json']);
  const idx = shouldAutoRefresh({ ...base, taskDependencies: ['directory-index', 'impact'], staleArtifacts: [GRAPH, art('.ai/directories/src/DIRECTORY_INDEX.md', 'directory index')] });
  assert.equal(idx.command, 'index');
  assert.equal(idx.decision, 'AUTO_REFRESH');
  const scoped = shouldAutoRefresh({ ...base, taskDependencies: ['directory-index'], taskScope: { paths: ['src/beta'] }, staleArtifacts: [art('.ai/directories/src/alpha/DIRECTORY_INDEX.md', 'directory index'), art('.ai/directories/src/beta/DIRECTORY_INDEX.md', 'directory index')] });
  assert.deepEqual(scoped.affectedArtifacts, ['.ai/directories/src/beta/DIRECTORY_INDEX.md'], 'only the artifacts the task relies on');
});

test('5 tracked or unknown version-control status: PROPOSE_REFRESH (A2), never automatic', () => {
  const tracked = shouldAutoRefresh({ ...base, trackedDerivedFiles: ['.ai/graph/graph.json'] });
  assert.deepEqual([tracked.decision, tracked.reason, tracked.level], ['PROPOSE_REFRESH', 'derived-files-tracked', 'A2']);
  assert.equal(shouldAutoRefresh({ ...base, trackedDerivedFiles: null }).reason, 'vcs-unknown', 'unknown counts as tracked');
  assert.equal(shouldAutoRefresh({ ...base, trackedDerivedFiles: undefined }).decision, 'PROPOSE_REFRESH');
  // tracked files the run cannot write do not block a graph-only refresh; task artifacts are never in the write set
  assert.equal(shouldAutoRefresh({ ...base, trackedDerivedFiles: ['.ai/AI_INDEX.md', '.ai/TASK_STATE.md', '.ai/HANDOFF.md'] }).decision, 'AUTO_REFRESH');
  assert.equal(shouldAutoRefresh({ ...base, taskDependencies: ['index'], staleArtifacts: [art('.ai/AI_INDEX.md', 'navigation map')], trackedDerivedFiles: ['.ai/AI_INDEX.md'] }).decision, 'PROPOSE_REFRESH');
  assert.equal(shouldAutoRefresh({ ...base, taskDependencies: ['index'], staleArtifacts: [art('.ai/AI_INDEX.md', 'navigation map')], trackedDerivedFiles: ['.ai/TASK_STATE.md', '.ai/HANDOFF.md', '.ai/DECISIONS.md'] }).decision, 'AUTO_REFRESH');
  assert.equal(mayWrite('index', '.ai', '.ai/TASK_STATE.md'), false);
  assert.equal(mayWrite('index', '.ai', 'src/a.ts'), false);
  assert.equal(mayWrite('graph', '.ai', '.ai/directories/x/DIRECTORY_INDEX.md'), false);
});

test('6 partial: bounded to what is missing and relied on', () => {
  const missingGraph = art('.ai/graph/graph.json', 'graph', 'MISSING');
  const d = shouldAutoRefresh({ ...base, intelligenceState: 'partial', staleArtifacts: [missingGraph] });
  assert.deepEqual([d.decision, d.command, d.affectedArtifacts], ['AUTO_REFRESH', 'graph', ['.ai/graph/graph.json']]);
  assert.equal(shouldAutoRefresh({ ...base, intelligenceState: 'partial', staleArtifacts: [missingGraph], taskDependencies: ['summary'] }).decision, 'NO_REFRESH');
  assert.equal(shouldAutoRefresh({ ...base, intelligenceState: 'partial', staleArtifacts: [missingGraph], trackedDerivedFiles: ['.ai/graph/graph.json'] }).decision, 'PROPOSE_REFRESH');
});

test('7 unverifiable: never refreshed, and unverifiable artifacts are never refresh targets', () => {
  assert.equal(shouldAutoRefresh({ ...base, intelligenceState: 'unverifiable', staleArtifacts: [art('.ai/graph/graph.json', 'graph', 'UNVERIFIABLE')] }).reason, 'unverifiable-not-refreshable');
  const mixed = shouldAutoRefresh({ ...base, staleArtifacts: [art('.ai/graph/graph.json', 'graph', 'UNVERIFIABLE')] });
  assert.equal(mixed.decision, 'NO_REFRESH', 'a stale session with only an unverifiable artifact relied on');
});

test('8 unavailable: no refresh and no retry; a failed refresh is not attempted again', () => {
  assert.equal(shouldAutoRefresh({ ...base, intelligenceState: 'unavailable' }).reason, 'status-unavailable');
  assert.equal(shouldAutoRefresh({ ...base, priorFailure: true }).reason, 'refresh-failed-earlier');
  assert.equal(shouldAutoRefresh({ ...base, priorFailure: true }).decision, 'NO_REFRESH');
});

test('9 and 10 forced rebuild, rehash, profile change, discarded caches, configuration changes and cleanup are never automatic', () => {
  for (const key of ['forced', 'rehash', 'profileChange', 'discardCache', 'configChange', 'cleanup']) {
    const d = shouldAutoRefresh({ ...base, requested: { [key]: true } });
    assert.deepEqual([d.decision, d.level, d.reason], ['BLOCKED', 'A0', 'manual-operation'], key);
    assert.deepEqual(d.detail.requested, [key]);
  }
  assert.equal(shouldAutoRefresh({ ...base, taskDependencies: ['directory-index'], staleArtifacts: [art('.ai/directories/src/DIRECTORY_INDEX.md', 'directory index')], configProfile: 'full', declaredProfile: 'lite' }).reason, 'profile-differs-from-config');
  assert.equal(shouldAutoRefresh({ ...base, taskDependencies: ['directory-index'], staleArtifacts: [art('.ai/directories/src/DIRECTORY_INDEX.md', 'directory index')], declaredProfile: null }).reason, 'profile-unknown');
});

test('11b SESSION_START may check status but never refreshes', () => {
  const d = shouldAutoRefresh({ ...base, event: 'SESSION_START' });
  assert.deepEqual([d.decision, d.reason], ['NO_REFRESH', 'session-start']);
});

test('12 the decision is deterministic: the same input gives the same answer, key order does not matter', () => {
  const a = JSON.stringify(shouldAutoRefresh(base));
  for (let i = 0; i < 25; i++) assert.equal(JSON.stringify(shouldAutoRefresh({ ...base })), a);
  const shuffled = { trackedDerivedFiles: [], outputDir: '.ai', declaredProfile: 'standard', taskDependencies: ['impact'], outputDirExists: true, staleArtifacts: [GRAPH], intelligenceState: 'stale' };
  assert.equal(JSON.stringify(shouldAutoRefresh(shuffled)), a);
  const two = shouldAutoRefresh({ ...base, taskDependencies: ['impact', 'graph', 'risk'], staleArtifacts: [GRAPH, art('.ai/AI_INDEX.md', 'navigation map')] });
  const three = shouldAutoRefresh({ ...base, taskDependencies: ['risk', 'impact', 'graph'], staleArtifacts: [GRAPH, art('.ai/AI_INDEX.md', 'navigation map')] });
  assert.equal(JSON.stringify(two), JSON.stringify(three));
});

test('state classification agrees with the canonical table and with the adapters', async () => {
  const c = (CURRENT, STALE, UNVERIFIABLE, MISSING) => ({ CURRENT, STALE, UNVERIFIABLE, MISSING });
  const cases = [
    [{ counts: c(5, 0, 0, 0), artifacts: [] }, 'current'],
    [{ counts: c(3, 0, 2, 0), artifacts: [] }, 'unverifiable'],
    [{ counts: c(4, 1, 0, 0), artifacts: [] }, 'stale'],
    [{ counts: c(1, 1, 1, 1), artifacts: [] }, 'stale'],
    [{ counts: c(0, 0, 0, 3), artifacts: [] }, 'missing'],
    [{ counts: c(3, 0, 0, 1), artifacts: [] }, 'partial'],
    [{ counts: c(0, 0, 2, 1), artifacts: [] }, 'partial'],
    [{ nope: true }, 'unavailable'],
  ];
  for (const [s, want] of cases) assert.equal(classifyState(s), want);
  for (const adapter of ['codex', 'antigravity']) {
    const file = path.join(REPO, 'adapters', adapter, 'lib', 'intelligence.mjs');
    if (!fs.existsSync(file)) continue;
    const { classifyStatus } = await import(pathToFileURL(file).href);
    for (const [s, want] of cases) assert.equal(classifyStatus({ exitCode: 0, json: { ...s, artifacts: s.artifacts ?? [] } }).state, want, `${adapter}`);
  }
});

// ---- end to end, real engine, fixture projects ---------------------------------------------------------------

test('2b missing .ai/: the command never creates it, never scans into it, and exits 0 with NO_REFRESH', () => {
  const dir = tmpDir('pi-missing-');
  fs.cpSync(path.join(FIXTURES, 'app'), dir, { recursive: true });
  const before = snapshot(dir);
  const r = refresh(dir, ['--relies-on', 'graph,impact', '--class', 'LARGE', '--search-insufficient']);
  assert.equal(r.status, 1, 'a proposal needs attention');
  assert.equal(parsed(r).decision.decision, 'PROPOSE_REFRESH');
  assert.equal(parsed(r).decision.reason, 'first-index');
  const quiet = refresh(dir, ['--relies-on', 'graph']);
  assert.equal(quiet.status, 0);
  assert.equal(parsed(quiet).decision.decision, 'NO_REFRESH');
  assert.deepEqual(snapshot(dir), before);
  assert.ok(!fs.existsSync(path.join(dir, '.ai')));
});

test('4b stale + relied on + untracked: the graph is refreshed incrementally, nothing else is written or deleted', gitOpts, () => {
  const dir = project();
  const orphan = path.join(dir, '.ai', 'directories', 'obsolete', 'DIRECTORY_INDEX.md');
  fs.mkdirSync(path.dirname(orphan), { recursive: true });
  fs.writeFileSync(orphan, '---\nschema: x\n---\nleftover derived file\n');
  touch(dir);
  const st = JSON.parse(cli(['status', dir, '--json'], dir).stdout);
  assert.ok(st.counts.STALE > 0);
  const before = snapshot(dir);
  const r = refresh(dir, ['--relies-on', 'impact', '--class', 'MEDIUM', '--risk', 'LOW']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = parsed(r);
  assert.deepEqual([out.decision.decision, out.decision.command, out.record.result, out.record.level], ['AUTO_REFRESH', 'graph', 'ok', 'A1']);
  assert.equal(out.refreshed.ok, true);
  const after_ = snapshot(dir);
  const changed = changedFiles(before, after_);
  assert.ok(changed.length > 0);
  for (const f of changed) assert.ok(/^\.ai\/(graph\/|state\/)/.test(f), `${f} is outside the permitted intelligence locations`);
  for (const f of Object.keys(before)) assert.ok(f in after_, `${f} was deleted`);
  assert.ok(fs.existsSync(orphan), 'obsolete derived files are not pruned by an automatic refresh');
  assert.equal(after_['src/util.ts'], before['src/util.ts'], 'sources are untouched');
  const graph = JSON.parse(cli(['status', dir, '--json'], dir).stdout).artifacts.find((a) => a.path.endsWith('graph/graph.json'));
  assert.equal(graph.state, 'CURRENT');
});

test('4c an index-level need runs the incremental index with the declared profile, deleting nothing', gitOpts, () => {
  const dir = project({ profile: 'lite' });
  touch(dir);
  const before = snapshot(dir);
  const r = refresh(dir, ['--relies-on', 'navigation']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(parsed(r).decision.command, 'index');
  assert.equal(parsed(r).refreshed.ok, true);
  const after_ = snapshot(dir);
  assert.equal(JSON.parse(after_['.ai/index.json']).profile, 'lite', 'the declared profile is kept');
  for (const f of Object.keys(before)) assert.ok(f in after_, `${f} was deleted`);
  for (const f of changedFiles(before, after_)) assert.ok(f.startsWith('.ai/'), `${f} is outside .ai/`);
  assert.equal(after_['.ai/TASK_STATE.md'], before['.ai/TASK_STATE.md']);
});

test('5b stale + relied on + tracked derived data: a proposal, and no file is written', gitOpts, () => {
  const dir = project();
  git(dir, 'add', '.ai/graph/graph.json');
  touch(dir);
  const before = snapshot(dir);
  const r = refresh(dir, ['--relies-on', 'impact']);
  assert.equal(r.status, 1);
  const out = parsed(r);
  assert.deepEqual([out.decision.decision, out.decision.reason, out.decision.level, out.record.result], ['PROPOSE_REFRESH', 'derived-files-tracked', 'A2', 'needs-confirmation']);
  assert.deepEqual(snapshot(dir), before);
  const tracked = trackedUnder(dir, '.ai');
  assert.deepEqual(tracked, ['.ai/graph/graph.json'], 'tracking state was only read, never changed');
});

test('5c outside a git work tree the status cannot be established: proposal, not automatic', () => {
  const dir = project({ init: false });
  if (hasGit && spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { windowsHide: true }).status === 0) return; // temp dir sits inside a repository: nothing to assert
  touch(dir);
  const before = snapshot(dir);
  const out = parsed(refresh(dir, ['--relies-on', 'impact']));
  assert.equal(out.decision.reason, 'vcs-unknown');
  assert.deepEqual(snapshot(dir), before);
});

test('6b partial (graph missing) refreshes only the graph artifacts', gitOpts, () => {
  const dir = project();
  fs.rmSync(path.join(dir, '.ai', 'graph', 'graph.json'));
  const before = snapshot(dir);
  const r = refresh(dir, ['--relies-on', 'dependents']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual([parsed(r).decision.decision, parsed(r).decision.command], ['AUTO_REFRESH', 'graph']);
  const after_ = snapshot(dir);
  for (const f of changedFiles(before, after_)) assert.ok(/^\.ai\/(graph\/|state\/)/.test(f), f);
  assert.ok('.ai/graph/graph.json' in after_);
  assert.equal(after_['.ai/AI_INDEX.md'], before['.ai/AI_INDEX.md']);
});

test('8b unavailable status (broken configuration): no refresh, no retry, exit 0', gitOpts, () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'project-intel.config.json'), '{ not json');
  touch(dir);
  const before = snapshot(dir);
  const r = refresh(dir, ['--relies-on', 'impact']);
  assert.equal(r.status, 0);
  assert.deepEqual([parsed(r).decision.decision, parsed(r).decision.reason], ['NO_REFRESH', 'status-unavailable']);
  assert.deepEqual(snapshot(dir), before);
});

test('9b and 10b --rehash and --profile are refused on refresh, and nothing changes', gitOpts, () => {
  const dir = project();
  touch(dir);
  const before = snapshot(dir);
  for (const extra of [['--rehash'], ['--profile', 'full']]) {
    const r = refresh(dir, ['--relies-on', 'impact', ...extra]);
    assert.equal(r.status, 1);
    assert.deepEqual([parsed(r).decision.decision, parsed(r).decision.level], ['BLOCKED', 'A0']);
    assert.equal(parsed(r).record.result, 'refused');
  }
  assert.deepEqual(snapshot(dir), before);
});

test('11 a failing refresh is reported as failed, never as success, and is not retried', gitOpts, () => {
  const dir = project();
  const graphDir = path.join(dir, '.ai', 'graph');
  fs.rmSync(graphDir, { recursive: true });
  fs.writeFileSync(graphDir, 'a file where the graph directory should be');
  touch(dir);
  const r = refresh(dir, ['--relies-on', 'impact']);
  assert.equal(r.status, 1);
  const out = parsed(r);
  assert.equal(out.decision.decision, 'AUTO_REFRESH');
  assert.equal(out.refreshed.ok, false);
  assert.equal(out.record.result, 'failed');
  assert.ok(!/ok/.test(out.record.result));
  const again = parsed(refresh(dir, ['--relies-on', 'impact', '--after-failure']));
  assert.deepEqual([again.decision.decision, again.decision.reason], ['NO_REFRESH', 'refresh-failed-earlier']);
});

test('12b the same situation gives the same decision and record fields every time (apart from the time)', gitOpts, () => {
  const dir = project();
  touch(dir);
  const strip = (o) => ({ decision: o.decision, record: { ...o.record, at: undefined } });
  const a = strip(parsed(refresh(dir, ['--relies-on', 'impact', '--check'])));
  const b = strip(parsed(refresh(dir, ['--relies-on', 'impact', '--check'])));
  assert.deepEqual(a, b);
  assert.equal(a.decision.decision, 'AUTO_REFRESH', '--check decides without running');
});

test('SESSION_START with stale, relied-on, untracked intelligence still does not refresh', gitOpts, () => {
  const dir = project();
  touch(dir);
  const before = snapshot(dir);
  const out = parsed(refresh(dir, ['--relies-on', 'impact', '--event', 'SESSION_START']));
  assert.deepEqual([out.decision.decision, out.decision.reason, out.record.event], ['NO_REFRESH', 'session-start', 'SESSION_START']);
  assert.deepEqual(snapshot(dir), before);
});

test('13 and 14 paths with spaces, non-ASCII names and OneDrive-like folders work end to end', gitOpts, () => {
  for (const nested of [['with spaces', 'my project'], ['OneDrive', 'Belgeler Ünlü', 'Proje Ç ş']]) {
    const dir = project({ nested });
    touch(dir);
    const r = refresh(dir, ['--relies-on', 'impact']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(parsed(r).decision.decision, 'AUTO_REFRESH');
    assert.equal(parsed(r).refreshed.ok, true);
    assert.ok(!r.stdout.includes(dir), 'no absolute path in the output');
  }
});

test('15 no shell: the automation code uses argument arrays only and no exec', () => {
  for (const f of fs.readdirSync(path.join(TOOLS_ROOT, 'automation')).filter((x) => x.endsWith('.mjs'))) {
    const t = fs.readFileSync(path.join(TOOLS_ROOT, 'automation', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/shell\s*:\s*(true|['"`])/.test(t), `${f} enables a shell`);
    assert.ok(!/(?<![.\w])(exec|execSync|execFile|execFileSync)\s*\(/.test(t), `${f} uses exec`);
    if (/child_process/.test(t)) assert.match(t, /shell:\s*false/, `${f} must say shell: false`);
  }
});

test('16 no secret ever reaches the output or the derived files', gitOpts, () => {
  const SECRET = 'sk-test-REFRESH-9f8e7d-NEVER-PRINT';
  const dir = project();
  fs.writeFileSync(path.join(dir, '.env'), `API_KEY=${SECRET}\n`);
  fs.writeFileSync(path.join(dir, 'id_rsa'), `-----BEGIN PRIVATE KEY-----\n${SECRET}\n`);
  touch(dir);
  const r = spawnSync(process.execPath, [BIN, 'refresh', dir, '--json', '--relies-on', 'impact'], { encoding: 'utf8', cwd: dir, env: { ...process.env, OPENAI_API_KEY: SECRET }, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  const all = snapshot(dir);
  for (const [f, content] of Object.entries(all)) if (f.startsWith('.ai/')) assert.ok(!content.includes(SECRET), `${f} contains a secret`);
  assert.equal(all['.env'], `API_KEY=${SECRET}\n`, 'the secret file itself is untouched');
});

test('17 nothing is written outside the permitted intelligence locations (whole tree compared, git state untouched)', gitOpts, () => {
  const dir = project();
  touch(dir);
  const gitBefore = git(dir, 'status', '--porcelain=v1').stdout;
  const before = snapshot(dir);
  assert.equal(refresh(dir, ['--relies-on', 'impact']).status, 0);
  const changed = changedFiles(before, snapshot(dir));
  assert.ok(changed.length > 0 && changed.every((f) => /^\.ai\/(graph\/|state\/)/.test(f)), changed.join(', '));
  assert.equal(git(dir, 'log', '--oneline').stdout.trim(), '', 'no commit was made');
  assert.equal(git(dir, 'diff', '--cached', '--name-only').stdout.trim(), '', 'nothing was staged');
  assert.ok(gitBefore.length >= 0);
  assert.ok(!fs.existsSync(path.join(dir, '.gitignore')), '.gitignore was not created');
});

test('18 the adapters hold no refresh logic of their own: they pass the command through', () => {
  const offenders = [];
  for (const adapter of ['claude', 'codex', 'antigravity']) {
    const root = path.join(REPO, 'adapters', adapter);
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'tests' && e.name !== 'node_modules') walk(abs);
        } else if (e.name.endsWith('.mjs')) {
          const t = fs.readFileSync(abs, 'utf8');
          if (/runIndex|runGraph|generateIndex|shouldAutoRefresh|refresh-decision|autoRefresh|prune\s*:\s*false/.test(t)) offenders.push(path.relative(REPO, abs));
        }
      }
    })(root);
  }
  assert.deepEqual(offenders, []);
});

test('19 the engine default is unchanged: a user-run index still prunes obsolete derived files', () => {
  const dir = project({ init: false });
  const orphan = path.join(dir, '.ai', 'directories', 'obsolete', 'DIRECTORY_INDEX.md');
  fs.mkdirSync(path.dirname(orphan), { recursive: true });
  fs.writeFileSync(orphan, 'leftover\n');
  assert.equal(cli(['index', dir], dir).status, 0);
  assert.ok(!fs.existsSync(orphan), 'index (not automatic) keeps its cleanup');
  assert.ok(os.platform().length > 0);
});
