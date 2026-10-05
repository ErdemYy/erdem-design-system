import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanup, FIXTURES, TOOLS_ROOT, tmpDir } from './helpers.mjs';
import { MAX_TARGETS, RoutingInputError, cleanPath, recordCode, routeContext } from '../automation/context-router.mjs';
import { CLASS_CEILING, DESIGN_CONCERNS, PLATFORM_SOURCES, SECURITY_SOURCES } from '../automation/context-sources.mjs';
import { guardPaths, isSecretPath, looksLikeGlob } from '../automation/path-safety.mjs';
import { classifyState as recordsClassify, actionRecord as recordsRecord } from '../automation/records.mjs';
import { actionRecord, classifyState } from '../automation/refresh.mjs';
import { shouldAutoRefresh } from '../automation/refresh-decision.mjs';
import { describeArtifactPath, directoryIndexRel, directorySummaryRel, fileSummaryRel, scopeRelatesTo, slugPath } from '../lib/artifact-paths.mjs';

// Phase 5C.1: hardening found by the Phase 5C closure audit. Real engine, fixture projects in temp directories.
after(cleanup);

const REPO = path.resolve(TOOLS_ROOT, '..');
const BIN = path.join(TOOLS_ROOT, 'bin', 'project-intel.mjs');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const cli = (args, cwd, env) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, windowsHide: true, env: env ?? process.env });
const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const gitOpts = { skip: !hasGit && 'git is not available' };
const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
const CURRENT = { state: 'current' };
const T = (over) => ({ taskClass: 'SMALL', taskTypes: ['bugfix'], targets: ['src/util.ts'], ...over });
const paths = (r) => r.requiredSources.map((s) => s.path);

// ---- 1. minimum <= ceiling, and every level beyond the class default has a real reason ------------------------------

