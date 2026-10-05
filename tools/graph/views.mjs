import { createGraphQuery } from '../analyze/query.mjs';
import { cmp, isUnder, normalizeRel } from '../lib/util.mjs';

/**
 * Filtered graph views. A view is a plain object consumed by the Mermaid and DOT renderers:
 *   { mode, title, level: 'file'|'subsystem', nodes[], edges[], notes[], truncated, target }
 * Views never exceed `maxNodes`: larger graphs are aggregated, truncated deterministically, or summarized.
 */

const STYLE_ORDER = ['static', 'reexport', 'dynamic', 'type', 'reference'];

export function edgeStyle(e) {
  if (e.type === 'references') return 'reference';
  if (e.type === 'exports') return 'reexport';
  if (e.typeOnly) return 'type';
  if (e.kind === 'dynamic') return 'dynamic';
  return 'static';
}

function labelOf(id) {
  const parts = id.split('/');
  return parts.slice(-2).join('/');
}

function toViewNode(n, extra = {}) {
  return {
    id: n.id,
    label: n.type === 'external' ? n.metadata.package : labelOf(n.id),
    kind: n.type,
    subsystem: n.type === 'file' ? n.metadata.subsystem : null,
    publicSurface: n.publicSurface,
    entryPoint: !!n.metadata?.entryPoint,
    risk: n.risk,
    ...extra,
  };
}

/** One edge per pair, keeping the strongest style. */
function collapseEdges(edges, memberIds) {
  const best = new Map();
  for (const e of edges) {
    if (!memberIds.has(e.source) || !memberIds.has(e.target)) continue;
    const key = `${e.source}\0${e.target}`;
    const style = edgeStyle(e);
    const cur = best.get(key);
    if (!cur || STYLE_ORDER.indexOf(style) < STYLE_ORDER.indexOf(cur.style)) best.set(key, { source: e.source, target: e.target, style });
  }
  return [...best.values()].sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target));
}

function priority(a, b) {
  return (b.consumers?.length ?? 0) - (a.consumers?.length ?? 0) || cmp(a.id, b.id);
}

function truncate(candidates, maxNodes, keepFirst = () => false) {
  if (candidates.length <= maxNodes) return { kept: candidates, omitted: 0 };
  const forced = candidates.filter(keepFirst);
  const rest = candidates.filter((c) => !keepFirst(c));
  const kept = [...forced, ...rest.slice(0, Math.max(0, maxNodes - forced.length))];
  return { kept, omitted: candidates.length - kept.length };
}

