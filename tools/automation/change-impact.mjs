/**
 * Automatic change impact orchestration (ai/CHANGE_IMPACT.md, ai/AUTOMATION_PROTOCOL.md → Change impact). Pure and
 * read-only: it receives an explicit change set, the session state of the intelligence and a graph query object, and returns
 * a bounded impact report. It reads no file, runs no query of its own, opens no secret, writes nothing and refreshes nothing.
 *
 * It orchestrates what exists and builds none of it again:
 *   the graph and its queries       tools/analyze/query.mjs (createGraphQuery, supplied by the caller), never a second graph
 *   risk and public surface         the engine's own per-node values (risk with its basis, publicSurface with its reasons)
 *   class, risk floors, validation  the context router (routeContext), the one place those rules live
 *   artifact names                  lib/artifact-paths.mjs
 *   the refresh decision            automation/refresh.mjs, called by the command, not here; this only names what to rely on
 *   tests                           never run: the report recommends, validation orchestration is a later step
 *
 * A graph is used only when it can be trusted for this change: a current graph artifact, or a graph the caller just built
 * from the current sources. Otherwise the report says so, lists bounded source searches instead, and never presents
 * graph-shaped results (ai/CONTEXT_PROTOCOL.md → Missing or stale context).
 */
import { slugPath, describeArtifactPath } from '../lib/artifact-paths.mjs';
import { subsystemOf } from '../lib/subsystem.mjs';
import { RoutingInputError, cleanPath, guardPaths, isSecretPath } from './path-safety.mjs';
import { actionRecord } from './records.mjs';
import { CLASSES, RELIANCE, RISKS, pathKey, platformIsCaseInsensitive } from './refresh-decision.mjs';
import { INTELLIGENCE_STATES, artifactTrust, routeContext } from './context-router.mjs';
import { SEARCH_FALLBACK } from './context-sources.mjs';

export { RoutingInputError };

export const CHANGE_STATUSES = Object.freeze(['created', 'modified', 'deleted', 'renamed']);

/**
 * Bounds of one report. No canonical document fixes numbers (ai/CONTEXT_PROTOCOL.md defines no token figure); these are
 * operational bounds of the implementation, chosen so that a report stays a short list in the spirit of
 * ai/TOKEN_EFFICIENCY.md ("neighbors of the target, never the whole graph"). Exceeding one is always reported.
 */
export const IMPACT_BOUNDS = Object.freeze({ changedFiles: 20, depth: 3, directDependents: 30, transitive: 40, tests: 20, surfaces: 20, cycleGroups: 5, searches: 12, dependencies: 30, fileDependents: 30, cycleMembers: 8, reopen: 6 });

/**
 * The convention of every impact report (one small rule, no state vocabulary of its own):
 *   null   unknown: not evaluated, because there was no graph evidence to evaluate it from
 *   []     known empty (the evidence was consulted and there is nothing)
 *   false / true   known
 * A consumer must treat null as "could not be determined", never as "none". The report's completeness says how far to trust it:
 *   COMPLETE          every list is whole
 *   BOUNDED_COMPLETE  the evidence was consulted, but a stated bound cut a list (see bounded)
 *   PARTIAL           some or all of the evidence could not be consulted (see limitations)
 */
export const IMPACT_CONVENTION = Object.freeze({ unknown: null, knownEmpty: [], completeness: ['COMPLETE', 'BOUNDED_COMPLETE', 'PARTIAL'] });

/** Categories whose content is part of the structure fingerprint of the engine (graph/build.mjs STRUCTURE_CATEGORIES). */
const STRUCTURE = new Set(['source', 'test', 'config', 'generated']);
/** Categories counted as members of a directory (index/status.mjs memberFp). */
const MEMBER = new Set(['source', 'test']);
const RISK_RANK = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 });
const unique = (xs) => [...new Set(xs)];
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const maxRisk = (a, b) => ((RISK_RANK[b] ?? 0) > (RISK_RANK[a] ?? 0) ? b : a);

/**
 * Public-surface reasons of the engine (graph/surface.mjs) that are evidence of an API or contract being involved. The
 * five dimensions are the ones of ai/CHANGE_IMPACT.md; evidence for them comes only from engine facts, the rest from the
 * caller's signals. Nothing is inferred from names.
 */
const API_REASONS = new Set(['package-entry', 'configured-entry', 'framework-route']);
const DIMENSIONS = Object.freeze([['configuration', 'configImpact'], ['api', 'apiImpact'], ['data', 'dataImpact'], ['platform', 'platformImpact'], ['designSystem', 'designSystemImpact']]);

// ---- the change set ---------------------------------------------------------------------------------------------

/**
 * A change set is explicit: { phase, files: [{ path, status, from? }], taskClass, risk, taskTypes, signals }.
 * Statuses: created, modified, deleted, renamed (renamed needs the old path in \`from\`: a rename is never inferred).
 * Secret-pattern paths are withheld and never analyzed. Only the first IMPACT_BOUNDS.changedFiles are analyzed, in the
 * caller's order (taken as priority); the rest are reported for batching, never dropped silently.
 */
