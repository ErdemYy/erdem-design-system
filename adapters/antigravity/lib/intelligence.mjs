import { runSafe } from './helpers.mjs';

/**
 * Maps the canonical engine's `status --json` result to one of the adapter-facing states of
 * `adapters/GENERIC.md` §3: missing | current | stale | unverifiable | partial | unavailable.
 * The adapter decides nothing about freshness itself: the engine's content-hash comparison is the authority.
 */
export const STATES = ['missing', 'current', 'stale', 'unverifiable', 'partial', 'unavailable'];

const artifactState = (data, suffix) => data.artifacts.find((a) => a.path.endsWith(suffix))?.state ?? 'MISSING';
const GRAPH_WORD = { CURRENT: 'current', STALE: 'stale', UNVERIFIABLE: 'unverifiable', MISSING: 'missing' };

export function classifyStatus({ exitCode, json, failedToStart = false, timedOut = false, refused = null }) {
  if (refused) return { state: 'unavailable', reason: refused === 'windows-shim' ? 'the configured command is a Windows shim; use node and a script path' : 'project-intel could not be started' };
  if (timedOut) return { state: 'unavailable', reason: 'status timed out' };
  if (failedToStart) return { state: 'unavailable', reason: 'project-intel could not be started' };
  if (exitCode === 2 || !json || !json.counts || !Array.isArray(json.artifacts)) return { state: 'unavailable', reason: exitCode === 2 ? 'project-intel reported an error' : 'unreadable status output' };
  const c = json.counts;
  const base = {
    counts: c,
    graph: GRAPH_WORD[artifactState(json, 'graph/graph.json')],
    index: GRAPH_WORD[artifactState(json, 'AI_INDEX.md')],
    changed: json.changes?.changed?.length ?? 0,
    added: json.changes?.added?.length ?? 0,
    removed: json.changes?.removed?.length ?? 0,
  };
  if (c.STALE > 0) return { state: 'stale', ...base };
  if (c.MISSING > 0 && c.CURRENT === 0 && c.UNVERIFIABLE === 0) return { state: 'missing', ...base };
  if (c.MISSING > 0) return { state: 'partial', ...base };
  if (c.UNVERIFIABLE > 0) return { state: 'unverifiable', ...base };
  return { state: 'current', ...base };
}

/** Run the engine's status (read-only; it re-hashes sources) and classify it. */
export function checkIntelligence(projectRoot, argv, { timeoutMs = 30000, env } = {}) {
  if (!argv) return { state: 'unavailable', reason: 'no project-intel command available' };
  const r = runSafe([...argv, 'status', '--json', projectRoot], { cwd: projectRoot, timeoutMs, env });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return classifyStatus({ exitCode: r.status, json, timedOut: r.timedOut, refused: r.refused });
}
