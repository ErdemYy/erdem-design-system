import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runIndex, runStatus } from '../lib/pipeline.mjs';
import { validate } from '../lib/jsonschema.mjs';
import { parseFrontMatter } from '../index/render.mjs';
import { cleanup, copyFixture, listTree, makeTree, readAll, TOOLS_ROOT, validateDot, validateMermaid } from './helpers.mjs';

after(cleanup);

const schemaOf = (rel) => JSON.parse(fs.readFileSync(path.join(TOOLS_ROOT, rel), 'utf8'));
const stateOf = (dir, p) => runStatus(dir).status.artifacts.find((a) => a.path === p)?.state;
const full = (dir) => runIndex(dir, { profile: 'full' });

test('index writes only inside the output directory and leaves source untouched', () => {
  const dir = copyFixture('app');
  const before = listTree(dir);
  const beforeContent = new Map(before.map((p) => [p, fs.readFileSync(path.join(dir, p), 'utf8')]));
  full(dir);
  const after_ = listTree(dir);
  const added = after_.filter((p) => !before.includes(p));
  assert.ok(added.length > 5);
  assert.ok(added.every((p) => p.startsWith('.ai/')), `unexpected writes outside .ai: ${added.filter((p) => !p.startsWith('.ai/'))}`);
  for (const [p, text] of beforeContent) assert.equal(fs.readFileSync(path.join(dir, p), 'utf8'), text, `${p} must not change`);
});

test('all artifacts for the full profile exist and conform to their schemas', () => {
  const dir = copyFixture('app');
  full(dir);
  const files = listTree(path.join(dir, '.ai'));
  for (const f of ['AI_INDEX.md', 'FILE_INDEX.md', 'index.json', 'graph/graph.json', 'graph/graph.mmd', 'graph/graph.dot', 'state/parse-cache.json', 'state/report.json']) {
    assert.ok(files.includes(f), `missing ${f}`);
  }
  const read = (p) => JSON.parse(fs.readFileSync(path.join(dir, '.ai', p), 'utf8'));
  assert.deepEqual(validate(read('index.json'), schemaOf('index/schema/index.schema.v1.json')), []);
  assert.deepEqual(validate(read('graph/graph.json'), schemaOf('graph/schema/graph.schema.v1.json')), []);
  const fpSchema = schemaOf('lib/schemas/fingerprint.schema.v1.json');
  for (const f of read('index.json').files) assert.deepEqual(validate(f.fingerprint, fpSchema), [], f.path);
  const summaries = files.filter((f) => f.startsWith('summaries/') && f.endsWith('.json'));
  assert.ok(summaries.length >= 3);
  for (const s of summaries) assert.deepEqual(validate(read(s), schemaOf('index/schema/summary.schema.v1.json')), [], s);
  for (const f of files.filter((x) => x.endsWith('.mmd'))) assert.deepEqual(validateMermaid(fs.readFileSync(path.join(dir, '.ai', f), 'utf8')), [], f);
  for (const f of files.filter((x) => x.endsWith('.dot'))) assert.deepEqual(validateDot(fs.readFileSync(path.join(dir, '.ai', f), 'utf8')), [], f);
});

test('schema versions are stamped on every machine artifact', () => {
  const dir = copyFixture('app');
  full(dir);
  const read = (p) => JSON.parse(fs.readFileSync(path.join(dir, '.ai', p), 'utf8'));
  assert.equal(read('index.json').schemaVersion, 1);
  assert.equal(read('graph/graph.json').schemaVersion, 1);
  assert.equal(read('state/parse-cache.json').schemaVersion, 1);
  assert.equal(read('state/report.json').schemaVersion, 1);
  assert.equal(read('summaries/files/src/index.ts.json').schemaVersion, 1);
  assert.equal(read('index.json').tool.name, 'project-intel');
  assert.equal(read('index.json').hashAlgo, 'sha256');
  const fm = parseFrontMatter(fs.readFileSync(path.join(dir, '.ai/AI_INDEX.md'), 'utf8'));
  assert.equal(fm.schemaVersion, '1');
  assert.equal(fm.source, 'project-intel 0.1.0');
  assert.equal(fm.generated, 'true');
  assert.match(fm.generatedAt, /^\d{4}-\d\d-\d\dT/);
});

