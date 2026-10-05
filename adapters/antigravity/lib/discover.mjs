import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SELF_ROOT } from './paths.mjs';
import { exists, readHead, readJson, splitCommand } from './helpers.mjs';

/** A directory is a design-system root when its manifest names it (only the first bytes are read). */
export function isDesignSystemRoot(dir) {
  if (!dir) return false;
  const head = readHead(path.join(dir, 'system-manifest.yaml'), 2048);
  return !!head && /^name:\s*erdem-design-system\s*$/m.test(head);
}

/**
 * Where is the design system? Order: ERDEM_DESIGN_SYSTEM_ROOT, adapter configuration (project, then user; a
 * relative path is a project-local copy), the root recorded at install time, the checkout containing this
 * adapter, none. A candidate counts only if its manifest names `erdem-design-system`. An explicitly configured
 * but invalid root is reported in `tried` and is never silently replaced by a guess for that source.
 */
export function resolveDesignSystemRoot({ env = process.env, config, sources = {}, ledger, selfRoot = SELF_ROOT } = {}) {
  const candidates = [];
  if (env.ERDEM_DESIGN_SYSTEM_ROOT) candidates.push([path.resolve(env.ERDEM_DESIGN_SYSTEM_ROOT), 'env']);
  if (config?.designSystemRoot && sources.designSystemRoot !== 'env') candidates.push([config.designSystemRoot, sources.designSystemRoot === 'project' ? 'project-config' : 'user-config']);
  if (ledger?.designSystemRoot) candidates.push([ledger.designSystemRoot, 'installed']);
  if (selfRoot) candidates.push([selfRoot, 'adapter-location']);
  const tried = [];
  for (const [dir, source] of candidates) {
    const ok = isDesignSystemRoot(dir);
    tried.push({ source, ok });
    if (ok) return { root: dir, source, tried };
  }
  return { root: null, source: null, tried };
}

/** Nearest ancestor with .ai/ or .git, else the directory itself. */
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

/** The engine command as argv, or null. A configured command wins; otherwise the engine in the design-system root. */
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

export function readLedger(ledgerPath) {
  const r = readJson(ledgerPath);
  return r.data && typeof r.data === 'object' ? r.data : null;
}

/** Load one module of the canonical engine from the design-system root (the adapter reuses it, never copies it). */
export async function importEngineModule(root, relPath) {
  const file = root && path.join(root, 'tools', relPath);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return await import(pathToFileURL(file).href);
  } catch {
    return null;
  }
}
