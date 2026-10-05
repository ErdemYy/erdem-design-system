import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { cleanup, TOOLS_ROOT, tmpDir } from './helpers.mjs';
import { CHANGE_STATUSES, IMPACT_BOUNDS, RoutingInputError, analyzeChangeImpact, normalizeChangeSet, predictIntelligenceImpact } from '../automation/change-impact.mjs';
import { routeContext } from '../automation/context-router.mjs';
import { buildProjectGraph } from '../lib/pipeline.mjs';
import { classifyPath, compileCategoryRules } from '../lib/classify.mjs';
import { loadConfig } from '../lib/config.mjs';
import { createGraphQuery } from '../analyze/query.mjs';
import { directoryIndexRel } from '../lib/artifact-paths.mjs';

after(cleanup);

const REPO = path.resolve(TOOLS_ROOT, '..');
const BIN = path.join(TOOLS_ROOT, 'bin', 'project-intel.mjs');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const cli = (args, cwd, env) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, windowsHide: true, env: env ?? process.env });
const CURRENT = { state: 'current' };

function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

/** A small TypeScript project with a chain util <- format <- a <- b <- c, tests, a cycle, a public entry and config. */
const BASE = {
  'package.json': JSON.stringify({ name: 'impact-fixture', main: 'src/index.ts', dependencies: { react: '*' } }),
  'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
  'vite.config.ts': 'export default {};\n',
  'src/index.ts': "export * from './features/a';\n",
  'src/core/util.ts': 'export const u = 1;\n',
  'src/core/format.ts': "import { u } from './util';\nexport const f = u;\n",
  'src/features/a.ts': "import { f } from '../core/format';\nexport const a = f;\n",
  'src/features/b.ts': "import { a } from './a';\nexport const b = a;\n",
  'src/features/c.ts': "import { b } from './b';\nexport const c = b;\n",
  'src/features/a.test.ts': "import { a } from './a';\nvoid a;\n",
  'src/core/util.test.ts': "import { u } from './util';\nvoid u;\n",
  'src/ui/Button.tsx': "import { u } from '../core/util';\nexport const Button = () => u;\n",
  'src/ui/Button.test.tsx': "import { Button } from './Button';\nvoid Button;\n",
  'src/cycle/x.ts': "import { y } from './y';\nexport const x = () => y();\n",
  'src/cycle/y.ts': "import { x } from './x';\nimport { u } from '../core/util';\nexport const y = () => x() + u;\n",
  'src/lib/p.ts': 'export const p = 1;\n',
  'src/lib/q.ts': "import { p } from './p';\nexport const q = p;\n",
  'src/lib/p.test.ts': "import { p } from './p';\nvoid p;\n",
  'src/lib/q.test.ts': "import { q } from './q';\nvoid q;\n",
  'src/theme/tokens.ts': 'export const t = 1;\n',
  'src/data/schema.ts': 'export const s = 1;\n',
  'docs/README.md': '# docs\n',
};

function project(extra = {}, { nested = [] } = {}) {
  const dir = path.join(tmpDir('pi-impact-'), ...nested, 'app');
  fs.mkdirSync(dir, { recursive: true });
  writeTree(dir, { ...BASE, ...extra });
  return dir;
}
const graphOf = (dir) => buildProjectGraph(dir);
const queryOf = (dir) => graphOf(dir).query;

/** analyze with a freshly built graph (what --fresh-graph does) */
function fresh(dir, change, intel = CURRENT, more = {}) {
  return analyzeChangeImpact(change, intel, { query: queryOf(dir), graphSource: 'fresh-build', ...more });
}
const mod = (...paths) => ({ files: paths.map((p) => ({ path: p, status: 'modified' })), taskClass: 'SMALL', taskTypes: ['bugfix'] });
const ids = (rows) => rows.map((r) => r.path);

// ---- direct, transitive, cycles ---------------------------------------------------------------------------------

test('1 a one-file local change: nothing depends on it, so there is no downstream impact and no context to reopen', () => {
  const r = fresh(project(), mod('src/features/c.ts'));
  assert.deepEqual([r.directImpact.dependents, r.transitiveImpact.dependents, r.affectedTests.direct, r.affectedTests.consumer], [[], [], [], []]);
  assert.deepEqual([r.risk.level, r.requiredValidation.depth, r.class.value, r.confidence, r.graph.basis], ['LOW', 'V1', 'SMALL', 'high', 'fresh build from the current sources']);
  assert.equal(r.requiredContext.justified, false);
  assert.equal(r.publicSurfaceImpact.present, false);
  assert.deepEqual(r.changedFiles.map((c) => [c.path, c.known, c.category]), [['src/features/c.ts', true, 'source']]);
});

test('2 and 3 direct and transitive dependents differ: distance, via, and where each is listed', () => {
  const r = fresh(project(), mod('src/core/util.ts'));
  assert.deepEqual(ids(r.directImpact.dependents).sort(), ['src/core/format.ts', 'src/core/util.test.ts', 'src/cycle/y.ts', 'src/ui/Button.tsx']);
  assert.ok(r.directImpact.dependents.every((d) => d.distance === 1 && d.via[0] === 'src/core/util.ts'));
  const trans = Object.fromEntries(r.transitiveImpact.dependents.map((d) => [d.path, d.distance]));
  assert.equal(trans['src/features/a.ts'], 2);
  assert.equal(trans['src/features/b.ts'], 3);
  assert.equal(trans['src/features/c.ts'], undefined, `beyond depth ${IMPACT_BOUNDS.depth} is not listed`);
  assert.ok(!ids(r.transitiveImpact.dependents).some((p) => ids(r.directImpact.dependents).includes(p)), 'a file is listed once, at its nearest distance');
  assert.equal(r.bounded.transitive.depthLimited, true);
  assert.ok(r.limitations.some((l) => /3 levels deep/.test(l)));
  assert.equal(r.confidence, 'medium', 'a depth-limited result is not high confidence');
});

