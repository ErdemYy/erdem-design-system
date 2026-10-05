import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run as install } from '../scripts/install.mjs';
import { OWNER } from '../lib/installer.mjs';
import { ADAPTER, LAUNCHER, capture, cleanup, fakeHome, node, readJson, snapshot, tmp, tree, write } from './helpers.mjs';

after(cleanup);

const inst = (h, extra = []) => {
  const q = capture();
  const code = install(['--codex-home', h.codexHome, '--agents-home', h.agentsHome, ...extra], { io: q.io, env: h.env, home: h.root });
  return { code, text: q.text() };
};

test('1 dry run changes nothing and says what it would do', () => {
  const h = fakeHome();
  write(path.join(h.codexHome, 'AGENTS.md'), '# Mine\n');
  const before = snapshot(h.root);
  const r = inst(h, ['--agents-md', '--dry-run']);
  assert.equal(r.code, 0);
  assert.match(r.text, /^\[dry run\]/);
  assert.match(r.text, /create .*SKILL\.md/);
  assert.match(r.text, /update .*AGENTS\.md/);
  assert.deepEqual(snapshot(h.root), before);
});

test('2 clean install: skill, owner file, config and ledger; the AGENTS.md block is opt-in; no config.toml or hooks', () => {
  const h = fakeHome();
  const r = inst(h);
  assert.equal(r.code, 0, r.text);
  const files = tree(h.root);
  for (const f of ['.agents/skills/erdem/SKILL.md', '.agents/skills/erdem/references/context.md', '.agents/skills/erdem/references/task-routing.md', '.agents/skills/erdem/references/design-routing.md', '.agents/skills/erdem/references/validation.md', '.agents/skills/erdem/references/handoff.md', '.agents/skills/erdem/scripts/erdem.mjs', '.agents/skills/erdem/adapter-link.json', '.agents/skills/erdem/.erdem-owner.json', '.codex/erdem-adapter/config.json', '.codex/erdem-adapter/install.json']) {
    assert.ok(files.includes(f), `missing ${f}`);
  }
  assert.ok(!files.includes('.codex/AGENTS.md'), 'no AGENTS.md without --agents-md');
  assert.ok(!files.some((f) => /config\.toml$|hooks\.json$/.test(f)), 'config.toml and hooks are never created');
  const owner = readJson(path.join(h.agentsHome, 'skills/erdem/.erdem-owner.json'));
  assert.equal(owner.owner, OWNER);
  assert.ok(Object.keys(owner.files).includes('SKILL.md'));
  const link = readJson(path.join(h.agentsHome, 'skills/erdem/adapter-link.json'));
  assert.ok(fs.existsSync(path.join(link.adapterDir, 'scripts/context.mjs')));
});

test('3 repeated install is idempotent', () => {
  const h = fakeHome();
  inst(h, ['--agents-md']);
  const before = snapshot(h.root);
  const again = inst(h, ['--agents-md']);
  assert.equal(again.code, 0);
  assert.match(again.text, /already up to date/);
  assert.deepEqual(snapshot(h.root), before);
  const md = fs.readFileSync(path.join(h.codexHome, 'AGENTS.md'), 'utf8');
  assert.equal(md.split(`BEGIN ${OWNER}`).length - 1, 1);
});

test('4 existing AGENTS.md content is preserved byte for byte (BOM, CRLF, UTF-8)', () => {
  const h = fakeHome();
  const original = '﻿# Kurallarım\r\n\r\nÇalışma kuralları: şğüöçı İ.\r\n';
  write(path.join(h.codexHome, 'AGENTS.md'), original);
  assert.equal(inst(h, ['--agents-md']).code, 0);
  const md = fs.readFileSync(path.join(h.codexHome, 'AGENTS.md'), 'utf8');
  assert.ok(md.startsWith(original), 'the original text is untouched');
  assert.ok(md.includes('\r\n<!-- BEGIN') || md.includes(`<!-- BEGIN ${OWNER} -->`));
  assert.ok(!/[^\r]\n/.test(md.replace(/^﻿/, '')), 'the file keeps CRLF line endings throughout');
  const before = md;
  inst(h, ['--agents-md']);
  assert.equal(fs.readFileSync(path.join(h.codexHome, 'AGENTS.md'), 'utf8'), before);
});

