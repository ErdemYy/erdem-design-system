import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanProject } from '../lib/scan.mjs';
import { loadConfig, ConfigError, DEFAULTS } from '../lib/config.mjs';
import { hashContent, setFingerprint } from '../lib/fingerprint.mjs';
import { createMatcher } from '../lib/glob.mjs';
import { parseJsonc } from '../lib/json.mjs';
import { cleanup, makeTree, FIXTURES } from './helpers.mjs';

after(cleanup);

const scan = (dir, overrides) => scanProject(dir, { config: loadConfig(dir, { overrides }) });
const paths = (s) => s.files.map((f) => f.path);

test('discovery finds files, categories and languages in sorted order', () => {
  const s = scanProject(path.join(FIXTURES, 'app'));
  const p = paths(s);
  assert.deepEqual(p, [...p].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  const byPath = new Map(s.files.map((f) => [f.path, f]));
  assert.equal(byPath.get('src/index.ts').category, 'source');
  assert.equal(byPath.get('src/index.ts').language, 'typescript');
  assert.equal(byPath.get('src/components/Button.tsx').language, 'typescript');
  assert.equal(byPath.get('src/legacy.js').language, 'javascript');
  assert.equal(byPath.get('src/util.test.ts').category, 'test');
  assert.equal(byPath.get('package.json').category, 'config');
  assert.equal(byPath.get('tsconfig.json').category, 'config');
  assert.equal(byPath.get('README.md').category, 'documentation');
  assert.equal(byPath.get('scripts/tool.py').language, 'python');
  assert.ok(s.stats.byCategory.source > 10);
});

test('default ignores: dependency, build and cache folders are never read', () => {
  const dir = makeTree({
    'src/a.ts': 'export const a = 1;',
    'node_modules/pkg/index.js': 'module.exports = 1;',
    '.next/server/page.js': 'x',
    'dist/out.js': 'x',
    'build/out.js': 'x',
    'coverage/lcov.info': 'x',
    'vendor/lib.js': 'x',
    'cache/x.json': '{}',
    'tmp/x.txt': 'x',
    'generated/gen.ts': 'export {}',
    'logs/app.log': 'x',
    '.git/config': 'x',
  });
  const s = scan(dir);
  assert.deepEqual(paths(s), ['src/a.ts']);
  const ignored = s.ignored.map((i) => i.path);
  for (const d of ['node_modules/', '.next/', 'dist/', 'build/', 'coverage/', 'vendor/', 'cache/', 'tmp/', 'generated/']) assert.ok(ignored.includes(d), `${d} should be reported as ignored`);
});

test('project .gitignore and configured patterns are honored; defaults cannot be negated', () => {
  const dir = makeTree({
    '.gitignore': 'private/\n*.skip.ts\n!dist/\n',
    'src/a.ts': 'export {}',
    'src/b.skip.ts': 'export {}',
    'private/x.ts': 'export {}',
    'dist/x.ts': 'export {}',
    'extra/y.ts': 'export {}',
  });
  assert.deepEqual(paths(scan(dir)), ['.gitignore', 'extra/y.ts', 'src/a.ts']);
  assert.deepEqual(paths(scan(dir, { ignore: ['extra/'] })), ['.gitignore', 'src/a.ts']);
  assert.ok(paths(scan(dir, { respectGitignore: false })).includes('private/x.ts'));
  assert.ok(paths(scan(dir, { useDefaultIgnores: false, respectGitignore: false })).includes('dist/x.ts'));
});

test('glob matcher semantics', () => {
  const m = createMatcher(['*.log', '/root-only.txt', 'a/**/b.ts', 'docs/', '!keep.log']);
  assert.equal(m('x/y/z.log', false), true);
  assert.equal(m('keep.log', false), false);
  assert.equal(m('root-only.txt', false), true);
  assert.equal(m('sub/root-only.txt', false), false);
  assert.equal(m('a/b.ts', false), true);
  assert.equal(m('a/x/y/b.ts', false), true);
  assert.equal(m('docs', true), true);
  assert.equal(m('docs', false), false);
});

test('secret-pattern files are withheld and never read', () => {
  const dir = makeTree({
    'src/a.ts': 'export const a = 1;',
    '.env': 'API_KEY=SUPERSECRET123',
    '.env.local': 'TOKEN=SUPERSECRET123',
    '.env.production': 'X=SUPERSECRET123',
    'keys/server.pem': '-----BEGIN PRIVATE KEY-----SUPERSECRET123',
    'config/credentials.json': '{"password":"SUPERSECRET123"}',
    'id_rsa': 'SUPERSECRET123',
    '.npmrc': '//registry:_authToken=SUPERSECRET123',
    '.ssh/known': 'SUPERSECRET123',
    'certs/site.crt': 'SUPERSECRET123',
  });
  const reads = [];
  const original = fs.readFileSync;
  fs.readFileSync = function patched(file, ...rest) {
    reads.push(String(file));
    return original.call(this, file, ...rest);
  };
  let s;
  try {
    s = scan(dir);
  } finally {
    fs.readFileSync = original;
  }
  assert.deepEqual(paths(s), ['src/a.ts']);
  const withheld = s.withheld.map((w) => w.path);
  for (const p of ['.env', '.env.local', '.env.production', 'keys/server.pem', 'config/credentials.json', 'id_rsa', '.npmrc', '.ssh/', 'certs/site.crt']) {
    assert.ok(withheld.includes(p), `${p} should be withheld`);
  }
  const normalized = reads.map((r) => r.replace(/\\/g, '/'));
  assert.ok(normalized.some((r) => r.endsWith('src/a.ts')), 'the spy must observe ordinary reads, otherwise this test proves nothing');
  for (const secret of ['/.env', '.env.local', '.env.production', 'server.pem', 'credentials.json', 'id_rsa', '.npmrc', '.ssh', 'site.crt']) {
    assert.ok(!normalized.some((r) => r.endsWith(secret) || r.includes(`${secret}/`)), `${secret} must never be opened`);
  }
  assert.ok(!JSON.stringify(s.files).includes('SUPERSECRET123'));
});

test('categories: generated header, lockfiles, minified, assets', () => {
  const dir = makeTree({
    'src/gen.ts': '// @generated by a tool\nexport const g = 1;\n',
    'src/hand.ts': 'export const h = 1;\n',
    'package-lock.json': '{}',
    'public/app.min.js': 'x',
    'public/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]),
    'notes.txt': 'hello',
    'data/blob.xyz': 'unknown',
  });
  const by = new Map(scan(dir).files.map((f) => [f.path, f.category]));
  assert.equal(by.get('src/gen.ts'), 'generated');
  assert.equal(by.get('src/hand.ts'), 'source');
  assert.equal(by.get('package-lock.json'), 'generated');
  assert.equal(by.get('public/app.min.js'), 'generated');
  assert.equal(by.get('public/logo.png'), 'asset');
  assert.equal(by.get('notes.txt'), 'documentation');
  assert.equal(by.get('data/blob.xyz'), 'unknown');
});

test('large files are metadata-only and configurable', () => {
  const dir = makeTree({ 'src/big.ts': 'export const x = "' + 'a'.repeat(3000) + '";', 'src/small.ts': 'export const y = 1;' });
  const s = scan(dir, { maxHashBytes: 1000, maxParseBytes: 500 });
  const big = s.files.find((f) => f.path === 'src/big.ts');
  assert.equal(big.fingerprint.hash, null);
  assert.equal(big.fingerprint.reason, 'too-large');
  assert.equal(big.parse, null);
  assert.ok(s.diagnostics.some((d) => d.path === 'src/big.ts' && d.code === 'metadata-only-too-large'));
  const small = s.files.find((f) => f.path === 'src/small.ts');
  assert.match(small.fingerprint.hash, /^[0-9a-f]{64}$/);
  // hashable but not parseable
  const s2 = scan(dir, { maxHashBytes: 100000, maxParseBytes: 500 });
  const big2 = s2.files.find((f) => f.path === 'src/big.ts');
  assert.match(big2.fingerprint.hash, /^[0-9a-f]{64}$/);
  assert.equal(big2.parseStatus, 'skipped-too-large');
  assert.ok(s2.diagnostics.some((d) => d.path === 'src/big.ts' && d.code === 'parse-skipped-too-large'));
});

test('fingerprint: SHA-256 over normalized text; CRLF, LF and BOM give one identity', () => {
  const lf = hashContent(Buffer.from('a\nb\n'));
  const crlf = hashContent(Buffer.from('a\r\nb\r\n'));
  const bom = hashContent(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\nb\n')]));
  assert.equal(lf.hash, crlf.hash);
  assert.equal(lf.hash, bom.hash);
  assert.equal(lf.normalization, 'text-lf-nobom');
  assert.notEqual(lf.hash, hashContent(Buffer.from('a\nc\n')).hash);
  assert.match(lf.hash, /^[0-9a-f]{64}$/);
  const bin = hashContent(Buffer.from([1, 0, 2, 13, 10]));
  assert.equal(bin.normalization, 'binary-raw');
});

test('fingerprint: size and mtime are recorded but the hash is the identity', () => {
  const dir = makeTree({ 'src/a.ts': 'export const a = 1;\n' });
  const first = scan(dir).files[0].fingerprint;
  fs.utimesSync(path.join(dir, 'src/a.ts'), new Date(2001, 1, 1), new Date(2001, 1, 1));
  const touched = scan(dir).files[0].fingerprint;
  assert.equal(first.hash, touched.hash);
  assert.notEqual(first.mtime, touched.mtime);
  assert.equal(first.algo, 'sha256');
  assert.equal(first.size, 20);
});

test('set fingerprint: order independent, unverifiable when a member has no hash', () => {
  const a = setFingerprint([{ path: 'b', hash: '2' }, { path: 'a', hash: '1' }]);
  const b = setFingerprint([{ path: 'a', hash: '1' }, { path: 'b', hash: '2' }]);
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, setFingerprint([{ path: 'a', hash: '1' }, { path: 'b', hash: '3' }]).hash);
  assert.equal(setFingerprint([{ path: 'a', hash: null }]).hash, null);
});

test('package manifests, tsconfig (JSONC) and README hints are collected', () => {
  const s = scanProject(path.join(FIXTURES, 'app'));
  assert.equal(s.packages.get('package.json').name, 'fixture-app');
  assert.equal(s.tsconfigs.get('tsconfig.json').baseUrl, '.');
  assert.deepEqual(Object.keys(s.tsconfigs.get('tsconfig.json').paths), ['@/*']);
  assert.equal(s.files.find((f) => f.path === 'README.md').hint, 'Fixture app');
  assert.equal(s.files.find((f) => f.path === 'src/index.ts').hint, 'Entry module of the fixture app.');
});

test('JSONC parser strips comments and trailing commas but not string contents', () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": "// not a comment", /* x */ "b": [1,2,], }'), { a: '// not a comment', b: [1, 2] });
});

