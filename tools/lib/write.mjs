import fs from 'node:fs';
import path from 'node:path';

/** Timestamps are the only content allowed to differ between otherwise identical outputs. */
function maskTimestamps(text) {
  return text.replace(/("?generatedAt"?\s*:\s*)"?[0-9T:.\-+Z]*"?/g, '$1<ts>');
}

/** Resolve a path under `root` and refuse anything outside it. */
export function safeJoin(root, ...parts) {
  const abs = path.resolve(root, ...parts);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Refusing to write outside the project: ${abs}`);
  return abs;
}

/**
 * Write a file only when its content changed (ignoring generatedAt). An unchanged artifact keeps its bytes,
 * including its original timestamp. Returns 'created' | 'updated' | 'unchanged'.
 */
export function writeIfChanged(root, relPath, content) {
  const abs = safeJoin(root, relPath);
  let existing = null;
  try {
    existing = fs.readFileSync(abs, 'utf8');
  } catch {
    existing = null;
  }
  if (existing !== null && maskTimestamps(existing) === maskTimestamps(content)) return 'unchanged';
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return existing === null ? 'created' : 'updated';
}

/** Delete files under `relDir` that are not in `keep` (generated-output cleanup, inside the output directory only). */
export function pruneDirectory(root, relDir, keep, extensions) {
  const absDir = safeJoin(root, relDir);
  const removed = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
        try {
          if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
        } catch {
          /* ignore */
        }
      } else if (ent.isFile() && extensions.some((e) => ent.name.endsWith(e))) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (!keep.has(rel)) {
          fs.rmSync(abs);
          removed.push(rel);
        }
      }
    }
  }
  walk(absDir);
  return removed.sort();
}

export function readJsonIfExists(root, relPath) {
  try {
    return JSON.parse(fs.readFileSync(safeJoin(root, relPath), 'utf8'));
  } catch {
    return null;
  }
}