test('5 foreign skill folder and invalid ownership metadata are never overwritten; nothing else changes', () => {
  for (const owner of [null, '{ not json', JSON.stringify({ owner: 'SOMEONE_ELSE', files: {} }), JSON.stringify({ owner: OWNER })]) {
    const h = fakeHome();
    write(path.join(h.agentsHome, 'skills/erdem/SKILL.md'), '---\nname: erdem\n---\nsomeone else\n');
    if (owner !== null) write(path.join(h.agentsHome, 'skills/erdem/.erdem-owner.json'), owner);
    write(path.join(h.codexHome, 'AGENTS.md'), '# keep\n');
    const before = snapshot(h.root);
    const r = inst(h, ['--agents-md']);
    assert.equal(r.code, 1, String(owner));
    assert.match(r.text, /not owned by this adapter/);
    assert.deepEqual(snapshot(h.root), before, 'blocked means no change at all');
  }
});

test('6 unbalanced markers block the install and leave the file untouched', () => {
  for (const content of [`x\n<!-- BEGIN ${OWNER} -->\nhalf\n`, `<!-- END ${OWNER} -->\nx\n<!-- BEGIN ${OWNER} -->\n`, `<!-- BEGIN ${OWNER} -->\n<!-- BEGIN ${OWNER} -->\n<!-- END ${OWNER} -->\n`]) {
    const h = fakeHome();
    write(path.join(h.codexHome, 'AGENTS.md'), content);
    const before = snapshot(h.root);
    const r = inst(h, ['--agents-md']);
    assert.equal(r.code, 1);
    assert.match(r.text, /unbalanced or duplicated/);
    assert.deepEqual(snapshot(h.root), before);
  }
});

test('7 AGENTS.override.md takes precedence: the block goes where Codex will load it', () => {
  const h = fakeHome();
  write(path.join(h.codexHome, 'AGENTS.md'), '# base\n');
  write(path.join(h.codexHome, 'AGENTS.override.md'), '# override\n');
  const r = inst(h, ['--agents-md']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /AGENTS\.override\.md exists/);
  assert.ok(fs.readFileSync(path.join(h.codexHome, 'AGENTS.override.md'), 'utf8').includes(`BEGIN ${OWNER}`));
  assert.equal(fs.readFileSync(path.join(h.codexHome, 'AGENTS.md'), 'utf8'), '# base\n');
});

test('8 local changes are kept unless --force', () => {
  const h = fakeHome();
  inst(h);
  const skill = path.join(h.agentsHome, 'skills/erdem/SKILL.md');
  fs.appendFileSync(skill, '\nmy note\n');
  const r = inst(h);
  assert.match(r.text, /local changes and was left as is/);
  assert.ok(fs.readFileSync(skill, 'utf8').includes('my note'));
  assert.equal(inst(h, ['--force']).code, 0);
  assert.ok(!fs.readFileSync(skill, 'utf8').includes('my note'));
});

