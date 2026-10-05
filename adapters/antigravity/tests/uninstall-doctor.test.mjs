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

const inst = (h, extra = []) => {
  const q = capture();
  return { code: install(['--config-home', h.configHome, ...extra], { io: q.io, env: h.env, home: h.root }), text: q.text() };
};
const instP = (h, proj, extra = []) => {
  const q = capture();
  return { code: install(['--scope', 'project', '--project', proj, ...extra], { io: q.io, env: h.env, home: h.root }), text: q.text() };
};
const uninst = (h, extra = []) => {
  const q = capture();
  return { code: uninstall(['--config-home', h.configHome, ...extra], { io: q.io, env: h.env, home: h.root }), text: q.text() };
};
const uninstP = (h, proj, extra = []) => {
  const q = capture();
  return { code: uninstall(['--scope', 'project', '--project', proj, ...extra], { io: q.io, env: h.env, home: h.root }), text: q.text() };
};
const doc = (h, extra = [], env = h.env) => {
  const q = capture();
  return { code: doctor(['--config-home', h.configHome, '--no-cli', '--no-intel', '--json', ...extra], { io: q.io, env, home: h.root, cwd: h.root }), text: q.text() };
};
const checks = (r) => JSON.parse(r.text).checks;
const level = (r, id) => checks(r).filter((c) => c.id === id).map((c) => c.level);

test('14 user uninstall restores the original state; the adapter config is kept unless --purge-config; idempotent', () => {
  const h = fakeHome();
  write(path.join(h.configHome, 'mcp_config.json'), '{"a":1}');
  write(path.join(h.configHome, 'skills/other/SKILL.md'), 'other');
  const before = snapshot(h.root);
  inst(h);
  const r = uninst(h);
  assert.equal(r.code, 0, r.text);
  const after_ = snapshot(h.root);
  assert.ok(!tree(h.root).some((f) => f.includes('skills/erdem/')));
  assert.equal(after_['.gemini/config/mcp_config.json'], before['.gemini/config/mcp_config.json']);
  assert.equal(after_['.gemini/config/skills/other/SKILL.md'], before['.gemini/config/skills/other/SKILL.md']);
  assert.ok(after_['.gemini/config/erdem-adapter/config.json']);
  assert.match(uninst(h).text, /nothing to remove/);
  assert.equal(uninst(h, ['--purge-config']).code, 0);
  assert.ok(!tree(h.root).some((f) => f.includes('erdem-adapter')));
});

test('15 project uninstall: the block is removed, a created AGENTS.md is removed again, dry run changes nothing', () => {
  const h = fakeHome();
  const proj = tmp('erdem-proj-');
  write(path.join(proj, 'keep.txt'), 'k');
  instP(h, proj, ['--agents-md']);
  assert.ok(fs.existsSync(path.join(proj, 'AGENTS.md')));
  const before = snapshot(proj);
  const d = uninstP(h, proj, ['--dry-run']);
  assert.match(d.text, /^\[dry run\]/);
  assert.deepEqual(snapshot(proj), before);
  assert.equal(uninstP(h, proj).code, 0);
  assert.deepEqual(tree(proj), ['keep.txt']);

  const proj2 = tmp('erdem-proj-');
  write(path.join(proj2, 'AGENTS.md'), '# mine\r\n\r\ntext\r\n');
  const original = snapshot(proj2);
  instP(h, proj2, ['--agents-md']);
  uninstP(h, proj2);
  assert.deepEqual(snapshot(proj2), original, 'the user text is restored byte for byte');
});

test('16 uninstall never removes a foreign or sibling skill, or a block without a ledger entry', () => {
  const h = fakeHome();
  write(path.join(h.configHome, 'skills/erdem/SKILL.md'), 'foreign');
  const before = snapshot(h.root);
  uninst(h);
  assert.deepEqual(snapshot(h.root), before);

  const proj = tmp('erdem-proj-');
  write(path.join(proj, '.agents/skills/erdem/.erdem-owner.json'), JSON.stringify({ owner: 'ERDEM_DESIGN_SYSTEM_CODEX_ADAPTER', files: {} }));
  const pb = snapshot(proj);
  uninstP(h, proj);
  assert.deepEqual(snapshot(proj), pb, 'the Codex adapter skill is left alone');

  const proj2 = tmp('erdem-proj-');
  instP(h, proj2, ['--agents-md']);
  fs.rmSync(path.join(proj2, '.agents/.erdem-antigravity-install.json'));
  uninstP(h, proj2);
  assert.ok(fs.readFileSync(path.join(proj2, 'AGENTS.md'), 'utf8').includes(`BEGIN ${OWNER}`), 'no ledger entry means the block stays');
});

test('17 project-scope uninstall leaves the user scope alone', () => {
  const h = fakeHome();
  inst(h);
  const proj = tmp('erdem-proj-');
  instP(h, proj, ['--agents-md']);
  const userBefore = snapshot(h.root);
  assert.equal(uninstP(h, proj).code, 0);
  assert.ok(!tree(proj).some((f) => f.startsWith('.agents/')));
  assert.deepEqual(snapshot(h.root), userBefore);
});