test('4 and 36 cycles terminate, are deduplicated, and are reported', () => {
  const dir = project();
  const r = fresh(dir, mod('src/cycle/x.ts'));
  assert.deepEqual(r.cycles.changed, ['src/cycle/x.ts']);
  assert.deepEqual(r.cycles.groups, [['src/cycle/x.ts', 'src/cycle/y.ts']]);
  assert.deepEqual(r.cycles.affected, ['src/cycle/y.ts']);
  assert.deepEqual(ids(r.directImpact.dependents), ['src/cycle/y.ts']);
  assert.ok(r.changedFiles[0].inCycle);
  // a long ring: the traversal is bounded and finishes
  const ring = {};
  const N = 300;
  for (let i = 0; i < N; i++) ring[`src/ring/n${i}.ts`] = `import './n${(i + 1) % N}';\nexport const v${i} = ${i};\n`;
  const rdir = project(ring);
  const t0 = Date.now();
  const rr = fresh(rdir, mod('src/ring/n0.ts'));
  assert.ok(Date.now() - t0 < 20000, 'terminates');
  const all = [...rr.directImpact.dependents, ...rr.transitiveImpact.dependents];
  assert.equal(new Set(ids(all)).size, all.length, 'no node twice');
  assert.ok(all.length <= IMPACT_BOUNDS.directDependents + IMPACT_BOUNDS.transitive);
  assert.ok(rr.cycles.groups.length <= IMPACT_BOUNDS.cycleGroups && rr.cycles.groups.every((g) => g.length <= 8), 'the cycle report is bounded');
});

// ---- tests, public surface -------------------------------------------------------------------------------------

test('5 6 public surface: changing one raises class, risk and validation; one that merely depends on the change widens the tests', () => {
  const dir = project();
  const surface = fresh(dir, { ...mod('src/index.ts'), taskClass: 'TRIVIAL' });
  assert.deepEqual(surface.publicSurfaceImpact.changed, [{ path: 'src/index.ts', reasons: ['package-entry'] }]);
  assert.deepEqual([surface.class.value, surface.class.reclassified[0]?.why], ['MEDIUM', 'public-surface']);
  assert.ok(['MEDIUM', 'HIGH', 'CRITICAL'].includes(surface.risk.level));
  assert.ok(['V2', 'V3', 'V4'].includes(surface.requiredValidation.depth), 'the router: class MEDIUM, raised further by the engine\'s own risk for an entry point');
  assert.ok(surface.risk.raisedBy.some((x) => /public surface/.test(x)));
  const plain = fresh(dir, { ...mod('src/features/c.ts'), taskClass: 'TRIVIAL' });
  assert.equal(plain.requiredValidation.depth, 'V0');
  assert.ok(surface.requiredValidation.depth > plain.requiredValidation.depth, 'a public surface changes the validation requirement');
  // a.ts is re-exported by the entry: the surface is affected, not changed
  const affected = fresh(dir, mod('src/features/a.ts'));
  assert.deepEqual([affected.publicSurfaceImpact.changed, affected.publicSurfaceImpact.affected, affected.class.value], [[], ['src/index.ts'], 'SMALL']);
  assert.equal(affected.requiredValidation.tests.consumerJustified, true);
  assert.ok(affected.requiredContext.reasons.includes('public-surface'));
  assert.deepEqual(affected.requiredValidation.tests.consumer, affected.affectedTests.consumer, 'consumer tests are recommended when a public surface depends on the change');
  const none = fresh(dir, mod('src/lib/p.ts'));
  assert.equal(none.publicSurfaceImpact.present, false);
});

test('6 affected tests: direct tests, consumer tests, and consumer tests only where justified', () => {
  const dir = project();
  const r = fresh(dir, mod('src/lib/p.ts'));
  assert.deepEqual(r.affectedTests.direct, ['src/lib/p.test.ts']);
  assert.deepEqual(r.affectedTests.consumer, ['src/lib/q.test.ts']);
  assert.equal(r.requiredValidation.tests.consumerJustified, false, 'SMALL, LOW risk, no public surface: consumer tests are listed but not recommended');
  assert.deepEqual(r.requiredValidation.tests.consumer, []);
  assert.deepEqual(r.requiredValidation.tests.direct, ['src/lib/p.test.ts']);
  const medium = fresh(dir, { ...mod('src/lib/p.ts'), taskClass: 'MEDIUM', taskTypes: ['feature'] });
  assert.equal(medium.requiredValidation.tests.consumerJustified, true);
  assert.deepEqual(medium.requiredValidation.tests.consumer, ['src/lib/q.test.ts']);
  const viaSurface = fresh(dir, mod('src/core/util.ts'));
  assert.equal(viaSurface.requiredValidation.tests.consumerJustified, true, 'util is consumed by the public entry through the chain, so consumer tests are recommended');
  assert.match(r.requiredValidation.note, /nothing is run/);
  assert.ok(!('command' in r.requiredValidation) && !JSON.stringify(r.requiredValidation).includes('npm '), 'no command is invented');
});

// ---- dimensions --------------------------------------------------------------------------------------------------

test('7 to 11 the five dimensions: from the caller\'s signals, and from engine evidence where the engine has it', () => {
  const dir = project();
  const dims = (change) => fresh(dir, change).dimensions;
  const none = dims(mod('src/features/c.ts'));
  for (const k of ['configuration', 'api', 'data', 'platform', 'designSystem']) assert.deepEqual(none[k], { present: false, source: 'none', evidence: [] }, k);
  assert.deepEqual(Object.keys(none), ['configuration', 'api', 'data', 'platform', 'designSystem'], 'no sixth dimension');
  const config = dims(mod('vite.config.ts'));
  assert.deepEqual([config.configuration.present, config.configuration.source, config.configuration.evidence], [true, 'evidence', ['vite.config.ts']]);
  const api = dims(mod('src/index.ts'));
  assert.deepEqual([api.api.present, api.api.source, api.api.evidence], [true, 'evidence', ['src/index.ts']]);
  for (const [flag, name] of [['configImpact', 'configuration'], ['apiImpact', 'api'], ['dataImpact', 'data'], ['platformImpact', 'platform'], ['designSystemImpact', 'designSystem']]) {
    const d = dims({ ...mod('src/data/schema.ts'), signals: { [flag]: true } });
    assert.deepEqual([d[name].present, d[name].source], [true, 'signal'], name);
    for (const other of Object.keys(d).filter((k) => k !== name)) assert.equal(d[other].present, false, `${flag} sets only ${name}`);
  }
  const both = dims({ ...mod('src/index.ts'), signals: { apiImpact: true } });
  assert.equal(both.api.source, 'both');
  const ctx = fresh(dir, { ...mod('src/theme/tokens.ts'), signals: { designSystemImpact: true } }).requiredContext;
  assert.ok(ctx.justified && ctx.reasons.includes('dimension:designSystem'), 'a dimension asks for context through the router');
});

