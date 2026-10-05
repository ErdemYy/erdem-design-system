import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanup, FIXTURES, TOOLS_ROOT, tmpDir } from './helpers.mjs';
import { mayWrite, pathKey, platformIsCaseInsensitive, shouldAutoRefresh } from '../automation/refresh-decision.mjs';
import { trackedUnder } from '../automation/refresh.mjs';

// Phase 5B.1: hardening found by the Phase 5B closure audit. Real engine, fixture projects in temp directories.
after(cleanup);

const BIN = path.join(TOOLS_ROOT, 'bin', 'project-intel.mjs');
const cli = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, windowsHide: true });
const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const gitOpts = { skip: !hasGit && 'git is not available' };
const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
const CI = platformIsCaseInsensitive();

function project({ nested = [], init = true, profile } = {}) {
  const dir = path.join(tmpDir('pi-harden-'), ...nested, 'app');
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'app'), dir, { recursive: true });
  const r = cli(['index', dir, ...(profile ? ['--profile', profile] : [])], dir);
  assert.equal(r.status, 0, r.stderr);
  if (init && hasGit) git(dir, 'init', '-q');
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

const touch = (dir) => fs.appendFileSync(path.join(dir, 'src', 'util.ts'), '\nexport const refreshProbe = 1;\n');
const refresh = (dir, extra = []) => cli(['refresh', dir, '--json', ...extra], dir);
const parsed = (r) => JSON.parse(r.stdout);
const profileOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.ai', 'index.json'), 'utf8')).profile;

const art = (p, kind, state = 'STALE') => ({ path: p, kind, state });
const GRAPH = art('.ai/graph/graph.json', 'graph');
const base = { intelligenceState: 'stale', staleArtifacts: [GRAPH], outputDirExists: true, taskDependencies: ['impact'], trackedDerivedFiles: [], declaredProfile: 'standard', outputDir: '.ai' };

const plantLeftovers = (dir) => {
  const files = ['directories/obsolete/DIRECTORY_INDEX.md', 'summaries/obsolete/old.json', 'graph/views/obsolete.mmd'];
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, '.ai', f)), { recursive: true });
    fs.writeFileSync(path.join(dir, '.ai', f), 'leftover derived file\n');
  }
  return files.map((f) => path.join(dir, '.ai', f));
};

test('B1 tracked-path case: paths that differ only in case are one file on Windows and macOS, two on Linux', () => {
  const pure = (tracked, ci) => shouldAutoRefresh({ ...base, trackedDerivedFiles: tracked, caseInsensitivePaths: ci });
  assert.deepEqual([pure(['.AI/graph/graph.json'], true).decision, pure(['.AI/graph/graph.json'], true).reason], ['PROPOSE_REFRESH', 'derived-files-tracked']);
  assert.equal(pure(['.AI/graph/graph.json'], false).decision, 'AUTO_REFRESH', 'case-sensitive: .AI is another directory');
  assert.equal(pure(['.ai/Graph/GRAPH.json'], true).decision, 'PROPOSE_REFRESH', 'subpath case is folded as well');
  assert.equal(pure(['.ai/Graph/GRAPH.json'], false).decision, 'AUTO_REFRESH');
  assert.equal(pure(['.AI/TASK_STATE.md'], true).decision, 'AUTO_REFRESH', 'task artifacts are never in the write set, in any case');
  assert.equal(pathKey('.AI\\Graph//x/', true), '.ai/graph/x');
  assert.equal(pathKey('.AI\\Graph//x/', false), '.AI/Graph/x');
  assert.equal(pathKey('./.ai/a', true), '.ai/a');
  assert.equal(mayWrite('graph', '.ai', '.AI/GRAPH/graph.json', true), true);
  assert.equal(mayWrite('graph', '.ai', '.AI/GRAPH/graph.json', false), false);
  assert.equal(mayWrite('index', '.ai', '.AI/task_state.md', true), false);
});

