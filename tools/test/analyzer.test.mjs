import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../lib/languages/javascript.mjs';
import { tokenize, leadingComment } from '../lib/languages/javascript-lexer.mjs';

const specs = (facts, kind) => facts.imports.filter((i) => !kind || i.kind === kind).map((i) => `${i.specifier}:${i.kind}${i.typeOnly ? ':type' : ''}`);

test('ES module imports: default, named, namespace, side-effect, type-only', () => {
  const f = analyze(
    `import a from './a';\nimport { b, c as d } from "./b";\nimport * as ns from './ns';\nimport './side';\nimport type { T } from './types';\nimport { type U, type V } from './more-types';\nimport { type W, x } from './mixed';\n`,
    { path: 'x.ts' },
  );
  assert.deepEqual(specs(f), [
    './a:static',
    './b:static',
    './mixed:static',
    './more-types:static:type',
    './ns:static',
    './side:side-effect',
    './types:static:type',
  ]);
  assert.equal(f.status, 'parsed');
});

test('multi-line import without semicolons does not swallow the next statement', () => {
  const f = analyze(`import {\n  a,\n  b,\n} from './multi'\nimport c from './after'\nconst x = 1\n`, { path: 'x.ts' });
  assert.deepEqual(specs(f), ['./after:static', './multi:static']);
});

test('TypeScript import = require, dynamic import and CommonJS require', () => {
  const f = analyze(`import fs = require('./fs-like');\nconst lazy = () => import('./lazy');\nconst c = require('./cjs');\nconst t = require(\`./tpl\`);\n`, { path: 'x.ts' });
  assert.deepEqual(specs(f), ['./cjs:require', './fs-like:require', './lazy:dynamic', './tpl:require']);
});

test('computed specifiers are never turned into edges', () => {
  const f = analyze(`const n = 'x';\nrequire(n);\nimport(n);\nimport(\`./a/\${n}\`);\nrequire('./' + n);\n`, { path: 'x.js' });
  assert.deepEqual(f.imports, []);
  assert.ok(f.diagnostics.some((d) => d.code === 'dynamic-import-non-literal'));
  assert.ok(f.diagnostics.some((d) => d.code === 'require-non-literal'));
});

test('re-exports are recorded separately from imports', () => {
  const f = analyze(`export * from './star';\nexport * as ns from './ns';\nexport { a, b as c } from './named';\nexport { default as D } from './d';\nexport type { T } from './t';\n`, { path: 'x.ts' });
  assert.deepEqual(f.imports, []);
  const r = f.reexports.map((x) => `${x.specifier}:${x.star ? '*' : x.names.join('+')}${x.typeOnly ? ':type' : ''}`);
  assert.deepEqual(r, ['./d:D', './named:a+c', './ns:ns', './star:*', './t:T:type']);
  assert.deepEqual(f.exports, ['*', 'D', 'T', 'a', 'c', 'ns']);
});

test('export names from declarations and lists', () => {
  const f = analyze(
    `export const a = 1;\nexport let b;\nexport function fn() {}\nexport async function af() {}\nexport function* gen() {}\nexport class K {}\nexport abstract class AK {}\nexport interface I {}\nexport type Ty = string;\nexport enum E {}\nexport const enum CE {}\nexport namespace NS {}\nexport default function () {}\nconst p = 1, q = 2;\nexport { p, q as renamed };\nexport declare const dc: number;\n`,
    { path: 'x.ts' },
  );
  assert.deepEqual(f.exports, ['AK', 'CE', 'E', 'I', 'K', 'NS', 'Ty', 'a', 'af', 'b', 'dc', 'default', 'fn', 'gen', 'p', 'renamed']);
});

test('CommonJS exports', () => {
  const f = analyze(`module.exports = { one, two: 2, three() {}, 'four': 4 };\nexports.five = 5;\nmodule.exports.six = 6;\n`, { path: 'x.cjs' });
  assert.deepEqual(f.exports, ['five', 'four', 'module.exports', 'one', 'six', 'three', 'two']);
});

test('comments, strings, template literals and regular expressions are never code', () => {
  const src = [
    "// import { a } from './comment';",
    "/* require('./block') */",
    "const s = \"import b from './string'\";",
    "const t = `import c from './tpl'; ${'require(\"./inner\")'}`;",
    "const r = /import\\s+d\\s+from\\s+'.\\/re'/;",
    "const ok = require('./real');",
  ].join('\n');
  const f = analyze(src, { path: 'x.ts' });
  assert.deepEqual(specs(f), ['./real:require']);
});

test('member access named import/export/require is not a statement', () => {
  const f = analyze(`const o = { import: 1, export: 2 };\nobj.import('./x');\nobj.require('./y');\nobj.export = 3;\n`, { path: 'x.js' });
  assert.deepEqual(f.imports, []);
  assert.deepEqual(f.exports, []);
});

test('imports inside blocks and ambient module declarations are not top-level statements', () => {
  const f = analyze(`declare module 'x' {\n  import y from './inside-declare';\n  export const z: number;\n}\nexport const real = 1;\n`, { path: 'x.d.ts' });
  assert.deepEqual(f.imports, []);
  assert.deepEqual(f.exports, ['real']);
});

test('JSX text with apostrophes does not break extraction', () => {
  const f = analyze(`import a from './a';\nexport default () => <p>Don't stop, it's fine</p>;\nconst x = require('./after-jsx');\n`, { path: 'x.tsx' });
  assert.deepEqual(specs(f), ['./a:static', './after-jsx:require']);
  assert.equal(f.status, 'parsed');
});

test('malformed source never throws and is reported as partial', () => {
  const f = analyze(`import a from './kept';\nconst = {{{ "oops\n/* never closed`, { path: 'x.ts' });
  assert.equal(f.status, 'partial');
  assert.ok(f.diagnostics.some((d) => d.code === 'unterminated-comment' && d.severity === 'error'));
  assert.ok(f.diagnostics.some((d) => d.code === 'unbalanced-braces'));
  assert.deepEqual(specs(f), ['./kept:static']);
});

test('binary content is rejected without throwing', () => {
  const f = analyze('abc\u0000def', { path: 'x.ts' });
  assert.equal(f.status, 'failed');
  assert.equal(f.diagnostics[0].code, 'binary-content');
});

test('output is sorted and stable', () => {
  const a = analyze(`import z from './z';\nimport a from './a';\nexport const y = 1;\nexport const b = 2;\n`, { path: 'x.ts' });
  assert.deepEqual(specs(a), ['./a:static', './z:static']);
  assert.deepEqual(a.exports, ['b', 'y']);
});

test('tokenizer: division versus regular expression', () => {
  const { tokens } = tokenize('const a = b / c / d; const r = /x\\/y/g; x = (1) / 2;');
  assert.equal(tokens.filter((t) => t.t === 'regex').length, 1);
});

test('leading comment hint: first sentence only, license headers skipped', () => {
  assert.equal(leadingComment('/**\n * Parses things. Second sentence.\n * @param x\n */\nexport {}'), 'Parses things.');
  assert.equal(leadingComment("'use client';\n// Renders the header.\nexport {}"), 'Renders the header.');
  assert.equal(leadingComment('/* Copyright 2020 Someone. All rights reserved. */\nexport {}'), null);
  assert.equal(leadingComment('export const x = 1;'), null);
});