function aggregate(fileNodes, edges, maxNodes) {
  const groups = new Map();
  for (const n of fileNodes) {
    const key = n.metadata.subsystem;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  let keys = [...groups.keys()].sort(cmp);
  let omitted = 0;
  if (keys.length > maxNodes) {
    const bySize = [...keys].sort((a, b) => groups.get(b).length - groups.get(a).length || cmp(a, b));
    omitted = keys.length - maxNodes;
    keys = bySize.slice(0, maxNodes).sort(cmp);
  }
  const keep = new Set(keys);
  const owner = new Map();
  for (const key of keys) for (const n of groups.get(key)) owner.set(n.id, key);
  const weights = new Map();
  for (const e of edges) {
    const a = owner.get(e.source);
    const b = owner.get(e.target);
    if (!a || !b || a === b) continue;
    const k = `${a}\0${b}`;
    weights.set(k, (weights.get(k) ?? 0) + 1);
  }
  return {
    nodes: keys.map((key) => ({
      id: `subsystem:${key}`,
      label: key === '.' ? '(root)' : key,
      kind: 'subsystem',
      subsystem: key,
      count: groups.get(key).length,
      publicSurface: groups.get(key).some((n) => n.publicSurface),
      entryPoint: false,
      risk: null,
    })),
    edges: [...weights.entries()]
      .map(([k, weight]) => {
        const [a, b] = k.split('\0');
        return { source: `subsystem:${a}`, target: `subsystem:${b}`, style: 'static', weight };
      })
      .sort((x, y) => cmp(x.source, y.source) || cmp(x.target, y.target)),
    omitted,
  };
}

export function buildView(graph, opts = {}) {
  const query = opts.query ?? createGraphQuery(graph);
  const mode = (opts.mode ?? 'full').toLowerCase();
  const maxNodes = opts.maxNodes ?? 60;
  const depth = opts.depth ?? (mode === 'impact' ? Infinity : 1);
  const includeExternal = opts.includeExternal ?? false;
  const includeTests = opts.includeTests ?? mode === 'impact';
  const visible = (n) => (n.type === 'external' ? includeExternal : includeTests || n.metadata.category !== 'test');
  const all = graph.nodes;
  const byId = new Map(all.map((n) => [n.id, n]));
  const notes = [];

  if (mode === 'full') {
    const nodes = all.filter(visible);
    const files = nodes.filter((n) => n.type === 'file');
    const ids = new Set(nodes.map((n) => n.id));
    if (nodes.length <= maxNodes) {
      return { mode, title: 'Dependency overview', level: 'file', nodes: nodes.map((n) => toViewNode(n)), edges: collapseEdges(graph.edges, ids), notes, truncated: null, target: null };
    }
    const agg = aggregate(files, graph.edges, maxNodes);
    notes.push(`${files.length} files exceed maxNodes (${maxNodes}); showing subsystems. Use --view subsystem --target <path> for detail; graph.json has the full graph.`);
    return {
      mode,
      title: 'Dependency overview (by subsystem)',
      level: 'subsystem',
      nodes: agg.nodes,
      edges: agg.edges,
      notes,
      truncated: agg.omitted ? { omitted: agg.omitted, unit: 'subsystems' } : null,
      target: null,
    };
  }

  if (mode === 'subsystem') {
    const target = normalizeRel(opts.target ?? '.');
    const inside = all.filter((n) => n.type === 'file' && visible(n) && (target === '.' || n.metadata.subsystem === target || isUnder(n.id, target)));
    if (inside.length === 0) notes.push(`no files found under "${target}"`);
    const insideIds = new Set(inside.map((n) => n.id));
    const outside = new Map();
    for (const e of graph.edges) {
      const aIn = insideIds.has(e.source);
      const bIn = insideIds.has(e.target);
      if (aIn === bIn) continue;
      const other = byId.get(aIn ? e.target : e.source);
      if (other && visible(other)) outside.set(other.id, other);
    }
    const candidates = [...inside.sort(priority), ...[...outside.values()].sort(priority)];
    const { kept, omitted } = truncate(candidates, maxNodes, () => false);
    const keptIds = new Set(kept.map((n) => n.id));
    return {
      mode,
      title: `Subsystem: ${target}`,
      level: 'file',
      nodes: kept.map((n) => toViewNode(n, { outside: !insideIds.has(n.id) })),
      edges: collapseEdges(graph.edges, keptIds),
      notes,
      truncated: omitted ? { omitted, unit: 'nodes' } : null,
      target,
    };
  }

  if (mode === 'file' || mode === 'impact') {
    const target = query.resolveId(opts.target ?? '');
    if (!target) {
      return { mode, title: `${mode}: ${opts.target ?? ''}`, level: 'file', nodes: [], edges: [], notes: [`"${opts.target}" is not in the graph`], truncated: null, target: null };
    }
    let found;
    if (mode === 'file') {
      found = query.getNeighborhood(target, depth, { includeExternal, includeTests }).nodes;
    } else {
      found = [{ id: target, distance: 0 }, ...query.getImpact(target, { maxDepth: depth === Infinity ? undefined : depth }).affected];
    }
    const wanted = found.filter((f) => byId.has(f.id) && (f.id === target || visible(byId.get(f.id))));
    wanted.sort((a, b) => (a.id === target ? -1 : b.id === target ? 1 : a.distance - b.distance || priority(byId.get(a.id), byId.get(b.id))));
    const { kept, omitted } = truncate(wanted, maxNodes, (c) => c.id === target);
    const keptIds = new Set(kept.map((k) => k.id));
    return {
      mode,
      title: mode === 'file' ? `File neighborhood: ${target}` : `Impact of changing: ${target}`,
      level: 'file',
      nodes: kept.map((k) => toViewNode(byId.get(k.id), { target: k.id === target })),
      edges: collapseEdges(graph.edges, keptIds),
      notes,
      truncated: omitted ? { omitted, unit: 'nodes' } : null,
      target,
    };
  }

  throw new Error(`Unknown view mode "${mode}" (use full, subsystem, file or impact)`);
}