// ---- risk --------------------------------------------------------------------------------------------------------

test('12 to 15 risk follows the canonical rules and the validation depth follows risk through the router', () => {
  const dir = project();
  const at = (risk, taskClass = 'SMALL') => fresh(dir, { ...mod('src/features/c.ts'), taskClass, risk });
  assert.deepEqual([at('LOW').risk.level, at('LOW').requiredValidation.depth], ['LOW', 'V1']);
  assert.deepEqual([at('MEDIUM').risk.level, at('MEDIUM').requiredValidation.depth], ['MEDIUM', 'V1']);
  assert.deepEqual([at('HIGH').risk.level, at('HIGH').requiredValidation.depth], ['HIGH', 'V2'], 'HIGH raises by one (ai/VALIDATION_PROTOCOL.md)');
  assert.deepEqual([at('CRITICAL').risk.level, at('CRITICAL').requiredValidation.depth], ['CRITICAL', 'V4']);
  assert.equal(at('HIGH', 'LARGE').requiredValidation.depth, 'V4');
  assert.equal(at('LOW', 'LARGE').requiredValidation.depth, 'V3');
  // the engine's own risk for the changed file counts, and the stated risk is never lowered
  const fan = {};
  for (let i = 0; i < 14; i++) fan[`src/shared/user${i}.ts`] = "import { hub } from './hub';\nexport const x" + i + ' = hub;\n';
  fan['src/shared/hub.ts'] = 'export const hub = 1;\n';
  const fdir = project(fan);
  const engine = queryOf(fdir).getNode('src/shared/hub.ts').risk;
  assert.ok(['MEDIUM', 'HIGH', 'CRITICAL'].includes(engine), `the engine rates the hub ${engine}`);
  const hub = fresh(fdir, { ...mod('src/shared/hub.ts'), risk: 'LOW' });
  assert.equal(hub.risk.level, engine, 'engine risk of the changed file raises a LOW stated risk');
  assert.ok(hub.risk.basis.some((b) => b.includes(engine)));
  assert.equal(fresh(fdir, { ...mod('src/shared/hub.ts'), risk: 'CRITICAL' }).risk.level, 'CRITICAL', 'a stated risk is never lowered');
  // dependents' risk is advisory, not applied
  const lowToHigh = fresh(fdir, mod('src/shared/user0.ts'));
  assert.equal(lowToHigh.risk.level, 'LOW');
  const dep = fresh(project({ ...fan, 'src/shared/user0.ts': "import { hub } from './hub';\nimport { w } from './wrap';\nexport const x0 = hub + w;\n", 'src/shared/wrap.ts': 'export const w = 1;\n' }), mod('src/shared/wrap.ts'));
  if (dep.risk.propagation) assert.deepEqual([dep.risk.propagation.applied, dep.risk.level], [false, 'LOW']);
});

// ---- intelligence states and the graph --------------------------------------------------------------------------

test('16 current intelligence: the graph artifact is used', () => {
  const dir = project();
  const q = queryOf(dir);
  const r = analyzeChangeImpact(mod('src/core/util.ts'), CURRENT, { query: q, phase: 'planned' });
  assert.deepEqual([r.graph.used, r.graph.basis, r.phase], [true, 'graph artifact (current)', 'completed']);
  assert.ok(r.directImpact.dependents.length > 0);
  const planned = analyzeChangeImpact({ ...mod('src/core/util.ts'), phase: 'planned' }, CURRENT, { query: q });
  assert.equal(planned.phase, 'planned');
  assert.equal(planned.intelligenceImpact.refresh, null, 'a planned change on a current graph needs no refresh');
});

test('17 18 19 20 21 stale, missing, unavailable and unusable graphs are never presented as current', () => {
  const dir = project();
  const q = queryOf(dir);
  for (const [name, intel, query] of [
    ['stale state', { state: 'stale' }, q],
    ['stale graph, other artifacts current', { state: 'partial', artifacts: { graph: 'stale', index: 'current' } }, q],
    ['missing', { state: 'missing' }, null],
    ['unavailable', { state: 'unavailable' }, null],
    ['unverifiable graph', { state: 'unverifiable' }, q],
    ['current state but no graph supplied', CURRENT, null],
    ['partial with the graph missing', { state: 'partial', artifacts: { graph: 'missing' } }, q],
  ]) {
    const r = analyzeChangeImpact(mod('src/core/util.ts'), intel, { query });
    assert.equal(r.graph.used, false, name);
    assert.deepEqual([r.directImpact.dependents, r.transitiveImpact.dependents, r.affectedTests.direct], [null, null, null], `${name}: unknown, not "none"`);
    assert.equal(r.confidence, 'low', name);
    assert.ok(r.inspection.length > 0 && r.inspection.length <= IMPACT_BOUNDS.searches, `${name}: bounded source searches instead`);
    assert.ok(r.inspection.every((s) => s.via === 'search' && s.effect === 'read-only'));
    assert.ok(r.limitations.some((l) => /no graph result is presented as current|no usable graph/.test(l)), name);
    assert.ok(r.risk.pending, 'impact undetermined: raise the risk one level if targeted search cannot determine it');
    assert.equal(r.requiredContext.justified, true);
    assert.ok(r.requiredContext.reasons.includes('graph-untrusted'));
    assert.equal(r.requiredContext.plan.minimumLevel >= 4, true, 'dependency uncertainty deepens the context through the router');
    assert.ok(!r.changedFiles[0].known && r.changedFiles[0].category === null);
  }
  const stale = analyzeChangeImpact(mod('src/core/util.ts'), { state: 'stale' }, { query: q });
  assert.deepEqual(stale.intelligenceImpact.refresh.reliesOn, ['impact', 'dependents'], 'the refresh decision is left to project-intel refresh');
  assert.match(stale.intelligenceImpact.refresh.note, /does not refresh/);
  const missing = analyzeChangeImpact(mod('src/core/util.ts'), { state: 'missing' }, {});
  assert.ok(missing.inspection.every((s) => !s.command), 'no index or graph command is planned for missing intelligence');
  assert.ok(!JSON.stringify(missing).includes('"index"') || !/project-intel index/.test(JSON.stringify(missing)));
});