test('B1b the exact observed case: git tracks .AI/graph/graph.json while the output directory is .ai', gitOpts, () => {
  const dir = project({ init: false });
  git(dir, 'init', '-q');
  const blob = git(dir, 'hash-object', '-w', path.join(dir, '.ai', 'graph', 'graph.json')).stdout.trim();
  git(dir, 'update-index', '--add', '--cacheinfo', `100644,${blob},.AI/graph/graph.json`);
  assert.ok(git(dir, 'ls-files').stdout.includes('.AI/graph/graph.json'));
  touch(dir);
  const before = snapshot(dir);
  const staged = git(dir, 'diff', '--cached', '--name-only').stdout;
  const r = refresh(dir, ['--relies-on', 'impact']);
  if (CI) {
    assert.equal(r.status, 1);
    assert.deepEqual([parsed(r).decision.decision, parsed(r).decision.reason], ['PROPOSE_REFRESH', 'derived-files-tracked']);
    assert.deepEqual(snapshot(dir), before, 'the tracked file was not rewritten');
    assert.deepEqual(trackedUnder(dir, '.ai'), ['.AI/graph/graph.json'], 'git matched the directory case-insensitively');
  } else {
    assert.equal(parsed(r).decision.decision, 'AUTO_REFRESH', 'a case-sensitive file system treats .AI as another directory');
    assert.deepEqual(trackedUnder(dir, '.ai'), []);
  }
  assert.equal(git(dir, 'diff', '--cached', '--name-only').stdout, staged, 'tracking state is untouched');
});

function customConfigProject() {
  const dir = project({ init: false });
  const custom = path.join(tmpDir('pi-config-'), 'custom.json');
  fs.writeFileSync(custom, JSON.stringify({ ignore: ['src/beta/'] }));
  fs.rmSync(path.join(dir, '.ai'), { recursive: true });
  assert.equal(cli(['index', dir, '--config', custom], dir).status, 0);
  git(dir, 'init', '-q');
  return { dir, custom };
}
const mentionsBeta = (dir) => fs.readFileSync(path.join(dir, '.ai', 'graph', 'graph.json'), 'utf8').includes('src/beta');