test('AI_INDEX stays concise and references the graph artifacts', () => {
  const dir = copyFixture('app');
  full(dir);
  const text = fs.readFileSync(path.join(dir, '.ai/AI_INDEX.md'), 'utf8');
  assert.ok(text.split('\n').length < 120, `AI_INDEX has ${text.split('\n').length} lines`);
  for (const section of ['## Identity', '## Architecture overview', '## Important directories', '## Important files', '## Entry points', '## Generated and ignored areas', '## Derived artifacts', '## Index metadata']) {
    assert.ok(text.includes(section), `missing ${section}`);
  }
  assert.ok(text.includes('.ai/graph/graph.json') && text.includes('.ai/graph/graph.mmd') && text.includes('.ai/graph/graph.dot'));
  assert.ok(text.includes('src/index.ts'));
  assert.ok(!text.includes('src/lazy.ts'), 'unimportant files are not listed');
  assert.ok(!text.includes('Not read by default (present): `.ai/`'), 'the output directory itself is not reported as an ignored area');
  assert.ok(!text.includes('SUPERSECRET'));
});

test('indexes are selective: directory indexes only for meaningful directories, file index only for important files', () => {
  const dir = copyFixture('app');
  full(dir);
  const files = listTree(path.join(dir, '.ai'));
  const dirIndexes = files.filter((f) => f.endsWith('DIRECTORY_INDEX.md'));
  assert.deepEqual(dirIndexes, ['directories/src/DIRECTORY_INDEX.md', 'directories/src/cycle/DIRECTORY_INDEX.md']);
  const fileIndex = fs.readFileSync(path.join(dir, '.ai/FILE_INDEX.md'), 'utf8');
  const rows = fileIndex.split('\n').filter((l) => l.startsWith('| `'));
  assert.ok(rows.length > 0 && rows.length < 10, `${rows.length} rows`);
  assert.ok(!fileIndex.includes('src/lazy.ts'));
  const idx = fs.readFileSync(path.join(dir, '.ai/directories/src/DIRECTORY_INDEX.md'), 'utf8');
  for (const s of ['## Purpose', '## Important files', '## Entry points', '## Responsibilities', '## Dependencies', '## Consumers', '## Related docs', '## Graph view']) assert.ok(idx.includes(s), s);
  assert.ok(idx.includes('.ai/graph/views/subsystem-'));
});

test('profiles gate the optional artifacts', () => {
  const dir = copyFixture('app');
  runIndex(dir, { profile: 'lite' });
  let files = listTree(path.join(dir, '.ai'));
  assert.ok(files.includes('AI_INDEX.md'));
  assert.ok(!files.some((f) => f.includes('DIRECTORY_INDEX') || f.startsWith('summaries/') || f === 'FILE_INDEX.md'));
  runIndex(dir, { profile: 'standard' });
  files = listTree(path.join(dir, '.ai'));
  assert.ok(files.some((f) => f.includes('DIRECTORY_INDEX')));
  assert.ok(!files.some((f) => f.startsWith('summaries/')));
  runIndex(dir, { profile: 'full' });
  files = listTree(path.join(dir, '.ai'));
  assert.ok(files.some((f) => f.startsWith('summaries/')));
  const r = runIndex(dir, { profile: 'lite' });
  files = listTree(path.join(dir, '.ai'));
  assert.ok(!files.some((f) => f.includes('DIRECTORY_INDEX') || f.startsWith('summaries/') || f === 'FILE_INDEX.md'), 'artifacts of a higher profile are removed');
  assert.ok(r.report.removed.length > 0);
  const auto = runIndex(dir, {});
  assert.equal(auto.report.profile, 'lite', 'a small project gets the light profile');
  const none = runIndex(dir, { profile: 'none' });
  assert.ok(!listTree(path.join(dir, '.ai')).includes('AI_INDEX.md'));
  assert.equal(none.report.profile, 'none');
});

test('summaries are concise, volatile fields are marked, and no implementation is copied', () => {
  const dir = copyFixture('app');
  full(dir);
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.ai/summaries/files/src/index.ts.json'), 'utf8'));
  assert.equal(s.path, 'src/index.ts');
  assert.equal(s.scope, 'file');
  assert.equal(s.purpose, 'Entry module of the fixture app.');
  assert.deepEqual(s.volatileFields, ['architecturalRole', 'dependencies', 'consumers', 'constraints', 'risks']);
  assert.equal(s.fingerprint.algo, 'sha256');
  assert.match(s.notice, /never authoritative/);
  const source = fs.readFileSync(path.join(dir, 'src/index.ts'), 'utf8');
  for (const line of source.split('\n').filter((l) => l.trim().length > 25)) assert.ok(!JSON.stringify(s).includes(line.trim()), `summary copies source: ${line}`);
  const d = JSON.parse(fs.readFileSync(path.join(dir, '.ai/summaries/directories/src.json'), 'utf8'));
  assert.equal(d.scope, 'directory');
  assert.match(d.fingerprint.hash, /^[0-9a-f]{64}$/);
  assert.ok(d.fingerprint.count > 5);
});

