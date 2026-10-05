import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cleanup, TOOLS_ROOT, tmpDir } from './helpers.mjs';
import { IMPACT_BOUNDS, RoutingInputError, analyzeChangeImpact, normalizeChangeSet } from '../automation/change-impact.mjs';
import { routeContext } from '../automation/context-router.mjs';
import { buildProjectGraph } from '../lib/pipeline.mjs';
import { loadConfig } from '../lib/config.mjs';
import { subsystemOf } from '../lib/subsystem.mjs';

after(cleanup);

const REPO = path.resolve(TOOLS_ROOT, '..');
const BIN = path.join(TOOLS_ROOT, 'bin', 'project-intel.mjs');
const cli = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, windowsHide: true });
const CURRENT = { state: 'current' };

const BASE = {
  'package.json': JSON.stringify({ name: 'hardening-fixture', main: 'src/index.ts' }),
  'src/index.ts': "export * from './features/a';\n",
  'src/core/util.ts': 'export const u = 1;\n',
  'src/core/format.ts': "import { u } from './util';\nexport const f = u;\n",
  'src/features/a.ts': "import { f } from '../core/format';\nexport const a = f;\n",
  'src/features/c.ts': 'export const c = 3;\n',
  'src/lib/p.ts': 'export const p = 1;\n',
  'src/cycle/x.ts': "import { y } from './y';\nexport const x = () => y();\n",
  'src/cycle/y.ts': "import { x } from './x';\nexport const y = () => x();\n",
};

function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}
function project(extra = {}, remove = []) {
  const dir = path.join(tmpDir('pi-impact-h-'), 'app');
  fs.mkdirSync(dir, { recursive: true });
  writeTree(dir, { ...BASE, ...extra });
  for (const r of remove) fs.rmSync(path.join(dir, r));
  return dir;
}
const queryOf = (dir) => buildProjectGraph(dir).query;
const fresh = (dir, change, intel = CURRENT, more = {}) => analyzeChangeImpact(change, intel, { query: queryOf(dir), graphSource: 'fresh-build', ...more });
const mod = (...paths) => ({ files: paths.map((p) => ({ path: p, status: 'modified' })), taskClass: 'SMALL' });
const hub = (n, prefix = 'src/consumers/c') => {
  const out = { 'src/hub/core.ts': 'export const core = 1;\n' };
  for (let i = 0; i < n; i++) out[`${prefix}${String(i).padStart(2, '0')}.ts`] = `import { core } from '../hub/core';\nexport const v${i} = core;\n`;
  return out;
};

// ---- 1 and 14: unknown is not none ----------------------------------------------------------------------------------

const GRAPH_FIELDS = (r) => [r.directImpact.dependents, r.directImpact.dependencies, r.directImpact.tests, r.directImpact.publicSurface, r.transitiveImpact.dependents, r.affectedTests.direct, r.affectedTests.consumer, r.publicSurfaceImpact.changed, r.publicSurfaceImpact.affected, r.publicSurfaceImpact.present, r.cycles.changed, r.cycles.affected, r.cycles.groups, r.subsystemsAffected, r.requiredValidation.tests.direct, r.requiredValidation.tests.consumer];

test('1 14 a graph that was consulted gives known values: empty lists and false are real answers', () => {
  const dir = project();
  for (const [name, r] of [['current artifact', analyzeChangeImpact(mod('src/features/c.ts'), CURRENT, { query: queryOf(dir) })], ['fresh build', fresh(dir, mod('src/features/c.ts'))]]) {
    assert.deepEqual([r.directImpact.dependents, r.directImpact.dependencies, r.directImpact.tests, r.transitiveImpact.dependents, r.affectedTests.direct, r.affectedTests.consumer], [[], [], [], [], [], []], name);
    assert.deepEqual([r.publicSurfaceImpact.present, r.cycles.changed, r.cycles.groups], [false, [], []], name);
    assert.ok(Object.values(r.dimensions).every((d) => d.present === false && d.source === 'none' && Array.isArray(d.evidence)), `${name}: known false`);
    assert.deepEqual([r.completeness, r.confidence, r.evidence.graph, r.evidence.evaluated], ['COMPLETE', 'high', 'known', true], name);
    assert.deepEqual([r.changedFiles[0].known, r.changedFiles[0].publicSurface, r.changedFiles[0].inCycle], [true, false, false], name);
  }
});