// ---- deletions and renames ---------------------------------------------------------------------------------------

test('22 deleted files: dependents come from a graph that still contains the file; otherwise they are unknown, never invented', () => {
  const dir = project();
  const q = queryOf(dir);
  const planned = analyzeChangeImpact({ files: [{ path: 'src/core/util.ts', status: 'deleted' }], phase: 'planned', taskClass: 'MEDIUM' }, CURRENT, { query: q });
  assert.deepEqual(planned.deletions[0].dependents.sort(), ['src/core/format.ts', 'src/core/util.test.ts', 'src/cycle/y.ts', 'src/ui/Button.tsx']);
  assert.match(planned.deletions[0].note, /unresolved imports/);
  assert.ok(planned.directImpact.dependents.length > 0);
  // after the deletion a fresh graph no longer has the file
  const dir2 = project();
  fs.rmSync(path.join(dir2, 'src/core/util.ts'));
  const after = fresh(dir2, { files: [{ path: 'src/core/util.ts', status: 'deleted' }], taskClass: 'MEDIUM' });
  assert.deepEqual([after.changedFiles[0].known, after.deletions[0].dependents], [false, null], 'the former dependents are unknown, not none');
  assert.match(after.deletions[0].note, /no longer contains this file/);
  assert.ok(after.limitations.some((l) => /not in the graph/.test(l)));
  assert.ok(after.inspection.some((s) => s.target === 'src/core/util.ts'), 'search for the deleted path instead');
  assert.equal(after.confidence, 'medium');
});

test('23 renamed files need both paths; the old path\'s dependents are the files to update; nothing is inferred', () => {
  const dir = project();
  const q = queryOf(dir);
  const r = analyzeChangeImpact({ files: [{ path: 'src/core/helpers.ts', from: 'src/core/format.ts', status: 'renamed' }], phase: 'planned', taskClass: 'SMALL' }, CURRENT, { query: q, categories: { 'src/core/helpers.ts': 'source' } });
  assert.deepEqual([r.renames[0].from, r.renames[0].to, r.renames[0].dependents], ['src/core/format.ts', 'src/core/helpers.ts', ['src/features/a.ts']]);
  assert.match(r.renames[0].note, /import paths updated/);
  assert.deepEqual(r.changedFiles[0], { ...r.changedFiles[0], path: 'src/core/helpers.ts', from: 'src/core/format.ts', status: 'renamed', known: true });
  assert.ok(r.directImpact.dependents.some((d) => d.path === 'src/features/a.ts' && d.via[0] === 'src/core/helpers.ts'));
  assert.ok(r.directImpact.dependencies.includes('src/core/util.ts'), 'the old file\'s dependencies carry over');
  for (const bad of [{ files: [{ path: 'b.ts', status: 'renamed' }] }, { files: [{ path: 'a.ts', from: 'a.ts', status: 'renamed' }] }, { files: [{ path: 'a.ts', from: 'b.ts', status: 'modified' }] }]) assert.throws(() => analyzeChangeImpact(bad, CURRENT, {}), RoutingInputError);
  // a rename seen only after the fact: the graph does not know the old path
  const after = fresh(project({ 'src/core/helpers.ts': BASE['src/core/format.ts'] }), { files: [{ path: 'src/core/helpers.ts', from: 'src/core/old-format.ts', status: 'renamed' }] });
  assert.deepEqual(after.renames[0].dependents, []);
  assert.match(after.renames[0].note, /does not contain the old path/);
});

// ---- ordering and bounds ------------------------------------------------------------------------------------------

test('24 25 26 27 results are deterministic, prioritized, bounded, reported when truncated, and never the whole graph', () => {
  const fan = { 'src/hub/core.ts': 'export const core = 1;\n' };
  for (let i = 0; i < 45; i++) fan[`src/consumers/${i % 3 === 0 ? 'alpha' : i % 3 === 1 ? 'beta' : 'gamma'}/c${String(i).padStart(2, '0')}.ts`] = `import { core } from '../../hub/core';\nexport const v${i} = core;\n`;
  for (let i = 0; i < 400; i++) fan[`src/noise/n${i}.ts`] = `export const n${i} = ${i};\n`;
  const dir = project(fan);
  const change = mod('src/hub/core.ts');
  const r = fresh(dir, change);
  assert.equal(r.directImpact.dependents.length, IMPACT_BOUNDS.directDependents);
  assert.deepEqual([r.bounded.directDependents.total, r.bounded.directDependents.truncated, r.bounded.batchingRequired, r.batching.required], [45, true, true, true]);
  assert.deepEqual(r.bounded.directDependents.remainingBySubsystem && Object.values(r.bounded.directDependents.remainingBySubsystem).reduce((a, b) => a + b, 0), 15);
  assert.deepEqual(Object.keys(r.bounded.directDependents.remainingBySubsystem), Object.keys(r.bounded.directDependents.remainingBySubsystem).sort(), 'deterministic subsystem order');
  assert.ok(r.limitations.some((l) => /15 more direct dependent\(s\) are not listed \(limit 30\)/.test(l)), 'truncation is reported, not silent');
  assert.equal(r.confidence, 'medium');
  assert.ok(!ids(r.directImpact.dependents).some((p) => p.startsWith('src/noise/')), 'no whole-repository result: unrelated files are not listed');
  assert.ok(JSON.stringify(r).length < 40000, 'a report is small even when the project is large');
  // determinism: same input, same output; same priority order
  const again = fresh(dir, change);
  assert.deepEqual({ ...again, record: undefined }, { ...r, record: undefined });
  const sorted = ids(r.directImpact.dependents);
  assert.deepEqual(sorted.slice(0, 3), [...sorted.slice(0, 3)].sort(), 'equal priority: by path');
  // priority: a public surface or higher-risk dependent is listed before plain ones at the same distance
  const pri = fresh(project({ ...fan, 'src/hub/entry.ts': "import { core } from './core';\nexport const e = core;\n", 'package.json': JSON.stringify({ name: 'p', main: 'src/hub/entry.ts' }) }), change);
  assert.equal(pri.directImpact.dependents[0].path, 'src/hub/entry.ts');
  assert.equal(pri.directImpact.dependents[0].publicSurface, true);
  // changed files and tests are bounded too
  const many = {};
  for (let i = 0; i < 25; i++) many[`src/m/f${i}.ts`] = `export const f${i} = ${i};\n`;
  const mdir = project(many);
  const mm = fresh(mdir, { files: Object.keys(many).map((p) => ({ path: p, status: 'modified' })), taskClass: 'LARGE' });
  assert.deepEqual([mm.changedFiles.length, mm.batching.remainingChangedFiles, mm.batching.required], [IMPACT_BOUNDS.changedFiles, 5, true]);
  assert.ok(mm.limitations.some((l) => /5 more changed file\(s\) are not analyzed \(limit 20\)/.test(l)));
  const tests = {};
  for (let i = 0; i < 26; i++) tests[`src/t/t${i}.test.ts`] = "import { core } from '../hub/core';\nvoid core;\n";
  const tt = fresh(project({ ...fan, ...tests }), change);
  assert.ok(tt.affectedTests.direct.length + tt.affectedTests.consumer.length <= IMPACT_BOUNDS.tests);
  assert.equal(tt.affectedTests.truncated, true);
});

