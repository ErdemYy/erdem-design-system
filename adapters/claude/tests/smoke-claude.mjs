#!/usr/bin/env node
/**
 * Manual smoke test against a real, installed Claude Code. NOT part of the automated suite: it makes one small
 * model call. Non-destructive: it installs the adapter into a throwaway PROJECT (never the user configuration),
 * runs `claude -p` once in that project with tools disallowed, and deletes the project afterwards.
 *
 *   node adapters/claude/tests/smoke-claude.mjs [--keep]
 *
 * Side effect to know about: Claude Code itself records a per-project entry under ~/.claude/projects/ for the
 * throwaway directory, even with session persistence disabled; the script cannot remove it (it is Claude's own data).
 *
 * Checks: Claude Code version, hook accepted and its line reaches the session, the skill is discoverable,
 * the CLAUDE.md block is loaded.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run as install } from '../scripts/install.mjs';
import { INTEL, REPO } from './helpers.mjs';

const keep = process.argv.includes('--keep');
const shell = process.platform === 'win32';
const claude = (args, opts = {}) => spawnSync('claude', args, { encoding: 'utf8', shell, timeout: 120000, windowsHide: true, ...opts });

const version = claude(['--version']);
if (version.status !== 0) {
  console.log('SKIPPED: Claude Code is not available on the command path.');
  process.exit(0);
}
console.log(`Claude Code: ${version.stdout.trim()}`);

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'erdem-smoke-'));
try {
  fs.cpSync(path.join(REPO, 'tools', 'test', 'fixtures', 'app'), proj, { recursive: true });
  spawnSync(process.execPath, [INTEL, 'index', proj, '--profile', 'standard'], { cwd: proj });
  const lines = [];
  const code = install(['--scope', 'project', '--project', proj, '--hook', '--claude-md'], { io: { out: (t) => lines.push(t), err: (t) => lines.push(t) } });
  console.log(`project-scope install: exit ${code}`);

  const prompt =
    "Do not use any tools. Answer in exactly three lines. " +
    "Line 1: copy verbatim any line of your session context that starts with 'ERDEM:' (or write NONE). " +
    "Line 2: write YES if a skill named 'erdem' is in your list of available skills, otherwise NO. " +
    "Line 3: write YES if your project instructions mention the Erdem Design System, otherwise NO.";
  // the prompt goes through stdin: passing it as an argument through a Windows shell mangles the quoting
  const r = claude(['-p', '--model', 'haiku', '--no-session-persistence', '--output-format', 'text'], { cwd: proj, input: prompt });
  console.log(`claude -p exit: ${r.status}`);
  console.log('--- response ---');
  console.log((r.stdout ?? '').trim().slice(0, 600));
  if (r.status !== 0) console.log(`stderr: ${(r.stderr ?? '').trim().slice(0, 300)}`);
  console.log('--- end ---');

  const out = r.stdout ?? '';
  const hookSeen = /ERDEM:/.test(out) && !/^NONE/m.test(out.split('\n')[0] ?? '');
  const skillSeen = /^\s*(line 2:?\s*)?YES/im.test(out.split('\n')[1] ?? '');
  const mdSeen = /^\s*(line 3:?\s*)?YES/im.test(out.split('\n')[2] ?? '');
  console.log(JSON.stringify({ hookLineReachedSession: hookSeen, skillListed: skillSeen, claudeMdLoaded: mdSeen }));
} finally {
  if (!keep) fs.rmSync(proj, { recursive: true, force: true });
  else console.log(`kept: ${proj}`);
}
