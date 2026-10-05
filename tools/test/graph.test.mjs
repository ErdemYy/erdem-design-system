import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildProjectGraph } from '../lib/pipeline.mjs';
import { validate } from '../lib/jsonschema.mjs';
import { stableStringify } from '../lib/json.mjs';
import { cleanup, copyFixture, makeTree, FIXTURES, TOOLS_ROOT } from './helpers.mjs';

after(cleanup);

const graphOf = (name, overrides) => buildProjectGraph(path.join(FIXTURES, name), overrides ? { overrides } : {});
const edgeList = (g) => g.edges.map((e) => `${e.source} -${e.type}/${e.kind}${e.typeOnly ? '/type' : ''}-> ${e.target}`);

test('TypeScript, TSX, JavaScript, CommonJS, dynamic import, re-export and alias edges', () => {
  const { graph } = graphOf('app');
  const edges = edgeList(graph);
  const must = [
    'src/index.ts -imports/static-> src/util.ts', // TS import
    'src/index.ts -imports/static-> src/components/Button.tsx', // TSX import
    'src/components/Button.tsx -imports/static-> src/util.ts', // relative import from TSX
    'src/index.ts -imports/static-> src/legacy.js', // JS import, explicit .js extension
    'src/index.ts -imports/require-> src/cjs.cjs', // CommonJS
    'src/index.ts -imports/dynamic-> src/lazy.ts', // dynamic import
    'src/index.ts -exports/reexport-> src/util.ts', // export * from
    'src/index.ts -exports/reexport-> src/components/Button.tsx', // export { default as } from
    'src/index.ts -imports/side-effect-> src/side.ts', // tsconfig paths alias, side-effect
    'src/index.ts -imports/static/type-> src/types.ts', // type-only
    'src/index.ts -imports/side-effect-> src/styles/main.css', // non-code import still a node
    'src/index.ts -imports/static-> ext:react', // external package
  ];
  for (const e of must) assert.ok(edges.includes(e), `missing edge: ${e}`);
  assert.equal(graph.edges.length, 18);
  assert.deepEqual(graph.stats.edgesByType, { exports: 2, imports: 16 });
});

test('no edges are invented: unsupported languages and non-literal specifiers', () => {
  const { graph } = graphOf('app');
  for (const id of ['scripts/tool.py', 'lib/Thing.java', 'native/widget.dart']) {
    const n = graph.nodes.find((x) => x.id === id);
    assert.deepEqual(n.imports, [], id);
    assert.equal(n.metadata.dependencyAnalysis, 'none');
    assert.equal(n.risk, null, `${id} has no evidence for a risk level`);
  }
  assert.ok(graph.edges.every((e) => ['imports', 'exports', 'references'].includes(e.type)));
  assert.deepEqual(graph.stats.languagesMetadataOnly, { css: 1, dart: 1, java: 1, python: 1 });
  const syntax = graphOf('syntax').graph;
  assert.deepEqual(edgeList(syntax), ['tricky.ts -imports/dynamic-> real-dynamic.ts', 'tricky.ts -imports/require-> real.ts']);
});

test('cyclic dependencies are detected and do not break traversal', () => {
  const { graph, query } = graphOf('app');
  assert.deepEqual(graph.cycles, [['src/cycle/a.ts', 'src/cycle/b.ts']]);
  assert.equal(graph.nodes.find((n) => n.id === 'src/cycle/a.ts').metadata.inCycle, true);
  assert.equal(graph.nodes.find((n) => n.id === 'src/util.ts').metadata.inCycle, false);
  const impact = query.getImpact('src/cycle/a.ts');
  assert.deepEqual(impact.affected.map((a) => a.id), ['src/cycle/b.ts']);
});

test('self-import is a cycle of one', () => {
  const dir = makeTree({ 'a.ts': "import './a';\nexport const a = 1;\n" });
  assert.deepEqual(buildProjectGraph(dir).graph.cycles, [['a.ts']]);
});

test('public surface is evidence based', () => {
  const { graph } = graphOf('app');
  const reasons = (id) => graph.nodes.find((n) => n.id === id).metadata.publicSurfaceReasons;
  assert.deepEqual(reasons('src/index.ts'), ['package-entry']);
  assert.deepEqual(reasons('src/shared/format.ts'), ['shared-module']);
  assert.deepEqual(reasons('package.json'), ['global-config']);
  assert.equal(graph.nodes.find((n) => n.id === 'src/util.ts').publicSurface, false, 'exports alone never make a public surface');
  assert.equal(graph.nodes.find((n) => n.id === 'src/index.ts').metadata.entryPoint, true);

  const next = graphOf('nextapp').graph;
  const routes = next.nodes.filter((n) => n.metadata.publicSurfaceReasons?.includes('framework-route')).map((n) => n.id);
  assert.deepEqual(routes, ['app/about/page.tsx', 'app/layout.tsx', 'app/page.tsx']);
  assert.equal(next.nodes.find((n) => n.id === 'lib/not-a-route.ts').publicSurface, false);

  const plain = graphOf('plainapp').graph;
  assert.equal(plain.nodes.find((n) => n.id === 'app/page.tsx').publicSurface, false, 'same folder layout without the framework dependency is not a route');
});

