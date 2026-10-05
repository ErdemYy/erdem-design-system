import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isoToAgeLabel, parseFrontMatter, readHead, safeToken } from './util.mjs';

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;
const PROFILES = ['none', 'lite', 'standard', 'full'];
const TASK_STATUSES = ['not-started', 'in-progress', 'blocked', 'done'];
const MAX_STAT = 200;

export function run(argv, { cwd, timeoutMs = 1000, env } = {}) {
  const started = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: env ?? process.env, maxBuffer: 4 * 1024 * 1024 });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut: r.error?.code === 'ETIMEDOUT',
    failedToStart: !!r.error && r.error.code !== 'ETIMEDOUT',
    ms: Date.now() - started,
  };
}

/** Task state facts, sanitized: only enumerated values and ISO dates leave this function (hook output reaches the model). */
export function readTaskState(projectRoot) {
  const file = path.join(projectRoot, '.ai', 'TASK_STATE.md');
  const head = readHead(file, 4096);
  if (head === null) return { present: false };
  const fm = parseFrontMatter(head);
  const status = /^##\s+Status\s*\r?\n+\s*([a-z-]+)/m.exec(head)?.[1];
  return {
    present: true,
    status: TASK_STATUSES.includes(status) ? status : null,
    updatedAt: safeToken(fm.updatedAt, ISO, 40),
  };
}

export function readHandoff(projectRoot) {
  const file = path.join(projectRoot, '.ai', 'HANDOFF.md');
  const head = readHead(file, 2048);
  if (head === null) return { present: false };
  const fm = parseFrontMatter(head);
  return {
    present: true,
    generatedAt: safeToken(fm.generatedAt, ISO, 40),
    from: safeToken(fm.from, /^[A-Za-z0-9._ -]{1,24}$/, 24),
    to: safeToken(fm.to, /^[A-Za-z0-9._ -]{1,24}$/, 24),
  };
}

/** Working-tree files changed after `sinceMs`: git status (no content reads) plus stat on at most MAX_STAT paths. */
function newerThanIndex(projectRoot, sinceMs, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 150) return { known: false };
  const r = run(['git', 'status', '--porcelain', '-z', '--untracked-files=normal'], { cwd: projectRoot, timeoutMs: Math.min(800, remaining) });
  if (!r.ok) return { known: false };
  const entries = r.stdout.split('\0').filter(Boolean);
  let newer = 0;
  let checked = 0;
  for (const e of entries) {
    const rel = e.slice(3);
    if (rel.startsWith('.ai/') || rel.startsWith('.ai\\')) continue;
    if (checked++ >= MAX_STAT) return { known: true, newer, capped: true };
    try {
      if (fs.statSync(path.join(projectRoot, rel)).mtimeMs > sinceMs) newer++;
    } catch {
      newer++; // a deleted tracked file is a change too
    }
  }
  return { known: true, newer, capped: false };
}

/**
 * Cheap, content-free picture of project intelligence. Its words are hints, not canonical session states
 * (`adapters/GENERIC.md` section 3): `missing` is the one canonical state it can establish (no index file);
 * `present` and `likely-stale` only say "an index exists" and "files are newer than it". Reads only the first bytes of a few files, plus one
 * time-boxed `git status`. It never rebuilds anything and never hashes or parses source. The staleness it can
 * report is a hint ("files newer than the index"); the authoritative check is `verifiedStatus`.
 */
export function lightStatus(projectRoot, { deadline = Date.now() + 1500, now = Date.now() } = {}) {
  const ai = path.join(projectRoot, '.ai');
  const out = { intelligence: 'missing', profile: null, age: null, graph: 'missing', hint: null, task: readTaskState(projectRoot), handoff: readHandoff(projectRoot) };
  const head = readHead(path.join(ai, 'AI_INDEX.md'), 2048);
  if (head === null) return out;
  const fm = parseFrontMatter(head);
  const generatedAt = safeToken(fm.generatedAt, ISO, 40);
  out.intelligence = 'present';
  out.profile = safeToken(fm.indexProfile, new RegExp(`^(${PROFILES.join('|')})$`), 10);
  out.age = generatedAt ? isoToAgeLabel(generatedAt, now) : null;
  out.graph = fs.existsSync(path.join(ai, 'graph', 'graph.json')) ? 'present' : 'missing';
  if (generatedAt) {
    const g = newerThanIndex(projectRoot, Date.parse(generatedAt), deadline);
    if (g.known && g.newer > 0) {
      out.intelligence = 'likely-stale';
      out.hint = { newer: g.newer, capped: !!g.capped };
      if (out.graph === 'present') out.graph = 'likely-stale';
    }
  }
  return out;
}

/**
 * Authoritative state from the engine's own `status --json` (it re-hashes sources, so callers time-box it).
 * Maps to the canonical session states of `adapters/GENERIC.md` section 3:
 * unavailable | stale | missing | partial | unverifiable | current. Nothing is renamed or folded into another state.
 */
export function verifiedStatus(projectRoot, argv, { timeoutMs = 20000 } = {}) {
  const r = run([...argv, 'status', '--json', projectRoot], { cwd: projectRoot, timeoutMs });
  if (r.timedOut) return { state: 'unavailable', reason: 'status timed out' };
  if (r.failedToStart) return { state: 'unavailable', reason: 'project-intel could not be started' };
  let data = null;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    return { state: 'unavailable', reason: r.status === 2 ? 'project-intel reported an error' : 'unreadable status output' };
  }
  if (r.status === 2 || !data?.counts || !Array.isArray(data.artifacts)) return { state: 'unavailable', reason: r.status === 2 ? 'project-intel reported an error' : 'unexpected status output' };
  const c = data.counts;
  const find = (needle) => data.artifacts.find((a) => a.path.endsWith(needle))?.state ?? 'MISSING';
  const base = { counts: c, graph: find('graph/graph.json'), index: find('AI_INDEX.md'), changed: (data.changes?.changed ?? []).length, added: (data.changes?.added ?? []).length, removed: (data.changes?.removed ?? []).length };
  if (c.STALE > 0) return { state: 'stale', ...base };
  if (c.MISSING > 0 && c.CURRENT === 0 && c.UNVERIFIABLE === 0) return { state: 'missing', ...base };
  if (c.MISSING > 0) return { state: 'partial', ...base };
  if (c.UNVERIFIABLE > 0) return { state: 'unverifiable', ...base };
  return { state: 'current', ...base };
}