test('1 14 stale, missing and unavailable graphs: every graph-derived field is unknown (null), never an empty list or false', () => {
  const dir = project();
  const q = queryOf(dir);
  const change = { files: [{ path: 'src/core/util.ts', status: 'modified' }, { path: 'src/core/format.ts', status: 'deleted' }, { path: 'src/features/c.ts', from: 'src/features/old-c.ts', status: 'renamed' }], taskClass: 'SMALL' };
  for (const [name, intel, query] of [
    ['stale', { state: 'stale' }, q],
    ['stale graph only', { state: 'partial', artifacts: { graph: 'stale' } }, q],
    ['missing', { state: 'missing' }, null],
    ['unavailable', { state: 'unavailable' }, null],
    ['unverifiable', { state: 'unverifiable' }, q],
  ]) {
    const r = analyzeChangeImpact(change, intel, { query });
    assert.deepEqual(GRAPH_FIELDS(r), GRAPH_FIELDS(r).map(() => null), `${name}: all unknown`);
    assert.ok(Object.values(r.dimensions).every((d) => d.present === null && d.source === 'unknown' && d.evidence === null), `${name}: dimensions not evaluated are not false`);
    assert.deepEqual(r.changedFiles.map((c) => [c.known, c.publicSurface, c.publicSurfaceReasons, c.risk, c.inCycle]), change.files.map(() => [null, null, null, null, null]), name);
    assert.deepEqual(r.deletions.map((d) => [d.dependents, d.dependentsTotal]), [[null, null]], `${name}: a deleted file's dependents are unknown`);
    assert.deepEqual(r.renames.map((d) => d.dependents), [null], name);
    assert.deepEqual([r.completeness, r.confidence, r.evidence.graph, r.evidence.evaluated, r.graph.used], ['PARTIAL', 'low', 'unknown', false, false], name);
    assert.deepEqual([r.bounded.directDependents.total, r.bounded.directDependents.truncated, r.bounded.tests.truncated, r.bounded.transitive.depthLimited], [null, null, null, null], `${name}: bounds are unknown too`);
    assert.equal(r.bounded.batchingRequired, false, 'unknown is not "bounded"');
    assert.ok(r.limitations.some((l) => /every graph-derived field is null \(unknown\)/.test(l)), name);
    assert.match(r.evidence.convention, /null = unknown/);
  }
});

test('1 14 a caller\'s signal is known even without a graph, and stays separate from the unknown graph evidence', () => {
  const r = analyzeChangeImpact({ files: [{ path: 'src/core/util.ts', status: 'modified' }], taskClass: 'SMALL', signals: { apiImpact: true, publicSurface: true } }, { state: 'missing' }, {});
  assert.deepEqual([r.dimensions.api.present, r.dimensions.api.source, r.dimensions.api.evidence], [true, 'signal', null]);
  assert.deepEqual([r.dimensions.configuration.present, r.dimensions.configuration.source], [null, 'unknown']);
  assert.deepEqual([r.publicSurfaceImpact.present, r.publicSurfaceImpact.changed, r.publicSurfaceImpact.affected], [true, null, null], 'signalled true; the engine evidence is unknown');
  assert.equal(r.class.value, 'MEDIUM', 'the signalled public surface still sets the canonical floor through the router');
  assert.equal(r.requiredValidation.tests.consumerJustified, true);
  assert.equal(r.requiredValidation.tests.consumer, null, 'but which consumer tests exist is unknown');
  assert.equal(r.directImpact.dependents, null);
});

test('14 the command prints unknown as unknown and the JSON carries null', () => {
  const dir = project();
  const text = cli(['change-impact', dir, '--state', 'missing', '--modified', 'src/core/util.ts', '--class', 'SMALL'], dir).stdout;
  assert.match(text, /direct dependents \(\?\): unknown \(graph not used\)/);
  assert.match(text, /tests: unknown \(graph not used\)/);
  assert.match(text, /public surface: unknown/);
  assert.match(text, /PARTIAL, confidence low/);
  assert.ok(!/dependents \(\d+\): none/.test(text));
  const json = JSON.parse(cli(['change-impact', dir, '--state', 'missing', '--modified', 'src/core/util.ts', '--class', 'SMALL', '--json'], dir).stdout);
  assert.deepEqual([json.directImpact.dependents, json.affectedTests.direct, json.publicSurfaceImpact.present], [null, null, null]);
  assert.ok(!fs.existsSync(path.join(dir, '.ai')), 'nothing was written');
});

test('14 the convention is documented once, in the module and the automation README', () => {
  const readme = fs.readFileSync(path.join(TOOLS_ROOT, 'automation', 'README.md'), 'utf8');
  assert.match(readme, /null.{0,40}unknown/i);
  assert.match(readme, /COMPLETE.*BOUNDED_COMPLETE.*PARTIAL/s);
});

// ---- 2: unclassified is not TRIVIAL ------------------------------------------------------------------------------

test('2 an omitted or null class is unclassified (V1 minimum), never an explicit TRIVIAL (V0)', () => {
  const dir = project();
  const run = (extra) => fresh(dir, { files: [{ path: 'src/features/c.ts', status: 'modified' }], ...extra });
  const omitted = run({});
  const nulled = run({ taskClass: null });
  const trivial = run({ taskClass: 'TRIVIAL' });
  const small = run({ taskClass: 'SMALL' });
  assert.deepEqual([omitted.class.value, nulled.class.value, trivial.class.value, small.class.value], [null, null, 'TRIVIAL', 'SMALL']);
  assert.deepEqual([omitted, nulled, trivial, small].map((r) => r.requiredValidation.depth), ['V1', 'V1', 'V0', 'V1']);
  assert.notEqual(omitted.requiredValidation.depth, trivial.requiredValidation.depth, 'unclassified != explicit TRIVIAL');
  const router = routeContext({ taskClass: null, targets: ['src/features/c.ts'], risk: 'LOW', intent: 'change' }, CURRENT, { reached: 3 });
  assert.equal(omitted.requiredValidation.depth, router.validationNeeds.depth, 'the canonical router decides, not 5D');
  assert.ok(omitted.limitations.some((l) => /no task class was given/.test(l)));
  assert.ok(!trivial.limitations.some((l) => /no task class was given/.test(l)));
  const high = run({ risk: 'HIGH' });
  assert.equal(high.requiredValidation.depth, 'V2', 'unclassified is raised by risk like any class');
});

// ---- 3: renames ----------------------------------------------------------------------------------------------------

