import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { run as install } from '../scripts/install.mjs';
import { planInstall, applyPlan } from '../lib/installer.mjs';
import { OWNER, hookCommand } from '../lib/settings.mjs';
import { ADAPTER, HOOK, cleanup, isolatedEnv, readJson, tmp, tree, write } from './helpers.mjs';

after(cleanup);
const execAsync = promisify(exec);

const quiet = () => {
  const lines = [];
  return { io: { out: (t) => lines.push(t), err: (t) => lines.push(t) }, text: () => lines.join('\n') };
};
const inst = (claudeDir, extra = [], env) => {
  const q = quiet();
  const code = install(['--claude-dir', claudeDir, ...extra], { io: q.io, env });
  return { code, text: q.text() };
};
const snapshot = (dir) => Object.fromEntries(tree(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

test('1 clean install: skill files, owner file, config and ledger; hook and CLAUDE.md are opt-in', () => {
  const c = path.join(tmp(), 'claude');
  const r = inst(c);
  assert.equal(r.code, 0, r.text);
  const files = tree(c);
  for (const f of ['skills/erdem/SKILL.md', 'skills/erdem/references/design-routing.md', 'skills/erdem/references/context-routing.md', 'skills/erdem/references/claude-workflow.md', 'skills/erdem/references/troubleshooting.md', 'skills/erdem/scripts/erdem.mjs', 'skills/erdem/adapter-link.json', 'skills/erdem/.erdem-owner.json', 'erdem-adapter/config.json', 'erdem-adapter/install.json']) {
    assert.ok(files.includes(f), `missing ${f}`);
  }
  assert.ok(!files.includes('settings.json'), 'no hook without --hook');
  assert.ok(!files.includes('CLAUDE.md'), 'no CLAUDE.md block without --claude-md');
  const owner = readJson(path.join(c, 'skills/erdem/.erdem-owner.json'));
  assert.equal(owner.owner, OWNER);
  assert.ok(Object.keys(owner.files).includes('SKILL.md'));
  const link = readJson(path.join(c, 'skills/erdem/adapter-link.json'));
  assert.ok(fs.existsSync(path.join(link.adapterDir, 'hooks/session-start.mjs')));
});

test('2 repeated install is idempotent: nothing is rewritten, no duplicate hook or block', () => {
  const c = path.join(tmp(), 'claude');
  inst(c, ['--hook', '--claude-md']);
  const before = snapshot(c);
  const again = inst(c, ['--hook', '--claude-md']);
  assert.equal(again.code, 0);
  assert.match(again.text, /already up to date/);
  assert.deepEqual(snapshot(c), before);
  const settings = readJson(path.join(c, 'settings.json'));
  assert.equal(settings.hooks.SessionStart.length, 1);
  const md = fs.readFileSync(path.join(c, 'CLAUDE.md'), 'utf8');
  assert.equal(md.split(`BEGIN ${OWNER}`).length - 1, 1);
  assert.ok(!tree(c).some((f) => f.includes('erdem-backup')), 'no backup when nothing changed');
});

test('3 existing settings and hooks are preserved; the hook is added once next to them', () => {
  const c = path.join(tmp(), 'claude');
  const original = {
    model: 'some-model',
    env: { SOME_TOKEN: 'SECRET-VALUE-123' },
    permissions: { allow: ['Bash(ls *)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Task', hooks: [{ type: 'command', command: 'node other.js' }] }],
      SessionStart: [
        { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hello', timeout: 30 }] },
        { hooks: [{ type: 'command', command: 'node "/x/y/plugin-hook.mjs"' }] },
      ],
    },
  };
  write(path.join(c, 'settings.json'), JSON.stringify(original, null, 2));
  const r = inst(c, ['--hook']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /2 existing SessionStart hook\(s\) preserved/);
  assert.ok(!r.text.includes('SECRET-VALUE-123'), 'settings contents are never printed');
  const after_ = readJson(path.join(c, 'settings.json'));
  assert.deepEqual({ ...after_, hooks: { ...after_.hooks, SessionStart: after_.hooks.SessionStart.slice(0, 2) } }, original, 'everything that was there is unchanged');
  assert.equal(after_.hooks.SessionStart.length, 3);
  assert.ok(after_.hooks.SessionStart[2].hooks[0].command.includes(`--erdem-owner=${OWNER}`));
  assert.equal(after_.hooks.SessionStart[2].hooks[0].timeout, 5);
  const backups = tree(c).filter((f) => f.startsWith('settings.json.erdem-backup-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c, backups[0]), 'utf8')), original, 'the backup is the original');
  inst(c, ['--hook']);
  assert.equal(readJson(path.join(c, 'settings.json')).hooks.SessionStart.length, 3, 'added once');
});

test('4 existing CLAUDE.md and adapter config are preserved', () => {
  const c = path.join(tmp(), 'claude');
  write(path.join(c, 'CLAUDE.md'), '# My rules\n\nBe concise.\n');
  write(path.join(c, 'erdem-adapter', 'config.json'), JSON.stringify({ schemaVersion: 1, autoStatus: 'verify', preferredProfile: 'full' }));
  const r = inst(c, ['--claude-md']);
  assert.equal(r.code, 0, r.text);
  const md = fs.readFileSync(path.join(c, 'CLAUDE.md'), 'utf8');
  assert.ok(md.startsWith('# My rules\n\nBe concise.\n'));
  assert.ok(md.includes(`<!-- BEGIN ${OWNER} -->`) && md.includes(`<!-- END ${OWNER} -->`));
  assert.deepEqual(readJson(path.join(c, 'erdem-adapter', 'config.json')), { schemaVersion: 1, autoStatus: 'verify', preferredProfile: 'full' }, 'user config is never modified');
});

test('5 a foreign skill folder named erdem is never overwritten; nothing else changes either', () => {
  const c = path.join(tmp(), 'claude');
  write(path.join(c, 'skills', 'erdem', 'SKILL.md'), '---\nname: erdem\n---\nsomeone else\n');
  write(path.join(c, 'settings.json'), '{}\n');
  const before = snapshot(c);
  const r = inst(c, ['--hook']);
  assert.equal(r.code, 1);
  assert.match(r.text, /not owned by this adapter/);
  assert.deepEqual(snapshot(c), before, 'blocked means no change at all');
});

test('6 local changes to an installed file are kept unless --force', () => {
  const c = path.join(tmp(), 'claude');
  inst(c);
  const skill = path.join(c, 'skills/erdem/SKILL.md');
  fs.appendFileSync(skill, '\nMy own note.\n');
  const r = inst(c);
  assert.match(r.text, /local changes and was left as is/);
  assert.ok(fs.readFileSync(skill, 'utf8').includes('My own note.'));
  const forced = inst(c, ['--force']);
  assert.equal(forced.code, 0);
  assert.ok(!fs.readFileSync(skill, 'utf8').includes('My own note.'));
});

test('7 invalid or unsafe settings stop the install and are left untouched', () => {
  for (const content of ['{ not json', '[]', JSON.stringify({ hooks: [] }), JSON.stringify({ hooks: { SessionStart: 'nope' } })]) {
    const c = path.join(tmp(), 'claude');
    write(path.join(c, 'settings.json'), content);
    const r = inst(c, ['--hook']);
    assert.equal(r.code, 1, content);
    assert.match(r.text, /Manual hook integration/);
    assert.equal(fs.readFileSync(path.join(c, 'settings.json'), 'utf8'), content, 'byte-identical');
    assert.ok(!tree(c).some((f) => f.startsWith('skills/')), 'nothing was installed');
  }
});

test('8 dry run changes nothing and says what it would do', () => {
  const c = path.join(tmp(), 'claude');
  write(path.join(c, 'settings.json'), '{"theme":"dark"}\n');
  const before = snapshot(c);
  const r = inst(c, ['--hook', '--claude-md', '--dry-run']);
  assert.equal(r.code, 0);
  assert.match(r.text, /^\[dry run\]/);
  assert.match(r.text, /create .*SKILL\.md/);
  assert.match(r.text, /(add|update) .*settings\.json/);
  assert.deepEqual(snapshot(c), before);
});

test('9 project scope: skill and CLAUDE.md in the project, hook in the untracked local settings', () => {
  const proj = tmp();
  write(path.join(proj, 'CLAUDE.md'), '# Project\n');
  const q = quiet();
  const code = install(['--scope', 'project', '--project', proj, '--hook', '--claude-md'], { io: q.io });
  assert.equal(code, 0, q.text());
  const files = tree(proj);
  assert.ok(files.includes('.claude/skills/erdem/SKILL.md'));
  assert.ok(files.includes('.claude/settings.local.json'));
  assert.ok(files.includes('.claude/erdem-adapter-install.json'));
  assert.ok(!files.includes('.claude/settings.json'), 'the shared settings file is never touched');
  assert.match(q.text(), /out of version control/);
  assert.ok(fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8').startsWith('# Project\n'));
});

test('10 --manual-only renders an explicit-invocation skill; the default stays model-invocable', () => {
  const a = path.join(tmp(), 'claude');
  const b = path.join(tmp(), 'claude');
  inst(a);
  inst(b, ['--manual-only']);
  assert.ok(!fs.readFileSync(path.join(a, 'skills/erdem/SKILL.md'), 'utf8').includes('disable-model-invocation'));
  assert.match(fs.readFileSync(path.join(b, 'skills/erdem/SKILL.md'), 'utf8'), /^disable-model-invocation: true$/m);
  assert.equal(readJson(path.join(b, 'erdem-adapter/config.json')).autoSkill, false);
  const again = inst(b);
  assert.match(again.text, /already up to date/, 'the choice is remembered through the config');
});

test('11 hook commands use forward slashes and quoting that works in a real shell, including paths with spaces', async () => {
  const base = path.join(tmp(), 'dir with spaces');
  const adapter = path.join(base, 'adapters', 'claude');
  fs.cpSync(ADAPTER, adapter, { recursive: true, filter: (s) => !s.includes(`${path.sep}tests`) });
  write(path.join(base, 'system-manifest.yaml'), 'name: erdem-design-system\n');
  const cmd = hookCommand(path.join(adapter, 'hooks', 'session-start.mjs'));
  assert.ok(!cmd.includes('\\'), 'forward slashes only');
  assert.match(cmd, /^node "[^"]+session-start\.mjs" --erdem-owner=/);
  const home = tmp();
  const proj = tmp();
  const env = isolatedEnv(home);
  const { stdout } = await execAsync(cmd, { env, cwd: proj, timeout: 15000 });
  assert.match(stdout.trim(), /^ERDEM: system=found intelligence=missing/);

  // and through the planner with an adapter directory that contains spaces
  const c = path.join(tmp(), 'claude');
  const plan = planInstall({ scope: 'user', claudeDir: c, hook: true, adapterDir: adapter, designSystemRoot: base });
  const res = applyPlan(plan);
  assert.ok(res.written.length > 0);
  const stored = readJson(path.join(c, 'settings.json')).hooks.SessionStart[0].hooks[0].command;
  assert.ok(stored.includes('dir with spaces/adapters/claude/hooks/session-start.mjs'));
});

test('12 the hook, CLAUDE.md block and skill never contain machine-specific paths in the repository sources', () => {
  for (const f of ['CLAUDE.md', 'skill/SKILL.md', 'skill/references/design-routing.md', 'skill/references/context-routing.md', 'skill/references/claude-workflow.md', 'skill/references/troubleshooting.md', 'skill/scripts/erdem.mjs', 'package/adapter-manifest.json']) {
    const text = fs.readFileSync(path.join(ADAPTER, f), 'utf8');
    assert.ok(!/[A-Za-z]:[\\/]Users[\\/]|\/home\/[a-z]|\/Users\/[A-Za-z]/.test(text), `${f} contains a user-specific path`);
  }
  assert.ok(fs.existsSync(HOOK));
});
