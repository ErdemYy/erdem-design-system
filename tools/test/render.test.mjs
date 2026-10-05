import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildProjectGraph } from '../lib/pipeline.mjs';
import { buildView } from '../graph/views.mjs';
import { renderMermaid, mermaidLabel } from '../graph/render-mermaid.mjs';
import { renderDot, dotString } from '../graph/render-dot.mjs';
import { makeSafeIds } from '../graph/ids.mjs';
import { cleanup, makeTree, validateDot, validateMermaid, FIXTURES } from './helpers.mjs';

after(cleanup);

const appGraph = () => buildProjectGraph(path.join(FIXTURES, 'app'));

test('Mermaid output is valid, uses hashed ids and never raw paths in identifiers', () => {
  const { graph, query } = appGraph();
  const view = buildView(graph, { mode: 'full', query });
  const text = renderMermaid(view);
  assert.deepEqual(validateMermaid(text), []);
  assert.match(text, /^%% project-intel graph view/);
  assert.match(text, /\nflowchart TD\n/);
  for (const m of text.matchAll(/^\s*(n[0-9a-f]+)\[/gm)) assert.match(m[1], /^n[0-9a-f]{8,}$/);
  assert.ok(!/\bsrc\/index\.ts\s*(-->|\[)/.test(text));
  assert.ok(text.includes('["src/index.ts"]'), 'labels carry the readable path');
});

test('DOT output is valid without Graphviz', () => {
  const { graph, query } = appGraph();
  const text = renderDot(buildView(graph, { mode: 'full', query }));
  assert.deepEqual(validateDot(text), []);
  assert.match(text, /^digraph "project_intel" \{/);
  assert.ok(text.trimEnd().endsWith('}'));
});

test('labels are escaped safely in both formats', () => {
  const nasty = 'a "quote" <b> #hash `tick` \\ back';
  const ml = mermaidLabel(nasty);
  assert.ok(!/["<>`]/.test(ml));
  assert.ok(ml.includes('#quot;') && ml.includes('#lt;') && ml.includes('#gt;') && ml.includes('#96;') && ml.includes('#35;'));
  const dl = dotString(nasty);
  assert.ok(!/(?<!\\)"/.test(dl));
  // characters that are legal in file names on every OS but meaningful in diagram syntax
  const dir = makeTree({ 'src/we#ird [name] (1) `x` &.ts': 'export const a = 1;\n', 'src/b.ts': "import './we#ird [name] (1) `x` &';\n" });
  const { graph, query } = buildProjectGraph(dir);
  const view = buildView(graph, { mode: 'full', query });
  assert.deepEqual(validateMermaid(renderMermaid(view)), []);
  assert.deepEqual(validateDot(renderDot(view)), []);
});

test('safe ids are stable, unique and path-free', () => {
  const ids = makeSafeIds(['a/b.ts', 'a/c.ts', 'ext:react']);
  assert.equal(new Set(ids.values()).size, 3);
  for (const v of ids.values()) assert.match(v, /^n[0-9a-f]+$/);
  assert.deepEqual([...makeSafeIds(['a/b.ts', 'a/c.ts', 'ext:react'])], [...ids]);
});

test('FULL view: files when small, subsystem overview when large, never unbounded', () => {
  const { graph, query } = appGraph();
  const small = buildView(graph, { mode: 'full', query, maxNodes: 60 });
  assert.equal(small.level, 'file');
  assert.ok(small.nodes.every((n) => n.kind === 'file'), 'externals and tests are hidden by default');
  assert.ok(!small.nodes.some((n) => n.id === 'src/util.test.ts'));

  const agg = buildView(graph, { mode: 'full', query, maxNodes: 8 });
  assert.equal(agg.level, 'subsystem');
  assert.ok(agg.nodes.length <= 8);
  assert.ok(agg.notes.some((n) => /exceed maxNodes/.test(n)));
  assert.deepEqual(validateMermaid(renderMermaid(agg)), []);
  assert.deepEqual(validateDot(renderDot(agg)), []);
  assert.ok(agg.edges.every((e) => e.weight >= 1));

  const tiny = buildView(graph, { mode: 'full', query, maxNodes: 3 });
  assert.ok(tiny.nodes.length <= 3);
  assert.equal(tiny.truncated.unit, 'subsystems');
  const text = renderMermaid(tiny);
  assert.match(text, /note_truncated\["\+\d+ more subsystems omitted/);
  assert.deepEqual(validateMermaid(text), []);
});

test('SUBSYSTEM view: the directory plus its direct outside neighbors', () => {
  const { graph, query } = appGraph();
  const view = buildView(graph, { mode: 'subsystem', target: 'src/shared', query });
  const ids = view.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['src/alpha/a.ts', 'src/beta/b.ts', 'src/gamma/g.ts', 'src/shared/format.ts']);
  assert.equal(view.nodes.find((n) => n.id === 'src/shared/format.ts').outside, false);
  assert.equal(view.nodes.find((n) => n.id === 'src/alpha/a.ts').outside, true);
  assert.deepEqual(validateMermaid(renderMermaid(view)), []);
  assert.deepEqual(validateDot(renderDot(view)), []);
});

test('FILE view: target plus direct neighbors; depth widens it', () => {
  const { graph, query } = appGraph();
  const one = buildView(graph, { mode: 'file', target: 'src/components/Button.tsx', query });
  assert.deepEqual(one.nodes.map((n) => n.id).sort(), ['src/components/Button.tsx', 'src/index.ts', 'src/util.ts']);
  assert.equal(one.nodes.find((n) => n.target).id, 'src/components/Button.tsx');
  const chain = buildProjectGraph(makeTree({ 'a.ts': "import './b';\n", 'b.ts': "import './c';\n", 'c.ts': "import './d';\n", 'd.ts': 'export {}\n' }));
  const near = buildView(chain.graph, { mode: 'file', target: 'b.ts', depth: 1, query: chain.query });
  const wide = buildView(chain.graph, { mode: 'file', target: 'b.ts', depth: 2, query: chain.query });
  assert.deepEqual(near.nodes.map((n) => n.id).sort(), ['a.ts', 'b.ts', 'c.ts']);
  assert.deepEqual(wide.nodes.map((n) => n.id).sort(), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  assert.deepEqual(validateMermaid(renderMermaid(one)), []);
});

test('IMPACT view: target plus affected downstream nodes, tests included', () => {
  const { graph, query } = appGraph();
  const view = buildView(graph, { mode: 'impact', target: 'src/util.ts', query });
  assert.deepEqual(view.nodes.map((n) => n.id).sort(), ['src/components/Button.tsx', 'src/index.ts', 'src/util.test.ts', 'src/util.ts']);
  assert.ok(view.nodes.find((n) => n.id === 'src/util.ts').target);
  const text = renderMermaid(view);
  assert.deepEqual(validateMermaid(text), []);
  assert.match(text, /class n[0-9a-f]+ target;/);
});

test('views degrade safely: unknown target, empty view, bad mode', () => {
  const { graph, query } = appGraph();
  const missing = buildView(graph, { mode: 'file', target: 'nope.ts', query });
  assert.equal(missing.nodes.length, 0);
  assert.deepEqual(validateMermaid(renderMermaid(missing)), []);
  assert.deepEqual(validateDot(renderDot(missing)), []);
  assert.throws(() => buildView(graph, { mode: 'wat', query }), /Unknown view mode/);
});

test('view truncation is deterministic and keeps the target', () => {
  const { graph, query } = appGraph();
  const a = buildView(graph, { mode: 'impact', target: 'src/util.ts', maxNodes: 2, query });
  const b = buildView(graph, { mode: 'impact', target: 'src/util.ts', maxNodes: 2, query });
  assert.deepEqual(a, b);
  assert.equal(a.nodes.length, 2);
  assert.ok(a.nodes.some((n) => n.id === 'src/util.ts'));
  assert.equal(a.truncated.omitted, 2);
});

test('edge styles: re-export, dynamic and type-only are distinguishable', () => {
  const { graph, query } = appGraph();
  const text = renderMermaid(buildView(graph, { mode: 'file', target: 'src/index.ts', query }));
  assert.match(text, / -\.-> /);
  assert.match(text, / -\.->\|type\| /);
  const mono = buildProjectGraph(path.join(FIXTURES, 'monorepo'));
  const reexport = renderMermaid(buildView(mono.graph, { mode: 'file', target: 'packages/ui/src/index.ts', query: mono.query }));
  assert.match(reexport, / ==> /);
  const dot = renderDot(buildView(graph, { mode: 'file', target: 'src/index.ts', query }));
  assert.match(dot, /style=dashed/);
  assert.match(renderDot(buildView(mono.graph, { mode: 'file', target: 'packages/ui/src/index.ts', query: mono.query })), /penwidth=2/);
});