export function normalizeChangeSet(cs = {}, caseInsensitive = platformIsCaseInsensitive()) {
  const phase = cs.phase === 'planned' ? 'planned' : 'completed';
  if (!Array.isArray(cs.files) || !cs.files.length) throw new RoutingInputError('a change set needs at least one file: { path, status }');
  const seen = new Set();
  const files = [];
  const withheld = [];
  for (const raw of cs.files) {
    if (!CHANGE_STATUSES.includes(raw?.status)) throw new RoutingInputError(`unknown change status "${raw?.status}" (known: ${CHANGE_STATUSES.join(', ')})`);
    const file = { path: cleanPath(raw.path), status: raw.status };
    if (raw.status === 'renamed') {
      if (!raw.from) throw new RoutingInputError('a renamed file needs its old path (from): renames are never inferred');
      file.from = cleanPath(raw.from);
      if (file.from === file.path) throw new RoutingInputError('a rename needs two different paths');
    } else if (raw.from !== undefined) throw new RoutingInputError('only a renamed file has a from path');
    const key = `${file.status}:${file.from ? pathKey(file.from, caseInsensitive) : ''}>${pathKey(file.path, caseInsensitive)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isSecretPath(file.path) || (file.from && isSecretPath(file.from))) {
      withheld.push(isSecretPath(file.path) ? file.path : file.from);
      continue;
    }
    files.push(file);
  }
  // A path is claimed by at most one entry, whether it is that entry's path or the old path a rename vacates (compared the way the
  // file system compares): this rejects a file that is modified and renamed away, a rename swap or chain, two renames from or to
  // one path, and names that differ only in case on a case-insensitive system.
  const claimed = new Map();
  files.forEach((file, i) => {
    for (const p of file.from ? [file.from, file.path] : [file.path]) {
      const k = pathKey(p, caseInsensitive);
      if (claimed.has(k) && claimed.get(k) !== i) throw new RoutingInputError(`"${p}" appears with two statuses or roles in the change set`);
      claimed.set(k, i);
    }
  });
  return { phase, files: files.slice(0, IMPACT_BOUNDS.changedFiles), remaining: files.slice(IMPACT_BOUNDS.changedFiles), withheld };
}

// ---- helpers ----------------------------------------------------------------------------------------------------

function subsystemTally(ids, nodeOf) {
  const out = {};
  for (const id of ids) {
    const s = nodeOf(id)?.metadata?.subsystem ?? '.';
    out[s] = (out[s] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => cmp(a, b)));
}

/**
 * Which engine artifact kinds a change makes stale, by the engine's own staleness rules (index/status.mjs, calibrated against
 * a real status run in the tests): the machine index lists every file, so any change makes it stale; the graph and the
 * navigation and file indexes follow the structure fingerprint (source, test, config and generated files); directory
 * indexes and directory summaries follow their member files (source and test); file summaries follow their own file.
 * A file whose category is unknown (a created file the caller did not classify) is treated as affecting everything.
 * Kinds that are missing, not expected or unverifiable keep that state: nothing is invented for them.
 */
export function predictIntelligenceImpact(files, intel, artifacts, categoryOf = () => null) {
  const rows = files.map((f) => {
    const cat = categoryOf(f.from ?? f.path) ?? categoryOf(f.path);
    return { f, cat, structure: cat === null || STRUCTURE.has(cat), member: cat === null || MEMBER.has(cat), summary: cat === null || MEMBER.has(cat) || cat === 'config' };
  });
  const will = { graph: rows.some((r) => r.structure), index: rows.length > 0, fileIndex: rows.some((r) => r.structure), directoryIndex: rows.some((r) => r.member), summary: rows.some((r) => r.summary) };
  const out = {};
  for (const kind of Object.keys(will)) {
    const s = intel.states[kind];
    out[kind] = s === 'current' ? (will[kind] ? 'stale' : 'current') : s;
  }
  // Per-source artifacts: only the ones whose source directory or file contains a touched path.
  const affected = [];
  for (const a of artifacts ?? []) {
    const d = describeArtifactPath(a.outputDir ?? '.ai', a.path);
    if (!d) continue;
    for (const r of rows) {
      const slugs = (r.f.from ? [r.f.from, r.f.path] : [r.f.path]).map((p) => slugPath(p));
      if (d.type === 'file-summary' ? r.summary && slugs.includes(d.covers) : r.member && slugs.some((x) => x === d.covers || x.startsWith(`${d.covers}/`))) {
        affected.push(a.path);
        break;
      }
    }
  }
  return { states: out, affectedArtifacts: unique(affected).sort(cmp) };
}

/**
 * Bounded source inspection used instead of graph results when the graph cannot be trusted for this change. A file is either
 * covered by both of its searches or not at all, and the files left out are named, never dropped silently.
 */
function inspectionPlan(files) {
  const ops = [];
  const covered = [];
  const notCovered = [];
  for (const f of files) {
    if (f.status === 'created') continue;
    const target = f.from ?? f.path;
    if (ops.length + 2 <= IMPACT_BOUNDS.searches) {
      ops.push({ op: 'find-consumers', target, via: 'search', effect: 'read-only', how: SEARCH_FALLBACK.dependents });
      ops.push({ op: 'find-tests', target, via: 'search', effect: 'read-only', how: SEARCH_FALLBACK.tests });
      covered.push(target);
    } else notCovered.push(target);
  }
  return { ops, covered, notCovered };
}

/** Removes any secret-pattern path from the finished report, whatever put it there (the one shared filter). The withheld list itself names paths only. */
function scrubSecretPaths(value, key = '') {
  let removed = 0;
  const PATHY = new Set(['path', 'from', 'to', 'target', 'id']);
  const walk = (v, k) => {
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) {
        if (typeof x === 'string' && isSecretPath(x)) removed++;
        else if (x && typeof x === 'object' && [x.path, x.from, x.to, x.target].some((p) => typeof p === 'string' && isSecretPath(p))) removed++;
        else out.push(walk(x, k));
      }
      return out;
    }
    if (v && typeof v === 'object') {
      const out = {};
      for (const [kk, vv] of Object.entries(v)) {
        if (kk === 'withheld') out[kk] = vv;
        else if (PATHY.has(kk) && typeof vv === 'string' && isSecretPath(vv)) {
          removed++;
          out[kk] = null;
        } else out[kk] = walk(vv, kk);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value, key), removed };
}

// ---- the analysis -----------------------------------------------------------------------------------------------

/**
 * @param {object} changeSet   see normalizeChangeSet
 * @param {object} intelligence { state, artifacts? } the session state and optional per-kind states (as for routeContext)
 * @param {object} project     { query, graphSource ('fresh-build' when the caller just built the graph), artifacts (status list, optional),
 *                               categories ({ path: category } for files the graph does not know, from the engine's classifier),
 *                               subsystemRoots (the engine's configured container directories, for files the graph does not know),
 *                               reached, loaded, answers, known: { dependents, tests }, caseInsensitive }
 *
 * Every list that depends on graph evidence is null when that evidence could not be consulted (see IMPACT_CONVENTION), and every
 * list that a bound can cut says so in bounded (limit, total, returned, omitted, truncated).
 */
export function analyzeChangeImpact(changeSet, intelligence = {}, project = {}) {
  const ci = project.caseInsensitive ?? platformIsCaseInsensitive();
  const cs = normalizeChangeSet(changeSet, ci);
  const intel = artifactTrust(intelligence);
  const query = project.query ?? null;
  const inputSignals = changeSet.signals ?? {};
  if (changeSet.taskClass != null && !CLASSES.includes(changeSet.taskClass)) throw new RoutingInputError('unknown task class "' + changeSet.taskClass + '"');
  if (changeSet.risk != null && !RISKS.includes(changeSet.risk)) throw new RoutingInputError('unknown risk "' + changeSet.risk + '"');

  // Nothing visible to analyze: every requested path was withheld as a secret path. That is not "a trivial change".
  const allWithheld = cs.files.length === 0;
  const graphBasis = allWithheld ? null : query && project.graphSource === 'fresh-build' ? 'fresh build from the current sources' : query && intel.trust.graph === 'trusted' ? 'graph artifact (current)' : null;
  const known = !!graphBasis;
  const K = (v) => (known ? v : null);
  const nodeOf = (id) => (query ? query.getNode(id) : null);
  const changedKeys = new Set(cs.files.flatMap((f) => [pathKey(f.path, ci), ...(f.from ? [pathKey(f.from, ci)] : [])]));
  const isChanged = (id) => changedKeys.has(pathKey(id, ci));
  const limitations = [];
  if (cs.remaining.length) limitations.push(cs.remaining.length + ' more changed file(s) are not analyzed (limit ' + IMPACT_BOUNDS.changedFiles + '): analyze them in batches by subsystem');
  if (cs.withheld.length) limitations.push(cs.withheld.length + ' changed path(s) match secret patterns and were not analyzed');
  if (allWithheld) limitations.push('every requested path was withheld as a secret path: no impact could be evaluated from them, and validation is not V0 merely because no visible file remains (the router\'s unclassified minimum applies)');
  if (changeSet.taskClass == null) limitations.push('no task class was given: the router\'s unclassified minimum applies (validation V1 at least); state a class to refine it');

  // Per changed file: what the graph knows about it.
  const changed = [];
  const agg = new Map(); // dependents of any changed file: id -> { id, distance (the nearest), via (which changed files) }
  const dependencies = new Set();
  const unknown = [];
  const unanalyzed = []; // changed files whose language has no dependency analysis: their dependents are unknown, never "none"
  const renames = [];
  const deletions = [];
  for (const f of cs.files) {
    const ref = f.from ?? f.path;
    const entry = { path: f.path, status: f.status, ...(f.from ? { from: f.from } : {}), known: null, category: null, language: null, publicSurface: null, publicSurfaceReasons: null, risk: null, inCycle: null };
    let all = null; // direct dependents of a deleted or renamed file; null = unknown
    let source = null;
    let note = null;
    if (graphBasis) {
      entry.known = false;
      let imp = query.getImpact(ref, { maxDepth: IMPACT_BOUNDS.depth });
      let lookup = 'path';
      // A rename already applied: the graph holds only the new path. Its dependents are facts about the new path, not about the old one.
      if (!imp.found && f.status === 'renamed') {
        const alt = query.getImpact(f.path, { maxDepth: IMPACT_BOUNDS.depth });
        if (alt.found) {
          imp = alt;
          lookup = 'new-path';
        }
      }
      if (imp.found) {
        const node = nodeOf(imp.target);
        Object.assign(entry, { known: true, ...(lookup === 'new-path' ? { lookup } : {}), category: node?.metadata?.category ?? null, language: imp.language ?? null, publicSurface: !!imp.publicSurface, publicSurfaceReasons: imp.publicSurfaceReasons ?? [], risk: imp.risk.level ?? null, inCycle: !!imp.inCycle });
        for (const n of imp.notes.filter((x) => /no dependency analysis|partially parsed/.test(x))) limitations.push(entry.path + ': ' + n);
        if (imp.notes.some((x) => /no dependency analysis/.test(x))) {
          entry.analysis = 'none';
          unanalyzed.push(f);
          unknown.push(f);
          limitations.push(entry.path + ': no dependency analysis for ' + (imp.language ?? 'this language') + ': the files and tests that import it are unknown (not "none")');
        }
        for (const d of imp.affected) {
          if (isChanged(d.id)) continue;
          const prev = agg.get(d.id) ?? { id: d.id, distance: d.distance, via: new Set() };
          prev.via.add(f.path);
          prev.distance = Math.min(prev.distance, d.distance);
          agg.set(d.id, prev);
        }
        for (const d of imp.dependencies) dependencies.add(d);
        all = imp.directDependents;
        source = lookup === 'new-path' ? 'new-path' : 'old-path';
        if (f.status === 'deleted') note = 'dependents of the deleted file will have unresolved imports';
        if (f.status === 'renamed') {
          note = lookup === 'new-path' ? 'the graph does not contain the old path (the rename is already applied): these are the dependents of the new path, not facts about the old one' : 'dependents of the old path need their import paths updated';
          if (lookup === 'new-path') limitations.push(f.from + ' -> ' + f.path + ': the rename is already applied; dependents are those of the new path');
        }
      } else {
        unknown.push(f);
        if (f.status === 'deleted') note = 'the graph no longer contains this file: its former dependents are unknown (search for its path)';
        if (f.status === 'renamed') note = 'neither the old nor the new path is in the graph: the dependents are unknown (search for the old path)';
      }
      if (f.status === 'renamed' && entry.lookup !== 'new-path') {
        const newNode = nodeOf(f.path);
        if (newNode) for (const d of query.getDependencies(f.path)) dependencies.add(d);
      }
    } else {
      unknown.push(f);
      if (f.status === 'deleted') note = 'graph not used: the dependents of this file are unknown (search for its path)';
      if (f.status === 'renamed') note = 'graph not used: the dependents of the old path are unknown (search for it)';
    }
    if (f.status === 'deleted') deletions.push({ path: f.path, all, source, note });
    if (f.status === 'renamed') renames.push({ from: f.from, to: f.path, all, source, note });
    changed.push(entry);
  }
  const nonCreatedUnknown = unknown.filter((f) => f.status !== 'created');
  const unanalyzedNonCreated = unanalyzed.filter((f) => f.status !== 'created');
  // When no changed file could be analyzed, every dependents-derived list is unknown (null), not an empty list.
  const depsKnown = known && !(unanalyzedNonCreated.length > 0 && cs.files.filter((f) => f.status !== 'created').every((f) => unknown.includes(f)));
  const KD = (v) => (depsKnown ? v : null);
  if (!graphBasis) {
    if (!allWithheld) limitations.push(intel.trust.graph === 'hint' || intel.states.graph === 'stale' ? 'the graph artifact is stale: no graph result is presented as current' : 'no usable graph (' + intel.states.graph + '): bounded source searches are listed instead of graph results');
    limitations.push('graph evidence was not consulted: every graph-derived field is null (unknown), which does not mean "none"');
  } else if (nonCreatedUnknown.length - unanalyzedNonCreated.length > 0) limitations.push((nonCreatedUnknown.length - unanalyzedNonCreated.length) + ' changed file(s) are not in the graph: search for their consumers');
  limitations.push('file-level analysis: which exported names a dependent uses is not resolved, so the impact is a superset of the real impact');

  // The bound of one list: how much exists, how much is shown, how much is left out. Never silent.
  const bound = (limit, total, returned, extra = {}) => ({ limit, total, returned, omitted: total - returned, truncated: total > returned, ...extra });
  const unknownBound = (limit, extra = {}) => ({ limit, total: null, returned: null, omitted: null, truncated: null, ...extra });
  const LABEL = { dependencies: 'direct dependencies', tests: 'affected tests', surfaces: 'affected public surfaces', cycleAffected: 'affected cycle members', cycleGroups: 'cycle groups', cycleMembers: 'cycle members', deletedDependents: 'dependents of deleted files', renamedDependents: 'dependents of renamed files', reopenDependents: 'dependents proposed for reopening' };

  // Ordering and bounds (deterministic priority: nearer first, public surface first, higher risk first, then path).
  const prio = (a, b) => a.distance - b.distance || (nodeOf(b.id)?.publicSurface ? 1 : 0) - (nodeOf(a.id)?.publicSurface ? 1 : 0) || (RISK_RANK[nodeOf(b.id)?.risk] ?? 0) - (RISK_RANK[nodeOf(a.id)?.risk] ?? 0) || cmp(a.id, b.id);
  const describe = (r) => ({ path: r.id, distance: r.distance, via: [...r.via].sort(cmp), publicSurface: !!nodeOf(r.id)?.publicSurface, risk: nodeOf(r.id)?.risk ?? null, category: nodeOf(r.id)?.metadata?.category ?? null, inCycle: !!nodeOf(r.id)?.metadata?.inCycle });
  const guardedList = (rows) => rows.filter((r) => !isSecretPath(r.id));
  const allRows = guardedList([...agg.values()]);
  const dRows = allRows.filter((r) => r.distance === 1).sort(prio);
  const tRows = allRows.filter((r) => r.distance > 1).sort(prio);
  const direct = new Map(dRows.map((r) => [r.id, r]));
  const trans = new Map(tRows.map((r) => [r.id, r]));
  const testMap = new Map(allRows.filter((r) => nodeOf(r.id)?.metadata?.category === 'test').map((r) => [r.id, r]));
  const surfacesAffected = new Set(allRows.filter((r) => nodeOf(r.id)?.publicSurface).map((r) => r.id));
  let maxAffectedRisk = null;
  for (const r of allRows) if (RISK_RANK[nodeOf(r.id)?.risk]) maxAffectedRisk = maxRisk(maxAffectedRisk, nodeOf(r.id).risk);
  const directReturned = dRows.slice(0, IMPACT_BOUNDS.directDependents);
  const transReturned = tRows.slice(0, IMPACT_BOUNDS.transitive);
  const dRest = dRows.slice(directReturned.length).map((r) => r.id);
  const tRest = tRows.slice(transReturned.length).map((r) => r.id);
  const bounded = {
    changedFiles: { limit: IMPACT_BOUNDS.changedFiles, analyzed: cs.files.length, remaining: cs.remaining.length, omitted: cs.remaining.length, truncated: cs.remaining.length > 0 },
    depth: IMPACT_BOUNDS.depth,
    directDependents: depsKnown ? { ...bound(IMPACT_BOUNDS.directDependents, dRows.length, directReturned.length), remainingBySubsystem: subsystemTally(dRest, nodeOf) } : unknownBound(IMPACT_BOUNDS.directDependents, { remainingBySubsystem: null }),
    transitive: depsKnown ? { ...bound(IMPACT_BOUNDS.transitive, tRows.length, transReturned.length), depthLimited: tRows.some((r) => r.distance >= IMPACT_BOUNDS.depth), remainingBySubsystem: subsystemTally(tRest, nodeOf) } : unknownBound(IMPACT_BOUNDS.transitive, { depthLimited: null, remainingBySubsystem: null }),
  };
  if (bounded.directDependents.truncated) limitations.push(dRest.length + ' more direct dependent(s) are not listed (limit ' + IMPACT_BOUNDS.directDependents + '): analyze by subsystem (remainingBySubsystem)');
  if (bounded.transitive.truncated) limitations.push(tRest.length + ' more transitive dependent(s) are not listed (limit ' + IMPACT_BOUNDS.transitive + '): analyze by subsystem (remainingBySubsystem)');
  if (bounded.transitive.depthLimited) limitations.push('transitive impact is followed ' + IMPACT_BOUNDS.depth + ' levels deep; consumers beyond that are not listed');

  // Direct dependencies of the changed files.
  const depsAll = [...dependencies].filter((p) => !isSecretPath(p)).sort(cmp);
  const depsReturned = depsAll.slice(0, IMPACT_BOUNDS.dependencies);
  bounded.dependencies = known ? bound(IMPACT_BOUNDS.dependencies, depsAll.length, depsReturned.length) : unknownBound(IMPACT_BOUNDS.dependencies);

  // Deleted and renamed files: their dependents, bounded per file and in total, in a deterministic order.
  const fileDependents = (all) => {
    if (all === null) return { dependents: null, dependentsTotal: null, dependentsOmitted: null };
    const rows = unique(all.filter((x) => !isChanged(x) && !isSecretPath(x))).sort(cmp);
    const ret = rows.slice(0, IMPACT_BOUNDS.fileDependents);
    return { dependents: ret, dependentsTotal: rows.length, dependentsOmitted: rows.length - ret.length };
  };
  const finishFile = (e) => {
    const { all, ...rest } = e;
    return { ...rest, ...fileDependents(all) };
  };
  const deletionsOut = deletions.map((d) => ({ path: d.path, dependentsSource: d.source, ...finishFile(d) })).map(({ source, all, ...x }) => x);
  const renamesOut = renames.map((r) => ({ from: r.from, to: r.to, dependentsSource: r.source, ...finishFile(r) })).map(({ source, all, ...x }) => x);
  const sumBound = (rows, limit) => {
    const t = rows.filter((r) => r.dependentsTotal !== null);
    const total = t.reduce((a, r) => a + r.dependentsTotal, 0);
    const returned = t.reduce((a, r) => a + r.dependents.length, 0);
    return rows.length && t.length ? { ...bound(limit, total, returned), files: rows.length } : rows.length ? unknownBound(limit, { files: rows.length }) : { ...bound(limit, 0, 0), files: 0 };
  };
  bounded.deletedDependents = sumBound(deletionsOut, IMPACT_BOUNDS.fileDependents);
  bounded.renamedDependents = sumBound(renamesOut, IMPACT_BOUNDS.fileDependents);

  // Tests: directly related (they depend on a changed file) and consumer tests (they depend on something that does).
  const tests = guardedList([...testMap.values()]).sort((a, b) => a.distance - b.distance || cmp(a.id, b.id));
  const directTestsAll = tests.filter((t) => t.distance === 1).map((t) => t.id);
  const consumerTestsAll = tests.filter((t) => t.distance > 1).map((t) => t.id);
  const directTests = directTestsAll.slice(0, IMPACT_BOUNDS.tests);
  const consumerTests = consumerTestsAll.slice(0, Math.max(0, IMPACT_BOUNDS.tests - directTests.length));
  const testsBound = known
    ? { ...bound(IMPACT_BOUNDS.tests, directTestsAll.length + consumerTestsAll.length, directTests.length + consumerTests.length), directCount: directTestsAll.length, consumerCount: consumerTestsAll.length }
    : unknownBound(IMPACT_BOUNDS.tests, { directCount: null, consumerCount: null });
  bounded.tests = testsBound;
  const testsKnown = new Set((project.known?.tests ?? []).map((p) => pathKey(p, ci)));

  // Public surface, cycles, dimensions.
  const changedSurfaces = changed.filter((c) => c.publicSurface).map((c) => ({ path: c.path, reasons: c.publicSurfaceReasons }));
  const surfacesAll = [...surfacesAffected].filter((p) => !isSecretPath(p)).sort(cmp);
  const affectedSurfaceList = surfacesAll.slice(0, IMPACT_BOUNDS.surfaces);
  bounded.surfaces = known ? bound(IMPACT_BOUNDS.surfaces, surfacesAll.length, affectedSurfaceList.length) : unknownBound(IMPACT_BOUNDS.surfaces);
  const cycleGroups = known ? query.getCycles().map((g) => g.filter((id) => !isSecretPath(id))) : null;
  let cyclesOut = { changed: null, affected: null, groups: null };
  if (known) {
    const inCycleIds = new Set(cycleGroups.flat());
    const affectedCycle = unique([...dRows, ...tRows].filter((r) => inCycleIds.has(r.id)).map((r) => r.id)).sort(cmp);
    const groupsAll = cycleGroups.filter((g) => g.some((id) => isChanged(id) || direct.has(id) || trans.has(id)));
    const groupsReturned = groupsAll.slice(0, IMPACT_BOUNDS.cycleGroups);
    const members = groupsReturned.map((g) => [...g].sort(cmp));
    cyclesOut = { changed: changed.filter((c) => c.inCycle).map((c) => c.path).sort(cmp), affected: affectedCycle.slice(0, IMPACT_BOUNDS.surfaces), groups: members.map((g) => g.slice(0, IMPACT_BOUNDS.cycleMembers)) };
    bounded.cycleAffected = bound(IMPACT_BOUNDS.surfaces, affectedCycle.length, cyclesOut.affected.length);
    bounded.cycleGroups = bound(IMPACT_BOUNDS.cycleGroups, groupsAll.length, groupsReturned.length);
    bounded.cycleMembers = bound(IMPACT_BOUNDS.cycleMembers, members.reduce((a, g) => a + g.length, 0), cyclesOut.groups.reduce((a, g) => a + g.length, 0));
  } else {
    bounded.cycleAffected = unknownBound(IMPACT_BOUNDS.surfaces);
    bounded.cycleGroups = unknownBound(IMPACT_BOUNDS.cycleGroups);
    bounded.cycleMembers = unknownBound(IMPACT_BOUNDS.cycleMembers);
  }

  // The five dimensions: a caller's signal is known whatever the graph says; engine evidence needs the graph; with neither, unknown.
  const dimensions = {};
  for (const [name, flag] of DIMENSIONS) {
    const evidence = [];
    if (known) {
      if (name === 'configuration') for (const c of changed) if (c.category === 'config' || (c.publicSurfaceReasons ?? []).includes('global-config')) evidence.push(c.path);
      if (name === 'api') for (const c of changed) if ((c.publicSurfaceReasons ?? []).some((r) => API_REASONS.has(r))) evidence.push(c.path);
    }
    const signal = !!inputSignals[flag];
    if (known) dimensions[name] = { present: signal || evidence.length > 0, source: signal && evidence.length ? 'both' : signal ? 'signal' : evidence.length ? 'evidence' : 'none', evidence: unique(evidence).sort(cmp) };
    else dimensions[name] = { present: signal ? true : null, source: signal ? 'signal' : 'unknown', evidence: null };
  }

  // Risk and validation come from the router, the one place those rules live.
  const engineRisk = changed.reduce((r, c) => maxRisk(r, c.risk), null);
  const risk0 = maxRisk(changeSet.risk ?? 'LOW', engineRisk ?? 'LOW');
  // The canonical subsystem: the engine's own key (the graph's node metadata, else subsystemOf with the configured roots), never directories.
  const subOf = (p) => nodeOf(p)?.metadata?.subsystem ?? (project.subsystemRoots ? subsystemOf(p, { subsystemRoots: project.subsystemRoots }) : null);
  const subsystemsOfChange = unique(cs.files.flatMap((f) => [subOf(f.path), f.from ? subOf(f.from) : null]).filter(Boolean));
  const signals = {
    ...inputSignals,
    // ai/CHANGE_IMPACT.md: a change TO a public surface sets its floors (risk at least MEDIUM, class at least MEDIUM). A public
    // surface that merely depends on the change is reported and widens test recommendations, but does not reclassify the task.
    ...(changedSurfaces.length ? { publicSurface: true } : {}),
    ...(subsystemsOfChange.length > 1 ? { crossSubsystem: true } : {}),
    ...(!graphBasis || nonCreatedUnknown.length ? { dependencyUncertain: true } : {}),
    ...(dimensions.configuration.present && (changeSet.taskTypes ?? []).includes('configuration') ? { buildOrRuntime: inputSignals.buildOrRuntime ?? true } : {}),
  };
  const existing = changed.filter((c) => c.status !== 'deleted').map((c) => c.path);
  const reopenAll = dRows.map((r) => r.id);
  const reopenReturned = reopenAll.slice(0, IMPACT_BOUNDS.reopen);
  bounded.reopenDependents = known ? bound(IMPACT_BOUNDS.reopen, reopenAll.length, reopenReturned.length, { informational: true }) : unknownBound(IMPACT_BOUNDS.reopen, { informational: true });
  // The class is never invented: an omitted class is unclassified (the router's own minimum, V1), not TRIVIAL (V0). When every path was
  // withheld, a stated TRIVIAL does not lower the minimum either.
  const given = changeSet.taskClass ?? null;
  const routeClass = allWithheld && (given === null || given === 'TRIVIAL') ? null : given;
  // The router must see the graph actually used: a graph built now is current for this change whatever the artifact says.
  const routeIntel = graphBasis && project.graphSource === 'fresh-build' ? { ...intelligence, artifacts: { ...(intelligence.artifacts ?? {}), graph: 'current' } } : intelligence;
  const route = routeContext(
    { taskClass: routeClass, risk: risk0, taskTypes: changeSet.taskTypes ?? [], targets: existing, signals, intent: 'change', event: 'CONTEXT_EXPANDED' },
    routeIntel,
    { reached: Number.isInteger(project.reached) ? project.reached : 3, loaded: project.loaded, answers: project.answers, caseInsensitive: ci },
  );
  const risk = { level: route.risk, basis: [], raisedBy: [] };
  if (engineRisk) risk.basis.push('engine risk of the changed files: ' + engineRisk);
  if (changeSet.risk) risk.basis.push('stated risk: ' + changeSet.risk);
  if (changedSurfaces.length) risk.raisedBy.push('a changed file is a public surface (ai/CHANGE_IMPACT.md: at least MEDIUM)');
  if (maxAffectedRisk) risk.propagation = { maxRiskAmongDependents: maxAffectedRisk, applied: false, note: 'advisory: the canonical rules do not raise a change\'s risk by its dependents\' risk' };
  if (!graphBasis) risk.pending = 'if targeted search cannot determine the impact, treat the risk as one level higher and say why (ai/CHANGE_IMPACT.md)';
  const classAtLeastMedium = route.class && CLASSES.indexOf(route.class) >= CLASSES.indexOf('MEDIUM');
  const justifiedConsumerTests = signals.publicSurface || surfacesAll.length > 0 || RISK_RANK[route.risk] >= RISK_RANK.MEDIUM || classAtLeastMedium;
  const requiredValidation = {
    depth: route.validationNeeds.depth,
    basis: route.validationNeeds.basis,
    broader: ['V3', 'V4'].includes(route.validationNeeds.depth),
    tests: { direct: KD(directTests), consumer: depsKnown ? (justifiedConsumerTests ? consumerTests : []) : null, consumerJustified: known ? !!justifiedConsumerTests : justifiedConsumerTests ? true : null, truncated: testsBound.truncated },
    note: 'a recommendation only: no command is chosen and nothing is run (ai/VALIDATION_PROTOCOL.md: commands come from the project)',
  };

  // Intelligence: which artifacts the change makes stale.
  const categoryOf = (p) => nodeOf(p)?.metadata?.category ?? project.categories?.[p] ?? null;
  const predicted = predictIntelligenceImpact(cs.files, intel, project.artifacts, categoryOf);
  const reliesOn = (graphBasis ? [] : ['impact', 'dependents']).filter((t) => RELIANCE[t]);
  const refresh = cs.phase === 'completed' && (!graphBasis || predicted.states.graph === 'stale') && ['stale', 'partial', 'missing'].includes(intel.state) ? { consider: 'project-intel refresh', reliesOn: reliesOn.length ? reliesOn : ['impact'], note: 'the refresh decision is separate (ai/AUTOMATION_PROTOCOL.md); impact analysis does not refresh' } : null;

  // Context to reopen, through the canonical router.
  const newDependents = reopenAll.filter((id) => !(project.loaded ?? []).some((l) => pathKey(l.path, ci) === pathKey(id, ci)));
  const reopenReasons = [];
  if (newDependents.length) reopenReasons.push('new-dependents');
  if (changedSurfaces.length || surfacesAll.length) reopenReasons.push('public-surface');
  for (const [name] of DIMENSIONS) if (dimensions[name].present) reopenReasons.push('dimension:' + name);
  if (RISK_RANK[route.risk] > RISK_RANK[changeSet.risk ?? 'LOW']) reopenReasons.push('risk-raised');
  if ([...testMap.keys()].some((t) => !testsKnown.has(pathKey(t, ci)))) reopenReasons.push('tests-expanded');
  if (graphBasis && nonCreatedUnknown.length) reopenReasons.push('files-not-in-graph');
  if (!graphBasis) reopenReasons.push(allWithheld ? 'all-withheld' : 'graph-untrusted');
  const requiredContext = reopenReasons.length
    ? { justified: true, reasons: unique(reopenReasons), reopen: guardPaths(reopenReturned).ok, plan: { level: route.level, minimumLevel: route.minimumLevel, ceiling: route.ceiling, requiredSources: route.requiredSources, requiredQueries: route.requiredQueries, optionalQueries: route.optionalQueries, reasons: route.reasons, evaluation: route.evaluation } }
    : { justified: false, reasons: [], reopen: [], plan: null };

  // Inspection (when evidence is missing): bounded, with the files it does not cover named.
  const inspect = !graphBasis ? inspectionPlan(cs.files) : nonCreatedUnknown.length ? inspectionPlan(nonCreatedUnknown) : { ops: [], covered: [], notCovered: [] };
  bounded.inspection = {
    limit: IMPACT_BOUNDS.searches,
    searches: inspect.ops.length,
    total: inspect.covered.length + inspect.notCovered.length,
    returned: inspect.covered.length,
    omitted: inspect.notCovered.length,
    truncated: inspect.notCovered.length > 0,
    filesInspected: inspect.covered,
    filesNotInspected: inspect.notCovered,
    confidenceImpact: inspect.notCovered.length ? 'files that are neither in the graph nor inspected are unknown: the result is partial for them' : 'none beyond the graph state',
  };

  // Every truncation is reported, in words and in the totals. The reopen list is informational: its items are all in directImpact.
  for (const [k, label] of Object.entries(LABEL)) if (bounded[k]?.truncated) limitations.push(bounded[k].omitted + ' more ' + label + ' are not listed (limit ' + bounded[k].limit + ')' + (k === 'reopenDependents' ? ': the full list is directImpact.dependents' : ''));
  if (bounded.inspection.truncated) limitations.push(inspect.notCovered.length + ' changed file(s) are not inspected (search limit ' + IMPACT_BOUNDS.searches + '): inspect them in batches');
  const truncatedLists = Object.entries(bounded).filter(([, v]) => v && typeof v === 'object' && v.truncated === true).map(([k]) => k).sort(cmp);
  const evidenceTruncated = truncatedLists.filter((k) => !bounded[k].informational);
  bounded.truncatedLists = truncatedLists;
  bounded.batchingRequired = evidenceTruncated.length > 0;

  // COMPLETE (every list whole), BOUNDED_COMPLETE (consulted, but a bound cut a list) or PARTIAL (evidence not consulted).
  const completeness = !graphBasis || nonCreatedUnknown.length ? 'PARTIAL' : evidenceTruncated.length || bounded.transitive.depthLimited ? 'BOUNDED_COMPLETE' : 'COMPLETE';
  const confidence = !graphBasis ? 'low' : completeness !== 'COMPLETE' || limitations.some((l) => /no dependency analysis|partially parsed/.test(l)) ? 'medium' : 'high';

  const out = {
    version: 1,
    phase: cs.phase,
    completeness,
    evidence: { convention: 'null = unknown (not evaluated), [] = known empty, false/true = known', graph: known ? 'known' : 'unknown', evaluated: known, allWithheld },
    changedFiles: changed,
    unanalyzed: unanalyzed.map((f) => f.path),
    batching: { required: bounded.batchingRequired, remainingChangedFiles: cs.remaining.length, truncatedLists: evidenceTruncated },
    graph: { used: known, basis: graphBasis, state: intel.state, artifact: intel.states.graph },
    directImpact: { dependents: KD(directReturned.map(describe)), dependencies: KD(depsReturned), tests: KD(directTests), publicSurface: K(changedSurfaces) },
    transitiveImpact: { dependents: KD(transReturned.map(describe)), depth: IMPACT_BOUNDS.depth },
    affectedTests: depsKnown ? { direct: directTests, consumer: consumerTests, ...testsBound } : { direct: null, consumer: null, ...testsBound },
    publicSurfaceImpact: known
      ? { changed: changedSurfaces, affected: affectedSurfaceList, present: !!(changedSurfaces.length || affectedSurfaceList.length) }
      : { changed: null, affected: null, present: inputSignals.publicSurface ? true : null },
    cycles: cyclesOut,
    deletions: deletionsOut,
    renames: renamesOut,
    dimensions,
    subsystemsAffected: KD(subsystemTally([...dRows, ...tRows].map((r) => r.id), nodeOf)),
    risk,
    class: { value: route.class, given, reclassified: route.reclassified },
    requiredContext,
    requiredValidation,
    intelligenceImpact: { ...predicted.states, affectedArtifacts: predicted.affectedArtifacts, refresh },
    inspection: inspect.ops,
    bounded,
    withheld: unique([...cs.withheld]).sort(cmp),
    limitations: unique(limitations),
    confidence,
  };
  // The one shared secret-path filter, applied to the finished report whatever put a path there.
  const scrubbed = scrubSecretPaths(out);
  const report = scrubbed.value;
  if (scrubbed.removed) report.limitations = unique([...report.limitations, scrubbed.removed + ' secret-pattern path(s) were removed from the report']);
  report.record = actionRecord({
    event: 'IMPACT_REQUIRED',
    action: 'impact-analysis',
    reason: (report.publicSurfaceImpact.present ? 'public-surface' : RISK_RANK[route.risk] >= RISK_RANK.HIGH ? 'required-by-risk' : 'required-by-class') + ': ' + (graphBasis ? 'graph' : 'inspection'),
    level: 'A1',
    result: 'ok',
    detail: { changed: cs.files.length, direct: depsKnown ? dRows.length : null, transitive: depsKnown ? tRows.length : null, tests: depsKnown ? tests.length : null, risk: route.risk, depth: route.validationNeeds.depth, graph: graphBasis ? 'used' : 'not-used', completeness, confidence },
  });
  return report;
}

export { INTELLIGENCE_STATES };
