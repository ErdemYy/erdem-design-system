#!/usr/bin/env node
import path from 'node:path';
import { UsageError, isMain, makeIo, parseArgs } from '../lib/helpers.mjs';
import { isDesignSystemRoot } from '../lib/discover.mjs';
import { applyPlan, describePlan, planInstall } from '../lib/installer.mjs';
import { SELF_ROOT } from '../lib/paths.mjs';

const HELP = `Install the Erdem Codex adapter (explicit, idempotent, never overwrites foreign files).

Usage: node adapters/codex/scripts/install.mjs [options]

  --scope user|project        where to install (default: user)
  --project <dir>             project directory (required with --scope project)
  --agents-md                 also add the small managed block to AGENTS.md (AGENTS.override.md if that exists)
  --no-skill                  do not install the $erdem skill
  --codex-home <dir>          use this directory instead of CODEX_HOME / ~/.codex (testing, portable installs)
  --agents-home <dir>         use this directory instead of ~/.agents (testing, portable installs)
  --design-system-root <dir>  design system to record (default: the checkout containing this adapter)
  --force                     overwrite adapter files that have local changes
  --dry-run                   show what would change, change nothing
  --json                      machine-readable output

By default only the skill is installed. config.toml and hooks are never touched.
Exit codes: 0 ok, 1 blocked by a conflict (nothing was changed), 2 usage error.`;

export function run(argv, { env = process.env, home, io = makeIo() } = {}) {
  try {
    const args = parseArgs(argv, {
      flags: ['--agents-md', '--no-skill', '--force', '--dry-run', '--json', '--help'],
      values: ['--scope', '--project', '--codex-home', '--agents-home', '--design-system-root'],
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
      codexHome: args.opts['codex-home'],
      agentsHome: args.opts['agents-home'],
      designSystemRoot: root,
      agentsMd: !!args.opts['agents-md'],
      skill: !args.opts['no-skill'],
      force: !!args.opts.force,
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
    io.out(args.opts.json ? JSON.stringify({ changed, written: result.written, removed: result.removed, warnings: plan.warnings, notes: plan.notes }, null, 2) : `${describePlan(plan)}\n${changed ? `done: ${result.written.length} written, ${result.removed.length} removed` : 'already up to date'}`);
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
