import fs from 'node:fs';
import path from 'node:path';
import { INDEX_FILE } from '../lib/cache.mjs';
import { setFingerprint } from '../lib/fingerprint.mjs';
import { readJsonIfExists, safeJoin } from '../lib/write.mjs';
import { cmp, isUnder } from '../lib/util.mjs';
import { structureFingerprint } from '../graph/build.mjs';
import { parseFrontMatter } from './render.mjs';

/**
 * Stale-context detection. States:
 *   CURRENT        stored fingerprint equals the current fingerprint of its source
 *   STALE          the source changed, moved, was removed, or the configuration changed
 *   UNVERIFIABLE   the source cannot be safely fingerprinted (too large, unreadable, or no stored hash)
 * plus MISSING when an expected artifact does not exist. The content hash decides; mtime is never used.
 *
 * `scan` must be a fresh scan of the project (hashes recomputed), parse not required.
 */
export function checkStatus(scan) {
  const root = scan.root;
  const out = scan.config.outputDir;
  const artifacts = [];
  const cur = new Map(scan.files.map((f) => [f.path, f.fingerprint.hash]));
  const catOf = new Map(scan.files.map((f) => [f.path, f.category]));
  const add = (p, kind, state, reason) => artifacts.push({ path: p, kind, state, ...(reason ? { reason } : {}) });

  function compareFile(p, storedHash) {
    if (!cur.has(p)) return { state: 'STALE', reason: 'removed' };
    const now = cur.get(p);
    if (!storedHash || !now) return { state: 'UNVERIFIABLE', reason: !storedHash ? 'no stored hash' : 'cannot be fingerprinted now' };
    return now === storedHash ? { state: 'CURRENT' } : { state: 'STALE', reason: 'changed' };
  }

  function combine(results) {
    if (results.some((r) => r.state === 'STALE')) return 'STALE';
    if (results.some((r) => r.state === 'UNVERIFIABLE')) return 'UNVERIFIABLE';
    return 'CURRENT';
  }

  const changes = { changed: [], removed: [], added: [] };

  // machine index
  const index = readJsonIfExists(root, `${out}/${INDEX_FILE}`);
  if (!index || index.schema !== 'erdem.index') {
    add(`${out}/${INDEX_FILE}`, 'machine index', 'MISSING', 'run "project-intel index"');
  } else {
    const stored = new Map(index.files.map((f) => [f.path, f.fingerprint?.hash ?? null]));
    const results = [];
    for (const [p, h] of stored) {
      const r = compareFile(p, h);
      results.push(r);
      if (r.reason === 'changed') changes.changed.push(p);
      if (r.reason === 'removed') changes.removed.push(p);
    }
    for (const p of cur.keys()) if (!stored.has(p)) changes.added.push(p);
    let state = combine(results);
    let reason;
    if (changes.added.length) {
      state = 'STALE';
      reason = `${changes.added.length} file(s) added`;
    }
    if (index.configDigest !== scan.configDigest) {
      state = 'STALE';
      reason = 'configuration changed';
    }
    if (state === 'STALE' && !reason) reason = `${changes.changed.length} changed, ${changes.removed.length} removed`;
    add(`${out}/${INDEX_FILE}`, 'machine index', state, reason);
  }

  const structure = structureFingerprint(scan);
  const configOk = (digest) => digest === scan.configDigest;

  // graph
  const graph = readJsonIfExists(root, `${out}/graph/graph.json`);
  if (!graph || graph.schema !== 'erdem.graph') {
    add(`${out}/graph/graph.json`, 'graph', 'MISSING', 'run "project-intel index" or "project-intel graph"');
  } else {
    const results = graph.nodes.filter((n) => n.type === 'file').map((n) => compareFile(n.path, n.fingerprint?.hash ?? null));
    let state = combine(results);
    let reason;
    if (graph.fingerprint?.hash && structure.hash && graph.fingerprint.hash !== structure.hash) {
      state = 'STALE';
      reason = 'structure files changed, were added or removed';
    } else if (!graph.fingerprint?.hash || !structure.hash) {
      if (state === 'CURRENT') state = 'UNVERIFIABLE';
      reason = reason ?? 'a structure file cannot be fingerprinted';
    }
    if (!configOk(graph.configDigest)) {
      state = 'STALE';
      reason = 'configuration changed';
    }
    add(`${out}/graph/graph.json`, 'graph', state, reason);
  }

  // markdown artifacts tied to the structure fingerprint
  for (const name of ['AI_INDEX.md', 'FILE_INDEX.md']) {
    const rel = `${out}/${name}`;
    const abs = safeJoin(root, rel);
    if (!fs.existsSync(abs)) {
      if (name === 'AI_INDEX.md') add(rel, 'navigation map', 'MISSING', 'run "project-intel index"');
      continue;
    }
    const fm = parseFrontMatter(fs.readFileSync(abs, 'utf8')) ?? {};
    const stored = fm.fingerprint?.startsWith('sha256:') ? fm.fingerprint.slice(7) : null;
    let state;
    let reason;
    if (!stored || !structure.hash) {
      state = 'UNVERIFIABLE';
      reason = !stored ? 'no stored fingerprint' : 'a structure file cannot be fingerprinted';
    } else if (stored !== structure.hash) {
      state = 'STALE';
      reason = 'structure files changed, were added or removed';
    } else state = 'CURRENT';
    if (name === 'AI_INDEX.md' && fm.configDigest && !scan.configDigest.startsWith(fm.configDigest)) {
      state = 'STALE';
      reason = 'configuration changed';
    }
    add(rel, name === 'AI_INDEX.md' ? 'navigation map' : 'file index', state, reason);
  }

  const walk = (dir, ext, fn) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries.sort((a, b) => cmp(a.name, b.name))) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, ext, fn);
      else if (ent.isFile() && ent.name.endsWith(ext)) fn(abs, path.relative(root, abs).split(path.sep).join('/'));
    }
  };

  const memberFp = (dir) =>
    setFingerprint(scan.files.filter((f) => isUnder(f.path, dir) && (f.category === 'source' || f.category === 'test')).map((f) => ({ path: f.path, hash: f.fingerprint.hash })));

  // directory indexes
  walk(safeJoin(root, `${out}/directories`), '.md', (abs, rel) => {
    const fm = parseFrontMatter(fs.readFileSync(abs, 'utf8')) ?? {};
    const stored = fm.fingerprint?.startsWith('sha256:') ? fm.fingerprint.slice(7) : null;
    const now = fm.path ? memberFp(fm.path) : null;
    if (!fm.path || !stored || !now?.hash) add(rel, 'directory index', 'UNVERIFIABLE', 'no stored fingerprint or a member cannot be fingerprinted');
    else if (stored !== now.hash) add(rel, 'directory index', 'STALE', 'files in this directory changed, were added or removed');
    else add(rel, 'directory index', 'CURRENT');
  });

  // summaries
  walk(safeJoin(root, `${out}/summaries`), '.json', (abs, rel) => {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch {
      add(rel, 'summary', 'UNVERIFIABLE', 'unreadable summary file');
      return;
    }
    if (s.scope === 'file') {
      const r = compareFile(s.path, s.fingerprint?.hash ?? null);
      add(rel, 'file summary', r.state, r.reason);
    } else if (s.scope === 'directory') {
      const now = memberFp(s.path);
      if (!s.fingerprint?.hash || !now.hash) add(rel, 'directory summary', 'UNVERIFIABLE', 'a member cannot be fingerprinted');
      else add(rel, 'directory summary', s.fingerprint.hash === now.hash ? 'CURRENT' : 'STALE', s.fingerprint.hash === now.hash ? undefined : 'files in this directory changed, were added or removed');
    }
  });
  void catOf;

  artifacts.sort((a, b) => cmp(a.path, b.path));
  const counts = { CURRENT: 0, STALE: 0, UNVERIFIABLE: 0, MISSING: 0 };
  for (const a of artifacts) counts[a.state]++;
  const cap = (list) => list.sort(cmp).slice(0, 50);
  return {
    ok: counts.STALE === 0 && counts.MISSING === 0,
    counts,
    artifacts,
    changes: { changed: cap(changes.changed), removed: cap(changes.removed), added: cap(changes.added) },
  };
}
