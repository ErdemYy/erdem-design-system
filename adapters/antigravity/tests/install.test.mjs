import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run as install } from '../scripts/install.mjs';
import { OWNER } from '../lib/installer.mjs';
import { ADAPTER, LAUNCHER, capture, cleanup, fakeHome, node, readJson, snapshot, tmp, tree, write } from './helpers.mjs';

after(cleanup);

const CODEX_OWNER = 'ERDEM_DESIGN_SYSTEM_CODEX_ADAPTER';
const user = (h, extra = []) => {
  const q = capture();
  const code = install(['--config-home', h.configHome, ...extra], { io: q.io, env: h.env, home: h.root });
  return { code, text: q.text() };
};
const project = (h, proj, extra = []) => {
  const q = capture();
  const code = install(['--scope', 'project', '--project', proj, ...extra], { io: q.io, env: h.env, home: h.root });
  return { code, text: q.text() };
};
const SKILL = '.gemini/config/skills/erdem';

test('1 dry run changes nothing and says what it would do', () => {
  const h = fakeHome();
  write(path.join(h.configHome, 'mcp_config.json'), '{}');
  const before = snapshot(h.root);
  const r = user(h, ['--dry-run']);
  assert.equal(r.code, 0);
  assert.match(r.text, /^\[dry run\]/);
  assert.match(r.text, /create .*SKILL\.md/);
  assert.deepEqual(snapshot(h.root), before);
  const proj = tmp('erdem-proj-');
  const pb = snapshot(proj);
  assert.match(project(h, proj, ['--agents-md', '--dry-run']).text, /create .*AGENTS\.md/);
  assert.deepEqual(snapshot(proj), pb);
});

test('2 clean user install: skill, owner file, config and ledger; no hooks, MCP, rules or plugins are created', () => {
  const h = fakeHome();
  const r = user(h);
  assert.equal(r.code, 0, r.text);
  const files = tree(h.root);
  for (const f of ['SKILL.md', 'references/context.md', 'references/task-routing.md', 'references/design-routing.md', 'references/validation.md', 'references/handoff.md', 'scripts/erdem.mjs', 'adapter-link.json', '.erdem-owner.json']) assert.ok(files.includes(`${SKILL}/${f}`), `missing ${f}`);
  assert.ok(files.includes('.gemini/config/erdem-adapter/config.json') && files.includes('.gemini/config/erdem-adapter/install.json'));
  assert.ok(!files.some((f) => /hooks\.json$|mcp_config\.json$|plugins?\.json$|skills\.json$|\/rules\/|\/workflows\/|GEMINI\.md$|AGENTS\.md$/.test(f)), 'only the skill and adapter state are written');
  const owner = readJson(path.join(h.configHome, 'skills/erdem/.erdem-owner.json'));
  assert.equal(owner.owner, OWNER);
  const link = readJson(path.join(h.configHome, 'skills/erdem/adapter-link.json'));
  assert.ok(fs.existsSync(path.join(link.adapterDir, 'scripts/context.mjs')));
});