test('configuration: validation errors are explicit; output directory must stay inside the project', () => {
  const dir = makeTree({ 'a.ts': '' });
  assert.throws(() => loadConfig(dir, { overrides: { outputDir: '../outside' } }), ConfigError);
  assert.throws(() => loadConfig(dir, { overrides: { maxHashBytes: -1 } }), /maxHashBytes/);
  assert.throws(() => loadConfig(dir, { overrides: { profile: 'huge' } }), /profile/);
  fs.writeFileSync(path.join(dir, 'project-intel.config.json'), '{ "graph": { "maxNodes": 5 }, // comment\n "ignore": ["x/"] }');
  const cfg = loadConfig(dir);
  assert.equal(cfg.graph.maxNodes, 5);
  assert.equal(cfg.graph.includeTests, DEFAULTS.graph.includeTests);
  assert.deepEqual(cfg.ignore, ['x/']);
  fs.writeFileSync(path.join(dir, 'project-intel.config.json'), '{ broken');
  assert.throws(() => loadConfig(dir), ConfigError);
});

test('unsupported languages are metadata-only: nodes without parse facts', () => {
  const s = scanProject(path.join(FIXTURES, 'app'));
  const py = s.files.find((f) => f.path === 'scripts/tool.py');
  assert.equal(py.parseStatus, 'unsupported');
  assert.equal(py.parse, null);
  assert.equal(py.adapter.id, 'generic');
});

