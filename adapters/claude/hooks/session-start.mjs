#!/usr/bin/env node
/**
 * SessionStart hook: adds ONE short status line to Claude's context. Design constraints:
 *  - fast: no content reads, no parsing, no hashing (default mode); `git status` is time-boxed;
 *  - never rebuilds an index and never prints index, task state, graph or tokens;
 *  - never blocks: every path exits 0, errors degrade to a fixed short line or to silence;
 *  - never assumes project-intel exists;
 *  - prints only fixed vocabulary, enumerated values and numbers (no free text from the repository).
 * Ownership marker (see package/adapter-manifest.json): ERDEM_DESIGN_SYSTEM_CLAUDE_ADAPTER
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAdapterConfig } from '../lib/config.mjs';
import { findProjectRoot, readLedger, resolveDesignSystemRoot, resolveIntelCommand } from '../lib/discover.mjs';
import { hookLine } from '../lib/format.mjs';
import { lightStatus, verifiedStatus } from '../lib/intel.mjs';
import { userTargets } from '../lib/paths.mjs';

const BUDGET_MS = 3000;

function readStdin(timeoutMs = 300) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = () => resolve(data);
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', done);
    process.stdin.resume();
  });
}

export async function buildLine({ env = process.env, cwd, now = Date.now() } = {}) {
  const deadline = now + BUDGET_MS;
  const targets = userTargets({ env });
  const projectRoot = findProjectRoot(cwd ?? process.cwd());
  const loaded = loadAdapterConfig({ env, userConfigPath: targets.configPath, projectConfigPath: path.join(projectRoot, '.claude', 'erdem-adapter.json') });
  if (loaded.errors.length) return 'ERDEM: adapter configuration invalid (ignored); run the adapter doctor';
  const { config } = loaded;
  if (config.autoStatus === 'off') return null;
  const ledger = readLedger(targets.ledgerPath);
  const found = resolveDesignSystemRoot({ env, config, sources: loaded.sources, ledger });
  const intelligence = lightStatus(projectRoot, { deadline, now });
  if (config.autoStatus === 'verify' && intelligence.intelligence !== 'missing') {
    const cmd = resolveIntelCommand({ root: found.root, config });
    const left = deadline - Date.now();
    if (cmd && left > 400) intelligence.verified = verifiedStatus(projectRoot, cmd.argv, { timeoutMs: Math.min(2000, left) });
    if (intelligence.verified?.state === 'unavailable') intelligence.verified = null; // cannot tell: fall back to the light hint, which says it is unverified
  }
  return hookLine({ system: !!found.root, intelligence, config });
}

async function main() {
  let cwd;
  try {
    const raw = await readStdin();
    if (raw.trim()) cwd = JSON.parse(raw)?.cwd;
  } catch {
    cwd = undefined;
  }
  try {
    const line = await buildLine({ cwd: typeof cwd === 'string' ? cwd : undefined });
    if (line) process.stdout.write(line + '\n');
  } catch {
    process.stdout.write('ERDEM: adapter error (ignored)\n');
  }
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
