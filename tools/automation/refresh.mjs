/**
 * Automatic intelligence refresh: gathers the facts, asks the single decision function, and, only for
 * AUTO_REFRESH, runs the existing engine incrementally. There is no second indexer here: the work is done by
 * runIndex or runGraph (lib/pipeline.mjs). Nothing is persisted, scheduled or retried; the caller gets a
 * decision and an action record (ai/AUTOMATION_PROTOCOL.md, Observability) and decides what to show.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConfigError, loadConfig } from '../lib/config.mjs';
import { runGraph, runIndex, runStatus } from '../lib/pipeline.mjs';
import { EVENTS, mayWrite, platformIsCaseInsensitive, shouldAutoRefresh } from './refresh-decision.mjs';
import { actionRecord, classifyState } from './records.mjs';

export { actionRecord, classifyState };

/**
 * Which files under the output directory does version control track? Returns a sorted array of project-relative
 * paths, or null when that cannot be established (git missing, not a git work tree, or any error). Unknown is
 * treated as tracked by the decision function. Read-only: `git ls-files` changes nothing. No shell is used.
 */
export function trackedUnder(root, outputDir, { caseInsensitive = platformIsCaseInsensitive() } = {}) {
  const run = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const inside = run(['rev-parse', '--is-inside-work-tree']);
  if (inside.error || inside.status !== 0 || inside.stdout.trim() !== 'true') return null;
  // Where the file system ignores case, tracked paths that differ from the configured directory only in case are the
  // same files: ask git for a case-insensitive match (the decision function folds the rest of each path).
  const pathspec = caseInsensitive ? `:(icase,literal)${outputDir}` : `:(literal)${outputDir}`;
  const r = run(['ls-files', '-z', '--', pathspec]);
  if (r.error || r.status !== 0) return null;
  return r.stdout.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')).sort();
}

/** The profile the existing index declares (index.json "profile"), or null when it cannot be read. */
export function declaredProfile(root, outputDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, outputDir, 'index.json'), 'utf8'));
    return ['none', 'lite', 'standard', 'full'].includes(j.profile) ? j.profile : null;
  } catch {
    return null;
  }
}

const RESULT_OF = { NO_REFRESH: 'noop', PROPOSE_REFRESH: 'needs-confirmation', BLOCKED: 'refused' };
const CODE_OF = (d) => (d.reason === 'session-start' ? 'session-start' : d.reason === 'first-index' ? 'sufficiency-q4' : d.reason === 'manual-operation' ? 'user-request' : d.reason === 'unclassifiable-state' ? 'unclassifiable' : d.reason === 'declined-earlier' ? 'user-request' : 'relied-on-stale');

/**
 * @param {string} root project root (absolute)
 * @param {object} task {event, reliesOn, scope, taskClass, risk, searchInsufficient, declinedReasons, priorFailure, requested, configPath}
 *   configPath is the configuration file the existing intelligence was produced with (the same one `index --config` takes);
 *   it is used for every engine call here, so a refresh never runs under a different effective configuration.
 * @param {{execute?: boolean, now?: Date}} [opts] execute:false only decides
 */
export function autoRefresh(root, task = {}, opts = {}) {
  const execute = opts.execute !== false;
  const configPath = task.configPath || undefined;
  const event = EVENTS.includes(task.event) ? task.event : 'INTELLIGENCE_CHECKED';
  const input = {
    event,
    taskClass: task.taskClass,
    risk: task.risk,
    taskDependencies: task.reliesOn ?? [],
    taskScope: { paths: task.scope ?? [] },
    searchInsufficient: !!task.searchInsufficient,
    declinedReasons: [...new Set(task.declinedReasons ?? [])].sort(),
    priorFailure: !!task.priorFailure,
    requested: task.requested ?? {},
  };

  // Facts are gathered (a status check re-hashes sources) only when the answer could depend on them.
  const manual = Object.values(input.requested).some(Boolean);
  const shortCircuit = manual || event === 'SESSION_START' || input.priorFailure;
  let state = 'unavailable';
  let status = null;
  let cfg = null;
  if (!shortCircuit) {
    try {
      cfg = loadConfig(root, { configPath });
      status = runStatus(root, { configPath }).status;
      state = classifyState(status);
    } catch (e) {
      if (!(e instanceof ConfigError)) state = 'unavailable';
    }
  }
  const outputDir = cfg?.outputDir ?? '.ai';
  const outputDirExists = fs.existsSync(path.join(root, outputDir));
  const needsFacts = !shortCircuit && (state === 'stale' || state === 'partial') && input.taskDependencies.length > 0;
  const decision = shouldAutoRefresh({
    ...input,
    intelligenceState: shortCircuit ? 'current' : state,
    staleArtifacts: status?.artifacts?.filter((a) => a.state !== 'CURRENT') ?? [],
    outputDir,
    outputDirExists,
    trackedDerivedFiles: needsFacts ? trackedUnder(root, outputDir, { caseInsensitive: opts.caseInsensitive ?? platformIsCaseInsensitive() }) : [],
    declaredProfile: needsFacts ? declaredProfile(root, outputDir) : null,
    configProfile: cfg?.profile ?? null,
    caseInsensitivePaths: opts.caseInsensitive ?? platformIsCaseInsensitive(),
  });
  const result = { decision, record: null, refreshed: null };

  if (decision.decision !== 'AUTO_REFRESH' || !execute) {
    result.record = actionRecord({ event, action: 'incremental-refresh', reason: `${CODE_OF(decision)}: ${decision.reason}`, level: decision.level, result: decision.reason === 'declined-earlier' ? 'declined' : RESULT_OF[decision.decision] ?? 'noop' /* AUTO_REFRESH with execute:false: decided, not run */, detail: { decision: decision.decision, state: decision.detail.state }, now: opts.now });
    return result;
  }

  // AUTO_REFRESH: one incremental run with the existing engine. Profile pinned, nothing deleted, no rehash.
  const command = decision.command;
  let writes = {};
  let error = null;
  try {
    // Every engine call that could generate an index passes prune:false: an automatic refresh never deletes a file.
    if (command === 'graph') writes = runGraph(root, { configPath }).writes;
    else writes = runIndex(root, { configPath, profile: declaredProfile(root, outputDir), prune: false }).report.writes;
  } catch (e) {
    error = e;
  }
  const outside = Object.keys(writes).filter((p) => !mayWrite(command, outputDir, p));
  let still = [];
  if (!error) {
    try {
      const after = runStatus(root, { configPath }).status;
      still = after.artifacts.filter((a) => decision.affectedArtifacts.includes(a.path.replace(/\\/g, '/')) && (a.state === 'STALE' || a.state === 'MISSING')).map((a) => a.path);
    } catch {
      still = decision.affectedArtifacts;
    }
  }
  const counts = { created: 0, updated: 0, unchanged: 0 };
  for (const s of Object.values(writes)) counts[s] = (counts[s] ?? 0) + 1;
  const ok = !error && !outside.length && !still.length;
  result.refreshed = { ok, command, counts, stillStale: still.length, outsideScope: outside.length, error: error ? error.name : null };
  result.record = actionRecord({
    event,
    action: 'incremental-refresh',
    reason: `relied-on-stale: ${command}`,
    level: 'A1',
    result: ok ? 'ok' : 'failed',
    detail: { command, ...counts, stillStale: still.length, outsideScope: outside.length, ...(error ? { error: error.name } : {}) },
    now: opts.now,
  });
  return result;
}
