import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run as install } from '../scripts/install.mjs';
import { run as uninstall } from '../scripts/uninstall.mjs';
import { run as doctor } from '../scripts/doctor.mjs';
import { OWNER } from '../lib/installer.mjs';
import { capture, cleanup, fakeHome, snapshot, tmp, tree, write } from './helpers.mjs';

after(cleanup);

const base = (h) => ['--codex-home', h.codexHome, '--agents-home', h.agentsHome];
const inst = (h, extra = []) => {
  const q = capture();
  return { code: install([...base(h), ...extra], { io: q.io, env: h.env, home: h.root }), text: q.text() };
};
const uninst = (h, extra = []) => {
  const q = capture();
  return { code: uninstall([...base(h), ...extra], { io: q.io, env: h.env, home: h.root }), text: q.text() };
};
const doc = (h, extra = []) => {
  const q = capture();
  return { code: doctor([...base(h), '--no-codex-cli', '--no-intel', '--json', ...extra], { io: q.io, env: h.env, home: h.root, cwd: h.root }), text: q.text() };
};
const checks = (r) => JSON.parse(r.text).checks;
const level = (r, id) => checks(r).filter((c) => c.id === id).map((c) => c.level);

test('14 uninstall restores the original state exactly and is idempotent', () => {
  const h = fakeHome();
  write(path.join(h.codexHome, 'AGENTS.md'), '# mine\r\n\r\ntext\r\n');
  write(path.join(h.codexHome, 'config.toml'), 'a = 1\n');
  write(path.join(h.agentsHome, 'skills/other/SKILL.md'), 'other');
  const before = snapshot(h.root);
  inst(h, ['--agents-md']);
  const r = uninst(h);
  assert.equal(r.code, 0, r.text);
  const after_ = snapshot(h.root);
  assert.equal(after_['.codex/AGENTS.md'], before['.codex/AGENTS.md'], 'the block is removed and the file text is restored byte for byte');
  assert.ok(!tree(h.root).some((f) => f.startsWith('.agents/skills/erdem/')));
  assert.equal(after_['.codex/config.toml'], before['.codex/config.toml']);
  assert.equal(after_['.agents/skills/other/SKILL.md'], before['.agents/skills/other/SKILL.md']);
  assert.ok(after_['.codex/erdem-adapter/config.json'], 'the user adapter config is kept unless --purge-config');
  const again = uninst(h);
  assert.equal(again.code, 0);
  assert.match(again.text, /nothing to remove/);
  assert.equal(uninst(h, ['--purge-config']).code, 0);
  assert.ok(!tree(h.root).some((f) => f.includes('erdem-adapter')));
});

test('15 uninstall dry run changes nothing; a created AGENTS.md is removed again', () => {
  const h = fakeHome();
  inst(h, ['--agents-md']);
  assert.ok(fs.existsSync(path.join(h.codexHome, 'AGENTS.md')));
  const before = snapshot(h.root);
  const d = uninst(h, ['--dry-run']);
  assert.match(d.text, /^\[dry run\]/);
  assert.deepEqual(snapshot(h.root), before);
  uninst(h);
  assert.ok(!fs.existsSync(path.join(h.codexHome, 'AGENTS.md')), 'an AGENTS.md the adapter created is removed with its block');
});

test('16 uninstall never removes a foreign skill, a modified skill file, or a block without a ledger entry', () => {
  const h = fakeHome();
  write(path.join(h.agentsHome, 'skills/erdem/SKILL.md'), 'foreign');
  const before = snapshot(h.root);
  uninst(h);
  assert.deepEqual(snapshot(h.root), before, 'a foreign skill folder is left alone');

  const h2 = fakeHome();
  inst(h2, ['--agents-md']);
  fs.rmSync(path.join(h2.codexHome, 'erdem-adapter/install.json'));
  const r = uninst(h2);
  assert.match(r.text, /ledger|not recorded|left/i);
  assert.ok(fs.readFileSync(path.join(h2.codexHome, 'AGENTS.md'), 'utf8').includes(`BEGIN ${OWNER}`), 'no ledger entry means the block stays');
});