test('3 a planned rename: the old path is in the graph and its dependents are the files to update', () => {
  const dir = project();
  const r = fresh(dir, { files: [{ path: 'src/core/fmt.ts', from: 'src/core/format.ts', status: 'renamed' }], phase: 'planned', taskClass: 'SMALL' });
  assert.deepEqual([r.renames[0].dependents, r.renames[0].dependentsSource, r.renames[0].dependentsTotal], [['src/features/a.ts'], 'old-path', 1]);
  assert.match(r.renames[0].note, /import paths updated/);
  assert.equal(r.changedFiles[0].known, true);
  assert.equal(r.changedFiles[0].lookup, undefined);
});

test('3 an applied rename: the old path is gone, the new path is in the graph, and its dependents are reported as such', () => {
  const dir = project({ 'src/core/fmt.ts': BASE['src/core/format.ts'], 'src/features/a.ts': "import { f } from '../core/fmt';\nexport const a = f;\n" }, ['src/core/format.ts']);
  const r = fresh(dir, { files: [{ path: 'src/core/fmt.ts', from: 'src/core/format.ts', status: 'renamed' }], taskClass: 'SMALL' });
  assert.deepEqual([r.renames[0].dependents, r.renames[0].dependentsSource], [['src/features/a.ts'], 'new-path']);
  assert.match(r.renames[0].note, /already applied.*dependents of the new path, not facts about the old one/);
  assert.deepEqual([r.changedFiles[0].known, r.changedFiles[0].lookup], [true, 'new-path']);
  assert.deepEqual(r.directImpact.dependents.map((d) => [d.path, d.via]), [['src/features/a.ts', ['src/core/fmt.ts']]], 'a real graph fact about the new path');
  assert.ok(r.directImpact.dependencies.includes('src/core/util.ts'), 'the new path\'s own dependencies');
  assert.ok(r.limitations.some((l) => /rename is already applied/.test(l)));
  assert.deepEqual(r.inspection, [], 'nothing left to search for');
  assert.notEqual(r.completeness, 'PARTIAL', 'the new path\'s impact is evidence, so the result is not partial');
});

test('3 a rename where neither path is in the graph: unknown dependents, a bounded search, uncertainty', () => {
  const dir = project();
  const r = fresh(dir, { files: [{ path: 'src/core/nowhere.ts', from: 'src/core/ghost.ts', status: 'renamed' }], taskClass: 'SMALL' });
  assert.deepEqual([r.renames[0].dependents, r.renames[0].dependentsTotal, r.changedFiles[0].known], [null, null, false]);
  assert.match(r.renames[0].note, /neither the old nor the new path is in the graph/);
  assert.ok(r.inspection.some((s) => s.target === 'src/core/ghost.ts' && s.op === 'find-consumers'), 'search for the old path');
  assert.deepEqual([r.completeness, r.confidence], ['PARTIAL', 'medium']);
  assert.ok(r.requiredContext.reasons.includes('files-not-in-graph'));
  assert.equal(r.requiredContext.plan.minimumLevel >= 4, true, 'dependency uncertainty deepens the context');
});

test('3 renames inside a cycle terminate, planned and applied', () => {
  const planned = fresh(project(), { files: [{ path: 'src/cycle/x2.ts', from: 'src/cycle/x.ts', status: 'renamed' }], phase: 'planned', taskClass: 'SMALL' });
  assert.deepEqual([planned.renames[0].dependents, planned.renames[0].dependentsSource], [['src/cycle/y.ts'], 'old-path']);
  assert.deepEqual(planned.cycles.changed, ['src/cycle/x2.ts'], 'the changed file is reported under its new path, from the old node');
  const dir = project({ 'src/cycle/x2.ts': "import { y } from './y';\nexport const x = () => y();\n", 'src/cycle/y.ts': "import { x } from './x2';\nexport const y = () => x();\n" }, ['src/cycle/x.ts']);
  const applied = fresh(dir, { files: [{ path: 'src/cycle/x2.ts', from: 'src/cycle/x.ts', status: 'renamed' }], taskClass: 'SMALL' });
  assert.deepEqual([applied.renames[0].dependents, applied.renames[0].dependentsSource], [['src/cycle/y.ts'], 'new-path']);
  assert.deepEqual(applied.cycles.groups, [['src/cycle/x2.ts', 'src/cycle/y.ts']]);
  assert.deepEqual(applied.directImpact.dependents.map((d) => d.path), ['src/cycle/y.ts'], 'listed once; the changed file is not its own dependent');
});

// ---- 4 to 7: boundedness is never silent ----------------------------------------------------------------------------

const shape = (b) => Object.keys(b).sort().join();
const LIST_SHAPE = 'limit,omitted,returned,total,truncated';

test('4 direct dependencies beyond the limit are counted, reported and lower the confidence', () => {
  const f = {};
  let imports = '';
  for (let i = 0; i < 45; i++) {
    f[`src/dep/d${i}.ts`] = `export const d${i} = ${i};\n`;
    imports += `import './d${i}';\n`;
  }
  f['src/dep/many.ts'] = imports;
  const r = fresh(project(f), mod('src/dep/many.ts'));
  assert.equal(r.directImpact.dependencies.length, IMPACT_BOUNDS.dependencies);
  assert.deepEqual(r.bounded.dependencies, { limit: 30, total: 45, returned: 30, omitted: 15, truncated: true });
  assert.ok(r.limitations.some((l) => /15 more direct dependencies are not listed \(limit 30\)/.test(l)));
  assert.deepEqual([r.completeness, r.confidence, r.batching.required], ['BOUNDED_COMPLETE', 'medium', true]);
  assert.ok(r.batching.truncatedLists.includes('dependencies'));
  assert.deepEqual(r.directImpact.dependencies, [...r.directImpact.dependencies].sort(), 'deterministic order');
});