test('H1 across a wide matrix of inputs the minimum never exceeds the ceiling and the plan never goes past it unexplained', () => {
  const classes = [null, 'TRIVIAL', 'SMALL', 'MEDIUM', 'LARGE', 'ARCHITECTURAL'];
  const risks = [undefined, 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  const typeSets = [[], ['bugfix'], ['refactor'], ['dependency'], ['configuration'], ['migration'], ['security'], ['documentation'], ['architecture'], ['test'], ['feature', 'refactor']];
  const signalSets = [{}, { publicSurface: true }, { crossSubsystem: true }, { layerBoundary: true }, { dependencyUncertain: true }, { buildOrRuntime: true }, { securityBoundary: true }, { architectureUnresolved: true }, { dataLoss: true }, { sharedDependency: true }, { buildOrRuntime: true, dependencyUncertain: true, publicSurface: true }];
  const justified = ['task-type-floor', 'public-surface', 'required-by-risk', 'dependency-uncertainty', 'configuration-or-api-impact', 'architectural-dependency', 'security-boundary', 'migration', 'required-by-class', 'scope-growth'];
  let checked = 0;
  for (const taskClass of classes) for (const risk of risks) for (const taskTypes of typeSets) for (const signals of signalSets) for (const intent of ['change', 'read-only']) {
    const r = routeContext({ taskClass, risk, taskTypes, signals, intent, targets: ['src/a.ts'] }, CURRENT, { reached: 0 });
    checked++;
    assert.ok(r.minimumLevel <= r.ceiling, `minimum ${r.minimumLevel} > ceiling ${r.ceiling} for ${JSON.stringify({ taskClass, risk, taskTypes, signals, intent })}`);
    assert.ok(r.ceiling <= 5 && r.minimumLevel >= 0);
    if (r.level !== null) assert.ok(r.level <= r.ceiling, 'a plan without a stated escalation stays within the ceiling');
    assert.equal(r.beyondCeiling, false);
    assert.ok(r.reasons.length > 0);
    if (r.class && r.minimumLevel > CLASS_CEILING[r.class]) assert.ok(r.reasons.some((x) => justified.includes(x) && x !== 'required-by-class'), `Level ${r.minimumLevel} above the class default needs its own reason: ${r.reasons}`);
  }
  assert.ok(checked > 5000);
});

test('H1b the known cases: each is explained by its own reason, never by the class', () => {
  const probe = (task) => routeContext(T(task), CURRENT, { reached: 3 });
  const cases = [
    [{ taskClass: 'SMALL', taskTypes: ['refactor'] }, 'task-type-floor'],
    [{ taskClass: 'TRIVIAL', taskTypes: ['refactor'] }, 'task-type-floor'],
    [{ taskClass: 'SMALL', signals: { dependencyUncertain: true } }, 'dependency-uncertainty'],
    [{ taskClass: 'SMALL', taskTypes: ['configuration'], signals: { buildOrRuntime: true } }, 'configuration-or-api-impact'],
    [{ taskClass: 'SMALL', taskTypes: ['dependency'] }, 'task-type-floor'],
  ];
  for (const [task, reason] of cases) {
    const r = probe(task);
    assert.deepEqual([r.minimumLevel, r.ceiling, r.level, r.beyondCeiling], [4, 4, 4, false], JSON.stringify(task));
    assert.ok(r.reasons.includes(reason), `${JSON.stringify(task)} -> ${r.reasons}`);
    assert.ok(!r.reasons.includes('required-by-class'), 'the class is not the reason');
    assert.equal(r.impact.need, 'required');
  }
  const plain = probe({ taskClass: 'SMALL' });
  assert.deepEqual([plain.minimumLevel, plain.ceiling, plain.reasons], [3, 3, ['class-default']], 'no driver: the class default');
  assert.deepEqual(probe({ taskClass: 'MEDIUM', taskTypes: ['feature'] }).reasons, ['required-by-class']);
  for (const reason of ['task-type-floor', 'class-default', 'dependency-uncertainty', 'configuration-or-api-impact', 'architectural-dependency', 'security-boundary', 'migration', 'required-by-risk', 'public-surface', 'scope-growth']) {
    assert.ok(['required-by-class', 'required-by-risk', 'public-surface', 'scope-growth', 'sufficiency-q4'].includes(recordCode(reason)), `${reason} maps to a Phase 5A reason code`);
  }
  assert.match(probe({ taskClass: 'SMALL', taskTypes: ['refactor'] }).record.reason, /^required-by-class: level 4$/);
  assert.match(probe({ taskClass: 'SMALL', signals: { dependencyUncertain: true } }).record.reason, /^sufficiency-q4: level 4$/);
});

// ---- 2. target cap ---------------------------------------------------------------------------------------------

test('H2 the target cap: below, at and above the limit, in order, with a batching indication and nothing lost silently', () => {
  assert.equal(MAX_TARGETS, 12);
  const names = (n) => Array.from({ length: n }, (_, i) => `src/area${i % 3}/file${String(i).padStart(3, '0')}.ts`);
  const plan = (n, level = 3) => routeContext(T({ taskClass: 'MEDIUM', taskTypes: ['refactor'], targets: names(n) }), CURRENT, { reached: level - 1 });
  const below = plan(11);
  assert.deepEqual([below.targets.planned, below.targets.truncated, below.targets.remainingTargets, below.targets.batchingRequired], [11, false, 0, false]);
  const at = plan(12);
  assert.deepEqual([at.targets.planned, at.targets.truncated, at.targets.batchingRequired], [12, false, false]);
  const above = plan(13);
  assert.deepEqual([above.targets.planned, above.targets.truncated, above.targets.remainingTargets, above.targets.batchingRequired, above.targets.targetLimit], [12, true, 1, true, 12]);
  assert.deepEqual(above.targets.remainingBySubsystem, { 'src/area0': 1 });
  assert.match(above.notes.join(' '), /1 more target\(s\) are not planned \(limit 12\)/);
  const many = plan(300);
  assert.deepEqual([many.targets.planned, many.targets.remainingTargets], [12, 288]);
  assert.deepEqual(many.targets.remainingBySubsystem, { 'src/area0': 96, 'src/area1': 96, 'src/area2': 96 });
  assert.deepEqual(Object.keys(many.targets.remainingBySubsystem), ['src/area0', 'src/area1', 'src/area2'], 'deterministic order');
  assert.deepEqual(paths(many).filter((p) => p.startsWith('src/')), names(300).slice(0, 12), "the caller's order is kept: the first twelve are planned");
  const l4 = plan(300, 4);
  assert.equal(l4.requiredQueries.length, 12, 'queries follow the planned targets only');
  assert.ok(l4.requiredSources.length <= 12 + 3);
  // nothing is lost: batches reconstruct the input exactly
  const input = names(30);
  const first = routeContext(T({ taskClass: 'MEDIUM', taskTypes: ['refactor'], targets: input }), CURRENT, { reached: 2 });
  const planned1 = paths(first).filter((p) => p.startsWith('src/'));
  const rest = input.slice(planned1.length);
  const second = routeContext(T({ taskClass: 'MEDIUM', taskTypes: ['refactor'], targets: rest }), CURRENT, { reached: 2 });
  const planned2 = paths(second).filter((p) => p.startsWith('src/'));
  assert.deepEqual([...planned1, ...planned2, ...input.slice(planned1.length + planned2.length)], input);
  assert.deepEqual(routeContext(T({ targets: names(300) }), CURRENT, { reached: 2 }).targets, routeContext(T({ targets: names(300) }), CURRENT, { reached: 2 }).targets, 'deterministic');
  // duplicates collapse before the cap; secret paths are withheld and do not use up slots
  const dup = routeContext(T({ targets: [...names(12), ...names(12), '.env'] }), CURRENT, { reached: 2 });
  assert.deepEqual([dup.targets.planned, dup.targets.truncated, dup.withheld], [12, false, ['.env']]);
});

// ---- 3. one secret filter for every planned path --------------------------------------------------------------

test('H3 the shared filter keeps secret paths out of every part of the plan', () => {
  const secrets = ['.env', '.env.local', 'config/.env.production', 'config/id_rsa', 'keys/server.key', 'certs/a.pem', 'credentials.json', 'aws/credentials', '.ssh/known_hosts', '.aws/config', 'deploy/service-account.json', 'secrets.yaml', '.npmrc'];
  const ordinary = ['src/app.ts', 'docs/architecture.md', 'docs/decisions/001-token-strategy.md', 'src/token.ts', 'src/app/[id]/page.tsx', 'README.md'];
  for (const p of secrets) assert.equal(isSecretPath(p), true, p);
  for (const p of ordinary) assert.equal(isSecretPath(p), false, p);
  const arch = routeContext(T({ taskClass: 'ARCHITECTURAL', taskTypes: ['architecture'], signals: { layerBoundary: true } }), CURRENT, { reached: 4, architectureDocs: [...secrets.slice(0, 5), 'docs/architecture.md', 'docs/decisions/001-token-strategy.md'] });
  assert.deepEqual(paths(arch).filter((p) => !p.startsWith('.ai/')), ['docs/architecture.md', 'docs/decisions/001-token-strategy.md']);
  for (const p of secrets.slice(0, 5)) assert.ok(arch.withheld.includes(p), `${p} reported as withheld`);
  assert.ok(!JSON.stringify(arch.requiredSources).includes('.env'));
  const tgt = routeContext(T({ targets: [...secrets, ...ordinary.slice(0, 3)] }), CURRENT, { reached: 2 });
  assert.deepEqual(tgt.requiredSources.filter((s) => s.why === 'the target').map((s) => s.path), ordinary.slice(0, 3));
  assert.deepEqual([...tgt.withheld].sort(), [...secrets].sort());
  assert.deepEqual(guardPaths(['a.ts', '.env', 'b.ts', 'x/id_rsa']), { ok: ['a.ts', 'b.ts'], withheld: ['.env', 'x/id_rsa'] }, 'the filter keeps order');
  // the canonical documents the router can name are never mistaken for secrets
  const canonical = [...Object.values(DESIGN_CONCERNS).flat(), ...Object.values(PLATFORM_SOURCES).flat(), ...SECURITY_SOURCES, 'ai/TASK_ROUTING.md', 'ai/SAFE_MODIFICATION.md', 'ai/CHANGE_IMPACT.md', 'ai/GRAPH_PROTOCOL.md', 'ai/VALIDATION_PROTOCOL.md', 'core/TOKEN_REGISTER.md', 'core/DESIGN_TOKENS.md'];
  for (const p of canonical) assert.equal(isSecretPath(p), false, p);
  const sec = routeContext(T({ taskTypes: ['security'], targets: ['src/auth.ts'] }), CURRENT, { reached: 2 });
  for (const p of SECURITY_SOURCES) assert.ok(paths(sec).includes(p), `${p} is planned for a security task`);
  assert.deepEqual(sec.withheld, []);
  assert.throws(() => routeContext(T(), CURRENT, { reached: 4, architectureDocs: ['/etc/passwd'] }), RoutingInputError);
});

// ---- 4. framework route paths ---------------------------------------------------------------------------------

test('H4 framework route paths are literal; globs, traversal, absolute, UNC and drive paths are refused', () => {
  for (const ok of ['app/[id]/page.tsx', 'app/[[lang]]/page.tsx', 'app/[...slug]/page.tsx', 'src/routes/{id}.tsx', 'app/(shop)/[post-id]/page.tsx', 'src/routes/[[optional]]/+page.svelte', 'pages/[...all].tsx', 'src/{name}/index.ts', 'src/a b/[c d]/e.ts', 'src/日本語/[id].ts', 'src/Ünlü/{id}.tsx']) {
    assert.equal(cleanPath(ok), ok, ok);
    assert.equal(looksLikeGlob(ok), false, ok);
  }
  for (const glob of ['src/*.ts', 'src/**/x.ts', 'src/what?.ts', 'src/[a-z].ts', 'src/[0-9]/x.ts', 'src/[!a]/x.ts', 'src/[^a]/x.ts', 'src/{a,b}.ts', 'src/{1..3}.ts', 'src/[abc', 'src/abc]', 'src/{abc', 'src/abc}', 'src/[[a]/x.ts']) {
    assert.throws(() => cleanPath(glob), RoutingInputError, glob);
  }
  for (const bad of ['../x', 'a/../../b', '..\\x', '/etc/passwd', '\\\\server\\share\\x', '//server/share/x', 'C:\\Users\\x', 'c:/x', '', '.', 'a\0b']) assert.throws(() => cleanPath(bad), RoutingInputError, JSON.stringify(bad));
  assert.equal(cleanPath('app\\[id]\\page.tsx'), 'app/[id]/page.tsx', 'separators are normalized');
  const r = routeContext(T({ taskClass: 'MEDIUM', taskTypes: ['feature'], targets: ['app/[id]/page.tsx', 'app/[[lang]]/page.tsx', 'app/[...slug]/page.tsx', 'src/routes/{id}.tsx'] }), CURRENT, { reached: 3 });
  assert.deepEqual(r.requiredQueries.map((q) => q.command), ['app/[id]/page.tsx', 'app/[[lang]]/page.tsx', 'app/[...slug]/page.tsx', 'src/routes/{id}.tsx'].map((t) => ['impact', t, '--json']), 'each path is one literal argument');
  const dir = tmpDir('pi-brackets-');
  const out = cli(['route', dir, '--json', '--state', 'current', '--class', 'SMALL', '--types', 'bugfix', '--targets', 'app/[id]/page.tsx,src/routes/{id}.tsx', '--reached', '2'], dir);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).requiredSources.filter((s) => s.why === 'the target').map((s) => s.path), ['app/[id]/page.tsx', 'src/routes/{id}.tsx']);
  assert.equal(cli(['route', dir, '--state', 'current', '--class', 'SMALL', '--targets', 'src/*.ts'], dir).status, 2);
  assert.equal(cli(['route', dir, '--state', 'current', '--class', 'SMALL', '--targets', '../x'], dir).status, 2);
});

