#!/usr/bin/env node
import path from 'node:path';
import { UsageError, isMain, makeIo, parseArgs } from '../lib/helpers.mjs';
import { runDoctor } from '../lib/doctor.mjs';

const HELP = `Diagnose the Erdem Antigravity adapter (read-only; prints no secrets).

Usage: node adapters/antigravity/scripts/doctor.mjs [options]

  --scope user|project   which installation to inspect (default: user)
  --project <dir>        project directory (project scope, or the project whose .ai/ to check)
  --config-home <dir>     inspect this directory instead of ~/.gemini/config
  --no-cli         do not look for the Antigravity command line tools
  --no-intel             do not run project-intel status
  --json                 machine-readable output
Levels: ok, info, warning, failure. Exit codes: 0 no failures, 1 at least one failure, 2 usage error.`;

export function run(argv, { env = process.env, home, io = makeIo(), cwd = process.cwd() } = {}) {
  try {
    const args = parseArgs(argv, { flags: ['--json', '--help', '--no-cli', '--no-intel'], values: ['--scope', '--project', '--config-home'] });
    if (args.opts.help) {
      io.out(HELP);
      return 0;
    }
    const scope = args.opts.scope ?? 'user';
    if (!['user', 'project'].includes(scope)) throw new UsageError('--scope must be user or project');
    const result = runDoctor({
      env,
      home,
      scope,
      cwd,
      projectDir: args.opts.project ? path.resolve(args.opts.project) : undefined,
      configHomeDir: args.opts['config-home'],
      checkCli: !args.opts['no-cli'],
      checkIntel: !args.opts['no-intel'],
    });
    if (args.opts.json) io.out(JSON.stringify(result, null, 2));
    else io.out(result.checks.map((c) => `${c.level.padEnd(7)} ${c.id}: ${c.message}`).join('\n') + `\n${result.ok ? 'no failures' : 'failures found'}`);
    return result.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`doctor: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (isMain(import.meta.url)) process.exitCode = run(process.argv.slice(2));
