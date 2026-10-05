import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanup, FIXTURES, TOOLS_ROOT, tmpDir } from './helpers.mjs';
import { PROPOSAL_REASONS, shouldAutoRefresh } from '../automation/refresh-decision.mjs';

// Phase 5B.2: a decline is about one proposal reason. The caller holds the list of declined reasons for the
// session; the tool stores nothing.
after(cleanup);

const BIN = path.join(TOOLS_ROOT, 'bin', 'project-intel.mjs');
const cli = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, windowsHide: true });
const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const gitOpts = { skip: !hasGit && 'git is not available' };
const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
const refresh = (dir, extra = []) => cli(['refresh', dir, '--json', ...extra], dir);
const parsed = (r) => JSON.parse(r.stdout);
const touch = (dir) => fs.appendFileSync(path.join(dir, 'src', 'util.ts'), '\nexport const refreshProbe = 1;\n');

const art = (p, kind, state = 'STALE', reason) => ({ path: p, kind, state, ...(reason ? { reason } : {}) });
const base = { intelligenceState: 'stale', staleArtifacts: [art('.ai/graph/graph.json', 'graph')], outputDirExists: true, taskDependencies: ['impact'], trackedDerivedFiles: [], declaredProfile: 'standard', outputDir: '.ai' };
// Two reasons apply at once: the configuration changed and a relied-on file is tracked.
const two = { ...base, staleArtifacts: [art('.ai/graph/graph.json', 'graph', 'STALE', 'configuration changed')], trackedDerivedFiles: ['.ai/graph/graph.json'] };
const summary = (d) => [d.decision, d.reason];

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

test('D1 the same reason is suppressed after a decline, for every proposal reason', () => {
  const idx = { ...base, taskDependencies: ['directory-index'], staleArtifacts: [art('.ai/directories/src/DIRECTORY_INDEX.md', 'directory index')] };
  const inputs = {
    'first-index': { ...base, intelligenceState: 'missing', outputDirExists: false, staleArtifacts: [], taskClass: 'LARGE', searchInsufficient: true },
    'profile-unknown': { ...idx, declaredProfile: null },
    'profile-differs-from-config': { ...idx, configProfile: 'full', declaredProfile: 'lite' },
    'configuration-changed': { ...base, staleArtifacts: [art('.ai/graph/graph.json', 'graph', 'STALE', 'configuration changed')] },
    'vcs-unknown': { ...base, trackedDerivedFiles: null },
    'derived-files-tracked': { ...base, trackedDerivedFiles: ['.ai/graph/graph.json'] },
  };
  assert.deepEqual(Object.keys(inputs).sort(), [...PROPOSAL_REASONS].sort(), 'every proposal reason is covered');
  for (const [reason, input] of Object.entries(inputs)) {
    assert.deepEqual(summary(shouldAutoRefresh(input)), ['PROPOSE_REFRESH', reason], `${reason} is proposed`);
    const again = shouldAutoRefresh({ ...input, declinedReasons: [reason] });
    assert.deepEqual(summary(again), ['NO_REFRESH', 'declined-earlier'], `${reason} is not proposed again`);
    assert.deepEqual(again.detail.suppressed, [reason]);
    assert.equal(again.command, null);
  }
});

test('D2 a different reason is still proposed after a decline', () => {
  assert.deepEqual(summary(shouldAutoRefresh(two)), ['PROPOSE_REFRESH', 'configuration-changed'], 'the first applicable reason is proposed');
  assert.deepEqual(summary(shouldAutoRefresh({ ...two, declinedReasons: ['configuration-changed'] })), ['PROPOSE_REFRESH', 'derived-files-tracked'], 'declining one reason leaves the other open');
  assert.deepEqual(summary(shouldAutoRefresh({ ...two, declinedReasons: ['derived-files-tracked'] })), ['PROPOSE_REFRESH', 'configuration-changed']);
  // a decline for a reason that does not apply changes nothing
  assert.deepEqual(summary(shouldAutoRefresh({ ...two, declinedReasons: ['first-index', 'vcs-unknown', 'profile-unknown'] })), ['PROPOSE_REFRESH', 'configuration-changed']);
  assert.deepEqual(summary(shouldAutoRefresh({ ...base, trackedDerivedFiles: ['.ai/graph/graph.json'], declinedReasons: ['first-index'] })), ['PROPOSE_REFRESH', 'derived-files-tracked']);
});

test('D3 several declined reasons coexist, and a decline never becomes an automatic refresh', () => {
  const both = shouldAutoRefresh({ ...two, declinedReasons: ['configuration-changed', 'derived-files-tracked'] });
  assert.deepEqual(summary(both), ['NO_REFRESH', 'declined-earlier']);
  assert.deepEqual(both.detail.suppressed, ['configuration-changed', 'derived-files-tracked']);
  assert.equal(both.command, null);
  assert.notEqual(both.decision, 'AUTO_REFRESH', 'declining the reason that blocked the refresh does not unblock it');
  assert.deepEqual(summary(shouldAutoRefresh({ ...two, declinedReasons: ['derived-files-tracked', 'configuration-changed', 'first-index'] })), ['NO_REFRESH', 'declined-earlier'], 'order and extra entries do not matter');
  assert.equal(shouldAutoRefresh({ ...base, declinedReasons: [...PROPOSAL_REASONS] }).decision, 'AUTO_REFRESH', 'with no blocking reason, declines change nothing');
});