test('24b ordering does not depend on the order of the change set or of the graph', () => {
  const dir = project();
  const a = fresh(dir, mod('src/core/util.ts', 'src/theme/tokens.ts', 'src/features/b.ts'));
  const b = fresh(dir, mod('src/features/b.ts', 'src/core/util.ts', 'src/theme/tokens.ts'));
  assert.deepEqual(a.directImpact.dependents, b.directImpact.dependents);
  assert.deepEqual(a.transitiveImpact.dependents, b.transitiveImpact.dependents);
  assert.deepEqual(a.affectedTests, b.affectedTests);
  assert.deepEqual(a.publicSurfaceImpact, b.publicSurfaceImpact);
  assert.deepEqual(a.changedFiles.map((c) => c.path), ['src/core/util.ts', 'src/theme/tokens.ts', 'src/features/b.ts'], 'changed files keep the caller\'s order');
  const g = graphOf(dir).graph;
  const shuffled = { ...g, nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() };
  const c = analyzeChangeImpact(mod('src/core/util.ts'), CURRENT, { query: createGraphQuery(shuffled) });
  assert.deepEqual(c.directImpact.dependents, fresh(dir, mod('src/core/util.ts')).directImpact.dependents);
});

test('28 secret paths are withheld, never analyzed and never listed', () => {
  const dir = project({ '.env': 'API_KEY=SHOULD-NOT-BE-READ\n', 'config/id_rsa': 'PRIVATE\n' });
  const r = fresh(dir, { files: [{ path: '.env', status: 'modified' }, { path: 'config/id_rsa', status: 'deleted' }, { path: 'src/core/util.ts', status: 'modified' }], taskClass: 'SMALL' });
  assert.deepEqual(r.withheld, ['.env', 'config/id_rsa']);
  assert.deepEqual(r.changedFiles.map((c) => c.path), ['src/core/util.ts']);
  assert.ok(!JSON.stringify(r).includes('SHOULD-NOT-BE-READ'), 'no secret content: nothing is read');
  assert.ok(!r.changedFiles.some((c) => /\.env|id_rsa/.test(c.path)) && !r.directImpact.dependents.some((d) => /\.env|id_rsa/.test(d.path)));
  assert.ok(r.limitations.some((l) => /secret patterns/.test(l)));
  assert.equal(normalizeChangeSet({ files: [{ path: '.env', status: 'modified' }] }).files.length, 0);
  const onlySecret = analyzeChangeImpact({ files: [{ path: '.env', status: 'modified' }, { path: 'a.ts', status: 'modified' }] }, CURRENT, {});
  assert.deepEqual(onlySecret.withheld, ['.env']);
});

// ---- change set validation ---------------------------------------------------------------------------------------

test('the change set is explicit and validated', () => {
  assert.deepEqual(CHANGE_STATUSES, ['created', 'modified', 'deleted', 'renamed']);
  assert.throws(() => normalizeChangeSet({ files: [] }), /at least one file/);
  assert.throws(() => normalizeChangeSet({}), RoutingInputError);
  assert.throws(() => normalizeChangeSet({ files: [{ path: 'a.ts', status: 'touched' }] }), /unknown change status/);
  assert.throws(() => normalizeChangeSet({ files: [{ path: '/etc/passwd', status: 'modified' }] }), RoutingInputError);
  assert.throws(() => normalizeChangeSet({ files: [{ path: 'src/*.ts', status: 'modified' }] }), RoutingInputError);
  assert.throws(() => normalizeChangeSet({ files: [{ path: '../x.ts', status: 'modified' }] }), RoutingInputError);
  assert.throws(() => normalizeChangeSet({ files: [{ path: 'a.ts', status: 'modified' }, { path: 'a.ts', status: 'deleted' }] }), /two statuses/);
  assert.equal(normalizeChangeSet({ files: [{ path: 'a.ts', status: 'modified' }, { path: 'a.ts', status: 'modified' }] }).files.length, 1, 'exact duplicates collapse');
  assert.equal(normalizeChangeSet({ files: [{ path: 'app/[id]/page.tsx', status: 'modified' }] }).files[0].path, 'app/[id]/page.tsx', 'framework routes are literal');
  assert.throws(() => analyzeChangeImpact({ ...mod('a.ts'), taskClass: 'HUGE' }, CURRENT, {}), /unknown task class/);
  assert.throws(() => analyzeChangeImpact({ ...mod('a.ts'), risk: 'SEVERE' }, CURRENT, {}), /unknown risk/);
  assert.equal(normalizeChangeSet({ ...mod('a.ts'), phase: 'planned' }).phase, 'planned');
  assert.equal(normalizeChangeSet(mod('a.ts')).phase, 'completed');
});

// ---- the artifact vocabulary and staleness, against the real engine -------------------------------------------------