test('deterministic and idempotent: a second run rewrites nothing', () => {
  const dir = copyFixture('app');
  full(dir);
  const snapshot = new Map(listTree(path.join(dir, '.ai')).map((f) => [f, fs.readFileSync(path.join(dir, '.ai', f), 'utf8')]));
  const second = full(dir);
  assert.deepEqual(second.report.counts, { created: 0, updated: 0, unchanged: second.report.counts.unchanged });
  assert.equal(second.report.counts.created + second.report.counts.updated, 0);
  for (const [f, text] of snapshot) assert.equal(fs.readFileSync(path.join(dir, '.ai', f), 'utf8'), text, `${f} bytes must be identical, timestamps included`);
});

test('two checkouts of the same source produce identical artifacts apart from timestamps', () => {
  const a = copyFixture('app');
  const b = copyFixture('app');
  full(a);
  full(b);
  const strip = (t) => t.replace(/("?generatedAt"?\s*:\s*)"?[0-9T:.\-+Z]*"?/g, '$1<ts>').replace(/"mtime": "[^"]*"/g, '"mtime": "<mtime>"');
  const fa = listTree(path.join(a, '.ai'));
  assert.deepEqual(fa, listTree(path.join(b, '.ai')));
  for (const f of fa) assert.equal(strip(fs.readFileSync(path.join(a, '.ai', f), 'utf8')), strip(fs.readFileSync(path.join(b, '.ai', f), 'utf8')), f);
});

test('incremental: only changed files are re-parsed; unchanged derived data is reused', () => {
  const dir = copyFixture('app');
  const first = full(dir);
  assert.equal(first.scan.stats.parsedCached, 0);
  assert.ok(first.scan.stats.parsedFresh > 10);
  const second = full(dir);
  assert.equal(second.scan.stats.parsedFresh, 0);
  assert.equal(second.scan.stats.parsedCached, first.scan.stats.parsedFresh);
  fs.appendFileSync(path.join(dir, 'src/shared/format.ts'), "export const added = 'x';\n");
  const third = full(dir);
  assert.equal(third.scan.stats.parsedFresh, 1);
  assert.ok(third.graph.nodes.find((n) => n.id === 'src/shared/format.ts').exports.includes('added'));
  const changedWrites = Object.entries(third.report.writes).filter(([, s]) => s !== 'unchanged').map(([p]) => p);
  assert.ok(changedWrites.includes('.ai/summaries/files/src/shared/format.ts.json'));
  assert.ok(!changedWrites.includes('.ai/summaries/files/src/index.ts.json'), 'summary of an unrelated file keeps its bytes');
  assert.ok(!changedWrites.includes('.ai/directories/src/cycle/DIRECTORY_INDEX.md'));
});

test('a corrupt or incompatible cache is ignored, never trusted', () => {
  const dir = copyFixture('app');
  full(dir);
  fs.writeFileSync(path.join(dir, '.ai/state/parse-cache.json'), '{ not json');
  fs.writeFileSync(path.join(dir, '.ai/index.json'), JSON.stringify({ schema: 'erdem.index', schemaVersion: 99, files: [] }));
  const r = full(dir);
  assert.equal(r.scan.stats.parsedCached, 0);
  assert.ok(r.scan.stats.parsedFresh > 10);
});

