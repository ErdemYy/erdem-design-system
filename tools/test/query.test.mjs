import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildProjectGraph } from '../lib/pipeline.mjs';
import { createGraphQuery } from '../analyze/query.mjs';
import { cleanup, makeTree, FIXTURES } from './helpers.mjs';

after(cleanup);

const { graph, query } = buildProjectGraph(path.join(FIXTURES, 'app'));

test('getNode accepts ids and loosely written paths', () => {
  assert.equal(query.getNode('src/util.ts').id, 'src/util.ts');
  assert.equal(query.getNode('./src/util.ts').id, 'src/util.ts');
  assert.equal(query.getNode('src\\util.ts').id, 'src/util.ts');
  assert.equal(query.getNode('react').id, 'ext:react');
  assert.equal(query.getNode('nope.ts'), null);
});

test('what does this file import / what imports this file', () => {
  assert.deepEqual(query.getDependencies('src/components/Button.tsx'), ['src/util.ts']);
  assert.deepEqual(query.getDependents('src/util.ts', { includeTests: false }), ['src/components/Button.tsx', 'src/index.ts']);
  assert.deepEqual(query.getDependents('src/util.ts'), ['src/components/Button.tsx', 'src/index.ts', 'src/util.test.ts']);
  assert.deepEqual(query.getDependencies('src/index.ts', { types: ['exports'], includeExternal: false }), ['src/components/Button.tsx', 'src/util.ts']);
  assert.deepEqual(query.getDependencies('src/index.ts', { includeExternal: false, includeTypeOnly: false }).includes('src/types.ts'), false);
  assert.deepEqual(query.getDependencies('missing.ts'), []);
});

test('transitive dependencies and dependents carry distances', () => {
  const dir = makeTree({ 'a.ts': "import './b';\n", 'b.ts': "import './c';\n", 'c.ts': 'export {}\n' });
  const q = buildProjectGraph(dir).query;
  assert.deepEqual(q.getTransitiveDependencies('a.ts'), [{ id: 'b.ts', distance: 1 }, { id: 'c.ts', distance: 2 }]);
  assert.deepEqual(q.getTransitiveDependents('c.ts'), [{ id: 'b.ts', distance: 1 }, { id: 'a.ts', distance: 2 }]);
  assert.deepEqual(q.getTransitiveDependents('c.ts', { maxDepth: 1 }), [{ id: 'b.ts', distance: 1 }]);
});

test('neighborhood: dependencies and dependents within a depth', () => {
  const dir = makeTree({ 'a.ts': "import './b';\n", 'b.ts': "import './c';\n", 'c.ts': "import './d';\n", 'd.ts': 'export {}\n' });
  const q = buildProjectGraph(dir).query;
  const n1 = q.getNeighborhood('b.ts', 1);
  assert.deepEqual(n1.nodes.map((n) => n.id).sort(), ['a.ts', 'b.ts', 'c.ts']);
  assert.equal(n1.center, 'b.ts');
  assert.equal(n1.edges.length, 2);
  assert.deepEqual(q.getNeighborhood('b.ts', 2).nodes.map((n) => n.id).sort(), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  assert.deepEqual(q.getNeighborhood('b.ts', 5, { direction: 'out' }).nodes.map((n) => n.id).sort(), ['b.ts', 'c.ts', 'd.ts']);
  assert.deepEqual(q.getNeighborhood('nope', 1), { center: null, nodes: [], edges: [] });
});

test('impact: downstream nodes, tests, public surfaces, risk, notes', () => {
  const impact = query.getImpact('src/util.ts');
  assert.equal(impact.found, true);
  assert.deepEqual(impact.directDependents, ['src/components/Button.tsx', 'src/index.ts', 'src/util.test.ts']);
  assert.deepEqual(impact.tests, ['src/util.test.ts']);
  assert.deepEqual(impact.publicSurfacesAffected, ['src/index.ts']);
  assert.equal(impact.maxRiskAmongAffected, 'HIGH');
  assert.equal(impact.risk.level, 'LOW');
  assert.ok(impact.notes[0].includes('superset'));
  assert.equal(impact.affectedCount, 3);
  const limited = query.getImpact('src/util.ts', { maxDepth: 1 });
  assert.equal(limited.affected.every((a) => a.distance === 1), true);
  assert.equal(query.getImpact('missing.ts').found, false);
});

test('impact of an unsupported-language file explains its limits', () => {
  const impact = query.getImpact('scripts/tool.py');
  assert.equal(impact.found, true);
  assert.equal(impact.risk.level, null);
  assert.ok(impact.notes.some((n) => /no dependency analysis for python/.test(n)));
});

test('public surfaces, tests, risk, subsystems, cycles', () => {
  assert.deepEqual(query.findPublicSurfaces().map((s) => s.id), ['package.json', 'src/index.ts', 'src/shared/format.ts', 'tsconfig.json']);
  assert.deepEqual(query.findPublicSurfaces({ reason: 'shared-module' }).map((s) => s.id), ['src/shared/format.ts']);
  assert.equal(query.isPublicSurface('src/index.ts'), true);
  assert.equal(query.isPublicSurface('src/util.ts'), false);
  assert.deepEqual(query.getTests('src/util.ts'), ['src/util.test.ts']);
  assert.deepEqual(query.getTests('src/lazy.ts'), []);
  assert.equal(query.getRisk('src/index.ts').level, 'HIGH');
  assert.equal(query.getRisk('nope'), null);
  assert.deepEqual(query.getSubsystem('src/shared'), ['src/shared/format.ts']);
  assert.ok(query.listSubsystems().some((s) => s.key === 'src/cycle' && s.files === 2));
  assert.deepEqual(query.getCycles(), [['src/cycle/a.ts', 'src/cycle/b.ts']]);
});

test('shortest dependency path, including through cycles', () => {
  assert.deepEqual(query.shortestPath('src/index.ts', 'src/util.ts'), ['src/index.ts', 'src/util.ts']);
  assert.deepEqual(query.shortestPath('src/cycle/a.ts', 'src/cycle/a.ts'), ['src/cycle/a.ts']);
  assert.equal(query.shortestPath('src/util.ts', 'src/index.ts'), null);
  assert.equal(query.shortestPath('x', 'y'), null);
});

test('the query layer works on a graph loaded from JSON and never mutates it', () => {
  const copy = JSON.parse(JSON.stringify(graph));
  const frozen = JSON.stringify(copy);
  const q = createGraphQuery(copy);
  q.getImpact('src/util.ts');
  q.getNeighborhood('src/index.ts', 3);
  q.shortestPath('src/index.ts', 'src/util.ts');
  assert.equal(JSON.stringify(copy), frozen);
});