test('18 doctor on a clean install: no failures; the four levels only; expected checks present', () => {
  const h = fakeHome();
  inst(h);
  const r = doc(h);
  assert.equal(r.code, 0, r.text);
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.checks.every((c) => ['ok', 'info', 'warning', 'failure'].includes(c.level)));
  for (const id of ['node', 'config', 'design-system', 'canonical-files', 'adapter-files', 'manifest', 'skill', 'agents-md', 'permissions', 'config-home', 'runtime']) assert.ok(checks(r).some((c) => c.id === id), `missing check ${id}`);
  assert.deepEqual(level(r, 'canonical-files'), ['ok']);
  assert.deepEqual(level(r, 'skill'), ['ok']);
  assert.deepEqual(level(r, 'runtime'), ['info'], 'runtime behavior is reported as not checked, never as ok');
});

test('19 doctor is read-only and never opens mcp_config.json or hooks.json', () => {
  const h = fakeHome();
  inst(h);
  write(path.join(h.configHome, 'mcp_config.json'), '{"token":"SUPERSECRET-DO-NOT-PRINT"}');
  write(path.join(h.configHome, 'hooks.json'), '{"x":"SUPERSECRET-DO-NOT-PRINT"}');
  const before = snapshot(h.root);
  const r = doc(h);
  assert.deepEqual(snapshot(h.root), before);
  assert.ok(!r.text.includes('SUPERSECRET'));
  const empty = fakeHome();
  doc(empty);
  assert.deepEqual(tree(empty.root), []);
});

test('20 doctor reports problems: missing skill, modified skill, invalid ownership, malformed config, bad design-system path', () => {
  assert.deepEqual(level(doc(fakeHome()), 'skill'), ['warning']);

  const mod = fakeHome();
  inst(mod);
  fs.appendFileSync(path.join(mod.configHome, 'skills/erdem/SKILL.md'), 'x');
  assert.deepEqual(level(doc(mod), 'skill'), ['warning']);

  const bad = fakeHome();
  write(path.join(bad.configHome, 'skills/erdem/SKILL.md'), 'foreign');
  write(path.join(bad.configHome, 'skills/erdem/.erdem-owner.json'), '{ nope');
  const rb = doc(bad);
  assert.deepEqual(level(rb, 'skill'), ['failure']);
  assert.equal(rb.code, 1);

  const cfg = fakeHome();
  write(path.join(cfg.configHome, 'erdem-adapter/config.json'), '{ not json');
  const rc = doc(cfg);
  assert.ok(level(rc, 'config').includes('failure'));
  assert.equal(rc.code, 1);

  const ds = fakeHome();
  const rd = doc(ds, [], { ...ds.env, ERDEM_DESIGN_SYSTEM_ROOT: path.join(tmp(), 'missing-ds') });
  assert.ok(level(rd, 'design-system-config').includes('warning'));
});

test('21 doctor with Antigravity absent is not a failure (graceful fallback); a Codex-owned skill is info', () => {
  const h = fakeHome();
  const r = doc(h, [], { ...h.env, PATH: '' });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(level(r, 'config-home'), ['info']);

  const proj = tmp('erdem-proj-');
  write(path.join(proj, '.agents/skills/erdem/.erdem-owner.json'), JSON.stringify({ owner: 'ERDEM_DESIGN_SYSTEM_CODEX_ADAPTER', files: {} }));
  const q = capture();
  const code = doctor(['--scope', 'project', '--project', proj, '--config-home', h.configHome, '--no-cli', '--no-intel', '--json'], { io: q.io, env: h.env, home: h.root, cwd: proj });
  assert.equal(code, 0, q.text());
  assert.deepEqual(JSON.parse(q.text()).checks.filter((c) => c.id === 'skill').map((c) => c.level), ['info']);
});

test('22 doctor flags a block that is missing from the ledger; usage errors exit 2; no environment values are printed', () => {
  const h = fakeHome();
  const proj = tmp('erdem-proj-');
  instP(h, proj, ['--agents-md']);
  fs.rmSync(path.join(proj, '.agents/.erdem-antigravity-install.json'));
  const run = (env = h.env) => {
    const q = capture();
    const code = doctor(['--scope', 'project', '--project', proj, '--config-home', h.configHome, '--no-cli', '--no-intel', '--json'], { io: q.io, env, home: h.root, cwd: proj });
    return { code, text: q.text() };
  };
  assert.ok(JSON.parse(run().text).checks.some((c) => c.id === 'agents-ledger' && c.level === 'warning'));
  const q = capture();
  assert.equal(doctor(['--scope', 'machine'], { io: q.io, env: h.env, home: h.root }), 2);
  assert.ok(!run({ ...h.env, GEMINI_API_KEY: 'sk-test-SHOULD-NEVER-APPEAR' }).text.includes('sk-test-SHOULD-NEVER-APPEAR'));
});
