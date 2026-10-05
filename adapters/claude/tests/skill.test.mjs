import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadManifest } from '../lib/installer.mjs';
import { OWNER } from '../lib/settings.mjs';
import { parseFrontMatter } from '../lib/util.mjs';
import { ADAPTER, REPO, tree } from './helpers.mjs';

const read = (rel, base = ADAPTER) => fs.readFileSync(path.join(base, rel), 'utf8');
const lines = (t) => t.split('\n').length;

// Adapter-owned budgets (the Claude Code documentation recommends staying under 200 lines for a CLAUDE.md file).
const BUDGET = { claudeMdLines: 25, claudeMdBytes: 1800, skillLines: 100, skillBytes: 7000 };

test('CLAUDE.md block is small and points instead of copying', () => {
  const t = read('CLAUDE.md');
  assert.ok(lines(t) <= BUDGET.claudeMdLines, `${lines(t)} lines`);
  assert.ok(Buffer.byteLength(t) <= BUDGET.claudeMdBytes, `${Buffer.byteLength(t)} bytes`);
  for (const must of ['/erdem', '.ai/', 'progressively', 'Source code is authoritative']) assert.ok(t.includes(must), must);
  assert.ok(!/token register|DESIGN_PRINCIPLES|TOKEN_REGISTER/.test(t), 'no design-system content');
});

test('SKILL.md: valid front matter, precise description, compact body', () => {
  const t = read('skill/SKILL.md');
  const fm = parseFrontMatter(t);
  assert.equal(fm.name, 'erdem');
  assert.ok(fm.description.length > 100);
  assert.ok(fm.description.length <= 1536, 'the combined description is truncated at 1,536 characters by Claude Code');
  assert.match(fm.description, /Do not use for backend/);
  assert.match(fm.description, /UI/);
  assert.match(fm.description, /3D\/WebGL/);
  assert.equal(fm['argument-hint'], '[design|review|context|handoff] [what to do]');
  assert.match(fm['allowed-tools'], /^Bash\(node \$\{CLAUDE_SKILL_DIR\}\/scripts\/erdem\.mjs \*\)$/);
  assert.ok(!('disable-model-invocation' in fm), 'default is model-invocable; --manual-only renders it');
  assert.ok(lines(t) <= BUDGET.skillLines, `${lines(t)} lines`);
  assert.ok(Buffer.byteLength(t) <= BUDGET.skillBytes, `${Buffer.byteLength(t)} bytes`);
  assert.match(t, /\$ARGUMENTS/);
  for (const mode of ['design', 'review', 'context', 'handoff']) assert.ok(t.includes(`**${mode}**`), mode);
});

test('the description does not claim unrelated work', () => {
  const d = parseFrontMatter(read('skill/SKILL.md')).description;
  for (const unrelated of ['database', 'shell', 'build']) assert.match(d, new RegExp(`(?:not use for|Do not use).*${unrelated}`, 'i'));
});

test('references exist and every referenced canonical document exists', () => {
  const files = ['skill/SKILL.md', ...tree(path.join(ADAPTER, 'skill/references')).map((f) => `skill/references/${f}`)];
  assert.equal(files.length, 5);
  const missing = [];
  for (const f of files) {
    for (const m of read(f).matchAll(/`((?:core|ai|platforms|templates|adapters|tools)\/[A-Za-z0-9_./<>-]+\.md)`/g)) {
      const p = m[1].replace('<platform>', 'WEB');
      if (!fs.existsSync(path.join(REPO, p))) missing.push(`${f} -> ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
  const routing = read('skill/references/design-routing.md');
  for (const doc of ['COMPONENT_SYSTEM', 'TOKEN_REGISTER', 'WEBGL_3D', 'MOBILE', 'ACCESSIBILITY', 'MOTION_SYSTEM', 'QUALITY_STANDARD']) assert.ok(routing.includes(doc), doc);
});

test('no canonical content is duplicated into the adapter documents', () => {
  const canonical = new Set();
  for (const dir of ['core', 'ai', 'platforms']) {
    for (const f of tree(path.join(REPO, dir)).filter((x) => x.endsWith('.md'))) {
      for (const line of read(`${dir}/${f}`, REPO).split('\n')) {
        const t = line.trim();
        if (t.length >= 60 && !t.startsWith('|') && !t.startsWith('#')) canonical.add(t);
      }
    }
  }
  const adapterDocs = ['CLAUDE.md', 'README.md', 'skill/SKILL.md', ...tree(path.join(ADAPTER, 'skill/references')).map((f) => `skill/references/${f}`)].filter((f) => fs.existsSync(path.join(ADAPTER, f)));
  const dup = [];
  for (const f of adapterDocs) for (const line of read(f).split('\n')) if (canonical.has(line.trim())) dup.push(`${f}: ${line.trim().slice(0, 60)}`);
  assert.deepEqual(dup, []);
});

test('Claude-specific language does not leak into core, ai, platforms or templates', () => {
  const offenders = [];
  for (const dir of ['core', 'ai', 'platforms', 'templates']) {
    for (const f of tree(path.join(REPO, dir))) {
      if (/\b(claude|anthropic|codex|antigravity)\b/i.test(read(`${dir}/${f}`, REPO))) offenders.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('manifest is consistent with the sources and with the ownership marker', () => {
  const m = loadManifest();
  assert.equal(m.name, 'erdem-claude-adapter');
  assert.equal(m.hookOwner, OWNER);
  assert.equal(m.claudeMdMarker, OWNER);
  assert.equal(m.skillName, 'erdem');
  assert.equal(m.configSchemaVersion, 1);
  for (const f of m.files) assert.ok(fs.existsSync(path.join(ADAPTER, f.source)), f.source);
  for (const h of m.hooks) assert.ok(fs.existsSync(path.join(ADAPTER, h.script)), h.script);
  assert.ok(fs.existsSync(path.join(ADAPTER, m.claudeMd.source)));
  assert.ok(m.capabilities.length >= 4);
  assert.match(m.verifiedWith.claudeCode, /^\d+\.\d+\.\d+$/);
});

test('no dependencies: adapter sources import only relative modules and node: built-ins', () => {
  const offenders = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.mjs')) {
        for (const m of fs.readFileSync(abs, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]/g)) {
          if (!m[1].startsWith('.') && !m[1].startsWith('node:')) offenders.push(`${path.relative(ADAPTER, abs)}: ${m[1]}`);
        }
      }
    }
  })(ADAPTER);
  assert.deepEqual(offenders, []);
  assert.ok(!fs.existsSync(path.join(ADAPTER, 'package.json')) || !JSON.parse(read('package.json')).dependencies);
});

test('manifest declares the canonical system version it needs, and the repository meets it', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ADAPTER, 'package', 'adapter-manifest.json'), 'utf8'));
  assert.equal(m.owner, m.hookOwner);
  assert.match(m.requiresSystemVersion, /^\d+\.\d+\.\d+$/);
  const system = fs.readFileSync(path.join(ADAPTER, '..', '..', 'VERSION'), 'utf8').trim();
  const cmp = (a, b) => a.split('.').map(Number).reduce((r, n, i) => r || n - Number(b.split('.')[i]), 0);
  assert.ok(cmp(system, m.requiresSystemVersion) >= 0, `${system} must be at least ${m.requiresSystemVersion}`);
  assert.ok(m.integrationType.includes('skill') && m.supportedEnvironment.node);
});
