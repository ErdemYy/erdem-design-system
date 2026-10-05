/**
 * The one decision function for automatic intelligence refresh (ai/AUTOMATION_PROTOCOL.md, "Intelligence
 * automation" and the incremental-refresh row of "Operations"). Pure: it reads nothing and writes nothing, so the
 * same input always gives the same decision. The orchestrator (refresh.mjs) gathers the facts and runs the engine.
 *
 * Automatic refresh (AUTO_REFRESH, level A1) is allowed only when ALL four hold:
 *   1. the output directory (.ai/) exists
 *   2. the session state is stale or partial
 *   3. the task relies on a stale or missing artifact (relevance comes from what the caller says the task relies on;
 *      the task class alone is never proof)
 *   4. none of the files the refresh could write is tracked by version control (unknown counts as tracked)
 * and the refresh is incremental: it keeps the declared profile, deletes nothing, and changes no configuration.
 */

/** Every reason a refresh can be proposed (A2). A caller may pass any of these as declined. */
export const PROPOSAL_REASONS = Object.freeze(['first-index', 'profile-unknown', 'profile-differs-from-config', 'configuration-changed', 'vcs-unknown', 'derived-files-tracked']);

import { describeArtifactPath, scopeRelatesTo } from '../lib/artifact-paths.mjs';

export const DECISIONS = Object.freeze(['AUTO_REFRESH', 'NO_REFRESH', 'PROPOSE_REFRESH', 'BLOCKED']);
export const STATES = Object.freeze(['current', 'stale', 'unverifiable', 'partial', 'missing', 'unavailable']);
export const EVENTS = Object.freeze(['SESSION_START', 'INTELLIGENCE_CHECKED', 'CONTEXT_EXPANDED', 'IMPACT_REQUIRED', 'CHANGE_COMPLETED']);

/** Files that belong to the project's task artifacts. The engine never writes or prunes them. */
export const PROTECTED_NAMES = Object.freeze(['TASK_STATE.md', 'HANDOFF.md', 'DECISIONS.md']);

/** Artifact kinds, as the status command names them, grouped by what a task can rely on. */
const KIND_OF_STATUS = Object.freeze({
  graph: 'graph',
  'machine index': 'index',
  'navigation map': 'index',
  'file index': 'file-index',
  'directory index': 'directory-index',
  'file summary': 'summary',
  'directory summary': 'summary',
});

/** What a task may say it relies on, and the artifact kinds that answer it. */
export const RELIANCE = Object.freeze({
  graph: ['graph'],
  dependents: ['graph'],
  consumers: ['graph'],
  dependencies: ['graph'],
  impact: ['graph'],
  risk: ['graph'],
  cycles: ['graph'],
  'public-surface': ['graph', 'file-index'],
  index: ['index'],
  navigation: ['index'],
  'file-index': ['file-index'],
  'directory-index': ['directory-index'],
  summary: ['summary'],
});

export const CLASSES = Object.freeze(['TRIVIAL', 'SMALL', 'MEDIUM', 'LARGE', 'ARCHITECTURAL']);
export const RISKS = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

/** Windows and macOS file systems treat paths that differ only in case (and, on macOS, in Unicode form) as the same file. */
export const platformIsCaseInsensitive = (platform = process.platform) => platform === 'win32' || platform === 'darwin';

/** Separators, leading "./", duplicate and trailing slashes. */
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
/** Comparison key: normalised, and case- and Unicode-folded where the file system does that. Never used for output. */
export const pathKey = (p, caseInsensitive) => (caseInsensitive ? norm(p).normalize('NFC').toLowerCase() : norm(p));

export function artifactKind(statusKind) {
  return KIND_OF_STATUS[statusKind] ?? null;
}

/**
 * The slug of the source directory or file a per-source artifact describes, or null when it is global or unknown. The
 * names come from lib/artifact-paths.mjs, the functions the generator writes with, so scope matching cannot drift from
 * what the engine actually produced ("src/my dir" is stored as "src/my_dir").
 */
export function coveredPath(artifact, outputDir) {
  return describeArtifactPath(outputDir, artifact.path)?.covers ?? null;
}

