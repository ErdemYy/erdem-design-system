import { loadConfig } from './config.mjs';
import { loadPrevious } from './cache.mjs';
import { scanProject } from './scan.mjs';
import { writeIfChanged } from './write.mjs';
import { buildGraph } from '../graph/build.mjs';
import { buildView } from '../graph/views.mjs';
import { renderMermaid } from '../graph/render-mermaid.mjs';
import { renderDot } from '../graph/render-dot.mjs';
import { graphArtifacts, viewSlug } from '../graph/outputs.mjs';
import { stableStringify } from './json.mjs';
import { createGraphQuery } from '../analyze/query.mjs';
import { generateIndex } from '../index/generate.mjs';
import { checkStatus } from '../index/status.mjs';
import { buildCache, CACHE_FILE } from './cache.mjs';

function prepare(root, { configPath, overrides, rehash, now } = {}) {
  const cfg = loadConfig(root, { configPath, overrides: { ...(overrides ?? {}), ...(rehash ? { trustMtime: false } : {}) } });
  const previous = loadPrevious(root, cfg);
  const scan = scanProject(root, { config: cfg, previous, now });
  const { graph, diagnostics } = buildGraph(scan, { now: scan.generatedAt });
  return { cfg, scan, graph, diagnostics };
}

/** Full refresh: scan, graph, and every derived artifact for the chosen profile. Writes only inside the output directory. */
export function runIndex(root, opts = {}) {
  const { scan, graph, diagnostics } = prepare(root, opts);
  const report = generateIndex({ scan, graph, graphDiagnostics: diagnostics, profile: opts.profile, now: scan.generatedAt, prune: opts.prune });
  return { scan, graph, report };
}

/**
 * Graph artifacts only. Default: graph.json, graph.mmd and graph.dot (FULL overview).
 * With a view mode other than full: writes that view to graph/views/.
 */
export function runGraph(root, opts = {}) {
  const { cfg, scan, graph } = prepare(root, opts);
  const query = createGraphQuery(graph);
  const mode = (opts.view ?? 'full').toLowerCase();
  const out = cfg.outputDir;
  const writes = {};
  const viewOpts = {
    mode,
    target: opts.target,
    depth: opts.depth,
    maxNodes: opts.maxNodes ?? cfg.graph.maxNodes,
    includeTests: opts.includeTests ?? (mode === 'full' ? cfg.graph.includeTests : undefined),
    includeExternal: opts.includeExternal ?? cfg.graph.includeExternal,
    query,
  };
  let view = null;
  let rendered = null;
  if (mode === 'full') {
    const cfgLocal = opts.maxNodes ? { ...cfg, graph: { ...cfg.graph, maxNodes: opts.maxNodes } } : cfg;
    for (const a of graphArtifacts(graph, cfgLocal, { query })) writes[`${out}/${a.path}`] = writeIfChanged(scan.root, `${out}/${a.path}`, a.content);
    view = buildView(graph, viewOpts);
  } else {
    view = buildView(graph, viewOpts);
    const slug = viewSlug(`${mode}:${view.target ?? ''}`);
    rendered = { mmd: renderMermaid(view), dot: renderDot(view) };
    writes[`${out}/graph/views/${mode}-${slug}.mmd`] = writeIfChanged(scan.root, `${out}/graph/views/${mode}-${slug}.mmd`, rendered.mmd);
    writes[`${out}/graph/views/${mode}-${slug}.dot`] = writeIfChanged(scan.root, `${out}/graph/views/${mode}-${slug}.dot`, rendered.dot);
    writes[`${out}/graph/graph.json`] = writeIfChanged(scan.root, `${out}/graph/graph.json`, stableStringify(graph));
  }
  writes[`${out}/${CACHE_FILE}`] = writeIfChanged(scan.root, `${out}/${CACHE_FILE}`, stableStringify(buildCache(scan, scan.generatedAt)));
  return { scan, graph, view, rendered: rendered ?? { mmd: renderMermaid(view), dot: renderDot(view) }, writes };
}

/** Compare derived artifacts with the sources. Read-only. Always re-hashes: the hash decides, never mtime. */
export function runStatus(root, opts = {}) {
  const cfg = loadConfig(root, { configPath: opts.configPath, overrides: { ...(opts.overrides ?? {}), trustMtime: false } });
  const scan = scanProject(root, { config: cfg, parse: false, previous: { index: null, cache: null } });
  return { scan, status: checkStatus(scan) };
}

/** Impact query on a freshly built in-memory graph. Read-only. */
export function runImpact(root, target, opts = {}) {
  const { scan, graph } = prepare(root, opts);
  const query = createGraphQuery(graph);
  return { scan, graph, query, impact: query.getImpact(target, { maxDepth: opts.depth }) };
}

/** Build the graph in memory without writing anything. */
export function buildProjectGraph(root, opts = {}) {
  const { scan, graph, diagnostics } = prepare(root, opts);
  return { scan, graph, diagnostics, query: createGraphQuery(graph) };
}
