import { createHash } from 'node:crypto';
import { stableStringify } from '../lib/json.mjs';
import { slugify } from '../lib/util.mjs';
import { buildView } from './views.mjs';
import { renderMermaid } from './render-mermaid.mjs';
import { renderDot } from './render-dot.mjs';

/** File-name-safe slug with a short hash so different keys never collide. */
export function viewSlug(text) {
  return `${slugify(text)}-${createHash('sha1').update(text).digest('hex').slice(0, 6)}`;
}

/**
 * Graph artifacts, as [{path, content}] relative to the output directory:
 *   graph/graph.json, graph/graph.mmd, graph/graph.dot (default FULL view), graph/views/subsystem-*.{mmd,dot}
 */
export function graphArtifacts(graph, cfg, { subsystemTargets = [], query } = {}) {
  const opts = { maxNodes: cfg.graph.maxNodes, includeTests: cfg.graph.includeTests, includeExternal: cfg.graph.includeExternal, query };
  const full = buildView(graph, { ...opts, mode: 'full' });
  const out = [
    { path: 'graph/graph.json', content: stableStringify(graph) },
    { path: 'graph/graph.mmd', content: renderMermaid(full) },
    { path: 'graph/graph.dot', content: renderDot(full) },
  ];
  for (const target of subsystemTargets.slice(0, cfg.graph.maxSubsystemViews)) {
    const view = buildView(graph, { ...opts, mode: 'subsystem', target });
    const slug = viewSlug(target);
    out.push({ path: `graph/views/subsystem-${slug}.mmd`, content: renderMermaid(view) });
    out.push({ path: `graph/views/subsystem-${slug}.dot`, content: renderDot(view) });
  }
  return out;
}

export function subsystemViewPath(target) {
  return `graph/views/subsystem-${viewSlug(target)}.mmd`;
}