test('4 transitive dependents beyond the limit are counted per subsystem and reported', () => {
  const f = { 'src/hub/core.ts': 'export const core = 1;\n' };
  for (let m = 0; m < 15; m++) {
    f[`src/mid/m${String(m).padStart(2, '0')}.ts`] = "import { core } from '../hub/core';\nexport const m = core;\n";
    for (let l = 0; l < 3; l++) f[`src/leaf/l${String(m).padStart(2, '0')}_${l}.ts`] = `import { m } from '../mid/m${String(m).padStart(2, '0')}';\nexport const l = m;\n`;
  }
  const r = fresh(project(f), mod('src/hub/core.ts'));
  assert.deepEqual(r.bounded.transitive, { ...r.bounded.transitive, limit: 40, total: 45, returned: 40, omitted: 5, truncated: true });
  assert.equal(r.transitiveImpact.dependents.length, 40);
  assert.deepEqual(r.bounded.transitive.remainingBySubsystem, { 'src/leaf': 5 });
  assert.ok(r.limitations.some((l) => /5 more transitive dependent\(s\) are not listed \(limit 40\)/.test(l)));
  assert.ok(r.bounded.truncatedLists.includes('transitive') && r.batching.truncatedLists.includes('transitive'));
});

test('4 7 truncated tests: 26 found, 20 listed, the omission counted, confidence lowered, batching required', () => {
  const f = hub(2);
  for (let i = 0; i < 26; i++) f[`src/t/t${String(i).padStart(2, '0')}.test.ts`] = "import { core } from '../hub/core';\nvoid core;\n";
  const r = fresh(project(f), mod('src/hub/core.ts'));
  assert.deepEqual(r.bounded.tests, { limit: 20, total: 26, returned: 20, omitted: 6, truncated: true, directCount: 26, consumerCount: 0 });
  assert.equal(r.affectedTests.direct.length, 20);
  assert.deepEqual([r.affectedTests.truncated, r.affectedTests.omitted, r.requiredValidation.tests.truncated], [true, 6, true]);
  assert.deepEqual([r.completeness, r.confidence, r.batching.required], ['BOUNDED_COMPLETE', 'medium', true]);
  assert.ok(r.batching.truncatedLists.includes('tests'));
  assert.ok(r.limitations.some((l) => /6 more affected tests are not listed \(limit 20\)/.test(l)));
  const whole = fresh(project({ ...f, ...Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`src/t/t${String(i).padStart(2, '0')}.test.ts`, 'export {};\n'])) }), mod('src/hub/core.ts'));
  assert.deepEqual([whole.bounded.tests.truncated, whole.affectedTests.direct], [false, []]);
});

test('6 dependents of deleted and renamed files are bounded per file and in total, never silently', () => {
  const dir = project(hub(45));
  const del = fresh(dir, { files: [{ path: 'src/hub/core.ts', status: 'deleted' }], phase: 'planned', taskClass: 'MEDIUM' });
  const d = del.deletions[0];
  assert.deepEqual([d.dependents.length, d.dependentsTotal, d.dependentsOmitted], [30, 45, 15]);
  assert.deepEqual(d.dependents, [...d.dependents].sort(), 'order preserved: by path');
  assert.deepEqual(del.bounded.deletedDependents, { limit: 30, total: 45, returned: 30, omitted: 15, truncated: true, files: 1 });
  assert.ok(del.limitations.some((l) => /15 more dependents of deleted files are not listed \(limit 30\)/.test(l)));
  assert.deepEqual([del.batching.required, del.confidence], [true, 'medium']);
  const ren = fresh(dir, { files: [{ path: 'src/hub/core2.ts', from: 'src/hub/core.ts', status: 'renamed' }], phase: 'planned', taskClass: 'MEDIUM' });
  assert.deepEqual([ren.renames[0].dependents.length, ren.renames[0].dependentsTotal, ren.renames[0].dependentsOmitted], [30, 45, 15]);
  assert.equal(ren.bounded.renamedDependents.truncated, true);
  assert.ok(ren.limitations.some((l) => /15 more dependents of renamed files are not listed/.test(l)));
  const small = fresh(project(hub(3)), { files: [{ path: 'src/hub/core.ts', status: 'deleted' }], phase: 'planned', taskClass: 'MEDIUM' });
  assert.deepEqual([small.deletions[0].dependentsOmitted, small.bounded.deletedDependents.truncated], [0, false]);
});

test('4 affected public surfaces beyond the limit are counted and reported', () => {
  const f = { 'package.json': JSON.stringify({ name: 'n', dependencies: { next: '*', react: '*' } }), 'src/hub/core.ts': 'export const core = 1;\n' };
  for (let i = 0; i < 25; i++) f[`app/p${String(i).padStart(2, '0')}/page.tsx`] = "import { core } from '../../src/hub/core';\nexport default function P() { return core; }\n";
  const r = fresh(project(f), mod('src/hub/core.ts'));
  assert.deepEqual(r.bounded.surfaces, { limit: 20, total: 25, returned: 20, omitted: 5, truncated: true });
  assert.equal(r.publicSurfaceImpact.affected.length, 20);
  assert.ok(r.limitations.some((l) => /5 more affected public surfaces are not listed \(limit 20\)/.test(l)));
  assert.ok(r.batching.truncatedLists.includes('surfaces'));
});

