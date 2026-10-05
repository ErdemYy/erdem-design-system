#!/usr/bin/env node
import path from 'node:path';
import { UsageError, isMain, makeIo, parseArgs } from '../lib/cli.mjs';
import { runDoctor } from '../lib/doctor.mjs';

const HELP = `Diagnose the Erdem Claude Code adapter (read-only; prints no secrets).

Usage: node adapters/claude/scripts/doctor.mjs [options]

  --scope user|project   which installation to inspect (default: user)
  --project <dir>        project directory (project scope, or to look for .ai/)
  --claude-dir <dir>     inspect this directory instead of the real Claude configuration
  --claude-bin <cmd>     Claude Code command (default: claude); "none" skips the check
  --json                 machine-readable output
Exit codes: 0 no failures (warnings allowed), 1 at least one failure, 2 usage error.`;

export function run(argv, { env = process.env, home, io = makeIo(), cwd = process.cwd() } = {}) {
  try {
    const args = parseArgs(argv, { flags: ['--json', '--help'], values: ['--scope', '--project', '--claude-dir', '--claude-bin'] });
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
      claudeDir: args.opts['claude-dir'],
      claudeBin: args.opts['claude-bin'] === 'none' ? false : args.opts['claude-bin'] ?? 'claude',
    });
    if (args.opts.json) io.out(JSON.stringify(result, null, 2));
    else {
      const mark = { ok: 'ok  ', info: 'info', warn: 'WARN', fail: 'FAIL' };
      io.out(result.checks.map((c) => `${mark[c.level]} ${c.id}: ${c.message}`).join('\n') + `\n${result.ok ? 'no failures' : 'failures found'}`);
    }
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
