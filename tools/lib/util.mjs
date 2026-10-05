import path from 'node:path';

/** Code-unit comparison: stable across locales and platforms. */
export function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function toPosix(p) {
  return p.replace(/\\/g, '/');
}

export function sortedUnique(items) {
  return [...new Set(items)].sort(cmp);
}

export function slugify(text) {
  return text.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root';
}

/** posix.dirname that returns '.' for top-level paths. */
export function dirOf(rel) {
  return path.posix.dirname(rel);
}

/** True when `child` (posix, relative) is inside directory `dir` ('.' is everything). */
export function isUnder(child, dir) {
  if (dir === '.' || dir === '') return true;
  return child === dir || child.startsWith(dir + '/');
}

/** Normalize a user-supplied path to a project-relative posix path. */
export function normalizeRel(p) {
  let s = toPosix(String(p)).trim();
  while (s.startsWith('./')) s = s.slice(2);
  s = path.posix.normalize(s);
  if (s.endsWith('/') && s.length > 1) s = s.slice(0, -1);
  return s;
}

export function pluralize(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const k = keyFn(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