test('4 cycle groups, cycle members and affected cycle members beyond their limits are counted and reported', () => {
  const f = { 'src/hub/core.ts': 'export const core = 1;\n' };
  for (let g = 0; g < 7; g++) {
    f[`src/cyc/a${g}.ts`] = `import { core } from '../hub/core';\nimport { b } from './b${g}';\nexport const a = core + b;\n`;
    f[`src/cyc/b${g}.ts`] = `import { a } from './a${g}';\nexport const b = a;\n`;
  }
  for (let i = 0; i < 12; i++) f[`src/ring/r${String(i).padStart(2, '0')}.ts`] = `import { n } from './r${String((i + 1) % 12).padStart(2, '0')}';\nexport const n_${i} = n;\n`;
  const r = fresh(project(f), mod('src/hub/core.ts', 'src/ring/r00.ts'));
  assert.deepEqual(shape(r.bounded.cycleGroups), LIST_SHAPE);
  assert.deepEqual([r.bounded.cycleGroups.total, r.bounded.cycleGroups.returned, r.bounded.cycleGroups.omitted, r.bounded.cycleGroups.truncated], [8, 5, 3, true]);
  assert.equal(r.cycles.groups.length, 5);
  assert.ok(r.cycles.groups.every((g) => g.length <= 8));
  assert.ok(r.bounded.cycleMembers.truncated === (r.bounded.cycleMembers.total > r.bounded.cycleMembers.returned));
  const ringOnly = fresh(project(f), mod('src/ring/r00.ts'));
  assert.deepEqual([ringOnly.bounded.cycleMembers.total, ringOnly.bounded.cycleMembers.returned, ringOnly.bounded.cycleMembers.omitted, ringOnly.bounded.cycleMembers.truncated], [12, 8, 4, true]);
  assert.ok(ringOnly.limitations.some((l) => /4 more cycle members are not listed \(limit 8\)/.test(l)));
  assert.ok(r.limitations.some((l) => /3 more cycle groups are not listed \(limit 5\)/.test(l)));
});

test('4 5 a bounded inspection names the files it covers and the files it does not', () => {
  const files = Array.from({ length: 20 }, (_, i) => ({ path: `src/m/f${String(i).padStart(2, '0')}.ts`, status: 'modified' }));
  const r = analyzeChangeImpact({ files, taskClass: 'LARGE' }, { state: 'missing' }, {});
  assert.equal(r.inspection.length, IMPACT_BOUNDS.searches);
  const b = r.bounded.inspection;
  assert.deepEqual([b.limit, b.searches, b.total, b.returned, b.omitted, b.truncated], [12, 12, 20, 6, 14, true]);
  assert.equal(b.filesInspected.length, 6);
  assert.deepEqual(b.filesNotInspected, files.slice(6).map((f) => f.path));
  assert.deepEqual(b.filesInspected, files.slice(0, 6).map((f) => f.path), 'order preserved: the caller\'s order is the priority');
  assert.ok(r.inspection.every((s) => b.filesInspected.includes(s.target)), 'a file is covered by both of its searches or not at all');
  assert.match(b.confidenceImpact, /unknown/);
  assert.deepEqual([r.batching.required, r.confidence, r.completeness], [true, 'low', 'PARTIAL']);
  assert.ok(r.batching.truncatedLists.includes('inspection'));
  assert.ok(r.limitations.some((l) => /14 changed file\(s\) are not inspected \(search limit 12\)/.test(l)));
  const few = analyzeChangeImpact({ files: files.slice(0, 3), taskClass: 'SMALL' }, { state: 'missing' }, {});
  assert.deepEqual([few.bounded.inspection.truncated, few.bounded.inspection.filesNotInspected, few.batching.required], [false, [], false]);
});

test('4 the proposed reopen list is bounded and informational: it never forces batching by itself', () => {
  const r = fresh(project(hub(10)), mod('src/hub/core.ts'));
  assert.deepEqual(r.bounded.reopenDependents, { limit: 6, total: 10, returned: 6, omitted: 4, truncated: true, informational: true });
  assert.equal(r.requiredContext.reopen.length, 6);
  assert.ok(r.bounded.truncatedLists.includes('reopenDependents'));
  assert.ok(!r.batching.truncatedLists.includes('reopenDependents'), 'its items are all in directImpact.dependents');
  assert.equal(r.batching.required, false);
  assert.equal(r.directImpact.dependents.length, 10);
  assert.ok(r.limitations.some((l) => /4 more dependents proposed for reopening are not listed \(limit 6\)/.test(l)));
});

test('4 every bounded list reports the same shape, and the three completeness levels are distinguished', () => {
  const full = fresh(project(), mod('src/features/c.ts'));
  for (const k of ['dependencies', 'tests', 'surfaces', 'cycleAffected', 'cycleGroups', 'cycleMembers', 'deletedDependents', 'renamedDependents', 'reopenDependents', 'directDependents', 'transitive', 'inspection']) {
    const keys = Object.keys(full.bounded[k]);
    for (const need of ['limit', 'total', 'returned', 'omitted', 'truncated']) assert.ok(keys.includes(need), `${k}.${need}`);
  }
  assert.deepEqual([full.completeness, full.confidence, full.bounded.truncatedLists], ['COMPLETE', 'high', []]);
  const cut = fresh(project(hub(35)), mod('src/hub/core.ts'));
  assert.deepEqual([cut.completeness, cut.confidence], ['BOUNDED_COMPLETE', 'medium']);
  const partial = analyzeChangeImpact(mod('src/features/c.ts'), { state: 'stale' }, {});
  assert.deepEqual([partial.completeness, partial.confidence], ['PARTIAL', 'low']);
  const unknownFile = fresh(project(), mod('src/features/nope.ts'));
  assert.deepEqual([unknownFile.completeness, unknownFile.confidence], ['PARTIAL', 'medium']);
  assert.ok(!JSON.stringify(full).includes('"completeness":"HIGH"'));
});