// ---- 5. one slug function --------------------------------------------------------------------------------------

test('H5 the slug is the engine\'s: known names, no second implementation, one set of artifact names', () => {
  assert.equal(slugPath('src/my dir'), 'src/my_dir');
  assert.equal(slugPath('src/Ünlü'), 'src/_nl_');
  assert.equal(slugPath('src/a&b (x)/日本語'), 'src/a_b__x_/___');
  assert.equal(slugPath('src/keep-this_one.v2'), 'src/keep-this_one.v2', 'allowed characters are untouched');
  assert.equal(directoryIndexRel('src/my dir'), 'directories/src/my_dir/DIRECTORY_INDEX.md');
  assert.equal(fileSummaryRel('src/my dir/f.ts'), 'summaries/files/src/my_dir/f.ts.json');
  assert.equal(directorySummaryRel('src/Ünlü'), 'summaries/directories/src/_nl_.json');
  assert.deepEqual(describeArtifactPath('.ai', '.ai/directories/src/my_dir/DIRECTORY_INDEX.md'), { type: 'directory-index', covers: 'src/my_dir' });
  assert.deepEqual(describeArtifactPath('.ai', '.ai/summaries/files/src/util.ts.json'), { type: 'file-summary', covers: 'src/util.ts' });
  assert.deepEqual(describeArtifactPath('.ai', '.ai/summaries/directories/src.json'), { type: 'directory-summary', covers: 'src' });
  assert.equal(describeArtifactPath('.ai', '.ai/graph/graph.json'), null);
  assert.equal(scopeRelatesTo('src/my_dir', 'src/my dir'), true);
  assert.equal(scopeRelatesTo('src/my_dir', 'src'), true);
  assert.equal(scopeRelatesTo('src/my_dir/deep', 'src/my dir'), true);
  assert.equal(scopeRelatesTo('src/other', 'src/my dir'), false);
  // no second implementation: the replacement pattern exists once in the tools, and the generator uses the shared functions
  const hits = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'test', 'fixtures'].includes(e.name)) walk(abs);
      } else if (e.name.endsWith('.mjs') && fs.readFileSync(abs, 'utf8').includes('A-Za-z0-9._/-')) hits.push(path.relative(TOOLS_ROOT, abs).split(path.sep).join('/'));
    }
  })(TOOLS_ROOT);
  assert.deepEqual(hits, ['lib/artifact-paths.mjs']);
  const gen = fs.readFileSync(path.join(TOOLS_ROOT, 'index', 'generate.mjs'), 'utf8');
  assert.ok(!/slugPath/.test(gen) && /directoryIndexRel\(/.test(gen) && /fileSummaryRel\(/.test(gen) && /directorySummaryRel\(/.test(gen));
  assert.ok(!/directories\/\$\{/.test(fs.readFileSync(path.join(TOOLS_ROOT, 'automation', 'context-router.mjs'), 'utf8')), 'the router builds no artifact path by hand');
});

function oddProject({ nested = [] } = {}) {
  const dir = path.join(tmpDir('pi-slug-'), ...nested, 'app');
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'app'), dir, { recursive: true });
  for (const d of ['src/my dir', 'src/Ünlü', 'src/a&b (x)']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
    for (const i of [1, 2, 3]) fs.writeFileSync(path.join(dir, d, `f${i}.ts`), `export const v${i} = ${i};\n`);
  }
  fs.appendFileSync(path.join(dir, 'src', 'index.ts'), "import './my dir/f1';\nimport './Ünlü/f1';\nimport './a&b (x)/f1';\n");
  assert.equal(cli(['index', dir, '--profile', 'full'], dir).status, 0);
  return dir;
}