test('D4 BLOCKED is never suppressed by a decline', () => {
  const all = [...PROPOSAL_REASONS];
  for (const key of ['forced', 'rehash', 'profileChange', 'discardCache', 'configChange', 'cleanup']) {
    const d = shouldAutoRefresh({ ...two, requested: { [key]: true }, declinedReasons: all });
    assert.deepEqual([d.decision, d.level, d.reason], ['BLOCKED', 'A0', 'manual-operation'], key);
  }
  const noDir = shouldAutoRefresh({ ...base, outputDirExists: false, declinedReasons: all });
  assert.equal(noDir.decision, 'BLOCKED');
  assert.equal(shouldAutoRefresh({ ...base, intelligenceState: 'nonsense', declinedReasons: all }).decision, 'BLOCKED');
});

test('D5 session scope: the tool remembers nothing, so the same call without the caller\'s list proposes again', () => {
  const declined = shouldAutoRefresh({ ...two, declinedReasons: ['configuration-changed'] });
  const nextSession = shouldAutoRefresh(two);
  assert.deepEqual(summary(declined), ['PROPOSE_REFRESH', 'derived-files-tracked']);
  assert.deepEqual(summary(nextSession), ['PROPOSE_REFRESH', 'configuration-changed'], 'a new session starts with no declined reasons');
  for (let n = 0; n < 5; n++) assert.deepEqual(summary(shouldAutoRefresh(two)), summary(nextSession), 'no hidden counter or memory between calls');
  const input = { ...two, declinedReasons: ['configuration-changed'] };
  const frozen = JSON.stringify(input);
  shouldAutoRefresh(input);
  assert.equal(JSON.stringify(input), frozen, 'the input is not mutated');
});

test('D6 no persistent state: a declined call writes nothing, and the automation code has no write calls of its own', gitOpts, () => {
  const dir = tmpDir('pi-decline-state-');
  fs.cpSync(path.join(FIXTURES, 'app'), dir, { recursive: true });
  assert.equal(cli(['index', dir], dir).status, 0);
  git(dir, 'init', '-q');
  git(dir, 'add', '.ai/graph/graph.json');
  touch(dir);
  const before = snapshot(dir);
  const home = tmpDir('pi-decline-home-');
  const run = (extra) => spawnSync(process.execPath, [BIN, 'refresh', dir, '--json', '--relies-on', 'impact', ...extra], { encoding: 'utf8', cwd: home, windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home } });
  const first = run([]);
  assert.equal(parsed(first).decision.reason, 'derived-files-tracked');
  const declined = run(['--declined', 'derived-files-tracked']);
  assert.deepEqual(summary(parsed(declined).decision), ['NO_REFRESH', 'declined-earlier']);
  assert.equal(parsed(declined).record.result, 'declined');
  const afterDecline = run([]);
  assert.equal(parsed(afterDecline).decision.reason, 'derived-files-tracked', 'a later call without the flag proposes again: nothing was remembered');
  assert.deepEqual(snapshot(dir), before, 'the project is unchanged');
  assert.deepEqual(fs.readdirSync(home), [], 'nothing was written to the working directory, home or temp location');
  const code = ['refresh.mjs', 'refresh-decision.mjs'].map((f) => fs.readFileSync(path.join(TOOLS_ROOT, 'automation', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).join('\n');
  assert.ok(!/writeFile|appendFile|createWriteStream|mkdirSync|localStorage/.test(code), 'the automation code has no file-writing calls apart from the engine it invokes');
});

test('D7 end to end: declining one reason leaves the other open; unknown reasons are usage errors', gitOpts, () => {
  const dir = tmpDir('pi-decline-e2e-');
  fs.cpSync(path.join(FIXTURES, 'app'), dir, { recursive: true });
  const custom = path.join(tmpDir('pi-cfg-'), 'c.json');
  fs.writeFileSync(custom, JSON.stringify({ ignore: ['src/beta/'] }));
  assert.equal(cli(['index', dir, '--config', custom], dir).status, 0);
  git(dir, 'init', '-q');
  git(dir, 'add', '.ai/graph/graph.json');
  touch(dir);
  const before = snapshot(dir);
  // no --config: the configuration differs from the one that produced the artifacts, and the graph is tracked
  const reasonsOf = (declined) => parsed(refresh(dir, ['--relies-on', 'impact', ...(declined ? ['--declined', declined] : [])])).decision;
  assert.equal(reasonsOf().reason, 'configuration-changed');
  assert.equal(reasonsOf('configuration-changed').reason, 'derived-files-tracked', 'the other reason is still proposed');
  assert.equal(reasonsOf('derived-files-tracked').reason, 'configuration-changed');
  const all = reasonsOf('configuration-changed,derived-files-tracked');
  assert.deepEqual([all.decision, all.reason], ['NO_REFRESH', 'declined-earlier']);
  assert.deepEqual(snapshot(dir), before);
  const bad = refresh(dir, ['--relies-on', 'impact', '--declined', 'because-i-said-so']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown --declined reason/);
  const bare = refresh(dir, ['--relies-on', 'impact', '--declined']);
  assert.equal(bare.status, 2, 'a bare --declined names no reason and is an error');
});
