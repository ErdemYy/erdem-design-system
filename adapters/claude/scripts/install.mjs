#!/usr/bin/env node
import path from 'node:path';
import { UsageError, isMain, makeIo, parseArgs } from '../lib/cli.mjs';
import { isDesignSystemRoot } from '../lib/discover.mjs';
import { applyPlan, describePlan, planInstall } from '../lib/installer.mjs';
import { SELF_ROOT } from '../lib/paths.mjs';

const HELP = `Install the Erdem Claude Code adapter (explicit, idempotent, never overwrites foreign configuration).

Usage: node adapters/claude/scripts/install.mjs [options]

  --scope user|project        where to install (default: user)
  --project <dir>             project directory (required with --scope project)
  --hook                      also register the SessionStart hook (merged next to existing hooks)
  --claude-md                 also add the small managed block to CLAUDE.md
  --no-skill                  do not install the /erdem skill
  --manual-only               skill is invoked only with /erdem (disable-model-invocation)
  --claude-dir <dir>          use this directory instead of the real Claude configuration (testing, portable installs)
  --design-system-root <dir>  design system to record (default: the checkout containing this adapter)
  --node-command <cmd>        command used to run the hook (default: node)
  --force                     overwrite adapter files that have local changes
  --dry-run                   show what would change, change nothing
  --json                      machine-readable output

Nothing is installed by default beyond the skill; the hook and CLAUDE.md block are opt-in.
Exit codes: 0 ok, 1 blocked by a conflict (nothing was changed), 2 usage error.`;

export function run(argv, { env = process.env, home, io = makeIo() } = {}) {
  let args;
  try {
    args = parseArgs(argv, {
      flags: ['--hook', '--claude-md', '--no-skill', '--manual-only', '--force', '--dry-run', '--json', '--help'],
      values: ['--scope', '--project', '--claude-dir', '--design-system-root', '--node-command'],
    });
    if (args.opts.help) {
      io.out(HELP);
      return 0;
    }
    const scope = args.opts.scope ?? 'user';
    if (!['user', 'project'].includes(scope)) throw new UsageError('--scope must be user or project');
    const root = args.opts['design-system-root'] ? path.resolve(args.opts['design-system-root']) : SELF_ROOT;
    if (!isDesignSystemRoot(root)) throw new UsageError(`${root} is not an Erdem Design System root (no matching system-manifest.yaml)`);
    const plan = planInstall({
      scope,
      projectDir: args.opts.project,
      claudeDir: args.opts['claude-dir'],
      designSystemRoot: root,
      hook: !!args.opts.hook,
      claudeMd: !!args.opts['claude-md'],
      skill: !args.opts['no-skill'],
      manualOnly: args.opts['manual-only'] ? true : undefined,
      force: !!args.opts.force,
      nodeCommand: args.opts['node-command'],
      env,
      home,
    });
    const blocked = plan.conflicts.some((c) => c.blocking);
    if (args.opts['dry-run'] || blocked) {
      io.out(args.opts.json ? JSON.stringify({ dryRun: !!args.opts['dry-run'], blocked, actions: plan.actions.map((a) => ({ op: a.op, path: a.path })), warnings: plan.warnings, conflicts: plan.conflicts, notes: plan.notes }, null, 2) : `${args.opts['dry-run'] ? '[dry run] ' : ''}${describePlan(plan)}`);
      return blocked ? 1 : 0;
    }
    const result = applyPlan(plan);
    const changed = result.written.length + result.removed.length;
    io.out(args.opts.json ? JSON.stringify({ changed, written: result.written, removed: result.removed, backups: result.backups, warnings: plan.warnings, notes: plan.notes }, null, 2) : `${describePlan(plan)}\n${changed ? `done: ${result.written.length} written, ${result.removed.length} removed` : 'already up to date'}${result.backups.length ? `\nbackup: ${result.backups.join(', ')}` : ''}`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`install: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (isMain(import.meta.url)) process.exitCode = run(process.argv.slice(2));