test('H5b engine, router and refresh agree on the generated path (spaces, Unicode, punctuation)', gitOpts, () => {
  const dir = oddProject();
  const onDisk = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name === 'DIRECTORY_INDEX.md') onDisk.push(path.relative(dir, abs).split(path.sep).join('/'));
    }
  })(path.join(dir, '.ai', 'directories'));
  for (const d of ['src/my dir', 'src/Ünlü', 'src/a&b (x)']) {
    const expected = `.ai/${directoryIndexRel(d)}`;
    assert.ok(onDisk.includes(expected), `the engine wrote ${expected}`);
    assert.ok(fs.existsSync(path.join(dir, expected)));
    const planned = routeContext({ taskClass: 'MEDIUM', taskTypes: ['feature'], targets: [`${d}/f1.ts`], subsystem: d }, { state: 'current', artifacts: { directoryIndex: 'current' } }, { reached: 1 });
    assert.deepEqual(paths(planned), [expected], `the router plans the path the engine wrote for ${d}`);
    assert.ok(fs.existsSync(path.join(dir, paths(planned)[0])), 'and the planned file exists');
  }
  // the same through the command line, with the real status
  const viaCli = JSON.parse(cli(['route', dir, '--json', '--class', 'MEDIUM', '--types', 'feature', '--subsystem', 'src/Ünlü', '--targets', 'src/Ünlü/f1.ts', '--reached', '1'], dir).stdout);
  assert.deepEqual(viaCli.requiredSources.map((s) => s.path), ['.ai/directories/src/_nl_/DIRECTORY_INDEX.md']);
  // every artifact the engine wrote is described by the shared function and is related to its own source directory
  for (const rel of onDisk) {
    const d = describeArtifactPath('.ai', rel);
    assert.equal(d.type, 'directory-index');
    assert.ok(scopeRelatesTo(d.covers, d.covers));
  }
  // refresh scope matching uses the same names
  git(dir, 'init', '-q');
  const decide = (scope, reliesOn) => {
    fs.appendFileSync(path.join(dir, scope, 'f1.ts'), '\nexport const touched = 1;\n');
    return JSON.parse(cli(['refresh', dir, '--json', '--check', '--relies-on', reliesOn, '--scope', scope], dir).stdout).decision;
  };
  for (const [scope, reliesOn] of [['src/my dir', 'directory-index'], ['src/Ünlü', 'directory-index'], ['src/a&b (x)', 'directory-index'], ['src/my dir', 'summary'], ['src/Ünlü', 'summary']]) {
    const d = decide(scope, reliesOn);
    assert.deepEqual([d.decision, d.command], ['AUTO_REFRESH', 'index'], `${reliesOn} under scope "${scope}"`);
    assert.ok(d.affectedArtifacts.every((p) => p.includes(slugPath(scope).split('/').pop().slice(0, 3)) || /summaries/.test(p) || /directories/.test(p)));
  }
  // a different scope does not pull in these artifacts
  const other = shouldAutoRefresh({ intelligenceState: 'stale', staleArtifacts: [{ path: '.ai/directories/src/my_dir/DIRECTORY_INDEX.md', kind: 'directory index', state: 'STALE' }], outputDirExists: true, taskDependencies: ['directory-index'], taskScope: { paths: ['src/beta'] }, trackedDerivedFiles: [], declaredProfile: 'full', outputDir: '.ai' });
  assert.equal(other.reason, 'artifacts-not-relied-on');
  // summaries: the file-summary and directory-summary names are scope-matched too (they were not before)
  const sum = shouldAutoRefresh({ intelligenceState: 'stale', staleArtifacts: [{ path: '.ai/summaries/files/src/my_dir/f1.ts.json', kind: 'file summary', state: 'STALE' }, { path: '.ai/summaries/directories/src/_nl_.json', kind: 'directory summary', state: 'STALE' }], outputDirExists: true, taskDependencies: ['summary'], taskScope: { paths: ['src/my dir'] }, trackedDerivedFiles: [], declaredProfile: 'full', outputDir: '.ai' });
  assert.deepEqual(sum.affectedArtifacts, ['.ai/summaries/files/src/my_dir/f1.ts.json']);
});

