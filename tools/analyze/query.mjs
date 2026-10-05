import { cmp, normalizeRel } from '../lib/util.mjs';

const RISK_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/**
 * Reusable query layer over a machine graph (schema v1). Pure and read-only: it never touches the
 * file system. Dependency direction: an edge source depends on its target.
 *
 *   getNode, getDependencies, getDependents, getTransitiveDependencies, getTransitiveDependents,
 *   getNeighborhood, getImpact, findPublicSurfaces, getTests, shortestPath, getRisk, isPublicSurface,
 *   getCycles, listSubsystems, getSubsystem
 *
 * References accept a node id or a project-relative path (with or without "./" and with either slash).
 */
export function createGraphQuery(graph) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const outgoing = new Map();
  const incoming = new Map();
  for (const id of nodes.keys()) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const e of graph.edges) {
    outgoing.get(e.source)?.push(e);
    incoming.get(e.target)?.push(e);
  }

  const resolveId = (ref) => {
    if (typeof ref !== 'string') return null;
    if (nodes.has(ref)) return ref;
    const rel = normalizeRel(ref);
    if (nodes.has(rel)) return rel;
    if (nodes.has(`ext:${ref}`)) return `ext:${ref}`;
    return null;
  };

  const edgeAllowed = (e, opts) =>
    (!opts.types || opts.types.includes(e.type)) && (opts.includeTypeOnly !== false || !e.typeOnly);

  const nodeAllowed = (id, opts) => {
    const n = nodes.get(id);
    if (!n) return false;
    if (opts.includeExternal === false && n.type === 'external') return false;
    if (opts.includeTests === false && n.metadata?.category === 'test') return false;
    return true;
  };

  /** Breadth-first walk. direction: 'out' follows dependencies, 'in' follows dependents. */
  function walk(startId, direction, opts = {}) {
    const maxDepth = opts.maxDepth ?? Infinity;
    const dist = new Map([[startId, 0]]);
    const queue = [startId];
    while (queue.length) {
      const cur = queue.shift();
      const d = dist.get(cur);
      if (d >= maxDepth) continue;
      const list = direction === 'out' ? outgoing.get(cur) : incoming.get(cur);
      for (const e of list ?? []) {
        if (!edgeAllowed(e, opts)) continue;
        const next = direction === 'out' ? e.target : e.source;
        if (dist.has(next) || !nodeAllowed(next, opts)) continue;
        dist.set(next, d + 1);
        queue.push(next);
      }
    }
    dist.delete(startId);
    return [...dist.entries()].map(([id, distance]) => ({ id, distance })).sort((a, b) => a.distance - b.distance || cmp(a.id, b.id));
  }

  const direct = (ref, direction, opts = {}) => {
    const id = resolveId(ref);
    if (!id) return [];
    const set = new Set();
    for (const e of (direction === 'out' ? outgoing.get(id) : incoming.get(id)) ?? []) {
      if (!edgeAllowed(e, opts)) continue;
      const other = direction === 'out' ? e.target : e.source;
      if (nodeAllowed(other, opts)) set.add(other);
    }
    return [...set].sort(cmp);
  };

  const api = {
    graph,
    resolveId,

    getNode: (ref) => nodes.get(resolveId(ref)) ?? null,

    /** What does this file depend on? (direct) */
    getDependencies: (ref, opts) => direct(ref, 'out', opts),

    /** What depends on this file? (direct) */
    getDependents: (ref, opts) => direct(ref, 'in', opts),

    getTransitiveDependencies(ref, opts) {
      const id = resolveId(ref);
      return id ? walk(id, 'out', opts) : [];
    },

    getTransitiveDependents(ref, opts) {
      const id = resolveId(ref);
      return id ? walk(id, 'in', opts) : [];
    },

    /** The dependency neighborhood of a node within `depth` hops. direction: 'both' | 'in' | 'out'. */
    getNeighborhood(ref, depth = 1, opts = {}) {
      const id = resolveId(ref);
      if (!id) return { center: null, nodes: [], edges: [] };
      const direction = opts.direction ?? 'both';
      const found = new Map();
      if (direction === 'out' || direction === 'both') for (const x of walk(id, 'out', { ...opts, maxDepth: depth })) found.set(x.id, x.distance);
      if (direction === 'in' || direction === 'both') {
        for (const x of walk(id, 'in', { ...opts, maxDepth: depth })) found.set(x.id, Math.min(x.distance, found.get(x.id) ?? Infinity));
      }
      found.set(id, 0);
      const members = new Set(found.keys());
      const edges = graph.edges.filter((e) => members.has(e.source) && members.has(e.target) && edgeAllowed(e, opts));
      return {
        center: id,
        nodes: [...found.entries()].map(([nid, distance]) => ({ id: nid, distance })).sort((a, b) => a.distance - b.distance || cmp(a.id, b.id)),
        edges,
      };
    },

    /** Everything that depends on the target, directly or indirectly (file-level, a superset of real impact). */
    getImpact(ref, opts = {}) {
      const id = resolveId(ref);
      if (!id) return { target: ref, found: false, notes: ['not found in the graph (is the path project-relative and scanned?)'] };
      const node = nodes.get(id);
      const affected = walk(id, 'in', { maxDepth: opts.maxDepth, includeTypeOnly: opts.includeTypeOnly });
      const tests = affected.filter((a) => nodes.get(a.id)?.metadata?.category === 'test').map((a) => a.id);
      const surfaces = [id, ...affected.map((a) => a.id)].filter((x) => nodes.get(x)?.publicSurface);
      let maxRank = 0;
      for (const a of affected) maxRank = Math.max(maxRank, RISK_RANK[nodes.get(a.id)?.risk] ?? 0);
      const notes = ['file-level analysis: which exported names are used is not resolved, so this is a superset of the real impact'];
      if (node.type === 'file' && node.metadata.dependencyAnalysis === 'none') notes.push(`no dependency analysis for ${node.language ?? 'this file type'}: its own dependencies are unknown; dependents found through analyzed files remain valid`);
      if (node.type === 'file' && node.metadata.dependencyAnalysis === 'partial') notes.push('this file was only partially parsed; its dependencies may be incomplete');
      return {
        target: id,
        found: true,
        type: node.type,
        language: node.language,
        risk: { level: node.risk, basis: node.metadata?.riskBasis ?? [] },
        publicSurface: node.publicSurface,
        publicSurfaceReasons: node.metadata?.publicSurfaceReasons ?? [],
        inCycle: node.metadata?.inCycle ?? false,
        dependencies: direct(id, 'out'),
        directDependents: direct(id, 'in'),
        affected,
        affectedCount: affected.length,
        tests: tests.sort(cmp),
        publicSurfacesAffected: [...new Set(surfaces)].sort(cmp),
        maxRiskAmongAffected: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'][maxRank - 1] ?? null,
        notes,
      };
    },

    findPublicSurfaces({ reason } = {}) {
      return graph.nodes
        .filter((n) => n.publicSurface && (!reason || n.metadata.publicSurfaceReasons.includes(reason)))
        .map((n) => ({ id: n.id, reasons: n.metadata.publicSurfaceReasons, risk: n.risk }))
        .sort((a, b) => cmp(a.id, b.id));
    },

    /** Test files that depend on the target, directly or indirectly. */
    getTests(ref) {
      const id = resolveId(ref);
      if (!id) return [];
      return walk(id, 'in', {})
        .filter((a) => nodes.get(a.id)?.metadata?.category === 'test')
        .map((a) => a.id)
        .sort(cmp);
    },

    /** Shortest dependency chain from `from` to `to` following dependencies, or null. */
    shortestPath(from, to) {
      const a = resolveId(from);
      const b = resolveId(to);
      if (!a || !b) return null;
      const prev = new Map([[a, null]]);
      const queue = [a];
      while (queue.length) {
        const cur = queue.shift();
        if (cur === b) break;
        for (const next of direct(cur, 'out')) {
          if (!prev.has(next)) {
            prev.set(next, cur);
            queue.push(next);
          }
        }
      }
      if (!prev.has(b)) return null;
      const chain = [];
      for (let x = b; x !== null; x = prev.get(x)) chain.unshift(x);
      return chain;
    },

    getRisk(ref) {
      const n = nodes.get(resolveId(ref));
      return n ? { level: n.risk, basis: n.metadata?.riskBasis ?? [] } : null;
    },

    isPublicSurface(ref) {
      return !!nodes.get(resolveId(ref))?.publicSurface;
    },

    getCycles: () => graph.cycles.map((c) => [...c]),

    listSubsystems() {
      const map = new Map();
      for (const n of graph.nodes) {
        if (n.type !== 'file') continue;
        const key = n.metadata.subsystem;
        map.set(key, (map.get(key) ?? 0) + 1);
      }
      return [...map.entries()].map(([key, files]) => ({ key, files })).sort((a, b) => cmp(a.key, b.key));
    },

    getSubsystem(key) {
      return graph.nodes.filter((n) => n.type === 'file' && n.metadata.subsystem === key).map((n) => n.id).sort(cmp);
    },
  };
  return api;
}