test('39 the staleness prediction matches what the engine\'s own status reports, for every kind of change', () => {
  const kinds = { graph: 'graph', 'machine index': 'index', 'navigation map': 'index', 'file index': 'fileIndex', 'directory index': 'directoryIndex', 'file summary': 'summary', 'directory summary': 'summary' };
  const cases = [
    ['modify source', { 'src/core/util.ts': 'export const u = 2;\n' }, { path: 'src/core/util.ts', status: 'modified' }],
    ['modify test', { 'src/core/util.test.ts': "import { u } from './util';\nvoid u; // x\n" }, { path: 'src/core/util.test.ts', status: 'modified' }],
    ['modify docs', { 'docs/README.md': '# docs\nmore\n' }, { path: 'docs/README.md', status: 'modified' }],
    ['modify config', { 'tsconfig.json': '{ "compilerOptions": { "strict": false } }' }, { path: 'tsconfig.json', status: 'modified' }],
    ['create source', { 'src/core/new.ts': 'export const n = 1;\n' }, { path: 'src/core/new.ts', status: 'created' }],
    ['create docs', { 'docs/NOTES.md': 'notes\n' }, { path: 'docs/NOTES.md', status: 'created' }],
  ];
  const cfg = loadConfig(tmpDir('pi-cfg-'), {});
  const rules = compileCategoryRules(cfg);
  for (const [name, edit, file] of cases) {
    const dir = project();
    assert.equal(cli(['index', dir, '--profile', 'full'], dir).status, 0);
    const before = JSON.parse(cli(['status', dir, '--json'], dir).stdout);
    assert.ok(before.artifacts.every((a) => a.state === 'CURRENT'), 'a fresh index is current');
    const q = queryOf(dir);
    writeTree(dir, edit);
    const after = JSON.parse(cli(['status', dir, '--json'], dir).stdout);
    const actual = {};
    for (const a of after.artifacts) {
      const k = kinds[a.kind];
      actual[k] = actual[k] === 'stale' || a.state === 'STALE' ? 'stale' : actual[k] ?? 'current';
    }
    const categories = { [file.path]: classifyPath(file.path, path.posix.extname(file.path), cfg, rules).category };
    const catOf = (p) => q.getNode(p)?.metadata?.category ?? categories[p] ?? null;
    const states = Object.fromEntries(['graph', 'index', 'fileIndex', 'directoryIndex', 'summary'].map((k) => [k, 'current']));
    const predicted = predictIntelligenceImpact([file], { states }, after.artifacts.map((a) => ({ ...a, outputDir: '.ai' })), catOf);
    assert.deepEqual(predicted.states, { graph: actual.graph, index: actual.index, fileIndex: actual.fileIndex, directoryIndex: actual.directoryIndex, summary: actual.summary }, name);
    const staleArtifacts = after.artifacts.filter((a) => a.state === 'STALE' && /directories\/|summaries\//.test(a.path)).map((a) => a.path).sort();
    for (const p of predicted.affectedArtifacts) assert.ok(staleArtifacts.includes(p), `${name}: ${p} predicted stale and is`);
    for (const p of staleArtifacts.filter((x) => /directories\//.test(x))) assert.ok(predicted.affectedArtifacts.includes(p) || file.status === 'created', `${name}: ${p} is stale and was predicted`);
  }
});

test('40 impact analysis performs no refresh: it names what to rely on and, through the command, the existing decision', () => {
  const dir = project();
  assert.equal(cli(['index', dir], dir).status, 0);
  fs.appendFileSync(path.join(dir, 'src/core/util.ts'), 'export const more = 1;\n');
  const snap = () => JSON.stringify(Object.fromEntries((function walk(x) { return fs.readdirSync(x, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(x, e.name)) : [[path.relative(dir, path.join(x, e.name)), fs.readFileSync(path.join(x, e.name), 'latin1').length]])); })(dir)));
  const before = snap();
  const out = cli(['change-impact', dir, '--json', '--modified', 'src/core/util.ts', '--class', 'SMALL'], dir);
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout);
  assert.equal(r.graph.used, false, 'the graph artifact is stale after the edit: not used');
  assert.deepEqual(['decision', 'reason', 'level'].map((k) => k in r.intelligenceImpact.refreshDecision), [true, true, true]);
  assert.ok(['AUTO_REFRESH', 'PROPOSE_REFRESH', 'NO_REFRESH', 'BLOCKED'].includes(r.intelligenceImpact.refreshDecision.decision));
  assert.equal(snap(), before, 'nothing was refreshed or written');
  assert.equal(r.intelligenceImpact.graph, 'stale');
});

// ---- the command line, paths, security -----------------------------------------------------------------------------

test('29 30 31 Windows paths with spaces, OneDrive-like folders and non-ASCII names work end to end', () => {
  for (const nested of [['with spaces', 'my project'], ['OneDrive', 'Belgeler Ünlü', 'Proje Ç ş']]) {
    const dir = project({ 'src/my dir/ünlü.ts': "import { u } from '../core/util';\nexport const x = u;\n", 'src/my dir/a b.test.ts': "import { x } from './ünlü';\nvoid x;\n", 'app/[id]/page.tsx': "import { u } from '../../src/core/util';\nexport default () => u;\n" }, { nested });
    assert.equal(cli(['index', dir, '--profile', 'full'], dir).status, 0);
    const out = cli(['change-impact', dir, '--json', '--fresh-graph', '--modified', 'src/core/util.ts', '--class', 'SMALL'], dir);
    assert.equal(out.status, 0, out.stderr);
    const r = JSON.parse(out.stdout);
    assert.ok(ids(r.directImpact.dependents).includes('src/my dir/ünlü.ts'));
    assert.ok(ids(r.directImpact.dependents).includes('app/[id]/page.tsx'), 'bracketed route paths are literal');
    assert.ok(r.affectedTests.consumer.includes('src/my dir/a b.test.ts'));
    assert.ok(!out.stdout.includes(dir), 'no absolute path in the report');
    const mod2 = JSON.parse(cli(['change-impact', dir, '--json', '--fresh-graph', '--modified', 'src/my dir/ünlü.ts,app/[id]/page.tsx'], dir).stdout);
    assert.deepEqual(mod2.changedFiles.map((c) => [c.path, c.known]), [['src/my dir/ünlü.ts', true], ['app/[id]/page.tsx', true]]);
    // intelligence impact names the artifact path the engine wrote (slug), not the raw directory name
    const status = JSON.parse(cli(['status', dir, '--json'], dir).stdout);
    const withArtifacts = analyzeChangeImpact({ files: [{ path: 'src/my dir/ünlü.ts', status: 'modified' }] }, { state: 'current', artifacts: { directoryIndex: 'current', summary: 'current', graph: 'current', index: 'current', fileIndex: 'current' } }, { artifacts: status.artifacts.map((a) => ({ ...a, outputDir: '.ai' })) });
    assert.ok(withArtifacts.intelligenceImpact.affectedArtifacts.includes('.ai/directories/src/DIRECTORY_INDEX.md'), 'the directory index that contains the file');
    const synthetic = analyzeChangeImpact({ files: [{ path: 'src/my dir/ünlü.ts', status: 'modified' }] }, { state: 'current', artifacts: { directoryIndex: 'current', summary: 'current', graph: 'current', index: 'current', fileIndex: 'current' } }, { artifacts: [{ path: `.ai/${directoryIndexRel('src/my dir')}`, kind: 'directory index', state: 'CURRENT', outputDir: '.ai' }, { path: `.ai/${directoryIndexRel('src/other')}`, kind: 'directory index', state: 'CURRENT', outputDir: '.ai' }] });
    assert.deepEqual(synthetic.intelligenceImpact.affectedArtifacts, ['.ai/directories/src/my_dir/DIRECTORY_INDEX.md'], 'the slug the engine writes, and only the containing directory');
  }
});