test('risk is conservative and carries its evidence', () => {
  const { graph } = graphOf('app');
  const risk = (id) => graph.nodes.find((n) => n.id === id);
  assert.equal(risk('src/index.ts').risk, 'HIGH');
  assert.match(risk('src/index.ts').metadata.riskBasis.join(' '), /package entry/);
  assert.equal(risk('src/shared/format.ts').risk, 'MEDIUM');
  assert.equal(risk('src/lazy.ts').risk, 'LOW');
  assert.equal(risk('src/util.test.ts').risk, 'LOW');
  assert.equal(risk('package.json').risk, 'HIGH');
  // CRITICAL only through an explicit project rule; names alone never raise risk
  assert.notEqual(risk('src/side.ts').risk, 'CRITICAL');
  const configured = graphOf('app', { risk: { fanInMedium: 3, fanInHigh: 10, rules: [{ pattern: 'src/side.ts', level: 'CRITICAL', reason: 'declared critical by the project' }] } }).graph;
  const side = configured.nodes.find((n) => n.id === 'src/side.ts');
  assert.equal(side.risk, 'CRITICAL');
  assert.match(side.metadata.riskBasis.join(' '), /declared critical/);
});

test('names such as auth or migration do not raise risk', () => {
  const dir = makeTree({ 'src/auth/login.ts': 'export const login = 1;\n', 'src/db/migrations/001.ts': 'export const m = 1;\n' });
  const { graph } = buildProjectGraph(dir);
  for (const n of graph.nodes) assert.ok(n.risk === 'LOW' || n.risk === null, `${n.id} risk ${n.risk}`);
});

test('workspace packages resolve through the manifest; external packages stay external', () => {
  const { graph } = graphOf('monorepo');
  const edges = edgeList(graph);
  assert.ok(edges.includes('apps/web/src/main.ts -imports/static-> packages/ui/src/index.ts'));
  assert.ok(edges.includes('apps/web/src/main.ts -imports/static-> packages/ui/src/button.ts'));
  assert.ok(edges.includes('apps/web/src/main.ts -imports/static-> ext:left-pad'));
  assert.ok(edges.includes('packages/ui/src/index.ts -exports/reexport-> packages/ui/src/button.ts'));
  assert.equal(graph.nodes.find((n) => n.id === 'packages/ui/src/index.ts').metadata.publicSurfaceReasons.includes('package-entry'), true);
});

test('workspace names are NOT resolved without a declared workspaces field', () => {
  const dir = makeTree({
    'package.json': '{ "name": "root" }',
    'packages/ui/package.json': '{ "name": "@x/ui", "main": "index.ts" }',
    'packages/ui/index.ts': 'export const u = 1;\n',
    'app.ts': "import { u } from '@x/ui';\nexport const a = u;\n",
  });
  const { graph } = buildProjectGraph(dir);
  assert.ok(edgeList(graph).includes('app.ts -imports/static-> ext:@x/ui'));
});

test('dependency folders are never resolved into project files', () => {
  const dir = makeTree({
    'src/a.ts': "import x from 'pkg';\nimport y from './missing';\nexport const a = [x, y];\n",
    'node_modules/pkg/index.js': 'module.exports = 1;\n',
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": "." } }',
  });
  const { graph, diagnostics } = buildProjectGraph(dir);
  assert.ok(edgeList(graph).includes('src/a.ts -imports/static-> ext:pkg'));
  assert.ok(!graph.nodes.some((n) => n.id.includes('node_modules')));
  assert.ok(diagnostics.some((d) => d.code === 'unresolved-import' && d.path === 'src/a.ts' && /missing/.test(d.message)));
  assert.equal(graph.stats.unresolvedImports, 1);
  assert.ok(!graph.edges.some((e) => e.target.includes('missing')), 'unresolved imports are diagnostics, not edges');
});

