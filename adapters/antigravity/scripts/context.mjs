#!/usr/bin/env node
/**
 * Runtime helper behind `$erdem` (run through the skill's launcher, scripts/erdem.mjs):
 *   context        compact diagnostic: design system, intelligence state, graph, task state, handoff
 *   root           print the resolved design-system root
 *   intel ...      pass arguments to project-intel from the project root (status, index, graph, impact)
 *   handoff-check  drift between .ai/HANDOFF.md and the working tree
 * Nothing here re-implements the engine: freshness comes from `project-intel status`, impact from `project-intel impact`.
 * Output contains only fixed words, numbers, ISO dates and sanitized names; no file contents, no secrets.
 */
import path from 'node:path';
import { loadAdapterConfig } from '../lib/config.mjs';
import { findProjectRoot, readLedger, resolveDesignSystemRoot, resolveIntelCommand } from '../lib/discover.mjs';
import { isMain, makeIo, parseFrontMatter, readHead, runSafe, safeToken } from '../lib/helpers.mjs';
import { checkIntelligence } from '../lib/intelligence.mjs';
import { userTargets } from '../lib/paths.mjs';
import { checkHandoffDrift, readHandoff, readTaskState } from '../lib/state.mjs';

export function gather({ cwd = process.cwd(), env = process.env, home } = {}) {
  const targets = userTargets({ home });
  const projectRoot = findProjectRoot(cwd);
  const projectLedgerPath = path.join(projectRoot, '.agents', '.erdem-antigravity-install.json');
  const loaded = loadAdapterConfig({ env, userConfigPath: targets.configPath, projectConfigPath: path.join(projectRoot, '.agents', 'erdem-adapter.json') });
  const ledger = readLedger(targets.ledgerPath) ?? readLedger(projectLedgerPath);
  const found = resolveDesignSystemRoot({ env, config: loaded.config, sources: loaded.sources, ledger });
  const cmd = resolveIntelCommand({ root: found.root, config: loaded.config });
  return { targets, projectRoot, loaded, found, cmd };
}

export async function main(argv, { cwd = process.cwd(), env = process.env, home, io = makeIo() } = {}) {
  const [command = 'context', ...rest] = argv;
  const g = gather({ cwd, env, home });

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
    const r = runSafe([...g.cmd.argv, ...rest], { cwd: g.projectRoot, inherit: true, timeoutMs: 10 * 60 * 1000, env });
    if (r.refused) {
      io.err(`erdem: could not start project-intel (${r.refused === 'windows-shim' ? 'a Windows .cmd shim cannot be run without a shell; configure projectIntelCommand as ["node", "<path>/project-intel.mjs"]' : r.refused})`);
      return 1;
    }
    return r.status ?? 1;
  }

  if (command === 'handoff-check') {
    const d = await checkHandoffDrift(g.projectRoot, g.found.root);
    if (!d.handoff) {
      io.out('handoff: absent (nothing to verify; continue from task state and source)');
      return 0;
    }
    const changed = d.items.filter((i) => ['changed', 'missing'].includes(i.status));
    io.out([`handoff drift: ${changed.length ? `${changed.length} of ${d.items.length} listed files changed or missing` : `no drift detected in ${d.items.length} listed files`}`, ...d.items.map((i) => `  ${i.status.padEnd(18)} ${i.path}`), 'present-unverified means the file exists but no fingerprint could be compared: verify it in source'].join('\n'));
    return changed.length ? 1 : 0;
  }

  if (command !== 'context') {
    io.err(`erdem: unknown command "${command}" (context, root, intel, handoff-check)`);
    return 2;
  }

  const intel = g.cmd ? checkIntelligence(g.projectRoot, g.cmd.argv, { timeoutMs: 60000, env }) : { state: 'unavailable', reason: 'project-intel is not available' };
  const head = parseFrontMatter(readHead(path.join(g.projectRoot, '.ai', 'AI_INDEX.md'), 2048) ?? '');
  const profile = safeToken(head.indexProfile, /^(none|lite|standard|full)$/, 10);
  const task = readTaskState(g.projectRoot);
  const handoff = readHandoff(g.projectRoot);
  const lines = ['ERDEM CONTEXT (antigravity adapter)'];
  lines.push(`design system: ${g.found.root ? `found via ${g.found.source}` : 'not found (work without it; see references/context.md)'}`);
  lines.push(`project root: ${g.projectRoot}`);
  lines.push(`tooling: ${g.cmd ? `project-intel via ${g.cmd.source}` : 'project-intel unavailable (fall back to direct inspection)'}`);
  lines.push(`intelligence: ${intel.state}${intel.reason ? ` (${intel.reason})` : ''}`);
  if (intel.counts) {
    lines.push(`index: profile ${profile ?? 'unknown'}; graph: ${intel.graph}`);
    lines.push(`artifacts: ${intel.counts.CURRENT} current, ${intel.counts.STALE} stale, ${intel.counts.UNVERIFIABLE} unverifiable, ${intel.counts.MISSING} missing`);
    if (intel.state === 'stale') lines.push(`changed since index: ${intel.changed} changed, ${intel.added} added, ${intel.removed} removed`);
  }
  lines.push(`task state: ${task.present ? `${task.status ?? 'present'}${task.updatedAt ? `, updated ${task.updatedAt}` : ''}${task.owner ? `, owner ${task.owner}` : ''}` : 'absent'}`);
  lines.push(`handoff: ${handoff.present ? `present${handoff.generatedAt ? `, ${handoff.generatedAt}` : ''}${handoff.from ? `, from ${handoff.from}` : ''}${handoff.to ? `, to ${handoff.to}` : ''}` : 'absent'}`);
  lines.push(`config: preferredProfile=${g.loaded.config.preferredProfile}${g.loaded.errors.length ? ' (CONFIG INVALID: run doctor)' : ''}`);
  io.out(lines.join('\n'));
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