test('stale detection: missing, CURRENT, STALE (changed, added, removed, config), UNVERIFIABLE', () => {
  const dir = copyFixture('app');
  assert.equal(stateOf(dir, '.ai/index.json'), 'MISSING');
  full(dir);
  const all = () => runStatus(dir).status;
  assert.equal(all().ok, true);
  assert.equal(all().counts.STALE, 0);
  assert.ok(all().counts.CURRENT >= 10);

  // identity is the hash: CRLF conversion and mtime changes do not make anything stale
  const util = path.join(dir, 'src/shared/format.ts');
  fs.writeFileSync(util, fs.readFileSync(util, 'utf8').replace(/\n/g, '\r\n'));
  fs.utimesSync(util, new Date(2000, 0, 1), new Date(2000, 0, 1));
  assert.equal(all().ok, true, 'line endings and mtime alone are not a change');

  // a real content change
  fs.appendFileSync(util, '// changed\n');
  let s = all();
  assert.equal(s.ok, false);
  assert.deepEqual(s.changes.changed, ['src/shared/format.ts']);
  const byPath = new Map(s.artifacts.map((a) => [a.path, a.state]));
  assert.equal(byPath.get('.ai/summaries/files/src/shared/format.ts.json'), 'STALE');
  assert.equal(byPath.get('.ai/summaries/files/src/index.ts.json'), 'CURRENT', 'untouched summaries stay current');
  assert.equal(byPath.get('.ai/graph/graph.json'), 'STALE');
  assert.equal(byPath.get('.ai/AI_INDEX.md'), 'STALE');
  assert.equal(byPath.get('.ai/directories/src/cycle/DIRECTORY_INDEX.md'), 'CURRENT', 'a directory index is stale only when its own files change');
  assert.equal(byPath.get('.ai/directories/src/DIRECTORY_INDEX.md'), 'STALE');

  // refresh makes it current again
  full(dir);
  assert.equal(all().ok, true);

  // added and removed files
  fs.writeFileSync(path.join(dir, 'src/new.ts'), 'export {}\n');
  s = all();
  assert.equal(s.ok, false);
  assert.deepEqual(s.changes.added, ['src/new.ts']);
  full(dir);
  fs.rmSync(path.join(dir, 'src/lazy.ts'));
  s = all();
  assert.deepEqual(s.changes.removed, ['src/lazy.ts']);
  assert.equal(s.artifacts.find((a) => a.path === '.ai/graph/graph.json').state, 'STALE');
  full(dir);

  // a deleted source of a summary
  fs.rmSync(path.join(dir, 'src/shared/format.ts'));
  s = all();
  assert.equal(s.artifacts.find((a) => a.path === '.ai/summaries/files/src/shared/format.ts.json').state, 'STALE');
  assert.equal(s.artifacts.find((a) => a.path === '.ai/summaries/files/src/shared/format.ts.json').reason, 'removed');
});

test('stale detection: configuration changes make derived artifacts STALE', () => {
  const dir = copyFixture('app');
  full(dir);
  assert.equal(runStatus(dir).status.ok, true);
  fs.writeFileSync(path.join(dir, 'project-intel.config.json'), '{ "graph": { "maxNodes": 7 } }');
  const s = runStatus(dir).status;
  assert.equal(s.artifacts.find((a) => a.path === '.ai/index.json').state, 'STALE');
  assert.equal(s.artifacts.find((a) => a.path === '.ai/graph/graph.json').reason, 'configuration changed');
});

test('UNVERIFIABLE: files that cannot be safely fingerprinted are never reported CURRENT', () => {
  const dir = makeTree({ 'src/big.ts': 'export const x = "' + 'a'.repeat(4000) + '";\n', 'src/small.ts': "import './big';\nexport const s = 1;\n", 'package.json': '{ "name": "u", "main": "src/small.ts" }' });
  const overrides = { maxHashBytes: 2000, maxParseBytes: 1000 };
  fs.writeFileSync(path.join(dir, 'project-intel.config.json'), JSON.stringify(overrides));
  runIndex(dir, { profile: 'full' });
  const s = runStatus(dir).status;
  assert.ok(s.counts.UNVERIFIABLE > 0);
  assert.equal(s.artifacts.find((a) => a.path === '.ai/graph/graph.json').state, 'UNVERIFIABLE');
  assert.equal(s.artifacts.find((a) => a.path === '.ai/AI_INDEX.md').state, 'UNVERIFIABLE');
  assert.equal(s.ok, true, 'unverifiable is a warning, not a failure');
});

test('trustMtime is an opt-in shortcut; status always re-hashes', () => {
  const dir = copyFixture('app');
  fs.writeFileSync(path.join(dir, 'project-intel.config.json'), '{ "trustMtime": true }');
  full(dir);
  const util = path.join(dir, 'src/util.ts');
  const st = fs.statSync(util);
  const same = fs.readFileSync(util, 'utf8').replace('add', 'adx'); // same size, different content
  fs.writeFileSync(util, same);
  fs.utimesSync(util, st.atime, st.mtime);
  const status = runStatus(dir).status;
  assert.equal(status.ok, false, 'the hash decides: identical size and mtime cannot hide a content change');
  assert.deepEqual(status.changes.changed, ['src/util.ts']);
});
