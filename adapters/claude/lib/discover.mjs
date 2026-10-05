import fs from 'node:fs';
import path from 'node:path';
import { SELF_ROOT } from './paths.mjs';
import { exists, readHead, readJson, splitCommand } from './util.mjs';

/** A directory is a design-system root when its manifest names it. Only the first bytes are read. */
export function isDesignSystemRoot(dir) {
  if (!dir) return false;
  const head = readHead(path.join(dir, 'system-manifest.yaml'), 2048);
  return !!head && /^name:\s*erdem-design-system\s*$/m.test(head);
}

/**
 * Where is the design system? Discovery order:
 *   1. ERDEM_DESIGN_SYSTEM_ROOT
 *   2. adapter configuration (project override, then user config; a relative path is a project-local copy)
 *   3. the installation recorded when the adapter was installed
 *   4. the checkout this adapter script lives in
 *   5. none: callers fall back gracefully
 * No machine-specific path is ever assumed.
 */
export function resolveDesignSystemRoot({ env = process.env, config, sources = {}, ledger, selfRoot = SELF_ROOT } = {}) {
  const tried = [];
  const candidates = [];
  if (env.ERDEM_DESIGN_SYSTEM_ROOT) candidates.push([path.resolve(env.ERDEM_DESIGN_SYSTEM_ROOT), 'env']);
  if (config?.designSystemRoot && sources.designSystemRoot !== 'env') {
    candidates.push([config.designSystemRoot, sources.designSystemRoot === 'project' ? 'project-config' : 'user-config']);
  }
  if (ledger?.designSystemRoot) candidates.push([ledger.designSystemRoot, 'installed']);
  if (selfRoot) candidates.push([selfRoot, 'adapter-location']);
  for (const [dir, source] of candidates) {
    const ok = isDesignSystemRoot(dir);
    tried.push({ source, ok });
    if (ok) return { root: dir, source, tried };
  }
  return { root: null, source: null, tried };
}

/** Project root for a working directory: the nearest ancestor with .ai/, else with .git, else the directory itself. */
export function findProjectRoot(cwd) {
  let dir = path.resolve(cwd);
  const start = dir;
  for (let i = 0; i < 12; i++) {
    if (exists(path.join(dir, '.ai')) || exists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/**
 * The project-intel command as an argv array, or null. A configured command wins; otherwise the engine inside
 * the design-system root is run with the current node. A bare `project-intel` shim can be configured explicitly.
 */
export function resolveIntelCommand({ root, config }) {
  const c = config?.projectIntelCommand;
  if (Array.isArray(c) && c.length) return { argv: c, source: 'config' };
  if (typeof c === 'string' && c) return { argv: splitCommand(c), source: 'config' };
  if (root) {
    const bin = path.join(root, 'tools', 'bin', 'project-intel.mjs');
    if (fs.existsSync(bin)) return { argv: [process.execPath, bin], source: 'design-system' };
  }
  return null;
}

/** Ledger written by the installer (user scope), if any. */
export function readLedger(ledgerPath) {
  const r = readJson(ledgerPath);
  return r.data && typeof r.data === 'object' ? r.data : null;
}