test('17 project-scope uninstall removes only project files and leaves the user scope alone', () => {
  const h = fakeHome();
  inst(h);
  const proj = tmp('erdem-proj-');
  write(path.join(proj, 'AGENTS.md'), '# project\n');
  const q = capture();
  install(['--scope', 'project', '--project', proj, '--agents-md'], { io: q.io, env: h.env, home: h.root });
  const userBefore = snapshot(h.root);
  const q2 = capture();
  assert.equal(uninstall(['--scope', 'project', '--project', proj], { io: q2.io, env: h.env, home: h.root }), 0, q2.text());
  assert.equal(fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8'), '# project\n');
  assert.ok(!tree(proj).some((f) => f.startsWith('.agents/')), tree(proj).join(','));
  assert.deepEqual(snapshot(h.root), userBefore);
});

test('18 doctor on a clean install: no failures; levels are ok/info/warning/failure only', () => {
  const h = fakeHome();
  inst(h, ['--agents-md']);
  const r = doc(h);
  assert.equal(r.code, 0, r.text);
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.checks.every((c) => ['ok', 'info', 'warning', 'failure'].includes(c.level)));
  for (const id of ['node', 'config', 'design-system', 'canonical-files', 'adapter-files', 'manifest', 'skill', 'agents-md', 'permissions']) assert.ok(checks(r).some((c) => c.id === id), `missing check ${id}`);
  assert.deepEqual(level(r, 'canonical-files'), ['ok']);
  assert.deepEqual(level(r, 'skill'), ['ok']);
});

test('19 doctor is read-only: the whole tree is unchanged and no files are created', () => {
  const h = fakeHome();
  inst(h, ['--agents-md']);
  write(path.join(h.codexHome, 'config.toml'), 'token = "SUPERSECRET-DO-NOT-PRINT"\n');
  const before = snapshot(h.root);
  const r = doc(h);
  assert.deepEqual(snapshot(h.root), before);
  assert.ok(!r.text.includes('SUPERSECRET'), 'config.toml is never opened');
  const empty = fakeHome();
  doc(empty);
  assert.deepEqual(tree(empty.root), []);
});

test('20 doctor reports problems: missing skill, modified skill, invalid ownership, malformed config, bad design-system path', () => {
  const none = fakeHome();
  assert.deepEqual(level(doc(none), 'skill'), ['warning']);

  const mod = fakeHome();
  inst(mod);
  fs.appendFileSync(path.join(mod.agentsHome, 'skills/erdem/SKILL.md'), 'x');
  assert.deepEqual(level(doc(mod), 'skill'), ['warning']);

  const bad = fakeHome();
  write(path.join(bad.agentsHome, 'skills/erdem/SKILL.md'), 'foreign');
  write(path.join(bad.agentsHome, 'skills/erdem/.erdem-owner.json'), '{ nope');
  const rb = doc(bad);
  assert.deepEqual(level(rb, 'skill'), ['failure']);
  assert.equal(rb.code, 1);

  const cfg = fakeHome();
  write(path.join(cfg.codexHome, 'erdem-adapter/config.json'), '{ not json');
  const rc = doc(cfg);
  assert.ok(level(rc, 'config').includes('failure'));
  assert.equal(rc.code, 1);

  const ds = fakeHome();
  const nowhere = path.join(tmp(), 'missing-ds');
  const rd = (() => {
    const q = capture();
    const code = doctor([...base(ds), '--no-codex-cli', '--no-intel', '--json'], { io: q.io, env: { ...ds.env, ERDEM_DESIGN_SYSTEM_ROOT: nowhere }, home: ds.root, cwd: ds.root });
    return { code, text: q.text() };
  })();
  assert.ok(level(rd, 'design-system-config').includes('warning'), 'an invalid configured root is called out');
});

test('21 doctor flags a block that is missing from the ledger, and an over-size AGENTS.md', () => {
  const h = fakeHome();
  inst(h, ['--agents-md']);
  fs.rmSync(path.join(h.codexHome, 'erdem-adapter/install.json'));
  assert.deepEqual(level(doc(h), 'agents-ledger'), ['warning']);
  fs.appendFileSync(path.join(h.codexHome, 'AGENTS.md'), '\n' + 'filler line\n'.repeat(4000));
  assert.deepEqual(level(doc(h), 'agents-size'), ['warning']);
});

test('22 doctor usage errors exit 2; output never contains environment values', () => {
  const h = fakeHome();
  const q = capture();
  assert.equal(doctor(['--scope', 'machine'], { io: q.io, env: h.env, home: h.root }), 2);
  const env = { ...h.env, OPENAI_API_KEY: 'sk-test-SHOULD-NEVER-APPEAR', ERDEM_PREFERRED_PROFILE: 'standard' };
  const q2 = capture();
  doctor([...base(h), '--no-codex-cli', '--no-intel'], { io: q2.io, env, home: h.root, cwd: h.root });
  assert.ok(!q2.text().includes('sk-test-SHOULD-NEVER-APPEAR'));
});