// ---- 8: conflicting statuses ---------------------------------------------------------------------------------------

test('8 conflicting statuses are rejected: same path, vacated path, swap, chain, shared source or target, case-fold', () => {
  const bad = {
    'modified and renamed away': [{ path: 'a.ts', status: 'modified' }, { path: 'b.ts', from: 'a.ts', status: 'renamed' }],
    'renamed away and deleted': [{ path: 'b.ts', from: 'a.ts', status: 'renamed' }, { path: 'a.ts', status: 'deleted' }],
    'rename swap': [{ path: 'y.ts', from: 'x.ts', status: 'renamed' }, { path: 'x.ts', from: 'y.ts', status: 'renamed' }],
    'rename chain': [{ path: 'y.ts', from: 'x.ts', status: 'renamed' }, { path: 'z.ts', from: 'y.ts', status: 'renamed' }],
    'two renames from one path': [{ path: 'y.ts', from: 'x.ts', status: 'renamed' }, { path: 'z.ts', from: 'x.ts', status: 'renamed' }],
    'two renames to one path': [{ path: 'z.ts', from: 'x.ts', status: 'renamed' }, { path: 'z.ts', from: 'y.ts', status: 'renamed' }],
    'created over a vacated path': [{ path: 'y.ts', from: 'x.ts', status: 'renamed' }, { path: 'x.ts', status: 'created' }],
    'same path two statuses': [{ path: 'a.ts', status: 'modified' }, { path: 'a.ts', status: 'deleted' }],
  };
  for (const [name, files] of Object.entries(bad)) for (const ci of [true, false]) assert.throws(() => normalizeChangeSet({ files }, ci), RoutingInputError, `${name} (case-insensitive: ${ci})`);
  // the same through the analysis, and with Windows separators and ./ prefixes (the shared normalization)
  assert.throws(() => analyzeChangeImpact({ files: [{ path: 'src\\a.ts', status: 'modified' }, { path: './src/b.ts', from: 'src/a.ts', status: 'renamed' }] }, CURRENT, {}), /two statuses or roles/);
});

test('8 case-folded duplicates conflict only where the file system folds case', () => {
  const files = [{ path: 'src/A.ts', status: 'modified' }, { path: 'src/a.ts', status: 'deleted' }];
  assert.throws(() => normalizeChangeSet({ files }, true), /two statuses or roles/);
  assert.equal(normalizeChangeSet({ files }, false).files.length, 2, 'distinct files on a case-sensitive system');
  const swap = [{ path: 'src/b.ts', from: 'SRC/A.ts', status: 'renamed' }, { path: 'src/A.ts', status: 'modified' }];
  assert.throws(() => normalizeChangeSet({ files: swap }, true), /two statuses or roles/);
  assert.equal(normalizeChangeSet({ files: swap }, false).files.length, 2);
  // identical entries (even differing only in case, on a case-insensitive system) are one change, not a conflict
  assert.equal(normalizeChangeSet({ files: [{ path: 'src/A.ts', status: 'modified' }, { path: 'src/a.ts', status: 'modified' }] }, true).files.length, 1);
  // a rename that only changes case is legitimate
  assert.equal(normalizeChangeSet({ files: [{ path: 'src/a.ts', from: 'src/A.ts', status: 'renamed' }] }, true).files.length, 1);
});

test('8 legitimate combinations are not rejected', () => {
  const ok = normalizeChangeSet({ files: [{ path: 'b.ts', from: 'a.ts', status: 'renamed' }, { path: 'c.ts', status: 'modified' }, { path: 'd.ts', status: 'created' }, { path: 'e.ts', status: 'deleted' }, { path: 'b.ts', from: 'a.ts', status: 'renamed' }] }, true);
  assert.equal(ok.files.length, 4, 'an exact duplicate collapses');
});

// ---- 9: every requested path withheld -------------------------------------------------------------------------------

test('9 a change set whose paths were all withheld is not a trivial V0 change', () => {
  const dir = project({ '.env': 'API_KEY=SHOULD-NOT-BE-READ\n' });
  for (const taskClass of [undefined, 'TRIVIAL']) {
    const r = fresh(dir, { files: [{ path: '.env', status: 'modified' }], taskClass });
    assert.deepEqual([r.changedFiles, r.withheld, r.evidence.allWithheld, r.evidence.evaluated, r.evidence.graph], [[], ['.env'], true, false, 'unknown']);
    assert.deepEqual([r.completeness, r.confidence, r.graph.used], ['PARTIAL', 'low', false]);
    assert.notEqual(r.requiredValidation.depth, 'V0', `class ${taskClass}: never V0 merely because nothing is visible`);
    assert.deepEqual(GRAPH_FIELDS(r), GRAPH_FIELDS(r).map(() => null), 'nothing was evaluated, so nothing is "none"');
    assert.ok(r.limitations.some((l) => /every requested path was withheld/.test(l) && /not V0/.test(l)));
    assert.ok(r.requiredContext.reasons.includes('all-withheld') && !r.requiredContext.reasons.includes('graph-untrusted'));
    assert.deepEqual(r.inspection, []);
    assert.ok(!JSON.stringify(r).includes('SHOULD-NOT-BE-READ'));
  }
  const renamedOut = analyzeChangeImpact({ files: [{ path: 'config/app.ts', from: '.env', status: 'renamed' }] }, CURRENT, {});
  assert.deepEqual([renamedOut.evidence.allWithheld, renamedOut.withheld], [true, ['.env']], 'a rename from a secret path is withheld too');
  const mixed = fresh(dir, { files: [{ path: '.env', status: 'modified' }, { path: 'src/features/c.ts', status: 'modified' }], taskClass: 'TRIVIAL' });
  assert.deepEqual([mixed.evidence.allWithheld, mixed.requiredValidation.depth, mixed.completeness], [false, 'V0', 'COMPLETE'], 'a mixed set keeps the requested class for the visible file');
});

