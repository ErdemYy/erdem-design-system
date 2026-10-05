import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run as doctor } from '../scripts/doctor.mjs';
import { run as install } from '../scripts/install.mjs';
import { run as uninstall } from '../scripts/uninstall.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { cleanup, isolatedEnv, tmp, write } from './helpers.mjs';

after(cleanup);

const capture = () => {
  const lines = [];
  return { io: { out: (t) => lines.push(t), err: (t) => lines.push(t) }, text: () => lines.join('\n') };
};
const doc = (c, extra = []) => {
  const q = capture();
  const code = doctor(['--claude-dir', c, '--claude-bin', 'none', ...extra], { io: q.io, env: isolatedEnv(tmp('erdem-home-')), cwd: tmp() });
  return { code, text: q.text() };
};
const inst = (c, extra = []) => install(['--claude-dir', c, ...extra], { io: capture().io, env: isolatedEnv(tmp('erdem-home-')) });
const level = (res, id) => res.checks.filter((c) => c.id === id).map((c) => c.level);

test('doctor passes on a healthy installation and reports each component', () => {
  const c = path.join(tmp(), 'claude');
  inst(c, ['--hook']);
  const r = runDoctor({ claudeDir: c, claudeBin: false, env: isolatedEnv(tmp('erdem-home-')), cwd: tmp() });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((x) => x.level === 'fail')));
  for (const id of ['node', 'config', 'design-system', 'project-intel', 'skill', 'hook', 'permissions']) assert.ok(r.checks.some((x) => x.id === id), id);
  assert.deepEqual(level(r, 'skill'), ['ok']);
  assert.deepEqual(level(r, 'hook'), ['ok']);
  assert.deepEqual(level(r, 'project-intel'), ['ok']);
});

test('doctor before install: warnings, not failures', () => {
  const c = path.join(tmp(), 'claude');
  fs.mkdirSync(c, { recursive: true });
  const r = doc(c);
  assert.equal(r.code, 0);
  assert.match(r.text, /WARN skill: skill not installed/);
  assert.match(r.text, /info hook: no settings file/);
});

test('doctor fails on a foreign skill, a deleted hook script, invalid settings and invalid config', () => {
  const foreign = path.join(tmp(), 'claude');
  write(path.join(foreign, 'skills', 'erdem', 'SKILL.md'), 'x');
  assert.equal(doc(foreign).code, 1);

  const c = path.join(tmp(), 'claude');
  inst(c, ['--hook']);
  const settingsPath = path.join(c, 'settings.json');
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  s.hooks.SessionStart[0].hooks[0].command = s.hooks.SessionStart[0].hooks[0].command.replace('session-start.mjs', 'gone.mjs');
  fs.writeFileSync(settingsPath, JSON.stringify(s));
  assert.match(doc(c).text, /FAIL hook: SessionStart hook is registered but its script is missing/);

  write(settingsPath, '{ broken');
  assert.match(doc(c).text, /FAIL settings: .*not valid JSON/);

  const cfg = path.join(tmp(), 'claude');
  inst(cfg);
  write(path.join(cfg, 'erdem-adapter', 'config.json'), JSON.stringify({ schemaVersion: 1, autoStatus: 'bogus' }));
  const r = doc(cfg);
  assert.equal(r.code, 1);
  assert.match(r.text, /FAIL config: .*invalid value for "autoStatus"/);
});

test('doctor warns when hooks are disabled, when files were modified, and when the adapter checkout moved', () => {
  const c = path.join(tmp(), 'claude');
  inst(c, ['--hook']);
  const sp = path.join(c, 'settings.json');
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  s.disableAllHooks = true;
  fs.writeFileSync(sp, JSON.stringify(s));
  fs.appendFileSync(path.join(c, 'skills/erdem/SKILL.md'), '\nedit\n');
  const r = doc(c);
  assert.match(r.text, /WARN hooks-disabled/);
  assert.match(r.text, /WARN skill: skill files missing or modified: SKILL\.md/);
  const linkPath = path.join(c, 'skills/erdem/adapter-link.json');
  const link = JSON.parse(fs.readFileSync(linkPath, 'utf8'));
  link.adapterDir = path.join(tmp(), 'moved-away');
  fs.writeFileSync(linkPath, JSON.stringify(link));
  assert.match(doc(c).text, /FAIL skill-link/);
});

test('doctor never prints environment values, settings contents or tokens', () => {
  const c = path.join(tmp(), 'claude');
  write(path.join(c, 'settings.json'), JSON.stringify({ env: { API_TOKEN: 'SUPERSECRET123' }, apiKeyHelper: 'SUPERSECRET123' }));
  inst(c, ['--hook']);
  const q = capture();
  doctor(['--claude-dir', c, '--claude-bin', 'none', '--json'], { io: q.io, env: isolatedEnv(tmp('erdem-home-'), { ANTHROPIC_API_KEY: 'SUPERSECRET123', ERDEM_PROJECT_INTEL: 'node' }), cwd: tmp() });
  assert.ok(!q.text().includes('SUPERSECRET123'));
  const text = doc(c).text;
  assert.ok(!text.includes('SUPERSECRET123'));
});

test('doctor reports a missing or unusable Claude Code without failing the adapter', () => {
  const c = path.join(tmp(), 'claude');
  inst(c);
  const q = capture();
  const code = doctor(['--claude-dir', c, '--claude-bin', 'definitely-not-installed-claude-xyz'], { io: q.io, env: isolatedEnv(tmp('erdem-home-')), cwd: tmp() });
  assert.equal(code, 0);
  assert.match(q.text(), /WARN claude: Claude Code was not found/);
});

test('uninstall followed by doctor reports not installed', () => {
  const c = path.join(tmp(), 'claude');
  inst(c, ['--hook']);
  uninstall(['--claude-dir', c], { io: capture().io, env: isolatedEnv(tmp('erdem-home-')) });
  assert.match(doc(c).text, /WARN skill: skill not installed/);
  assert.match(doc(c).text, /SessionStart hook not installed|no settings file/);
});