test('9 project scope: skill files are path-free, the ledger is the only machine-specific file, the launcher still resolves the adapter', () => {
  const h = fakeHome();
  const proj = tmp('erdem-proj-');
  write(path.join(proj, 'AGENTS.md'), '<!-- BEGIN:nextjs-agent-rules -->\n# Foreign block\n<!-- END:nextjs-agent-rules -->\n');
  const q = capture();
  const code = install(['--scope', 'project', '--project', proj, '--agents-md'], { io: q.io, env: h.env, home: h.root });
  assert.equal(code, 0, q.text());
  const files = tree(proj);
  assert.ok(files.includes('.agents/skills/erdem/SKILL.md'));
  assert.ok(files.includes('.agents/.erdem-codex-install.json'));
  assert.ok(!files.includes('.agents/skills/erdem/adapter-link.json'), 'no adapter-link in a committed project skill');
  for (const f of files.filter((x) => x.startsWith('.agents/skills/'))) {
    const t = fs.readFileSync(path.join(proj, f), 'utf8');
    assert.ok(!t.includes(ADAPTER) && !t.includes(ADAPTER.replace(/\\/g, '/')), `${f} embeds a local path`);
  }
  const md = fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8');
  assert.ok(md.startsWith('<!-- BEGIN:nextjs-agent-rules -->\n# Foreign block\n<!-- END:nextjs-agent-rules -->\n'));
  assert.match(q.text(), /out of version control/);
  // the launcher finds the adapter through the untracked ledger, with no environment help
  const launcher = path.join(proj, '.agents/skills/erdem/scripts/erdem.mjs');
  const env = { ...h.env };
  delete env.ERDEM_ADAPTER_DIR;
  const r = node(launcher, ['root'], { env, cwd: proj });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(path.resolve(r.stdout.trim()), path.resolve(path.join(ADAPTER, '..', '..')));
});

test('10 no write outside the owned scope: only the adapter paths change in the home and project', () => {
  const h = fakeHome();
  write(path.join(h.codexHome, 'config.toml'), 'model = "x"\n');
  write(path.join(h.codexHome, 'auth.json'), '{"token":"SUPERSECRET123"}');
  write(path.join(h.root, 'unrelated.txt'), 'u');
  write(path.join(h.agentsHome, 'skills/other/SKILL.md'), 'other skill');
  const before = snapshot(h.root);
  inst(h, ['--agents-md']);
  const after_ = snapshot(h.root);
  const changed = Object.keys(after_).filter((f) => before[f] !== after_[f]);
  const allowed = [/^\.agents\/skills\/erdem\//, /^\.codex\/erdem-adapter\//, /^\.codex\/AGENTS\.md$/];
  assert.ok(changed.length > 5);
  assert.deepEqual(changed.filter((f) => !allowed.some((re) => re.test(f))), [], 'writes outside the owned scope');
  for (const f of ['.codex/config.toml', '.codex/auth.json', 'unrelated.txt', '.agents/skills/other/SKILL.md']) assert.equal(after_[f], before[f], `${f} must be untouched`);
});

test('11 missing design-system path is an explicit error, not a silent guess', () => {
  const h = fakeHome();
  const nowhere = path.join(tmp(), 'no-such-design-system');
  const r = inst(h, ['--design-system-root', nowhere]);
  assert.equal(r.code, 2);
  assert.match(r.text, /not an Erdem Design System root/);
  assert.deepEqual(tree(h.root), [], 'nothing was written');
});

test('12 usage errors exit 2 and print a clear message', () => {
  const h = fakeHome();
  for (const args of [['--bogus'], ['--scope', 'machine'], ['--scope', 'project'], ['--codex-home']]) {
    const q = capture();
    let code;
    try {
      code = install(args, { io: q.io, env: h.env, home: h.root });
    } catch (e) {
      code = e.message.includes('--project') ? 2 : 99;
    }
    assert.ok(code === 2 || code === undefined, `${args.join(' ')} -> ${code}`);
  }
});

test('13 the installed skill and launcher work end to end from the installed location', () => {
  const h = fakeHome();
  inst(h);
  const launcher = path.join(h.agentsHome, 'skills/erdem/scripts/erdem.mjs');
  const proj = tmp('erdem-proj-');
  const r = node(launcher, ['context'], { env: h.env, cwd: proj });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ERDEM CONTEXT \(codex adapter\)/);
  assert.match(r.stdout, /intelligence: missing/);
  assert.equal(path.basename(path.dirname(path.dirname(launcher))), 'erdem');
  assert.ok(fs.existsSync(LAUNCHER));
});
