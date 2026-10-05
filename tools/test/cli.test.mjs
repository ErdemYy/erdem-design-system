import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanup, copyFixture, TOOLS_ROOT, validateMermaid } from './helpers.mjs';

after(cleanup);

const BIN = path.join(TOOLS_ROOT, 'bin/project-intel.mjs');
const run = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...opts });

test('help, version and adapters', () => {
  const help = run(['help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: project-intel/);
  assert.match(help.stdout, /index \[root\]/);
  assert.equal(run(['version']).stdout.trim(), 'project-intel 0.1.0');
  const adapters = JSON.parse(run(['adapters', '--json']).stdout);
  assert.deepEqual(adapters.map((a) => a.id), ['javascript', 'generic']);
  assert.equal(adapters.find((a) => a.id === 'generic').supportsDependencies, false);
});

test('index then status then impact, as a user would run them', () => {
  const dir = copyFixture('app');
  const idx = run(['index', dir, '--profile', 'full']);
  assert.equal(idx.status, 0, idx.stderr);
  assert.match(idx.stdout, /index full: \d+ files, 18 edges, 1 cycles/);
  assert.ok(fs.existsSync(path.join(dir, '.ai/AI_INDEX.md')));

  const again = run(['index', dir, '--profile', 'full']);
  assert.match(again.stdout, /0 created, 0 updated/);

  const ok = run(['status', dir]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^OK: /);

  fs.appendFileSync(path.join(dir, 'src/shared/format.ts'), '// edit\n');
  const stale = run(['status', dir, '--json']);
  assert.equal(stale.status, 1);
  const parsed = JSON.parse(stale.stdout);
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.changes.changed, ['src/shared/format.ts']);

  const impact = run(['impact', 'src/util.ts', dir]);
  assert.equal(impact.status, 0, impact.stderr);
  assert.match(impact.stdout, /direct dependents \(3\)/);
  assert.match(impact.stdout, /src\/util\.test\.ts/);
  const json = JSON.parse(run(['impact', 'src/util.ts', dir, '--json']).stdout);
  assert.equal(json.found, true);
  assert.deepEqual(json.tests, ['src/util.test.ts']);

  const missing = run(['impact', 'nope.ts', dir]);
  assert.equal(missing.status, 1);
});

test('graph command: default outputs, filtered views, stdout and limits', () => {
  const dir = copyFixture('app');
  const g = run(['graph', dir]);
  assert.equal(g.status, 0, g.stderr);
  for (const f of ['graph.json', 'graph.mmd', 'graph.dot']) assert.ok(fs.existsSync(path.join(dir, '.ai/graph', f)), f);

  const mmd = run(['graph', dir, '--stdout']);
  assert.deepEqual(validateMermaid(mmd.stdout), []);

  const impact = run(['graph', dir, '--view', 'impact', '--target', 'src/util.ts', '--stdout']);
  assert.match(impact.stdout, /Impact of changing: src\/util\.ts/);
  assert.deepEqual(validateMermaid(impact.stdout), []);

  const file = run(['graph', dir, '--view', 'file', '--target', 'src/index.ts', '--depth', '1', '--json']);
  assert.equal(JSON.parse(file.stdout).nodes > 3, true);
  assert.ok(fs.readdirSync(path.join(dir, '.ai/graph/views')).some((f) => f.startsWith('file-')));

  const small = run(['graph', dir, '--max-nodes', '4', '--json']);
  const view = JSON.parse(small.stdout);
  assert.ok(view.nodes <= 4);
  assert.ok(view.truncated);

  const subsystem = run(['graph', dir, '--view', 'subsystem', '--target', 'src/shared', '--stdout']);
  assert.match(subsystem.stdout, /Subsystem: src\/shared/);
});

test('usage and configuration errors exit with code 2 and a clear message', () => {
  const dir = copyFixture('app');
  for (const args of [['wat'], ['index', '--bogus'], ['impact'], ['graph', '--depth', 'x'], ['index', '--profile']]) {
    const r = run(args, { cwd: dir });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^project-intel: /);
  }
  fs.writeFileSync(path.join(dir, 'project-intel.config.json'), '{ "maxHashBytes": "big" }');
  const bad = run(['index', dir]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /maxHashBytes/);
  const badProfile = run(['index', dir, '--profile', 'huge']);
  assert.equal(badProfile.status, 2);
});

test('the default root is the current directory', () => {
  const dir = copyFixture('app');
  const r = run(['status'], { cwd: dir });
  assert.equal(r.status, 1, 'no index yet: artifacts are missing');
  assert.match(r.stdout, /MISSING/);
});