test('B2 --config reaches every engine call: the configured exclusion stays excluded and status converges', gitOpts, () => {
  const { dir, custom } = customConfigProject();
  assert.equal(mentionsBeta(dir), false, 'the custom configuration excluded src/beta when the intelligence was produced');
  const statusOf = () => JSON.parse(cli(['status', dir, '--config', custom, '--json'], dir).stdout);
  assert.equal(statusOf().counts.STALE, 0);
  touch(dir);
  assert.ok(statusOf().counts.STALE > 0);
  const r = refresh(dir, ['--config', custom, '--relies-on', 'impact']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual([parsed(r).decision.decision, parsed(r).refreshed.ok], ['AUTO_REFRESH', true]);
  assert.equal(mentionsBeta(dir), false, 'the exclusion survived the automatic refresh');
  assert.equal(statusOf().artifacts.find((a) => a.path.endsWith('graph/graph.json')).state, 'CURRENT', 'status under the same configuration converges');
});

test('B2b without the configuration that produced the intelligence nothing is rewritten, and a missing --config file is an error', gitOpts, () => {
  const { dir } = customConfigProject();
  touch(dir);
  const before = snapshot(dir);
  const r = refresh(dir, ['--relies-on', 'impact']);
  assert.equal(r.status, 1);
  assert.deepEqual([parsed(r).decision.decision, parsed(r).decision.reason, parsed(r).decision.level], ['PROPOSE_REFRESH', 'configuration-changed', 'A2']);
  assert.deepEqual(snapshot(dir), before, 'the default configuration was not used to rewrite anything');
  const missing = refresh(dir, ['--config', path.join(os.tmpdir(), 'no-such-config.json'), '--relies-on', 'impact']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--config file not found/);
  assert.deepEqual(snapshot(dir), before);
});

test('B3 a declined refresh proposal reason is not repeated, for every proposal reason', () => {
  const missing = { ...base, intelligenceState: 'missing', outputDirExists: false, staleArtifacts: [], taskClass: 'LARGE', searchInsufficient: true };
  const idx = { ...base, taskDependencies: ['directory-index'], staleArtifacts: [art('.ai/directories/src/DIRECTORY_INDEX.md', 'directory index')] };
  const cases = [
    ['first-index', missing],
    ['derived-files-tracked', { ...base, trackedDerivedFiles: ['.ai/graph/graph.json'] }],
    ['vcs-unknown', { ...base, trackedDerivedFiles: null }],
    ['profile-unknown', { ...idx, declaredProfile: null }],
    ['profile-differs-from-config', { ...idx, configProfile: 'full', declaredProfile: 'lite' }],
    ['configuration-changed', { ...base, staleArtifacts: [{ ...GRAPH, reason: 'configuration changed' }] }],
  ];
  for (const [reason, input] of cases) {
    const first = shouldAutoRefresh(input);
    assert.deepEqual([first.decision, first.reason], ['PROPOSE_REFRESH', reason], `${reason} is proposed`);
    const again = shouldAutoRefresh({ ...input, declinedReasons: [reason] });
    assert.deepEqual([again.decision, again.reason, again.level, again.command, again.detail.suppressed], ['NO_REFRESH', 'declined-earlier', 'A2', null, [reason]], `${reason} is not repeated`);
  }
  assert.equal(shouldAutoRefresh({ ...base, declinedReasons: ['first-index'] }).decision, 'AUTO_REFRESH', 'nothing was proposed, so nothing is suppressed');
  assert.equal(shouldAutoRefresh({ ...base, declinedReasons: ['first-index'], requested: { rehash: true } }).decision, 'BLOCKED', 'a decline never hides a refusal');
});

test('B3b --declined end to end: first index, tracked derived files, profile mismatch', gitOpts, () => {
  const bare = tmpDir('pi-decline-');
  fs.cpSync(path.join(FIXTURES, 'app'), bare, { recursive: true });
  const args = ['--relies-on', 'graph,impact', '--class', 'LARGE', '--search-insufficient'];
  assert.equal(parsed(refresh(bare, args)).decision.decision, 'PROPOSE_REFRESH');
  const declined = refresh(bare, [...args, '--declined', 'first-index']);
  assert.equal(declined.status, 0, 'a declined proposal is not an attention state');
  assert.deepEqual([parsed(declined).decision.decision, parsed(declined).decision.reason, parsed(declined).record.result], ['NO_REFRESH', 'declined-earlier', 'declined']);
  assert.ok(!fs.existsSync(path.join(bare, '.ai')));

  const dir = project();
  git(dir, 'add', '.ai/graph/graph.json');
  touch(dir);
  const before = snapshot(dir);
  assert.equal(parsed(refresh(dir, ['--relies-on', 'impact'])).decision.reason, 'derived-files-tracked');
  const again = parsed(refresh(dir, ['--relies-on', 'impact', '--declined', 'derived-files-tracked']));
  assert.deepEqual([again.decision.decision, again.decision.reason, again.record.result], ['NO_REFRESH', 'declined-earlier', 'declined']);
  assert.deepEqual(snapshot(dir), before);

  const p = project({ profile: 'lite' });
  fs.writeFileSync(path.join(p, 'project-intel.config.json'), JSON.stringify({ profile: 'full' }));
  touch(p);
  const beforeP = snapshot(p);
  const first = parsed(refresh(p, ['--relies-on', 'navigation']));
  assert.deepEqual([first.decision.decision, first.decision.reason], ['PROPOSE_REFRESH', 'profile-differs-from-config']);
  // changing the profile in the configuration also changes the configuration digest, so two reasons apply: declining
  // one leaves the other open, and both must be declined to silence the proposal
  const second = parsed(refresh(p, ['--relies-on', 'navigation', '--declined', 'profile-differs-from-config']));
  assert.deepEqual([second.decision.decision, second.decision.reason], ['PROPOSE_REFRESH', 'configuration-changed']);
  const third = parsed(refresh(p, ['--relies-on', 'navigation', '--declined', 'profile-differs-from-config,configuration-changed']));
  assert.deepEqual([third.decision.decision, third.decision.reason, third.record.result], ['NO_REFRESH', 'declined-earlier', 'declined']);
  assert.deepEqual(snapshot(p), beforeP);
});

test('B4 automatic INDEX refresh never prunes, and a manual index still does', gitOpts, () => {
  const dir = project({ profile: 'full' });
  const leftovers = plantLeftovers(dir);
  touch(dir);
  const r = refresh(dir, ['--relies-on', 'navigation,directory-index,summary']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual([parsed(r).decision.decision, parsed(r).decision.command, parsed(r).refreshed.ok], ['AUTO_REFRESH', 'index', true], 'this is the index path, not the graph path');
  for (const f of leftovers) assert.ok(fs.existsSync(f), `${path.relative(dir, f)} was pruned by an automatic refresh`);
  touch(dir);
  assert.equal(cli(['index', dir, '--profile', 'full'], dir).status, 0);
  for (const f of leftovers) assert.ok(!fs.existsSync(f), `${path.relative(dir, f)} survived a manual index`);
});

test('B5 profile pinning end to end: a full index stays full although auto-selection would choose lite', gitOpts, () => {
  const dir = project({ profile: 'full' });
  assert.equal(profileOf(dir), 'full');
  touch(dir);
  const r = refresh(dir, ['--relies-on', 'navigation']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual([parsed(r).decision.command, parsed(r).refreshed.ok], ['index', true]);
  assert.equal(profileOf(dir), 'full', 'the declared profile was kept');
  assert.ok(fs.existsSync(path.join(dir, '.ai', 'FILE_INDEX.md')), 'full-profile artifacts are still there');
  touch(dir);
  assert.equal(cli(['index', dir], dir).status, 0);
  assert.equal(profileOf(dir), 'lite', 'control: without pinning the same fixture is re-picked as lite, so the assertion above proves pinning');
});

test('B6 spaces, non-ASCII and OneDrive-like paths also work on the INDEX path, leftovers untouched', gitOpts, () => {
  for (const nested of [['with spaces', 'my project'], ['OneDrive', 'Belgeler Ünlü', 'Proje Ç ş']]) {
    const dir = project({ nested, profile: 'full' });
    const leftovers = plantLeftovers(dir);
    touch(dir);
    const r = refresh(dir, ['--relies-on', 'navigation']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual([parsed(r).decision.command, parsed(r).refreshed.ok], ['index', true]);
    assert.equal(profileOf(dir), 'full');
    assert.ok(leftovers.every((f) => fs.existsSync(f)));
    assert.ok(!r.stdout.includes(dir), 'no absolute path in the output');
  }
});

test('B7 refresh validates its arguments: nothing that changes meaning is silently ignored', () => {
  const dir = tmpDir('pi-args-');
  fs.cpSync(path.join(FIXTURES, 'app'), dir, { recursive: true });
  const bad = (args, pattern) => {
    const r = cli(['refresh', dir, ...args], dir);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, pattern, args.join(' '));
  };
  bad(['--event', 'BOGUS'], /--event must be one of/);
  bad(['--event', 'session_start'], /--event must be one of/);
  bad(['--class', 'HUGE'], /--class must be one of/);
  bad(['--risk', 'SEVERE'], /--risk must be one of/);
  bad(['--relies-on', 'telepathy'], /unknown --relies-on/);
  for (const flag of [['--view', 'impact'], ['--depth', '2'], ['--target', 'src/a.ts'], ['--max-nodes', '5'], ['--include-tests'], ['--include-external'], ['--stdout']]) bad(flag, /do not apply to refresh/);
  bad(['--scope', '../outside'], /project-relative/);
  bad(['--scope', path.resolve(dir)], /project-relative/);
  bad(['--scope', 'C:\\x'], /project-relative/);
  assert.equal(cli(['refresh', dir, 'unexpected', '--relies-on', 'graph'], dir).status, 2);
  for (const event of ['SESSION_START', 'INTELLIGENCE_CHECKED', 'CONTEXT_EXPANDED', 'IMPACT_REQUIRED', 'CHANGE_COMPLETED']) {
    const ok = cli(['refresh', dir, '--event', event, '--check', '--json'], dir);
    assert.equal(ok.status, 0, event);
    assert.equal(JSON.parse(ok.stdout).record.event, event);
  }
  assert.ok(!fs.existsSync(path.join(dir, '.ai')), 'argument errors write nothing');
});

test('B8 every engine call in the automation code is pinned: prune:false on each index call, the configuration on each engine call', () => {
  const src = fs.readFileSync(path.join(TOOLS_ROOT, 'automation', 'refresh.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const indexCalls = [...src.matchAll(/runIndex\(([^;]*)\)\.report/g)].map((m) => m[1]);
  assert.ok(indexCalls.length >= 1);
  for (const c of indexCalls) assert.match(c, /prune:\s*false/, 'every automatic runIndex call passes prune: false');
  assert.ok(!/generateIndex|pruneDirectory/.test(src), 'the automation code never reaches the generator or the pruner directly');
  for (const fn of ['runGraph', 'runIndex', 'runStatus']) for (const m of src.matchAll(new RegExp(`${fn}\\(root, \\{([^}]*)\\}`, 'g'))) assert.match(m[1], /configPath/, `${fn} receives the configuration`);
  assert.equal([...src.matchAll(/loadConfig\(root, \{ configPath \}\)/g)].length, 1);
  assert.match(fs.readFileSync(path.join(TOOLS_ROOT, 'index', 'generate.mjs'), 'utf8'), /prune = true/, 'the default stays destructive for manual runs');
  assert.match(fs.readFileSync(path.join(TOOLS_ROOT, 'lib', 'pipeline.mjs'), 'utf8'), /prune: opts\.prune/);
  assert.ok(!/prune/.test(fs.readFileSync(path.join(TOOLS_ROOT, 'bin', 'project-intel.mjs'), 'utf8')), 'the manual CLI never passes prune');
});