test('H5c Windows paths with spaces, OneDrive-like folders and non-ASCII names: the planned directory index exists', gitOpts, () => {
  for (const nested of [['with spaces', 'my project'], ['OneDrive', 'Belgeler Ünlü', 'Proje Ç ş']]) {
    const dir = oddProject({ nested });
    const out = cli(['route', dir, '--json', '--class', 'MEDIUM', '--types', 'feature', '--subsystem', 'src/my dir', '--targets', 'src/my dir/f1.ts', '--reached', '1'], dir);
    assert.equal(out.status, 0, out.stderr);
    const plan = JSON.parse(out.stdout);
    assert.deepEqual(plan.requiredSources.map((s) => s.path), ['.ai/directories/src/my_dir/DIRECTORY_INDEX.md']);
    assert.ok(fs.existsSync(path.join(dir, plan.requiredSources[0].path)));
    assert.ok(!out.stdout.includes(dir), 'no absolute path in the plan');
  }
});

// ---- 6. shortest path -----------------------------------------------------------------------------------------

test('H6 shortest path needs two endpoints; with fewer or unusable ones the requirement is returned, never a one-endpoint query', () => {
  const base = { taskClass: 'MEDIUM', taskTypes: ['feature'], queries: ['shortest-path'] };
  const ok = routeContext(T({ ...base, pathBetween: ['src/a.ts', 'src/b.ts'] }), CURRENT, { reached: 3 });
  const q = ok.requiredQueries.find((x) => x.op === 'shortest-path');
  assert.deepEqual([q.via, q.function, q.args, q.from, q.to], ['library', 'shortestPath', ['src/a.ts', 'src/b.ts'], 'src/a.ts', 'src/b.ts']);
  assert.ok(!q.command && !q.target, 'library-only: no command, no single target');
  assert.deepEqual(ok.unresolvedRequirements, []);
  const noGraph = routeContext(T({ ...base, pathBetween: ['src/a.ts', 'src/b.ts'] }), { state: 'stale' }, { reached: 3 }).requiredQueries.find((x) => x.op === 'shortest-path');
  assert.deepEqual([noGraph.via, noGraph.from, noGraph.to, noGraph.fallbackFor], ['search', 'src/a.ts', 'src/b.ts', 'graph stale']);
  for (const [between, given] of [[undefined, 0], [['src/a.ts'], 1], [['a.ts', 'b.ts', 'c.ts'], 3]]) {
    const r = routeContext(T({ ...base, pathBetween: between }), CURRENT, { reached: 3 });
    assert.ok(!r.requiredQueries.some((x) => x.op === 'shortest-path'), `no query with ${given} endpoint(s)`);
    assert.deepEqual(r.unresolvedRequirements.map((u) => [u.op, u.given]), [['shortest-path', given]]);
    assert.match(r.unresolvedRequirements[0].requires, /two project-relative endpoints/);
  }
  const secret = routeContext(T({ ...base, pathBetween: ['src/a.ts', '.env'] }), CURRENT, { reached: 3 });
  assert.deepEqual([secret.unresolvedRequirements[0].why, secret.withheld], ['an endpoint was withheld as a secret path', ['.env']]);
  assert.ok(!secret.requiredQueries.some((x) => x.op === 'shortest-path'));
  // targets are never reused as endpoints, and other questions still run per target
  const both = routeContext(T({ ...base, queries: ['shortest-path', 'dependents'], targets: ['src/x.ts', 'src/y.ts'] }), CURRENT, { reached: 3 });
  assert.equal(both.requiredQueries.filter((x) => x.op === 'shortest-path').length, 0);
  assert.equal(both.requiredQueries.filter((x) => x.op === 'dependents').length, 2);
  assert.throws(() => routeContext(T({ ...base, pathBetween: ['../x', 'b.ts'] }), CURRENT), RoutingInputError);
  const dir = tmpDir('pi-between-');
  const viaCli = JSON.parse(cli(['route', dir, '--json', '--state', 'current', '--class', 'MEDIUM', '--types', 'feature', '--targets', 'src/a.ts', '--queries', 'shortest-path', '--between', 'src/a.ts,src/b.ts', '--reached', '3'], dir).stdout);
  assert.deepEqual(viaCli.requiredQueries.filter((x) => x.op === 'shortest-path').map((x) => x.args), [['src/a.ts', 'src/b.ts']]);
  const missing = JSON.parse(cli(['route', dir, '--json', '--state', 'current', '--class', 'MEDIUM', '--types', 'feature', '--targets', 'src/a.ts', '--queries', 'shortest-path', '--reached', '3'], dir).stdout);
  assert.equal(missing.unresolvedRequirements.length, 1);
  assert.match(cli(['route', dir, '--state', 'current', '--class', 'MEDIUM', '--types', 'feature', '--targets', 'src/a.ts', '--queries', 'shortest-path', '--reached', '3'], dir).stdout, /unresolved shortest-path/);
});

