import path from 'node:path';
import { SCHEMA, TOOL, HASH_ALGO } from '../lib/constants.mjs';
import { buildCache, CACHE_FILE, INDEX_FILE, REPORT_FILE } from '../lib/cache.mjs';
import { setFingerprint } from '../lib/fingerprint.mjs';
import { stableStringify } from '../lib/json.mjs';
import { pruneDirectory, writeIfChanged, safeJoin } from '../lib/write.mjs';
import { directoryIndexRel, directorySummaryRel, fileSummaryRel } from '../lib/artifact-paths.mjs';
import { cmp, isUnder } from '../lib/util.mjs';
import { createGraphQuery } from '../analyze/query.mjs';
import { graphArtifacts, subsystemViewPath } from '../graph/outputs.mjs';
import { selectImportantDirectories, selectImportantFiles, membersOf } from './important.mjs';
import { renderAiIndex, renderDirectoryIndex, renderFileIndex } from './render.mjs';
import { directorySummary, fileSummary } from './summary.mjs';
import fs from 'node:fs';

/** Auto profile: the lightest set of artifacts that is still useful. Thresholds are configurable defaults. */
export function pickProfile(cfg, sourceFileCount, override) {
  const wanted = override ?? cfg.profile;
  if (wanted !== 'auto') return wanted;
  if (sourceFileCount <= cfg.profileThresholds.lite) return 'lite';
  if (sourceFileCount <= cfg.profileThresholds.standard) return 'standard';
  return 'full';
}

/**
 * Generate all derived artifacts into the output directory (never into source directories).
 * Unchanged artifacts are left byte-for-byte untouched. Returns a report of what happened.
 * `prune: false` (used by automatic refresh) skips the removal of generated artifacts that no longer apply, so
 * the run only creates or rewrites files and never deletes one.
 */