/** Which of the stale or missing artifacts does this task rely on? Order follows the input, which is sorted by path. */
export function relevantArtifacts({ staleArtifacts, reliance, scopePaths, outputDir }) {
  const kinds = new Set();
  const ignored = [];
  for (const r of reliance) {
    if (RELIANCE[r]) for (const k of RELIANCE[r]) kinds.add(k);
    else ignored.push(r);
  }
  const scope = scopePaths.map(norm).filter(Boolean);
  const relevant = [];
  for (const a of staleArtifacts) {
    if (a.state !== 'STALE' && a.state !== 'MISSING') continue; // UNVERIFIABLE is never refreshable
    const kind = artifactKind(a.kind);
    if (!kind || !kinds.has(kind)) continue;
    const covered = coveredPath(a, outputDir);
    if (covered && scope.length && !scope.some((x) => scopeRelatesTo(covered, x))) continue;
    relevant.push(a);
  }
  return { relevant, ignored, kinds: [...kinds].sort() };
}

/** Paths the chosen command may write, as a predicate over project-relative paths. */
export function mayWrite(command, outputDir, relPath, caseInsensitive = platformIsCaseInsensitive()) {
  const out = pathKey(outputDir, caseInsensitive);
  const p = pathKey(relPath, caseInsensitive);
  if (!p.startsWith(`${out}/`)) return false;
  const rest = p.slice(out.length + 1);
  if (PROTECTED_NAMES.some((n) => pathKey(n, caseInsensitive) === rest)) return false;
  if (command === 'graph') return rest.startsWith('graph/') || rest.startsWith('state/');
  if (command === 'index') return true;
  return false;
}

const out = (decision, reason, level, extra = {}) => ({ decision, reason, level, affectedArtifacts: [], command: null, ...extra });

/**
 * @param {object} i
 * @param {string} [i.event]                  one of EVENTS
 * @param {string} i.intelligenceState        one of STATES (adapters/GENERIC.md section 3)
 * @param {Array}  [i.staleArtifacts]         [{path, kind, state}] from status, states STALE, MISSING or UNVERIFIABLE
 * @param {boolean}[i.outputDirExists]
 * @param {string} [i.outputDir]              default ".ai"
 * @param {{paths?: string[]}} [i.taskScope]
 * @param {string} [i.taskClass]              TRIVIAL..ARCHITECTURAL (a routing signal, never proof of reliance)
 * @param {string[]} [i.taskDependencies]     what the task relies on (keys of RELIANCE)
 * @param {string[]|null} [i.trackedDerivedFiles] tracked paths under the output directory; null = could not be established
 * @param {string} [i.risk]                   LOW..CRITICAL
 * @param {string|null} [i.declaredProfile]   profile recorded by the existing index
 * @param {string|null} [i.configProfile]     explicit profile in the project configuration, or null/"auto"
 * @param {object} [i.requested]              operations someone asked for: {forced, rehash, profileChange, discardCache, configChange, cleanup}
 * @param {boolean}[i.priorFailure]           a refresh already failed in this session: no retry
 * @param {string[]}[i.declinedReasons]       proposal reasons (PROPOSAL_REASONS) the user declined earlier in this session; held by the
 *                                            caller, never stored here. A declined reason is not proposed again; every other reason is
 * @param {boolean}[i.caseInsensitivePaths]  compare paths case-insensitively (default: Windows and macOS)
 * @param {boolean}[i.searchInsufficient]     targeted inspection could not answer "what depends on it"
 * @returns {{decision: string, reason: string, level: string, affectedArtifacts: string[], command: ('graph'|'index'|null), detail: object}}
 */
