/**
 * Subsystem key of a project-relative path: the first path segment, or the first two when the first is a
 * configured container directory (default src, packages, apps, libs, modules, services) and the path is
 * deeper than that. Root-level files belong to ".".
 */
export function subsystemOf(rel, cfg) {
  const segs = rel.split('/');
  if (segs.length === 1) return '.';
  if (cfg.subsystemRoots.includes(segs[0]) && segs.length > 2) return `${segs[0]}/${segs[1]}`;
  return segs[0];
}