export function generateIndex({ scan, graph, graphDiagnostics = [], profile: profileOverride, now, prune = true }) {
  const cfg = scan.config;
  const root = scan.root;
  const out = cfg.outputDir;
  const generatedAt = now ?? scan.generatedAt;
  const query = createGraphQuery(graph);
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const fileMap = new Map(scan.files.map((f) => [f.path, f]));
  const hashByPath = new Map(scan.files.map((f) => [f.path, f.fingerprint.hash]));
  const sourceCount = graph.nodes.filter((n) => n.type === 'file' && n.metadata.category === 'source').length;
  const profile = pickProfile(cfg, sourceCount, profileOverride);
  const writes = {};
  const wanted = []; // artifacts that exist after this run, relative to the output directory

  const put = (rel, content, kind, schema) => {
    writes[`${out}/${rel}`] = writeIfChanged(root, `${out}/${rel}`, content);
    wanted.push({ path: rel, kind, schema });
  };

  const important = { files: selectImportantFiles(graph, cfg), dirs: selectImportantDirectories(graph, scan, cfg) };
  const wantDirs = profile === 'standard' || profile === 'full';
  const wantFull = profile === 'full';
  const dirTargets = important.dirs.map((d) => d.path);

  // graph artifacts
  for (const a of graphArtifacts(graph, cfg, { subsystemTargets: wantDirs ? dirTargets : [], query })) {
    put(a.path, a.content, a.path.endsWith('.json') ? 'graph (machine)' : a.path.endsWith('.mmd') ? 'graph (Mermaid)' : 'graph (Graphviz DOT)', a.path === 'graph/graph.json' ? `graph v${SCHEMA.graph}` : '');
  }

  // directory indexes
  const directoryIndexPaths = new Map();
  const summaryPaths = new Map();
  if (wantDirs) {
    for (const d of important.dirs) {
      const members = membersOf(graph, d.path);
      const fp = setFingerprint(members.filter((n) => n.metadata.category === 'source' || n.metadata.category === 'test').map((n) => ({ path: n.id, hash: hashByPath.get(n.id) ?? null })));
      const readme = scan.files.find((f) => path.posix.dirname(f.path) === d.path && /^README/i.test(path.posix.basename(f.path)) && f.hint);
      const pkg = scan.packages.get(`${d.path}/package.json`);
      const hint = readme?.hint ?? pkg?.description ?? null;
      const relatedDocs = scan.files.filter((f) => f.category === 'documentation' && isUnder(f.path, d.path) && f.path.split('/').length - d.path.split('/').length <= 2).map((f) => f.path).sort(cmp).slice(0, 5);
      const rel = directoryIndexRel(d.path);
      directoryIndexPaths.set(d.path, `${out}/${rel}`);
      const viewPath = subsystemViewPath(d.path);
      put(rel, renderDirectoryIndex({ dir: d.path, graph, scan, cfg, now: generatedAt, important, fingerprint: fp, viewPath, members, hint, relatedDocs }), 'directory index', `index v${SCHEMA.index}`);
    }
  }

  // summaries and file index
  if (wantFull) {
    const fileTargets = important.files.slice(0, cfg.summaries.max);
    for (const f of fileTargets) {
      const rel = fileSummaryRel(f.id);
      summaryPaths.set(f.id, rel);
      put(rel, stableStringify(fileSummary({ node: nodeMap.get(f.id), hint: fileMap.get(f.id)?.hint ?? null, now: generatedAt })), 'file summary', `summary v${SCHEMA.summary}`);
    }
    for (const d of important.dirs.slice(0, Math.max(0, cfg.summaries.max - fileTargets.length))) {
      const members = membersOf(graph, d.path);
      const readme = scan.files.find((f) => path.posix.dirname(f.path) === d.path && /^README/i.test(path.posix.basename(f.path)) && f.hint);
      const hint = readme?.hint ?? scan.packages.get(`${d.path}/package.json`)?.description ?? null;
      put(directorySummaryRel(d.path), stableStringify(directorySummary({ dir: d.path, members, nodeMap, hashByPath, hint, now: generatedAt })), 'directory summary', `summary v${SCHEMA.summary}`);
    }
    put('FILE_INDEX.md', renderFileIndex({ graph, important, now: generatedAt, summaryPaths, cfg }), 'file index', `index v${SCHEMA.index}`);
  }

  // machine index
  const allFiles = scan.files.map((f) => ({
    path: f.path,
    ext: f.ext,
    language: f.language,
    category: f.category,
    size: f.size,
    mtime: f.mtime,
    fingerprint: f.fingerprint,
  }));
  // run-dependent counters (cache hits) are reported to the caller, not persisted: persisted output must be idempotent
  const { parsedFresh: _fresh, parsedCached: _cached, ...persistedStats } = scan.stats;
  const indexJson = {
    schema: 'erdem.index',
    schemaVersion: SCHEMA.index,
    tool: { name: TOOL.name, version: TOOL.version },
    generatedAt,
    project: graph.project,
    configDigest: scan.configDigest,
    hashAlgo: HASH_ALGO,
    profile,
    fingerprint: setFingerprint(scan.files.map((f) => ({ path: f.path, hash: f.fingerprint.hash }))),
    structureFingerprint: graph.fingerprint,
    files: allFiles,
    directories: dirTargets,
    stats: persistedStats,
  };
  put(INDEX_FILE, stableStringify(indexJson), 'machine index', `index v${SCHEMA.index}`);

  // state (not listed as navigation artifacts)
  const allDiagnostics = [...scan.diagnostics, ...graphDiagnostics];
  const report = {
    schema: 'erdem.report',
    schemaVersion: SCHEMA.report,
    tool: { name: TOOL.name, version: TOOL.version },
    generatedAt,
    stats: { ...persistedStats, graph: graph.stats },
    diagnostics: allDiagnostics,
    withheld: scan.withheld,
    ignored: scan.ignored.slice(0, 200),
  };
  writes[`${out}/${REPORT_FILE}`] = writeIfChanged(root, `${out}/${REPORT_FILE}`, stableStringify(report));
  writes[`${out}/${CACHE_FILE}`] = writeIfChanged(root, `${out}/${CACHE_FILE}`, stableStringify(buildCache(scan, generatedAt)));

  // AI_INDEX last: it lists everything above
  if (profile !== 'none') {
    const artifacts = [...wanted].sort((a, b) => cmp(a.path, b.path)).filter((a) => !a.path.startsWith('graph/views/') && !a.path.startsWith('directories/') && !a.path.startsWith('summaries/'));
    if (directoryIndexPaths.size) artifacts.push({ path: 'directories/ (one DIRECTORY_INDEX.md per important directory)', kind: `${directoryIndexPaths.size} directory indexes`, schema: `index v${SCHEMA.index}` });
    if (summaryPaths.size || wantFull) artifacts.push({ path: 'summaries/ (JSON)', kind: 'summaries', schema: `summary v${SCHEMA.summary}` });
    const aiIndex = renderAiIndex({ scan, graph, cfg, profile, important, artifacts, now: generatedAt, directoryIndexPaths });
    writes[`${out}/AI_INDEX.md`] = writeIfChanged(root, `${out}/AI_INDEX.md`, aiIndex);
    wanted.push({ path: 'AI_INDEX.md', kind: 'navigation map' });
  }

  // remove generated artifacts that no longer apply (inside the output directory only)
  const keep = new Set(wanted.map((a) => `${out}/${a.path}`));
  const removed = prune
    ? [
        ...pruneDirectory(root, `${out}/directories`, keep, ['.md']),
        ...pruneDirectory(root, `${out}/summaries`, keep, ['.json']),
        ...pruneDirectory(root, `${out}/graph/views`, keep, ['.mmd', '.dot']),
      ]
    : [];
  for (const rel of ['FILE_INDEX.md', 'AI_INDEX.md']) {
    if (prune && !keep.has(`${out}/${rel}`)) {
      const abs = safeJoin(root, `${out}/${rel}`);
      if (fs.existsSync(abs)) {
        fs.rmSync(abs);
        removed.push(`${out}/${rel}`);
      }
    }
  }

  const counts = { created: 0, updated: 0, unchanged: 0 };
  for (const s of Object.values(writes)) counts[s]++;
  return { profile, outputDir: out, writes, counts, removed: removed.sort(), important: { files: important.files.length, directories: important.dirs.length }, diagnostics: allDiagnostics };
}
