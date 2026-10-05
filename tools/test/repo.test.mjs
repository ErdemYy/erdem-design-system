import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildProjectGraph } from '../lib/pipeline.mjs';
import { TOOL, SCHEMA } from '../lib/constants.mjs';
import { listAdapters } from '../lib/languages/registry.mjs';
import { TOOLS_ROOT } from './helpers.mjs';

const pkg = JSON.parse(fs.readFileSync(path.join(TOOLS_ROOT, 'package.json'), 'utf8'));

test('no third-party dependencies: the manifest declares none and every import is relative or node:', () => {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(pkg[field], undefined, `${field} must not exist`);
  }
  const { graph } = buildProjectGraph(TOOLS_ROOT, { overrides: { ignore: ['test/fixtures/'] } });
  const externals = graph.nodes.filter((n) => n.type === 'external').map((n) => n.metadata.package);
  assert.ok(externals.length > 0);
  assert.deepEqual(externals.filter((e) => !e.startsWith('node:')), [], 'only Node built-ins may be imported');
});

test('every relative import inside the tools resolves (the tool indexes itself)', () => {
  const { graph, diagnostics, scan } = buildProjectGraph(TOOLS_ROOT, { overrides: { ignore: ['test/fixtures/'] } });
  const problems = [...diagnostics, ...scan.diagnostics].filter((d) => d.code === 'unresolved-import' || (d.severity === 'error' && d.parser === 'javascript'));
  assert.deepEqual(problems, []);
  assert.deepEqual(graph.cycles, [], 'the tools themselves have no dependency cycles');
});

test('versions and schemas are consistent', () => {
  assert.equal(pkg.version, TOOL.version);
  assert.deepEqual(SCHEMA, { index: 1, summary: 1, graph: 1, fingerprint: 1, cache: 1, report: 1 });
  for (const f of ['graph/schema/graph.schema.v1.json', 'index/schema/index.schema.v1.json', 'index/schema/summary.schema.v1.json', 'lib/schemas/fingerprint.schema.v1.json']) {
    const s = JSON.parse(fs.readFileSync(path.join(TOOLS_ROOT, f), 'utf8'));
    assert.ok(s.$id.endsWith('.v1'), f);
  }
});

test('language adapters: JavaScript/TypeScript implemented, generic fallback, planned languages are not faked', () => {
  const ids = listAdapters().map((a) => a.id);
  assert.deepEqual(ids, ['javascript', 'generic']);
  const covered = listAdapters().flatMap((a) => a.languages);
  for (const planned of ['python', 'dart', 'java', 'csharp']) assert.ok(!covered.includes(planned), `${planned} must not claim support yet`);
});

test('static checks pass (syntax of every module)', () => {
  const r = spawnSync(process.execPath, [path.join(TOOLS_ROOT, 'scripts/check.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('no generated project index lives inside the design-system repository', () => {
  const repoRoot = path.resolve(TOOLS_ROOT, '..');
  const offenders = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '.ai') offenders.push(abs);
        walk(abs);
      } else if (/^(AI_INDEX|FILE_INDEX|DIRECTORY_INDEX)\.md$/.test(ent.name) && !abs.includes(`${path.sep}templates${path.sep}`)) offenders.push(abs);
    }
  })(repoRoot);
  assert.deepEqual(offenders, []);
});
