#!/usr/bin/env node
/**
 * Manual runtime smoke test against a real Codex CLI. Not part of the automated suite: it needs a working,
 * authenticated Codex and makes one model request.
 *
 *   node adapters/codex/tests/smoke-codex.mjs [--codex <path-to-codex.exe>] [--use-user-config]
 *
 * It installs the adapter at PROJECT scope into a throwaway project (never into ~/.codex or ~/.agents), runs
 * `codex exec` read-only and ephemeral inside it, and reports what the model could observe. By default it passes
 * --ignore-user-config so the user's config.toml is not loaded (and not read by this script).
 * The result is evidence for one machine and one Codex version, not a compatibility guarantee.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as install } from '../scripts/install.mjs';
import { resolveExecutable, runSafe } from '../lib/helpers.mjs';

const args = process.argv.slice(2);
const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);

function findCodex() {
  const given = val('--codex');
  if (given) return given;
  const onPath = resolveExecutable('codex');
  if (onPath && !onPath.shim) return onPath.path;
  const base = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  if (base && fs.existsSync(base)) for (const d of fs.readdirSync(base)) if (fs.existsSync(path.join(base, d, 'codex.exe'))) return path.join(base, d, 'codex.exe');
  return null;
}

const codex = findCodex();
if (!codex) {
  console.log('smoke: no usable codex executable found (pass --codex <path>); nothing verified');
  process.exit(0);
}
const version = /(\d+\.\d+\.\d+[\w.+-]*)/.exec(runSafe([codex, '--version'], { timeoutMs: 15000 }).stdout)?.[1] ?? 'unknown';

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'erdem codex smoke '));
fs.writeFileSync(path.join(proj, 'AGENTS.md'), '# Smoke project\n');
fs.writeFileSync(path.join(proj, 'index.js'), 'console.log(1);\n');
const out = [];
const code = install(['--scope', 'project', '--project', proj, '--agents-md'], { io: { out: (t) => out.push(t), err: (t) => out.push(t) } });
if (code !== 0) {
  console.log(`smoke: install failed:\n${out.join('\n')}`);
  process.exit(1);
}

const prompt = [
  'Answer in at most 6 short lines, no tools other than reading and running the one command below.',
  '1. Do you have a skill named "erdem" available? Answer yes or no.',
  '2. Does your project instruction text (AGENTS.md) contain a block mentioning "$erdem"? Answer yes or no.',
  '3. Run `node .agents/skills/erdem/scripts/erdem.mjs context` in the project directory and quote the line that starts with "intelligence:", or say it could not run and why.',
].join('\n');
const flags = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', proj];
if (!args.includes('--use-user-config')) flags.push('--ignore-user-config');
flags.push('-');
const r = runSafe([codex, ...flags], { cwd: proj, input: prompt, timeoutMs: 5 * 60 * 1000 });
console.log(`codex ${version}; exit ${r.status}${r.timedOut ? ' (timed out)' : ''}`);
console.log('--- model answer / output (stdout) ---');
console.log(r.stdout.trim().slice(-2500));
if (r.status !== 0) console.log(`--- stderr (tail) ---\n${r.stderr.trim().slice(-1200)}`);
fs.rmSync(proj, { recursive: true, force: true });
