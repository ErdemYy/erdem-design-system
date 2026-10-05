import path from 'node:path';

function escapeRe(ch) {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? '\\' + ch : ch;
}

function bodyToRegex(body) {
  let re = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '*') {
      if (body[i + 1] === '*') {
        const prevSlash = i === 0 || body[i - 1] === '/';
        if (prevSlash && body[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
          continue;
        }
        if (prevSlash && i + 2 === body.length) {
          re += '.*';
          i += 2;
          continue;
        }
        re += '[^/]*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '[') {
      const j = body.indexOf(']', i + 2);
      if (j > i + 1) {
        let cls = body.slice(i + 1, j);
        if (cls[0] === '!') cls = '^' + cls.slice(1);
        re += '[' + cls.replace(/\\/g, '\\\\') + ']';
        i = j + 1;
        continue;
      }
    }
    if (c === '\\' && i + 1 < body.length) {
      re += escapeRe(body[i + 1]);
      i += 2;
      continue;
    }
    re += escapeRe(c);
    i++;
  }
  return re;
}

/** Compile one gitignore-style pattern. Returns null for blank lines and comments. */
export function compilePattern(raw) {
  let p = raw.replace(/\r$/, '');
  if (!p.trim() || p.startsWith('#')) return null;
  p = p.replace(/(?<!\\)\s+$/, '');
  let negated = false;
  if (p.startsWith('!')) {
    negated = true;
    p = p.slice(1);
  }
  let dirOnly = false;
  if (p.endsWith('/')) {
    dirOnly = true;
    p = p.slice(0, -1);
  }
  if (!p) return null;
  let anchored = false;
  if (p.startsWith('/')) {
    anchored = true;
    p = p.slice(1);
  } else if (p.includes('/')) {
    anchored = true;
  }
  return { negated, dirOnly, anchored, regex: new RegExp('^' + bodyToRegex(p) + '$') };
}

/**
 * Create a matcher from gitignore-style patterns. Later patterns override earlier ones.
 * The matcher tests one entry (a file or a directory); callers prune ignored directories while walking.
 */
export function createMatcher(patterns) {
  const rules = patterns.map(compilePattern).filter(Boolean);
  return function matches(relPath, isDir) {
    let result = false;
    const base = path.posix.basename(relPath);
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue;
      const target = rule.anchored ? relPath : base;
      if (rule.regex.test(target)) result = !rule.negated;
    }
    return result;
  };
}
