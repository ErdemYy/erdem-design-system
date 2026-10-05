import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run as install } from '../scripts/install.mjs';
import { run as uninstall } from '../scripts/uninstall.mjs';
import { OWNER } from '../lib/settings.mjs';
import { cleanup, readJson, tmp, tree, write } from './helpers.mjs';

after(cleanup);

const quiet = () => {
  const lines = [];
  return { io: { out: (t) => lines.push(t), err: (t) => lines.push(t) }, text: () => lines.join('\n') };
};
const inst = (c, extra = []) => {
  const q = quiet();
  return { code: install(['--claude-dir', c, ...extra], { io: q.io }), text: q.text() };
};
const uninst = (c, extra = []) => {
  const q = quiet();
  return { code: uninstall(['--claude-dir', c, ...extra], { io: q.io }), text: q.text() };
};
const snapshot = (dir) => Object.fromEntries(tree(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

test('uninstall removes only what the adapter installed and restores the originals', () => {
  const c = path.join(tmp(), 'claude');
  const settings = { model: 'm', hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo foreign' }] }], PreToolUse: [{ matcher: 'Task', hooks: [{ type: 'command', command: 'x' }] }] } };
  write(path.join(c, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  write(path.join(c, 'CLAUDE.md'), '# Mine\n\nKeep me.\n');
  write(path.join(c, 'skills', 'other-skill', 'SKILL.md'), 'unrelated skill\n');
  write(path.join(c, 'notes.txt'), 'unrelated file\n');
  const before = snapshot(c);
  inst(c, ['--hook', '--claude-md']);
  assert.notDeepEqual(snapshot(c), before);
  const r = uninst(c);
  assert.equal(r.code, 0, r.text);
  const after_ = snapshot(c);
  assert.deepEqual(readJson(path.join(c, 'settings.json')), settings, 'foreign hooks and keys intact');
  assert.equal(after_['CLAUDE.md'].trim(), before['CLAUDE.md'].trim(), 'only the managed block is removed');
  assert.equal(after_['skills/other-skill/SKILL.md'], before['skills/other-skill/SKILL.md']);
  assert.equal(after_['notes.txt'], before['notes.txt']);
  assert.ok(!Object.keys(after_).some((f) => f.startsWith('skills/erdem')), 'skill removed');
  assert.ok(!after_['erdem-adapter/install.json'], 'ledger removed');
  assert.ok(after_['erdem-adapter/config.json'], 'user config kept by default');
  assert.match(r.text, /user configuration and was kept/);
  const purge = uninst(c, ['--purge-config']);
  assert.equal(purge.code, 0);
  assert.ok(!tree(c).includes('erdem-adapter/config.json'));
});

test('files the installer itself created are removed again; a pre-existing file is not', () => {
  const c = path.join(tmp(), 'claude');
  inst(c, ['--hook', '--claude-md']);
  assert.ok(tree(c).includes('settings.json') && tree(c).includes('CLAUDE.md'));
  uninst(c);
  const left = tree(c).filter((f) => !f.startsWith('erdem-adapter/'));
  assert.deepEqual(left.filter((f) => !f.includes('erdem-backup')), [], `left behind: ${left}`);
});

test('modified skill files and extra user files are kept; the folder stays', () => {
  const c = path.join(tmp(), 'claude');
  inst(c);
  fs.appendFileSync(path.join(c, 'skills/erdem/SKILL.md'), '\nmy edit\n');
  write(path.join(c, 'skills/erdem/mine.md'), 'user file\n');
  const r = uninst(c);
  assert.match(r.text, /has local changes; kept/);
  assert.ok(fs.existsSync(path.join(c, 'skills/erdem/SKILL.md')));
  assert.ok(fs.existsSync(path.join(c, 'skills/erdem/mine.md')));
  assert.ok(!fs.existsSync(path.join(c, 'skills/erdem/references/design-routing.md')), 'unmodified owned files are removed');
  assert.ok(fs.existsSync(path.join(c, 'erdem-adapter/install.json')), 'the ledger is kept while something remains');
});

test('ambiguous ownership is refused: a marker without a ledger entry is never removed', () => {
  const c = path.join(tmp(), 'claude');
  inst(c, ['--hook', '--claude-md']);
  fs.rmSync(path.join(c, 'erdem-adapter', 'install.json'));
  const before = snapshot(c);
  const r = uninst(c);
  assert.equal(r.code, 0);
  assert.match(r.text, /ledger does not record; refusing to remove it/);
  assert.match(r.text, /block that the ledger does not record; left alone/);
  const after_ = snapshot(c);
  assert.equal(after_['settings.json'], before['settings.json']);
  assert.equal(after_['CLAUDE.md'], before['CLAUDE.md']);
  assert.ok(!Object.keys(after_).some((f) => f.startsWith('skills/erdem')), 'the skill is provably ours through its owner file');
});

test('a hook that merely resembles ours but lacks the marker is untouched', () => {
  const c = path.join(tmp(), 'claude');
  inst(c, ['--hook']);
  const settings = readJson(path.join(c, 'settings.json'));
  settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'node "/else/session-start.mjs"' }] });
  write(path.join(c, 'settings.json'), JSON.stringify(settings, null, 2));
  uninst(c);
  const after_ = readJson(path.join(c, 'settings.json'));
  assert.equal(after_.hooks.SessionStart.length, 1);
  assert.equal(after_.hooks.SessionStart[0].hooks[0].command, 'node "/else/session-start.mjs"');
});

test('a foreign skill folder, a foreign ledger and malformed markers are left alone', () => {
  const c = path.join(tmp(), 'claude');
  write(path.join(c, 'skills', 'erdem', 'SKILL.md'), 'not ours\n');
  write(path.join(c, 'erdem-adapter', 'install.json'), JSON.stringify({ owner: 'SOMEONE_ELSE' }));
  write(path.join(c, 'CLAUDE.md'), `x\n<!-- BEGIN ${OWNER} -->\nhalf a block\n`);
  const before = snapshot(c);
  const r = uninst(c);
  assert.equal(r.code, 0);
  assert.deepEqual(snapshot(c), before);
  assert.match(r.text, /not owned by this adapter; left alone/);
});

test('uninstall dry run changes nothing; uninstall without an installation is a no-op', () => {
  const c = path.join(tmp(), 'claude');
  inst(c, ['--hook']);
  const before = snapshot(c);
  const dry = uninst(c, ['--dry-run']);
  assert.match(dry.text, /^\[dry run\]/);
  assert.deepEqual(snapshot(c), before);
  const empty = path.join(tmp(), 'claude');
  fs.mkdirSync(empty, { recursive: true });
  const r = uninst(empty);
  assert.equal(r.code, 0);
  assert.match(r.text, /nothing to remove/);
});

test('install, uninstall, install again works and ends in the same state', () => {
  const c = path.join(tmp(), 'claude');
  inst(c, ['--hook', '--claude-md']);
  const first = snapshot(c);
  uninst(c);
  inst(c, ['--hook', '--claude-md']);
  const second = snapshot(c);
  // the ledger legitimately differs: the user config survived the uninstall, so it is no longer "created by the installer"
  for (const f of Object.keys(first).filter((x) => x !== 'erdem-adapter/install.json')) assert.equal(second[f], first[f], f);
  assert.equal(JSON.parse(second['erdem-adapter/install.json']).hooks.length, 1);
});

test('uninstall scoped to a project leaves the user installation alone', () => {
  const user = path.join(tmp(), 'claude');
  const proj = tmp();
  inst(user);
  const q = quiet();
  install(['--scope', 'project', '--project', proj, '--hook'], { io: q.io });
  const userBefore = snapshot(user);
  const u = quiet();
  assert.equal(uninstall(['--scope', 'project', '--project', proj], { io: u.io }), 0, u.text());
  assert.deepEqual(snapshot(user), userBefore);
  assert.ok(!tree(proj).some((f) => f.startsWith('.claude/skills/erdem')));
});
