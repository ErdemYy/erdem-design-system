import path from 'node:path';
import { createMatcher } from '../lib/glob.mjs';
import { resolveFileCandidate } from '../lib/languages/javascript.mjs';
import { subsystemOf } from '../lib/subsystem.mjs';
import { sortedUnique } from '../lib/util.mjs';

/**
 * Public surface and entry-point detection. Evidence-based only: a file is never a public surface merely
 * because it exports something or because of its name. Reasons are recorded per node.
 */

const NEXT_ROUTES = [
  /^(src\/)?app\/(.*\/)?(page|layout|route|loading|error|not-found|template|default|global-error)\.(tsx|ts|jsx|js|mjs)$/,
  /^(src\/)?pages\/.+\.(tsx|ts|jsx|js|mjs)$/,
  /^(src\/)?middleware\.(ts|js|mjs)$/,
];
const SVELTEKIT_ROUTES = [/^src\/routes\/(.*\/)?\+[a-z-]+\.(ts|js|svelte)$/];

function nearestPackage(rel, packages) {
  let dir = path.posix.dirname(rel);
  for (;;) {
    const cand = dir === '.' ? 'package.json' : `${dir}/package.json`;
    if (packages.has(cand)) return { path: cand, dir, pkg: packages.get(cand) };
    if (dir === '.' || dir === '') return null;
    dir = path.posix.dirname(dir);
  }
}

/**
 * ctx: { nodes: Map<id, {id, type, category, language}>, consumers: Map<id, Set<id>> (any edge type),
 *        scan, cfg, fileSet }
 * returns Map<id, {reasons: string[], entryPoint: boolean}>
 */
export function computeSurface(ctx) {
  const { nodes, consumers, scan, cfg, fileSet } = ctx;
  const out = new Map();
  const add = (id, reason, entry = false) => {
    const rec = out.get(id) ?? { reasons: new Set(), entryPoint: false };
    rec.reasons.add(reason);
    if (entry) rec.entryPoint = true;
    out.set(id, rec);
  };
  const isFileNode = (id) => nodes.get(id)?.type === 'file';

  // package entry points
  for (const [pkgPath, pkg] of scan.packages) {
    const dir = path.posix.dirname(pkgPath);
    const leaves = [pkg.main, pkg.module, pkg.types, ...pkg.bin, ...pkg.exportsLeaves].filter(Boolean);
    for (const leaf of leaves) {
      const base = path.posix.normalize(path.posix.join(dir, leaf));
      const hit = resolveFileCandidate(base, fileSet);
      if (hit && isFileNode(hit)) add(hit, 'package-entry', true);
    }
  }

  // framework route conventions, only with dependency evidence
  if (cfg.publicSurface.frameworks) {
    for (const [id, node] of nodes) {
      if (node.type !== 'file' || node.category !== 'source') continue;
      const np = nearestPackage(id, scan.packages);
      if (!np) continue;
      const rel = np.dir === '.' ? id : id.slice(np.dir.length + 1);
      const deps = new Set(np.pkg.dependencies);
      if (deps.has('next') && NEXT_ROUTES.some((r) => r.test(rel))) add(id, 'framework-route', true);
      if (deps.has('@sveltejs/kit') && SVELTEKIT_ROUTES.some((r) => r.test(rel))) add(id, 'framework-route', true);
    }
  }

  // global configuration at the project root
  for (const [id, node] of nodes) {
    if (node.type === 'file' && node.category === 'config' && !id.includes('/')) add(id, 'global-config');
  }

  // shared modules: imported from several other subsystems (tests excluded)
  for (const [id, node] of nodes) {
    if (node.type !== 'file' || node.category === 'test') continue;
    const own = subsystemOf(id, cfg);
    const subs = new Set();
    for (const src of consumers.get(id) ?? []) {
      const sn = nodes.get(src);
      if (!sn || sn.type !== 'file' || sn.category === 'test') continue;
      const s = subsystemOf(src, cfg);
      if (s !== own) subs.add(s);
    }
    if (subs.size >= cfg.publicSurface.sharedMinSubsystems) add(id, 'shared-module');
  }

  // explicit project configuration
  if (cfg.publicSurface.patterns.length) {
    const match = createMatcher(cfg.publicSurface.patterns);
    for (const [id, node] of nodes) if (node.type === 'file' && match(id, false)) add(id, 'configured');
  }
  if (cfg.entryPoints.length) {
    const match = createMatcher(cfg.entryPoints);
    for (const [id, node] of nodes) if (node.type === 'file' && match(id, false)) add(id, 'configured-entry', true);
  }

  const result = new Map();
  for (const [id, rec] of out) result.set(id, { reasons: sortedUnique([...rec.reasons]), entryPoint: rec.entryPoint });
  return result;
}