test('32 33 41 impact analysis writes nothing, spawns nothing and uses no network: the closure is pure and read-only', () => {
  const seen = new Map();
  (function visit(file) {
    if (seen.has(file)) return;
    const imports = [...fs.readFileSync(file, 'utf8').matchAll(/^import[^;]*?from\s+'([^']+)';/gms)].map((m) => m[1]);
    seen.set(file, imports);
    for (const i of imports.filter((x) => x.startsWith('.'))) visit(path.resolve(path.dirname(file), i));
  })(path.join(TOOLS_ROOT, 'automation', 'change-impact.mjs'));
  const files = [...seen.keys()].map((f) => path.relative(TOOLS_ROOT, f).split(path.sep).join('/')).sort();
  assert.ok(!files.includes('automation/refresh.mjs') && !files.includes('lib/pipeline.mjs'), 'no refresh and no engine pipeline in the closure');
  assert.ok(files.includes('automation/context-router.mjs') && files.includes('automation/records.mjs') && files.includes('lib/artifact-paths.mjs'), 'it reuses the router, the records and the artifact names');
  const builtins = [...new Set([...seen.values()].flat().filter((x) => x.startsWith('node:')))];
  assert.deepEqual(builtins.filter((b) => ['node:fs', 'node:child_process', 'node:net', 'node:http', 'node:https', 'node:dns', 'node:worker_threads', 'node:vm', 'node:os', 'node:fs/promises'].includes(b)), []);
  for (const f of seen.keys()) {
    const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/writeFile|appendFile|mkdirSync|rmSync|spawn|execSync|fetch\(|process\.env|npm |npx |node --test/.test(code), `${path.relative(TOOLS_ROOT, f)}: no write, process, network, environment or test-runner call`);
  }
  const dir = project();
  assert.equal(cli(['index', dir], dir).status, 0);
  const snap = () => JSON.stringify(Object.fromEntries((function walk(x) { return fs.readdirSync(x, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(x, e.name)) : [[path.relative(dir, path.join(x, e.name)), fs.statSync(path.join(x, e.name)).mtimeMs]])); })(dir)));
  const home = tmpDir('pi-impact-home-');
  const before = snap();
  for (const args of [['--modified', 'src/core/util.ts'], ['--modified', 'src/core/util.ts', '--fresh-graph'], ['--phase', 'planned', '--deleted', 'src/core/util.ts', '--renamed', 'src/core/format.ts=src/core/fmt.ts', '--created', 'src/new.ts']]) {
    const out = cli(['change-impact', dir, '--json', ...args], home, { ...process.env, TEMP: home, TMP: home, TMPDIR: home });
    assert.equal(out.status, 0, out.stderr);
  }
  assert.equal(snap(), before, 'the project is unchanged');
  assert.deepEqual(fs.readdirSync(home), []);
});

test('missing intelligence: no second index system, no .ai/ is created, and the result says what it could not know', () => {
  const dir = project();
  const before = fs.readdirSync(dir).sort();
  const out = cli(['change-impact', dir, '--json', '--modified', 'src/core/util.ts', '--class', 'MEDIUM', '--types', 'refactor'], dir);
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout);
  assert.deepEqual([r.graph.used, r.graph.state, r.confidence], [false, 'missing', 'low']);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  assert.ok(!fs.existsSync(path.join(dir, '.ai')));
  assert.equal(r.intelligenceImpact.refreshDecision.decision, 'NO_REFRESH');
  assert.equal(r.intelligenceImpact.refreshDecision.reason, 'missing-targeted-inspection', 'a first index is only ever proposed by the refresh rules');
  assert.equal(r.intelligenceImpact.graph, 'missing');
});

test('42 class does not decide the size of the impact: evidence does', () => {
  const dir = project();
  const leafArch = fresh(dir, { ...mod('src/features/c.ts'), taskClass: 'ARCHITECTURAL' });
  assert.deepEqual([leafArch.directImpact.dependents.length, leafArch.transitiveImpact.dependents.length, leafArch.requiredValidation.depth], [0, 0, 'V4']);
  const utilTrivial = fresh(dir, { ...mod('src/core/util.ts'), taskClass: 'TRIVIAL' });
  assert.ok(utilTrivial.directImpact.dependents.length >= 4, 'a TRIVIAL change to a shared file still has its dependents');
  assert.equal(utilTrivial.requiredValidation.depth, 'V0');
  assert.equal(utilTrivial.class.value, 'TRIVIAL', 'dependents alone do not reclassify');
});