test('import resolution: extension swap, directory index, TypeScript ESM .js specifiers', () => {
  const dir = makeTree({
    'src/main.ts': "import './swap.js';\nimport './folder';\nimport './plain';\nimport './comp';\nimport './data.json';\n",
    'src/swap.ts': 'export {}\n',
    'src/folder/index.ts': 'export {}\n',
    'src/plain.js': 'export {}\n',
    'src/comp.tsx': 'export {}\n',
    'src/data.json': '{}',
  });
  const targets = buildProjectGraph(dir).graph.edges.filter((e) => e.source === 'src/main.ts').map((e) => e.target);
  assert.deepEqual(targets, ['src/comp.tsx', 'src/data.json', 'src/folder/index.ts', 'src/plain.js', 'src/swap.ts']);
});

test('configured relationships are the only way to link unsupported languages', () => {
  const dir = makeTree({ 'scripts/run.py': 'import helper\n', 'scripts/helper.py': 'x = 1\n', 'a.ts': 'export {}\n' });
  const base = buildProjectGraph(dir).graph;
  assert.equal(base.edges.length, 0);
  const linked = buildProjectGraph(dir, { overrides: { graph: { explicitEdges: [{ source: 'scripts/run.py', target: 'scripts/helper.py' }, { source: 'nope.py', target: 'a.ts' }] } } });
  assert.deepEqual(edgeList(linked.graph), ['scripts/run.py -references/configured-> scripts/helper.py']);
  assert.ok(linked.diagnostics.some((d) => d.code === 'invalid-explicit-edge'));
  const consumers = linked.graph.nodes.find((n) => n.id === 'scripts/helper.py');
  assert.deepEqual(consumers.consumers, ['scripts/run.py']);
  assert.deepEqual(consumers.importers, [], 'importers are `imports` edges only');
});

test('deterministic output: identical graphs from different copies and different scan inputs', () => {
  const a = buildProjectGraph(copyFixture('app')).graph;
  const b = buildProjectGraph(copyFixture('app')).graph;
  const strip = (g) => stableStringify({ ...g, generatedAt: 'x' });
  assert.equal(strip(a), strip(b));
  const sorted = (arr) => arr.every((v, i) => i === 0 || arr[i - 1] <= v);
  assert.ok(sorted(a.nodes.map((n) => n.id)));
  assert.ok(sorted(a.edges.map((e) => `${e.source}\0${e.target}`)));
  for (const n of a.nodes) {
    assert.ok(sorted(n.imports) && sorted(n.importers) && sorted(n.consumers) && sorted(n.exports), n.id);
  }
});

test('graph.json conforms to the published schema', () => {
  const { graph } = graphOf('app');
  const schema = JSON.parse(fs.readFileSync(path.join(TOOLS_ROOT, 'graph/schema/graph.schema.v1.json'), 'utf8'));
  assert.deepEqual(validate(JSON.parse(stableStringify(graph)), schema), []);
  assert.equal(graph.schema, 'erdem.graph');
  assert.equal(graph.schemaVersion, 1);
  const broken = JSON.parse(stableStringify(graph));
  broken.nodes[0].risk = 'EXTREME';
  delete broken.edges[0].kind;
  assert.ok(validate(broken, schema).length >= 2);
});

test('node fingerprints are present and carry the algorithm', () => {
  const { graph } = graphOf('app');
  const n = graph.nodes.find((x) => x.id === 'src/util.ts');
  assert.equal(n.fingerprint.algo, 'sha256');
  assert.match(n.fingerprint.hash, /^[0-9a-f]{64}$/);
  assert.equal(graph.nodes.find((x) => x.id === 'ext:react').fingerprint, null);
  assert.match(graph.fingerprint.hash, /^[0-9a-f]{64}$/);
});

test('malformed files stay in the graph, flagged, without breaking neighbors', () => {
  const { graph, scan } = graphOf('malformed');
  assert.equal(graph.nodes.find((n) => n.id === 'bad.ts').metadata.parseStatus, 'partial');
  assert.ok(edgeList(graph).includes('consumer.ts -imports/static-> bad.ts'));
  assert.ok(scan.diagnostics.some((d) => d.path === 'bad.ts' && d.severity === 'error'));
  assert.match(graph.nodes.find((n) => n.id === 'bad.ts').metadata.riskBasis.join(' '), /partially parsed/);
});

test('root files that do not drive the build are not global-config surfaces', () => {
  const dir = makeTree({ '.gitignore': 'x\n', '.editorconfig': 'root = true\n', 'tsconfig.json': '{}', 'a.ts': 'export {}\n' });
  const { graph } = buildProjectGraph(dir);
  assert.ok(!graph.nodes.some((n) => n.id === '.gitignore' || n.id === '.editorconfig'));
  assert.deepEqual(graph.nodes.find((n) => n.id === 'tsconfig.json').metadata.publicSurfaceReasons, ['global-config']);
});