// ---- 7. impact signals -----------------------------------------------------------------------------------------

test('H7 configImpact, apiImpact, dataImpact, platformImpact and designSystemImpact are query hints, as ai/CHANGE_IMPACT.md defines them', () => {
  const doc = read('ai', 'CHANGE_IMPACT.md');
  for (const row of ['related data', 'related config', 'platform impact', 'API impact', 'design-system impact']) assert.ok(doc.includes(`| ${row} |`), `Dimensions lists "${row}"`);
  assert.match(doc, /Find each dimension below/, 'the dimensions say what to look for during impact analysis');
  assert.ok(!/(configuration|API|platform|data)[^.\n]{0,40}(raises|increases|deepens)[^.\n]{0,30}(level|depth)/i.test(doc), 'no canonical rule makes a dimension itself change the depth');
  const flags = { configImpact: true, apiImpact: true, dataImpact: true, platformImpact: true, designSystemImpact: true };
  for (const task of [T(), T({ taskClass: 'MEDIUM', taskTypes: ['feature'] }), T({ taskClass: 'TRIVIAL', taskTypes: ['documentation'] })]) {
    const without = routeContext(task, CURRENT, { reached: 2 });
    const withFlags = routeContext({ ...task, signals: flags }, CURRENT, { reached: 2 });
    for (const k of ['minimumLevel', 'ceiling', 'class', 'risk', 'level']) assert.equal(withFlags[k], without[k], `${k} is unchanged`);
    assert.deepEqual(withFlags.impact, without.impact);
    assert.deepEqual(withFlags.reasons, without.reasons);
  }
  const l4 = routeContext(T({ taskClass: 'MEDIUM', taskTypes: ['feature'], signals: flags }), CURRENT, { reached: 3 });
  assert.deepEqual(l4.requiredQueries.map((q) => q.op), ['impact', 'search-config', 'search-api', 'search-data', 'search-platform', 'search-design-system']);
  assert.ok(l4.requiredQueries.filter((q) => q.op.startsWith('search-')).every((q) => q.via === 'search' && q.effect === 'read-only'));
  const none = routeContext(T({ taskClass: 'TRIVIAL', taskTypes: ['documentation'], signals: flags }), CURRENT, { reached: 3 });
  assert.equal(none.requiredQueries.length, 0, 'where no impact is needed the hints add nothing');
  assert.match(fs.readFileSync(path.join(TOOLS_ROOT, 'automation', 'README.md'), 'utf8'), /query hints/);
});