test('37 38 context reopening goes through the canonical router, with no routing logic of its own', () => {
  const dir = project();
  const r = fresh(dir, { ...mod('src/index.ts'), taskClass: 'SMALL', taskTypes: ['feature'] }, CURRENT, { reached: 3 });
  assert.equal(r.requiredContext.justified, true);
  const direct = routeContext({ taskClass: 'SMALL', risk: r.risk.level, taskTypes: ['feature'], targets: ['src/index.ts'], signals: { publicSurface: true }, intent: 'change', event: 'CONTEXT_EXPANDED' }, CURRENT, { reached: 3 });
  assert.deepEqual([r.requiredContext.plan.level, r.requiredContext.plan.minimumLevel, r.requiredContext.plan.ceiling, r.requiredContext.plan.reasons], [direct.level, direct.minimumLevel, direct.ceiling, direct.reasons], 'the plan is the router\'s own');
  assert.deepEqual(r.requiredContext.plan.requiredSources, direct.requiredSources);
  assert.deepEqual([r.class.value, r.requiredValidation.depth], [direct.class, direct.validationNeeds.depth], 'class and validation come from the router');
  // an agent that stopped at Level 2 gets the next level up to Level 4 through the router
  const shallow = fresh(dir, { ...mod('src/index.ts'), taskClass: 'SMALL' }, CURRENT, { reached: 2 });
  assert.equal(shallow.requiredContext.plan.level, 3);
  const deeper = fresh(dir, { ...mod('src/index.ts'), taskClass: 'SMALL' }, CURRENT, { reached: 3 });
  assert.ok(deeper.requiredContext.plan.evaluation?.action === 'evaluate' || deeper.requiredContext.plan.level >= 4);
  // nothing new was discovered: no reason to reopen
  const quiet = fresh(dir, mod('src/features/c.ts'));
  assert.deepEqual([quiet.requiredContext.justified, quiet.requiredContext.plan], [false, null]);
  // dependents the agent already holds are not "new"
  const holdsAll = fresh(dir, mod('src/core/util.ts'), CURRENT, { loaded: ['src/core/format.ts', 'src/core/util.test.ts', 'src/cycle/y.ts', 'src/ui/Button.tsx'].map((p) => ({ path: p, unchanged: true })), known: { tests: ['src/core/util.test.ts', 'src/features/a.test.ts', 'src/ui/Button.test.tsx'] } });
  assert.ok(!holdsAll.requiredContext.reasons.includes('new-dependents') && !holdsAll.requiredContext.reasons.includes('tests-expanded'));
  const src = fs.readFileSync(path.join(TOOLS_ROOT, 'automation', 'change-impact.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/CLASS_CEILING|levelDrivers|ceilingOf|minimumLevelOf|impactNeed|ESCALATION_REASONS|CLASS_VALIDATION_DEPTH|validationNeeds\(/.test(src), 'no routing or validation policy in the impact module');
});

test('34 35 no adapter has an impact engine, and only canonical graph capabilities are used', () => {
  const offenders = [];
  for (const adapter of ['claude', 'codex', 'antigravity']) {
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'tests' && e.name !== 'node_modules') walk(abs);
        } else if (e.name.endsWith('.mjs') && /analyzeChangeImpact|change-impact|normalizeChangeSet|predictIntelligenceImpact|getImpact\(|createGraphQuery/.test(fs.readFileSync(abs, 'utf8'))) offenders.push(path.relative(REPO, abs));
      }
    })(path.join(REPO, 'adapters', adapter));
  }
  assert.deepEqual(offenders, []);
  for (const f of ['codex/skill/references/context.md', 'antigravity/skill/references/context.md', 'claude/skill/references/context-routing.md']) assert.match(read('adapters', f), /intel change-impact/, `${f} points to the canonical command`);
  // every graph function the module calls is a real library function in the capability matrix; none is presented as a command
  const src = fs.readFileSync(path.join(TOOLS_ROOT, 'automation', 'change-impact.mjs'), 'utf8');
  const used = [...new Set([...src.matchAll(/query\.(\w+)\(/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, ['getCycles', 'getDependencies', 'getImpact', 'getNode']);
  const readme = read('tools', 'analyze', 'README.md');
  const matrix = readme.slice(readme.indexOf('## Capability matrix'), readme.indexOf('## Limits'));
  for (const fn of used) assert.ok(matrix.includes(`\`${fn}\``) || readme.includes(`\`${fn}`), `${fn} is a documented query`);
  assert.ok(!/shortestPath|getNeighborhood|getTransitive/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), 'library-only questions that the report does not need are not used');
  assert.ok(Object.getOwnPropertyNames(createGraphQuery({ nodes: [], edges: [], cycles: [] })).includes('getImpact'));
});

test('the command line validates its input and never scans for a change set', () => {
  const dir = tmpDir('pi-impact-cli-');
  writeTree(dir, BASE);
  const bad = (args, pattern) => {
    const r = cli(['change-impact', dir, ...args], dir);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, pattern, args.join(' '));
  };
  bad([], /needs the changed files/);
  bad(['--modified', '../x.ts'], /not a plain project-relative path/);
  bad(['--modified', 'src/*.ts'], /not a plain project-relative path/);
  bad(['--modified', 'a.ts', '--renamed', 'noequals'], /old=new/);
  bad(['--modified', 'a.ts', '--phase', 'later'], /--phase must be/);
  bad(['--modified', 'a.ts', '--class', 'HUGE'], /--class must be one of/);
  bad(['--modified', 'a.ts', '--state', 'fine'], /--state must be one of/);
  bad(['--modified', 'a.ts', '--signals', 'vibes'], /unknown --signals/);
  bad(['--modified', 'a.ts', '--view', 'full'], /do not apply to change-impact/);
  bad(['--modified', 'a.ts', '--declined', 'x'], /do not apply to change-impact/);
  bad(['--modified', 'a.ts', '--reached', '9'], /--reached/);
  bad(['--modified', 'a.ts', '--config', path.join(dir, 'nope.json')], /--config file not found/);
  assert.ok(!fs.existsSync(path.join(dir, '.ai')), 'argument errors write nothing');
  const ok = JSON.parse(cli(['change-impact', dir, '--json', '--state', 'current', '--artifacts', 'graph=missing', '--modified', 'src/core/util.ts'], dir).stdout);
  assert.deepEqual([ok.graph.used, ok.graph.artifact], [false, 'missing']);
  const text = cli(['change-impact', dir, '--state', 'missing', '--modified', 'src/core/util.ts'], dir).stdout;
  assert.match(text, /^impact of 1 changed file\(s\) \(completed\); graph: not used/);
  assert.ok(os.platform().length > 0);
});