// ---- 10: the canonical subsystem ---------------------------------------------------------------------------------

test('10 the cross-subsystem fact is the engine\'s subsystem, not a count of directories', () => {
  const dir = project({ 'src/features/f.ts': "import { u } from '../core/util';\nexport const f = u;\n" });
  const cfg = loadConfig(dir);
  const g = buildProjectGraph(dir);
  for (const p of ['src/core/util.ts', 'src/core/format.ts', 'src/features/f.ts']) assert.equal(g.query.getNode(p).metadata.subsystem, subsystemOf(p, cfg), `${p}: the graph and the shared definition agree`);
  // the engine says src/core and src/features are two subsystems (src is a container directory): cross-subsystem, LARGE
  const two = fresh(dir, mod('src/core/util.ts', 'src/features/f.ts'));
  assert.deepEqual([two.class.value, two.class.reclassified.map((x) => x.why)], ['LARGE', ['cross-subsystem']]);
  // two files in one subsystem, in different folders below it, are not cross-subsystem
  const same = fresh(dir, mod('src/core/util.ts', 'src/core/format.ts'));
  assert.deepEqual([same.class.value, same.class.reclassified], ['SMALL', []]);
  // a model with different container directories says otherwise: src/core and src/features are both just "src"
  const none = analyzeChangeImpact(mod('src/core/util.ts', 'src/features/f.ts'), { state: 'missing' }, { subsystemRoots: [] });
  assert.deepEqual([none.class.value, none.class.reclassified], ['SMALL', []], 'not accidentally LARGE');
  const roots = analyzeChangeImpact(mod('src/core/util.ts', 'src/features/f.ts'), { state: 'missing' }, { subsystemRoots: cfg.subsystemRoots });
  assert.equal(roots.class.value, 'LARGE', 'the same facts under the engine\'s configured roots');
  // a created file and a deleted file are not in the graph, but their subsystem is still the engine's
  const created = fresh(dir, { files: [{ path: 'src/core/util.ts', status: 'modified' }, { path: 'src/newarea/n.ts', status: 'created' }], taskClass: 'SMALL' }, CURRENT, { subsystemRoots: cfg.subsystemRoots });
  assert.equal(created.class.value, 'LARGE');
  // without the engine's roots nothing is guessed
  const guess = analyzeChangeImpact({ files: [{ path: 'src/core/util.ts', status: 'modified' }, { path: 'src/newarea/n.ts', status: 'created' }], taskClass: 'SMALL' }, { state: 'missing' }, {});
  assert.deepEqual(guess.class.reclassified, []);
  // the command passes the project's configured roots
  const out = JSON.parse(cli(['change-impact', dir, '--state', 'missing', '--modified', 'src/core/util.ts,src/features/f.ts', '--class', 'SMALL', '--json'], dir).stdout);
  assert.equal(out.class.value, 'LARGE');
});

// ---- 11: the reopen plan reflects the graph actually used -----------------------------------------------------------

test('11 with a fresh graph the reopen plan has no stale-graph reason; with a stale graph it does', () => {
  const dir = project();
  const change = { files: [{ path: 'src/core/util.ts', status: 'modified' }], taskClass: 'MEDIUM', taskTypes: ['feature'] };
  const withFresh = analyzeChangeImpact(change, { state: 'stale' }, { query: queryOf(dir), graphSource: 'fresh-build' });
  assert.equal(withFresh.graph.used, true);
  assert.ok(!withFresh.requiredContext.reasons.includes('graph-untrusted'));
  const wantsGraph = (r) => JSON.stringify(r.requiredContext.plan ?? {});
  assert.ok(!/graph (stale|missing)/.test(wantsGraph(withFresh)), 'no stale-graph fallback in the plan');
  assert.ok(!(withFresh.requiredContext.plan?.requiredQueries ?? []).some((q) => q.fallbackFor), 'the graph queries are not downgraded to searches');
  const stale = analyzeChangeImpact(change, { state: 'stale' }, { query: queryOf(dir) });
  assert.equal(stale.graph.used, false);
  assert.ok(stale.requiredContext.reasons.includes('graph-untrusted'));
  assert.ok(/graph stale/.test(wantsGraph(stale)), wantsGraph(stale));
  const partial = analyzeChangeImpact(change, { state: 'partial', artifacts: { graph: 'stale', index: 'current' } }, { query: queryOf(dir), graphSource: 'fresh-build' });
  assert.ok(!/graph stale/.test(wantsGraph(partial)), 'a fresh build wins over a stale artifact of one kind');
  // through the command, over a project whose artifact went stale
  cli(['index', dir], dir);
  fs.appendFileSync(path.join(dir, 'src/core/util.ts'), 'export const z = 2;\n');
  const viaCli = JSON.parse(cli(['change-impact', dir, '--json', '--fresh-graph', '--modified', 'src/core/util.ts', '--class', 'MEDIUM', '--types', 'feature'], dir).stdout);
  assert.equal(viaCli.graph.used, true);
  assert.ok(!/graph stale/.test(JSON.stringify(viaCli.requiredContext.plan ?? {})));
  const viaCliStale = JSON.parse(cli(['change-impact', dir, '--json', '--modified', 'src/core/util.ts', '--class', 'MEDIUM', '--types', 'feature'], dir).stdout);
  assert.equal(viaCliStale.graph.used, false);
});

