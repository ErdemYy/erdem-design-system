#!/usr/bin/env node
/**
 * Runtime helper behind `/erdem` (called through the skill's launcher, scripts/erdem.mjs):
 *   context   compact diagnostic: design system, intelligence, graph, task state, handoff, profile
 *   root      print the resolved design-system root
 *   intel ... pass arguments to project-intel, run from the project root (status, index, graph, impact)
 * It reads only a few file heads and runs the engine's own commands; it prints no secrets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadAdapterConfig } from '../lib/config.mjs';
import { isMain, makeIo } from '../lib/cli.mjs';
import { findProjectRoot, readLedger, resolveDesignSystemRoot, resolveIntelCommand } from '../lib/discover.mjs';
import { lightStatus, verifiedStatus } from '../lib/intel.mjs';
import { userTargets } from '../lib/paths.mjs';

export function gather({ cwd = process.cwd(), env = process.env } = {}) {
  const targets = userTargets({ env });
  const projectRoot = findProjectRoot(cwd);
  const loaded = loadAdapterConfig({ env, userConfigPath: targets.configPath, projectConfigPath: path.join(projectRoot, '.claude', 'erdem-adapter.json') });
  const ledger = readLedger(targets.ledgerPath);
  const found = resolveDesignSystemRoot({ env, config: loaded.config, sources: loaded.sources, ledger });
  const cmd = resolveIntelCommand({ root: found.root, config: loaded.config });
  return { targets, projectRoot, loaded, found, cmd };
}

export function main(argv, { cwd = process.cwd(), env = process.env, io = makeIo() } = {}) {
  const [command = 'context', ...rest] = argv;
  const g = gather({ cwd, env });

  if (command === 'root') {
    if (!g.found.root) {
      io.err('erdem: design system not found (set ERDEM_DESIGN_SYSTEM_ROOT, or configure designSystemRoot)');
      return 1;
    }
    io.out(g.found.root);
    return 0;
  }

  if (command === 'intel') {
    if (!g.cmd) {
      io.err('erdem: project-intel is not available (no design system found and no projectIntelCommand configured)');
      return 1;
    }
    const r = spawnSync(g.cmd.argv[0], [...g.cmd.argv.slice(1), ...rest], { cwd: g.projectRoot, stdio: 'inherit', windowsHide: true });
    return r.status ?? 1;
  }

  if (command !== 'context') {
    io.err(`erdem: unknown command "${command}" (context, root, intel)`);
    return 2;
  }

  const light = lightStatus(g.projectRoot, { deadline: Date.now() + 5000 });
  const verified = g.cmd && light.intelligence !== 'missing' ? verifiedStatus(g.projectRoot, g.cmd.argv, { timeoutMs: 30000 }) : null;
  const lines = ['ERDEM CONTEXT'];
  lines.push(`design system: ${g.found.root ? `found via ${g.found.source}` : 'not found (work without it; see /erdem troubleshooting)'}`);
  lines.push(`project root: ${g.projectRoot}`);
  lines.push(`tooling: ${g.cmd ? `project-intel via ${g.cmd.source}` : 'project-intel unavailable (fall back to direct inspection)'}`);
  if (light.intelligence === 'missing') lines.push('intelligence: missing (no .ai/AI_INDEX.md); inspect the repository directly or run: erdem intel index');
  else {
    const state = verified && verified.state !== 'unavailable' ? `${verified.state}${verified.state === 'unverifiable' ? ' (caution: provisional)' : ''} (verified by project-intel status)` : verified ? `unavailable (${verified.reason}; light hint: index ${light.intelligence})` : `${light.intelligence} (hint only, not verified)`;
    lines.push(`intelligence: ${state}`);
    lines.push(`index: profile ${light.profile ?? 'unknown'}${light.age ? `, generated ${light.age} ago` : ''}`);
    const graph = verified?.graph ? verified.graph.toLowerCase() : light.graph;
    lines.push(`graph: ${graph}`);
    if (verified?.counts) lines.push(`artifacts: ${verified.counts.CURRENT} current, ${verified.counts.STALE} stale, ${verified.counts.UNVERIFIABLE} unverifiable, ${verified.counts.MISSING} missing`);
    if (verified && verified.state === 'stale') lines.push(`changed since index: ${verified.changed} changed, ${verified.added} added, ${verified.removed} removed`);
  }
  lines.push(`task state: ${light.task.present ? `${light.task.status ?? 'present'}${light.task.updatedAt ? `, updated ${light.task.updatedAt}` : ''}` : 'absent'}`);
  lines.push(`handoff: ${light.handoff.present ? `present${light.handoff.generatedAt ? `, ${light.handoff.generatedAt}` : ''}${light.handoff.from ? `, from ${light.handoff.from}` : ''}` : 'absent'}`);
  const c = g.loaded.config;
  lines.push(`config: autoStatus=${c.autoStatus} autoSkill=${c.autoSkill} preferredProfile=${c.preferredProfile}${g.loaded.errors.length ? ' (CONFIG INVALID: run doctor)' : ''}`);
  if (!fs.existsSync(path.join(g.projectRoot, '.git'))) lines.push('note: not a git repository; drift checks use fingerprints only');
  io.out(lines.join('\n'));
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