export function shouldAutoRefresh(i) {
  const state = i.intelligenceState;
  const outputDir = i.outputDir ?? '.ai';
  const cls = CLASSES.includes(i.taskClass) ? i.taskClass : null;
  const risk = RISKS.includes(i.risk) ? i.risk : null;
  const reliance = [...new Set((i.taskDependencies ?? []).map((x) => String(x).toLowerCase()))].sort();
  const base = { state, taskClass: cls, risk, reliance };
  const done = (decision, reason, level, extra = {}) => ({ ...out(decision, reason, level, extra), detail: { ...base, ...(extra.detail ?? {}) } });

  // An A2 proposal. Reasons the user already declined are not repeated (same reason only); a different reason is still
  // proposed. When every reason that applies was declined the answer is NO_REFRESH: a declined condition never turns
  // into an automatic refresh.
  const declined = new Set(i.declinedReasons ?? []);
  const propose = (candidates) => {
    const open = candidates.find((c) => !declined.has(c.reason));
    if (open) return done('PROPOSE_REFRESH', open.reason, 'A2', open.extra ?? {});
    return done('NO_REFRESH', 'declined-earlier', 'A2', { detail: { suppressed: candidates.map((c) => c.reason) } });
  };

  const req = i.requested ?? {};
  const manual = Object.entries(req).filter(([, v]) => v).map(([k]) => k).sort();
  if (manual.length) return done('BLOCKED', 'manual-operation', 'A0', { detail: { requested: manual } });
  if (!STATES.includes(state)) return done('BLOCKED', 'unclassifiable-state', 'A2');
  if (i.event === 'SESSION_START') return done('NO_REFRESH', 'session-start', 'A1');
  if (state === 'unavailable') return done('NO_REFRESH', 'status-unavailable', 'A1');
  if (i.priorFailure) return done('NO_REFRESH', 'refresh-failed-earlier', 'A1');
  if (state === 'current') return done('NO_REFRESH', 'state-current', 'A1');
  if (state === 'unverifiable') return done('NO_REFRESH', 'unverifiable-not-refreshable', 'A1');

  if (state === 'missing') {
    const bigClass = cls === 'MEDIUM' || cls === 'LARGE' || cls === 'ARCHITECTURAL';
    const serious = risk === 'HIGH' || risk === 'CRITICAL';
    if (reliance.length && i.searchInsufficient && (bigClass || serious)) return propose([{ reason: 'first-index', extra: { command: 'index' } }]);
    return done('NO_REFRESH', 'missing-targeted-inspection', 'A1');
  }

  // stale or partial
  if (!i.outputDirExists) return done('BLOCKED', 'output-directory-missing', 'A2');
  if (!reliance.length) return done('NO_REFRESH', 'no-reliance', 'A1');
  const { relevant, ignored, kinds } = relevantArtifacts({ staleArtifacts: i.staleArtifacts ?? [], reliance, scopePaths: i.taskScope?.paths ?? [], outputDir });
  const withIgnored = { ignoredReliance: ignored, relianceKinds: kinds };
  if (!relevant.length) return done('NO_REFRESH', 'artifacts-not-relied-on', 'A1', { detail: withIgnored });

  const command = relevant.every((a) => artifactKind(a.kind) === 'graph') ? 'graph' : 'index';
  const affectedArtifacts = relevant.map((a) => norm(a.path)).sort();
  const common = { command, affectedArtifacts, detail: withIgnored };

  // Every reason that stands between this task and an automatic refresh, in a fixed order. Each one is an A2 proposal.
  const problems = [];
  if (command === 'index') {
    if (!i.declaredProfile) problems.push({ reason: 'profile-unknown', extra: common });
    else {
      const cfgProfile = i.configProfile && i.configProfile !== 'auto' ? i.configProfile : null;
      if (cfgProfile && cfgProfile !== i.declaredProfile) problems.push({ reason: 'profile-differs-from-config', extra: common });
    }
  }
  if (relevant.some((a) => a.reason === 'configuration changed')) problems.push({ reason: 'configuration-changed', extra: common });
  const tracked = i.trackedDerivedFiles;
  if (tracked === null || tracked === undefined) problems.push({ reason: 'vcs-unknown', extra: common });
  else {
    const ci = i.caseInsensitivePaths ?? platformIsCaseInsensitive();
    const wouldWrite = tracked.map(norm).filter((p) => mayWrite(command, outputDir, p, ci)).sort();
    if (wouldWrite.length) problems.push({ reason: 'derived-files-tracked', extra: { ...common, detail: { ...withIgnored, trackedCount: wouldWrite.length } } });
  }
  if (problems.length) return propose(problems);

  return done('AUTO_REFRESH', 'relied-on-stale', 'A1', common);
}
