import path from 'node:path';
import { SCHEMA, TOOL } from '../lib/constants.mjs';
import { createMatcher } from '../lib/glob.mjs';
import { adapterFor } from '../lib/languages/registry.mjs';
import { fingerprintRef, setFingerprint } from '../lib/fingerprint.mjs';
import { subsystemOf } from '../lib/subsystem.mjs';
import { cmp, countBy, normalizeRel, sortedUnique } from '../lib/util.mjs';
import { findCycles } from './cycles.mjs';
import { computeSurface } from './surface.mjs';
import { createRiskEvaluator } from './risk.mjs';

/** Root configuration that does not drive the build or runtime: kept in the file index, not treated as a global-config surface. */
const NOT_BUILD_CONFIG = new Set(['.gitignore', '.editorconfig', 'project-intel.config.json']);
const STRUCTURE_CATEGORIES = new Set(['source', 'test', 'config', 'generated']);

/** Workspace packages are recognized only when the root manifest declares `workspaces`. */
function detectWorkspaces(scan) {
  const root = scan.packages.get('package.json');
  const map = new Map();
  if (!root?.workspaces?.length) return map;
  const match = createMatcher(root.workspaces.map((w) => w.replace(/^\.\//, '').replace(/\/$/, '')));
  for (const [pkgPath, pkg] of scan.packages) {
    if (pkgPath === 'package.json' || !pkg.name) continue;
    const dir = path.posix.dirname(pkgPath);
    if (match(dir, true)) map.set(pkg.name, { dir, pkg });
  }
  return map;
}

/** Set fingerprint of the files that determine structure (source, test, config, generated). */
export function structureFingerprint(scan) {
  return setFingerprint(
    scan.files.filter((f) => STRUCTURE_CATEGORIES.has(f.category)).map((f) => ({ path: f.path, hash: f.fingerprint.hash })),
  );
}

/**
 * Build the machine graph (schema v1) from a scan. Only reliably detectable relationships become edges.
 * Returns { graph, diagnostics }.
 */
export function buildGraph(scan, { now } = {}) {
  const cfg = scan.config;
  const diagnostics = [];
  const fileMap = new Map(scan.files.map((f) => [f.path, f]));
  const fileSet = new Set(fileMap.keys());
  const project = { fileSet, tsconfigs: scan.tsconfigs, workspacePackages: detectWorkspaces(scan) };
  const resolvers = new Map();
  const resolverFor = (adapter) => {
    if (!resolvers.has(adapter.id)) resolvers.set(adapter.id, adapter.createResolver(project));
    return resolvers.get(adapter.id);
  };

  const nodes = new Map(); // id -> internal node
  const edges = new Map(); // key -> edge

  const ensureFile = (p) => {
    let n = nodes.get(p);
    if (!n) {
      const f = fileMap.get(p);
      n = {
        id: p,
        type: 'file',
        path: p,
        language: f?.language ?? null,
        category: f?.category ?? 'unknown',
        exports: new Set(f?.parse?.exports ?? []),
        fingerprint: f ? fingerprintRef(f.fingerprint) : null,
        parseStatus: f?.parseStatus ?? 'n/a',
        supportsDependencies: f?.language ? adapterFor(f.language).supportsDependencies : false,
        externalImports: new Set(),
      };
      nodes.set(p, n);
    }
    return n;
  };
  const ensureExternal = (name) => {
    const id = `ext:${name}`;
    if (!nodes.has(id)) {
      nodes.set(id, { id, type: 'external', path: null, language: null, category: 'external', exports: new Set(), fingerprint: null, parseStatus: 'n/a', supportsDependencies: false, externalImports: new Set(), package: name });
    }
    return nodes.get(id);
  };
  const addEdge = (source, target, type, kind, typeOnly) => {
    const key = `${source}\0${target}\0${type}\0${kind}\0${typeOnly ? 1 : 0}`;
    if (!edges.has(key)) {
      const e = { source, target, type, kind };
      if (typeOnly) e.typeOnly = true;
      edges.set(key, e);
    }
  };

  // base nodes: source and test files, and root-level configuration
  for (const f of scan.files) {
    if (f.category === 'source' || f.category === 'test') ensureFile(f.path);
    else if (f.category === 'config' && !f.path.includes('/') && !NOT_BUILD_CONFIG.has(f.path)) ensureFile(f.path);
  }

  // edges from analyzed files
  const unresolved = new Set();
  for (const id of [...nodes.keys()].sort(cmp)) {
    const f = fileMap.get(id);
    if (!f?.parse || !f.language) continue;
    const adapter = adapterFor(f.language);
    if (!adapter.supportsDependencies) continue;
    const resolve = resolverFor(adapter);
    const handle = (spec, type, kind, typeOnly) => {
      const res = resolve(spec, id);
      if (res.kind === 'local') {
        ensureFile(res.path);
        addEdge(id, res.path, type, kind, typeOnly);
      } else if (res.kind === 'external') {
        ensureExternal(res.name);
        nodes.get(id).externalImports.add(res.name);
        addEdge(id, `ext:${res.name}`, type, kind, typeOnly);
      } else if (res.kind === 'unresolved') {
        const key = `${id}\0${spec}`;
        if (!unresolved.has(key)) {
          unresolved.add(key);
          diagnostics.push({ path: id, severity: 'warning', parser: adapter.id, code: 'unresolved-import', message: `cannot resolve "${spec}" (${res.reason})` });
        }
      }
    };
    for (const imp of f.parse.imports) handle(imp.specifier, 'imports', imp.kind, imp.typeOnly);
    for (const re of f.parse.reexports) handle(re.specifier, 'exports', 'reexport', re.typeOnly);
  }

  // relationships stated in project configuration (any language)
  for (const e of cfg.graph.explicitEdges) {
    const source = normalizeRel(e.source);
    const target = normalizeRel(e.target);
    if ((e.type && e.type !== 'references') || !fileSet.has(source) || !fileSet.has(target)) {
      diagnostics.push({ path: source, severity: 'warning', parser: 'config', code: 'invalid-explicit-edge', message: `explicit edge ${source} -> ${target} ignored: both ends must be scanned project files and type must be "references"` });
      continue;
    }
    ensureFile(source);
    ensureFile(target);
    addEdge(source, target, 'references', 'configured', false);
  }

  // adjacency
  const out = new Map();
  const importersOf = new Map(); // via `imports` edges
  const consumersOf = new Map(); // via any edge
  const importsOf = new Map();
  for (const id of nodes.keys()) {
    out.set(id, new Set());
    importersOf.set(id, new Set());
    consumersOf.set(id, new Set());
    importsOf.set(id, new Set());
  }
  for (const e of edges.values()) {
    out.get(e.source).add(e.target);
    consumersOf.get(e.target).add(e.source);
    if (e.type === 'imports') {
      importersOf.get(e.target).add(e.source);
      importsOf.get(e.source).add(e.target);
    }
  }

  const surfaces = computeSurface({ nodes, consumers: consumersOf, scan, cfg, fileSet });
  const evaluateRisk = createRiskEvaluator(cfg);
  const fileOnlyAdj = new Map();
  for (const [id, targets] of out) if (nodes.get(id).type === 'file') fileOnlyAdj.set(id, new Set([...targets].filter((t) => nodes.get(t).type === 'file')));
  const cycles = findCycles(fileOnlyAdj);
  const inCycle = new Set(cycles.flat());

  const nodeList = [];
  for (const id of [...nodes.keys()].sort(cmp)) {
    const n = nodes.get(id);
    const sorted = (s) => [...s].sort(cmp);
    if (n.type === 'external') {
      nodeList.push({
        id,
        type: 'external',
        path: null,
        language: null,
        imports: [],
        importers: sorted(importersOf.get(id)),
        exports: [],
        consumers: sorted(consumersOf.get(id)),
        publicSurface: false,
        risk: null,
        fingerprint: null,
        metadata: { package: n.package },
      });
      continue;
    }
    const surface = surfaces.get(id) ?? { reasons: [], entryPoint: false };
    const nonTestDependents = [...consumersOf.get(id)].filter((s) => nodes.get(s)?.category !== 'test').length;
    const risk = evaluateRisk({
      id,
      category: n.category,
      language: n.language,
      supportsDependencies: n.supportsDependencies,
      parseStatus: n.parseStatus,
      surfaceReasons: surface.reasons,
      importerCount: nonTestDependents,
    });
    const analysis = n.category === 'test' || n.category === 'source' || n.category === 'generated'
      ? ({ parsed: 'analyzed', partial: 'partial', failed: 'failed', unsupported: 'none', 'skipped-too-large': 'skipped', 'n/a': 'n/a' }[n.parseStatus] ?? 'n/a')
      : 'n/a';
    nodeList.push({
      id,
      type: 'file',
      path: id,
      language: n.language,
      imports: sorted(importsOf.get(id)),
      importers: sorted(importersOf.get(id)),
      exports: sorted(n.exports),
      consumers: sorted(consumersOf.get(id)),
      publicSurface: surface.reasons.some((r) => r !== 'configured-entry'),
      risk: risk.level,
      fingerprint: n.fingerprint,
      metadata: {
        category: n.category,
        subsystem: subsystemOf(id, cfg),
        entryPoint: surface.entryPoint,
        publicSurfaceReasons: surface.reasons,
        riskBasis: risk.basis,
        parseStatus: n.parseStatus,
        dependencyAnalysis: analysis,
        inCycle: inCycle.has(id),
        externalImports: sorted(n.externalImports),
      },
    });
  }

  const edgeList = [...edges.values()].sort(
    (a, b) => cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.type, b.type) || cmp(a.kind, b.kind) || Number(!!a.typeOnly) - Number(!!b.typeOnly),
  );
  const fileNodes = nodeList.filter((n) => n.type === 'file');
  const languagesAnalyzed = sortedUnique(fileNodes.filter((n) => n.metadata.dependencyAnalysis === 'analyzed' || n.metadata.dependencyAnalysis === 'partial').map((n) => n.language));
  const metadataOnly = countBy(
    fileNodes.filter((n) => n.metadata.dependencyAnalysis === 'none' && n.language),
    (n) => n.language,
  );
  const packageManifest = scan.packages.get('package.json');
  diagnostics.sort((a, b) => cmp(a.path ?? '', b.path ?? '') || cmp(a.code, b.code) || cmp(a.message, b.message));

  const graph = {
    schema: 'erdem.graph',
    schemaVersion: SCHEMA.graph,
    tool: { name: TOOL.name, version: TOOL.version },
    generatedAt: now ?? scan.generatedAt,
    project: { name: packageManifest?.name ?? path.basename(scan.root) },
    configDigest: scan.configDigest,
    fingerprint: structureFingerprint(scan),
    stats: {
      nodes: nodeList.length,
      files: fileNodes.length,
      externals: nodeList.length - fileNodes.length,
      edges: edgeList.length,
      edgesByType: countBy(edgeList, (e) => e.type),
      cycles: cycles.length,
      unresolvedImports: unresolved.size,
      languagesAnalyzed,
      languagesMetadataOnly: metadataOnly,
    },
    cycles,
    nodes: nodeList,
    edges: edgeList,
  };
  return { graph, diagnostics };
}
