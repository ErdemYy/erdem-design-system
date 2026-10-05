#!/usr/bin/env node
import { UsageError, isMain, makeIo, parseArgs } from '../lib/helpers.mjs';
import { applyUninstall, describePlan, planUninstall } from '../lib/installer.mjs';

const HELP = `Remove what the Erdem Antigravity adapter installed, and nothing else.

Usage: node adapters/antigravity/scripts/uninstall.mjs [options]

  --scope user|project   which installation to remove (default: user)
  --project <dir>        project directory (required with --scope project)
  --config-home <dir>     use this directory instead of ~/.gemini/config
  --purge-config         also remove the adapter's user config file (kept by default)
  --dry-run              show what would be removed
  --json                 machine-readable output

Removal requires proof of ownership: the owner file in the skill folder, and the marker pair plus a ledger entry
for the AGENTS.md block. Anything ambiguous is reported and left alone.
Exit codes: 0 ok, 2 usage error.`;

export function run(argv, { env = process.env, home, io = makeIo() } = {}) {
  try {
    const args = parseArgs(argv, { flags: ['--purge-config', '--dry-run', '--json', '--help'], values: ['--scope', '--project', '--config-home'] });
    if (args.opts.help) {
      io.out(HELP);
      return 0;
    }
    const scope = args.opts.scope ?? 'user';
    if (!['user', 'project'].includes(scope)) throw new UsageError('--scope must be user or project');
    const plan = planUninstall({ scope, projectDir: args.opts.project, configHomeDir: args.opts['config-home'], purgeConfig: !!args.opts['purge-config'], env, home });
    if (args.opts['dry-run']) {
      io.out(args.opts.json ? JSON.stringify({ dryRun: true, actions: plan.actions.map((a) => ({ op: a.op, path: a.path })), warnings: plan.warnings, conflicts: plan.conflicts, notes: plan.notes }, null, 2) : `[dry run] ${describePlan(plan)}`);
      return 0;
    }
    const result = applyUninstall(plan);
    io.out(args.opts.json ? JSON.stringify({ written: result.written, removed: result.removed, warnings: plan.warnings, conflicts: plan.conflicts, notes: plan.notes }, null, 2) : `${describePlan(plan)}\n${result.removed.length + result.written.length ? `done: ${result.removed.length} removed, ${result.written.length} rewritten` : 'nothing to remove'}`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`uninstall: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (isMain(import.meta.url)) process.exitCode = run(process.argv.slice(2));