test('3 repeated install is idempotent (user and project)', () => {
  const h = fakeHome();
  user(h);
  const before = snapshot(h.root);
  const again = user(h);
  assert.equal(again.code, 0);
  assert.match(again.text, /already up to date/);
  assert.deepEqual(snapshot(h.root), before);
  const proj = tmp('erdem-proj-');
  project(h, proj, ['--agents-md']);
  const pb = snapshot(proj);
  assert.match(project(h, proj, ['--agents-md']).text, /already up to date/);
  assert.deepEqual(snapshot(proj), pb);
  assert.equal(fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8').split(`BEGIN ${OWNER}`).length - 1, 1);
});

test('4 AGENTS.md block: existing content is preserved byte for byte (BOM, CRLF, UTF-8, foreign blocks)', () => {
  const h = fakeHome();
  const proj = tmp('erdem-proj-');
  const original = '﻿# Kurallarım\r\n\r\nÇalışma kuralları: şğüöçı İ.\r\n<!-- BEGIN:nextjs-agent-rules -->\r\nx\r\n<!-- END:nextjs-agent-rules -->\r\n';
  write(path.join(proj, 'AGENTS.md'), original);
  assert.equal(project(h, proj, ['--agents-md']).code, 0);
  const md = fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8');
  assert.ok(md.startsWith(original));
  assert.ok(!/[^\r]\n/.test(md.replace(/^﻿/, '')), 'CRLF kept throughout');
  project(h, proj, ['--agents-md']);
  assert.equal(fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8'), md);
});

test('5 foreign skill folder and invalid ownership metadata are never overwritten; nothing else changes', () => {
  for (const owner of [null, '{ not json', JSON.stringify({ owner: 'SOMEONE_ELSE', files: {} }), JSON.stringify({ owner: OWNER })]) {
    const h = fakeHome();
    write(path.join(h.configHome, 'skills/erdem/SKILL.md'), '---\nname: erdem\n---\nsomeone else\n');
    if (owner !== null) write(path.join(h.configHome, 'skills/erdem/.erdem-owner.json'), owner);
    const before = snapshot(h.root);
    const r = user(h);
    assert.equal(r.code, 1, String(owner));
    assert.match(r.text, /not owned by this adapter/);
    assert.deepEqual(snapshot(h.root), before, 'blocked means no change at all');
  }
});

test('6 unbalanced markers block the project install and leave the file untouched', () => {
  for (const content of [`x\n<!-- BEGIN ${OWNER} -->\nhalf\n`, `<!-- END ${OWNER} -->\nx\n<!-- BEGIN ${OWNER} -->\n`, `<!-- BEGIN ${OWNER} -->\n<!-- BEGIN ${OWNER} -->\n<!-- END ${OWNER} -->\n`]) {
    const h = fakeHome();
    const proj = tmp('erdem-proj-');
    write(path.join(proj, 'AGENTS.md'), content);
    const before = snapshot(proj);
    const r = project(h, proj, ['--agents-md']);
    assert.equal(r.code, 1);
    assert.match(r.text, /unbalanced or duplicated/);
    assert.deepEqual(snapshot(proj), before);
  }
});

test('7 local changes are kept unless --force', () => {
  const h = fakeHome();
  user(h);
  const skill = path.join(h.configHome, 'skills/erdem/SKILL.md');
  fs.appendFileSync(skill, '\nmy note\n');
  assert.match(user(h).text, /local changes and was left as is/);
  assert.ok(fs.readFileSync(skill, 'utf8').includes('my note'));
  assert.equal(user(h, ['--force']).code, 0);
  assert.ok(!fs.readFileSync(skill, 'utf8').includes('my note'));
});

test('8 project scope: skill files are path-free, only the ledger is machine-specific, the launcher resolves the adapter without help', () => {
  const h = fakeHome();
  const proj = tmp('erdem-proj-');
  write(path.join(proj, 'GEMINI.md'), '# my gemini rules\n');
  const r = project(h, proj, ['--agents-md']);
  assert.equal(r.code, 0, r.text);
  const files = tree(proj);
  assert.ok(files.includes('.agents/skills/erdem/SKILL.md'));
  assert.ok(files.includes('.agents/.erdem-antigravity-install.json'));
  assert.ok(!files.includes('.agents/skills/erdem/adapter-link.json'));
  assert.equal(fs.readFileSync(path.join(proj, 'GEMINI.md'), 'utf8'), '# my gemini rules\n', 'GEMINI.md is never touched');
  for (const f of files.filter((x) => x.startsWith('.agents/skills/'))) {
    const t = fs.readFileSync(path.join(proj, f), 'utf8');
    assert.ok(!t.includes(ADAPTER) && !t.includes(ADAPTER.replace(/\\/g, '/')), `${f} embeds a local path`);
  }
  assert.match(r.text, /out of version control/);
  const env = { ...h.env };
  delete env.ERDEM_ADAPTER_DIR;
  const out = node(path.join(proj, '.agents/skills/erdem/scripts/erdem.mjs'), ['root'], { env, cwd: proj });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(path.resolve(out.stdout.trim()), path.resolve(ADAPTER, '..', '..'));
});

test('9 sibling Codex adapter: its skill folder and its AGENTS.md block are recognized and kept, nothing is duplicated', () => {
  const h = fakeHome();
  const proj = tmp('erdem-proj-');
  write(path.join(proj, '.agents/skills/erdem/SKILL.md'), 'codex skill');
  write(path.join(proj, '.agents/skills/erdem/.erdem-owner.json'), JSON.stringify({ owner: CODEX_OWNER, files: {} }));
  write(path.join(proj, 'AGENTS.md'), `<!-- BEGIN ${CODEX_OWNER} -->\nblock\n<!-- END ${CODEX_OWNER} -->\n`);
  const before = snapshot(proj);
  const r = project(h, proj, ['--agents-md']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /already provided by the Codex adapter/);
  assert.match(r.text, /Codex adapter's block/);
  const after_ = snapshot(proj);
  for (const f of Object.keys(before)) assert.equal(after_[f], before[f], `${f} changed`);
  assert.deepEqual(Object.keys(after_).filter((f) => !(f in before)).sort(), ['.agents/.erdem-antigravity-install.json']);
});

test('10 no write outside the owned scope: only skill and adapter state change in the config home', () => {
  const h = fakeHome();
  write(path.join(h.configHome, 'mcp_config.json'), '{"servers":{"x":{"env":{"TOKEN":"SUPERSECRET123"}}}}');
  write(path.join(h.configHome, 'hooks.json'), '{"mine":{}}');
  write(path.join(h.configHome, 'skills/other/SKILL.md'), 'other skill');
  write(path.join(h.root, '.gemini/GEMINI.md'), 'user rules');
  write(path.join(h.root, 'unrelated.txt'), 'u');
  const before = snapshot(h.root);
  user(h);
  const after_ = snapshot(h.root);
  const changed = Object.keys(after_).filter((f) => before[f] !== after_[f]);
  const allowed = [/^\.gemini\/config\/skills\/erdem\//, /^\.gemini\/config\/erdem-adapter\//];
  assert.ok(changed.length > 5);
  assert.deepEqual(changed.filter((f) => !allowed.some((re) => re.test(f))), []);
  for (const f of ['.gemini/config/mcp_config.json', '.gemini/config/hooks.json', '.gemini/config/skills/other/SKILL.md', '.gemini/GEMINI.md', 'unrelated.txt']) assert.equal(after_[f], before[f], `${f} must be untouched`);
});

test('11 missing design-system path is an explicit error, not a silent guess', () => {
  const h = fakeHome();
  const r = user(h, ['--design-system-root', path.join(tmp(), 'no-such-design-system')]);
  assert.equal(r.code, 2);
  assert.match(r.text, /not an Erdem Design System root/);
  assert.deepEqual(tree(h.root), []);
});

test('12 unsupported capabilities are refused with a clear message, not faked', () => {
  const h = fakeHome();
  const r = user(h, ['--agents-md']);
  assert.equal(r.code, 2);
  assert.match(r.text, /no user-level instructions file/);
  assert.deepEqual(tree(h.root), [], 'nothing written');
  for (const args of [['--bogus'], ['--scope', 'machine'], ['--hooks'], ['--mcp'], ['--codex-home', 'x']]) {
    const q = capture();
    let code;
    try {
      code = install(args, { io: q.io, env: h.env, home: h.root });
    } catch {
      code = 99;
    }
    assert.equal(code, 2, args.join(' '));
  }
  const q = capture();
  assert.throws(() => install(['--scope', 'project'], { io: q.io, env: h.env, home: h.root }), /--project/);
});

test('13 the installed skill and launcher work end to end from the installed location, with no Antigravity present', () => {
  const h = fakeHome();
  user(h);
  const launcher = path.join(h.configHome, 'skills/erdem/scripts/erdem.mjs');
  const proj = tmp('erdem-proj-');
  const r = node(launcher, ['context'], { env: h.env, cwd: proj });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ERDEM CONTEXT \(antigravity adapter\)/);
  assert.match(r.stdout, /intelligence: missing/);
  assert.ok(fs.existsSync(LAUNCHER));
});