test('failure recovery: malformed, binary-garbage and unreadable-looking files do not stop the scan', () => {
  const dir = makeTree({
    'ok.ts': "import { x } from './other';\nexport const ok = x;\n",
    'other.ts': 'export const x = 1;\n',
    'broken.ts': 'import { a } from "./other";\nconst = {{{ `never closed',
    'garbage.ts': Buffer.from([0x69, 0x6d, 0x70, 0, 0, 0x6f, 0x72, 0x74]),
  });
  const s = scan(dir);
  assert.equal(s.files.length, 4);
  const by = new Map(s.files.map((f) => [f.path, f]));
  assert.equal(by.get('ok.ts').parseStatus, 'parsed');
  assert.equal(by.get('broken.ts').parseStatus, 'partial');
  assert.equal(by.get('garbage.ts').parseStatus, 'failed');
  const errors = s.diagnostics.filter((d) => d.severity === 'error');
  assert.ok(errors.some((d) => d.path === 'broken.ts' && d.parser === 'javascript' && d.code && d.message));
  assert.ok(errors.some((d) => d.path === 'garbage.ts' && d.code === 'binary-content'));
});

test('entries reported as links by readdir but confirmed as regular files by lstat are scanned', () => {
  const dir = makeTree({ 'src/real.ts': 'export const r = 1;', 'src/other.ts': "import './real';" });
  const original = fs.readdirSync;
  fs.readdirSync = function patched(target, options) {
    const entries = original.call(this, target, options);
    if (!options?.withFileTypes) return entries;
    return entries.map((e) => (e.isFile() ? new Proxy(e, { get: (t, k) => (k === 'isSymbolicLink' ? () => true : k === 'isFile' ? () => false : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }) : e));
  };
  let s;
  try {
    s = scan(dir);
  } finally {
    fs.readdirSync = original;
  }
  assert.deepEqual(paths(s), ['src/other.ts', 'src/real.ts']);
  assert.equal(s.diagnostics.filter((d) => d.code === 'symlink-skipped').length, 0);
});

// Two tests, because the privileges differ: a directory junction needs none on Windows (and a plain directory
// symlink needs none elsewhere), while a file symlink on Windows needs Developer Mode or elevation. Each test is
// skipped only when the operating system refuses to create that kind of link; it never passes without creating it.
function linkCase(t, { kind }) {
  const dir = makeTree({ 'src/a.ts': 'export {}', 'target/b.ts': 'export {}' });
  try {
    if (kind === 'dir') fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'src/linked'), 'junction');
    else fs.symlinkSync(path.join(dir, 'src/a.ts'), path.join(dir, 'src/a-link.ts'), 'file');
  } catch (e) {
    t.skip(`cannot create a ${kind === 'dir' ? 'directory junction or symlink' : 'file symlink'} here (${e.code})`);
    return null;
  }
  return dir;
}

test('a real directory link is not followed and is reported as a warning', (t) => {
  const dir = linkCase(t, { kind: 'dir' });
  if (!dir) return;
  const s = scan(dir);
  assert.ok(!paths(s).some((p) => p.startsWith('src/linked')), 'nothing under the link is scanned');
  assert.ok(paths(s).includes('src/a.ts'), 'ordinary files are still scanned');
  const skipped = s.diagnostics.filter((d) => d.code === 'symlink-skipped');
  assert.ok(skipped.length >= 1);
  assert.ok(skipped.every((d) => d.severity === 'warning'));
});

test('a real file symlink is not followed and is reported as a warning', (t) => {
  const dir = linkCase(t, { kind: 'file' });
  if (!dir) return;
  const s = scan(dir);
  assert.ok(!paths(s).includes('src/a-link.ts'));
  assert.ok(paths(s).includes('src/a.ts'));
  const skipped = s.diagnostics.filter((d) => d.code === 'symlink-skipped');
  assert.ok(skipped.length >= 1);
  assert.ok(skipped.every((d) => d.severity === 'warning'));
});