// ---- 12: 5B is decide-only ------------------------------------------------------------------------------------------

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        out[`${path.relative(dir, p)}/`] = 'dir';
        walk(p);
      } else out[path.relative(dir, p)] = `${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}:${fs.statSync(p).mtimeMs}`;
    }
  };
  walk(dir);
  return JSON.stringify(out);
}

test('12 an AUTO_REFRESH decision is only reported: no .ai byte, file or working tree entry changes', (t) => {
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (git.status !== 0) return t.skip('git is not available');
  const dir = project();
  assert.equal(cli(['index', dir], dir).status, 0);
  spawnSync('git', ['-C', dir, 'init', '-q']);
  fs.appendFileSync(path.join(dir, 'src/core/util.ts'), 'export const z = 2;\n');
  const porcelain = () => spawnSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).stdout;
  const before = snapshot(dir);
  const status = porcelain();
  const r = cli(['change-impact', dir, '--json', '--modified', 'src/core/util.ts', '--class', 'SMALL'], dir);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.graph.used, false, 'the artifact is stale, so the graph is not used');
  assert.equal(report.intelligenceImpact.refreshDecision.decision, 'AUTO_REFRESH', 'the existing decision says a refresh would be allowed');
  assert.equal(report.intelligenceImpact.refreshDecision.level, 'A1');
  assert.equal(snapshot(dir), before, 'not one byte, mtime, file or directory changed (.ai included)');
  assert.equal(porcelain(), status, 'the working tree is unchanged');
  // a human-readable run too
  cli(['change-impact', dir, '--modified', 'src/core/util.ts', '--class', 'SMALL'], dir);
  assert.equal(snapshot(dir), before);
  // and the source: the only call to the refresh decision is decide-only, and the analysis imports no refresh code
  const src = fs.readFileSync(BIN, 'utf8');
  const calls = src.split('\n').filter((l) => /autoRefresh\(/.test(l) && /CHANGE_COMPLETED/.test(l));
  assert.ok(calls.length === 1 && /\{ execute: false \}/.test(calls[0]), 'change-impact calls the refresh decision with execute: false');
  assert.ok(!/from '\.\/refresh(\.mjs)?'/.test(fs.readFileSync(path.join(TOOLS_ROOT, 'automation', 'change-impact.mjs'), 'utf8')));
});

// ---- 13: the secret filter on every output surface -------------------------------------------------------------------

test('13 no secret-pattern path appears on any surface of the report', () => {
  const query = {
    getNode: () => null,
    getImpact: (p) => ({
      found: true, target: p, language: 'ts', publicSurface: false, publicSurfaceReasons: [], risk: { level: 'LOW' }, inCycle: true, notes: [],
      affected: [{ id: 'src/ok.ts', distance: 1 }, { id: 'config/id_rsa', distance: 1 }, { id: 'deploy/.env', distance: 2 }, { id: 'src/deep.ts', distance: 2 }],
      dependencies: ['src/dep.ts', 'secrets/id_rsa'],
      directDependents: ['src/ok.ts', 'config/id_rsa', 'deploy/.env'],
    }),
    getDependencies: () => ['keys/id_rsa', 'src/dep2.ts'],
    getCycles: () => [['src/ok.ts', 'config/id_rsa', 'src/cyc.ts']],
  };
  const r = analyzeChangeImpact({ files: [{ path: 'src/m.ts', status: 'modified' }, { path: 'src/gone.ts', status: 'deleted' }, { path: 'src/new.ts', from: 'src/old.ts', status: 'renamed' }, { path: '.env.production', status: 'modified' }], taskClass: 'SMALL' }, CURRENT, { query });
  const text = JSON.stringify({ ...r, withheld: undefined });
  assert.ok(!/id_rsa|\.env/.test(text), text.match(/.{20}(id_rsa|\.env).{20}/)?.[0]);
  assert.deepEqual(r.withheld, ['.env.production']);
  assert.deepEqual(r.deletions[0].dependents, ['src/ok.ts']);
  assert.deepEqual(r.renames[0].dependents, ['src/ok.ts']);
  assert.deepEqual(r.cycles.groups, [['src/cyc.ts', 'src/ok.ts']]);
  assert.ok(r.directImpact.dependents.every((d) => d.path === 'src/ok.ts'));
  assert.ok(!r.directImpact.dependencies.some((d) => /id_rsa/.test(d)));
  assert.equal(r.bounded.deletedDependents.total, 1);
});

// ---- docs ---------------------------------------------------------------------------------------------------------------

test('the automation README documents the hardened contract', () => {
  const readme = fs.readFileSync(path.join(REPO, 'tools', 'automation', 'README.md'), 'utf8');
  for (const word of ['BOUNDED_COMPLETE', 'PARTIAL', 'new-path', 'unclassified', 'all-withheld', 'filesNotInspected', 'informational']) assert.ok(readme.includes(word), word);
});