// ---- 8. the refresh hint names only what the plan relies on -----------------------------------------------------

test('H8 stale or missing intelligence at Level 3 emits no refresh hint; each other level names the artifacts it uses', () => {
  const task = T({ taskClass: 'MEDIUM', taskTypes: ['feature'], subsystem: 'src' });
  const hint = (state, reached, intel = {}) => routeContext(task, { state, ...intel }, { reached }).intelligence.refresh;
  assert.equal(hint('stale', 2), null, 'Level 3 reads source only');
  assert.equal(hint('missing', 2), null);
  assert.equal(hint('partial', 2, { artifacts: { graph: 'missing', index: 'current', directoryIndex: 'current' } }), null);
  assert.deepEqual(hint('stale', -1).reliesOn, ['index'], 'Level 0 orients from the index as a hint');
  assert.deepEqual(hint('stale', 1).reliesOn, ['directory-index'], 'Level 2 would use the directory index');
  assert.deepEqual(hint('stale', 3).reliesOn, ['impact'], 'Level 4 would use the graph');
  assert.deepEqual(hint('partial', 3, { artifacts: { graph: 'missing', index: 'current', directoryIndex: 'current' } }).reliesOn, ['impact']);
  assert.equal(hint('partial', 3, { artifacts: { graph: 'current', index: 'current', directoryIndex: 'current' } }), null, 'a current graph needs no refresh');
  assert.equal(hint('partial', 1, { artifacts: { graph: 'current', index: 'current', directoryIndex: 'current' } }), null, 'a trusted directory index needs none');
  assert.equal(hint('unverifiable', 3), null, 'a refresh cannot fix unverifiable');
  assert.equal(hint('partial', 3, { artifacts: { graph: 'unverifiable', index: 'current', directoryIndex: 'current' } }), null);
  assert.equal(hint('current', 3), null);
  assert.equal(hint('unavailable', 3), null);
  const sizes = routeContext(task, { state: 'stale' }, { reached: 3, loaded: [] }).intelligence.refresh;
  assert.match(sizes.note, /does not refresh/);
});

