import path from 'node:path';
import { createMatcher } from '../lib/glob.mjs';
import { RISK_RANK } from '../graph/risk.mjs';
import { cmp, isUnder } from '../lib/util.mjs';

/**
 * Which files and directories deserve an index entry. Evidence only: entry points, public surfaces,
 * widely used modules, and anything the project lists explicitly. Everything else stays out of the index.
 */
export function selectImportantFiles(graph, cfg) {
  const category = new Map(graph.nodes.map((n) => [n.id, n.metadata?.category]));
  const match = cfg.important.patterns.length ? createMatcher(cfg.important.patterns) : null;
  const files = [];
  for (const n of graph.nodes) {
    if (n.type !== 'file' || n.metadata.category === 'test') continue;
    const reasons = [];
    if (n.metadata.entryPoint) reasons.push('entry point');
    for (const r of n.metadata.publicSurfaceReasons) reasons.push(r);
    const dependents = n.consumers.filter((c) => category.get(c) !== 'test').length;
    if (dependents >= cfg.important.minFanIn) reasons.push(`used by ${dependents} files`);
    if (match?.(n.id, false)) reasons.push('configured');
    if (reasons.length) files.push({ id: n.id, reasons: [...new Set(reasons)], risk: n.risk, consumers: dependents });
  }
  files.sort((a, b) => (RISK_RANK[b.risk] ?? 0) - (RISK_RANK[a.risk] ?? 0) || b.consumers - a.consumers || cmp(a.id, b.id));
  return files.slice(0, cfg.important.maxFiles);
}

/** Meaningful architectural directories: subsystem roots, package directories, and configured ones. */
export function selectImportantDirectories(graph, scan, cfg) {
  const subsystemKeys = new Set();
  const stats = new Map();
  const bump = (dir, field) => {
    const s = stats.get(dir) ?? { path: dir, sourceFiles: 0, tests: 0 };
    s[field]++;
    stats.set(dir, s);
  };
  for (const n of graph.nodes) {
    if (n.type !== 'file') continue;
    const cat = n.metadata.category;
    if (cat !== 'source' && cat !== 'test') continue;
    subsystemKeys.add(n.metadata.subsystem);
    let dir = path.posix.dirname(n.id);
    while (dir && dir !== '.') {
      bump(dir, cat === 'test' ? 'tests' : 'sourceFiles');
      dir = path.posix.dirname(dir);
    }
  }
  const match = cfg.directories.patterns.length ? createMatcher(cfg.directories.patterns) : null;
  const out = [];
  for (const s of stats.values()) {
    const reasons = [];
    if (subsystemKeys.has(s.path) && s.sourceFiles >= cfg.directories.minSourceFiles) reasons.push('subsystem root');
    if (scan.packages.has(`${s.path}/package.json`)) reasons.push('package');
    if (match?.(s.path, true)) reasons.push('configured');
    if (reasons.length) out.push({ ...s, reasons });
  }
  out.sort((a, b) => b.sourceFiles - a.sourceFiles || cmp(a.path, b.path));
  return out.slice(0, cfg.directories.maxIndexes);
}

export function membersOf(graph, dir) {
  return graph.nodes.filter((n) => n.type === 'file' && isUnder(n.id, dir));
}