// ---- 9. pure module boundary -----------------------------------------------------------------------------------

test('H9 the router is structurally read-only: its whole import closure has no file, process or network module, and does not include refresh', () => {
  const seen = new Map();
  (function visit(file) {
    if (seen.has(file)) return;
    const src = fs.readFileSync(file, 'utf8');
    const imports = [...src.matchAll(/^import[^;]*?from\s+'([^']+)';/gms)].map((m) => m[1]);
    seen.set(file, imports);
    for (const i of imports.filter((x) => x.startsWith('.'))) visit(path.resolve(path.dirname(file), i));
  })(path.join(TOOLS_ROOT, 'automation', 'context-router.mjs'));
  const files = [...seen.keys()].map((f) => path.relative(TOOLS_ROOT, f).split(path.sep).join('/')).sort();
  assert.deepEqual(files, ['automation/context-router.mjs', 'automation/context-sources.mjs', 'automation/path-safety.mjs', 'automation/records.mjs', 'automation/refresh-decision.mjs', 'lib/artifact-paths.mjs', 'lib/glob.mjs', 'lib/secret-patterns.mjs']);
  const builtins = [...new Set([...seen.values()].flat().filter((x) => x.startsWith('node:')))];
  const forbidden = ['node:fs', 'node:child_process', 'node:net', 'node:http', 'node:https', 'node:dns', 'node:worker_threads', 'node:vm', 'node:os', 'node:fs/promises'];
  assert.deepEqual(builtins.filter((b) => forbidden.includes(b)), [], `node modules in the closure: ${builtins}`);
  for (const f of seen.keys()) {
    const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/writeFile|appendFile|mkdirSync|rmSync|spawn|execSync|fetch\(|process\.env/.test(code), `${path.relative(TOOLS_ROOT, f)} has no write, process, network or environment access`);
  }
  assert.equal(recordsClassify, classifyState, 'refresh re-exports the shared state classifier');
  assert.equal(recordsRecord, actionRecord, 'and the shared record builder');
  const refreshSrc = fs.readFileSync(path.join(TOOLS_ROOT, 'automation', 'refresh.mjs'), 'utf8');
  assert.ok(!/^export (function|const) (classifyState|actionRecord)/m.test(refreshSrc), 'no second definition in refresh');
});

// ---- 10. nothing was weakened: writes, secrets, determinism ----------------------------------------------------

test('H10 routing still writes nothing, prints no secret, and is deterministic with the new inputs', () => {
  const dir = oddProject();
  const SECRET = 'sk-test-HARDEN-9f8e7d-NEVER-PRINT';
  fs.writeFileSync(path.join(dir, '.env'), `API_KEY=${SECRET}\n`);
  const snap = (d) => JSON.stringify(Object.fromEntries((function walk(x) { return fs.readdirSync(x, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(x, e.name)) : [[path.relative(d, path.join(x, e.name)), fs.readFileSync(path.join(x, e.name), 'latin1').length]])); })(d)));
  const before = snap(dir);
  const home = tmpDir('pi-harden-home-');
  const env = { ...process.env, TEMP: home, TMP: home, TMPDIR: home, OPENAI_API_KEY: SECRET };
  const args = ['route', dir, '--json', '--class', 'MEDIUM', '--types', 'feature,refactor', '--targets', '.env,src/my dir/f1.ts,app/[id]/page.tsx', '--queries', 'shortest-path,dependents', '--between', 'src/a.ts,src/b.ts', '--reached', '3'];
  const a = cli(args, home, env);
  const b = cli(args, home, env);
  assert.equal(a.status, 0, a.stderr);
  assert.ok(!a.stdout.includes(SECRET) && !a.stderr.includes(SECRET));
  const strip = (s) => ({ ...JSON.parse(s), record: undefined });
  assert.deepEqual(strip(a.stdout), strip(b.stdout));
  assert.deepEqual(JSON.parse(a.stdout).withheld, ['.env']);
  assert.equal(snap(dir), before, 'the project is unchanged');
  assert.deepEqual(fs.readdirSync(home), []);
});
