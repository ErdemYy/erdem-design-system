/**
 * The one path-safety filter for everything a read plan can name (targets, subsystems, architecture documents,
 * canonical sources, orientation files). Pure: no file access.
 *
 *   cleanPath      a project-relative path in canonical form, or an error
 *   isSecretPath   the engine's secret-pattern list (lib/secret-patterns.mjs), applied to the path and to each directory
 *                  above it; the same list the scanner uses, not a second one
 *   guardPaths     splits a list into plannable paths and withheld secret paths
 *
 * Glob versus literal. Framework routes use brackets and braces literally: app/[id]/page.tsx, app/[[lang]]/page.tsx,
 * app/[...slug]/page.tsx, src/routes/{id}.tsx. Those are accepted. A path is rejected as a glob when it contains "*" or
 * "?", a bracket class with a negation ([!x], [^x]) or a single-character range ([a-z], [0-9]), a brace group that
 * lists alternatives ({a,b}) or a range ({1..3}), or unbalanced brackets or braces. "[post-id]" is a name, "[a-z]" is a
 * class: the rule is that a class holds ranges of single characters or a negation, a route segment does not.
 */
import { createSecretMatcher } from '../lib/secret-patterns.mjs';

export class RoutingInputError extends Error {}

const secret = createSecretMatcher([]);

const SINGLE_CHAR_RANGE = /(?<![A-Za-z0-9])[A-Za-z0-9]-[A-Za-z0-9](?![A-Za-z0-9])/;

/** True when the text uses glob syntax rather than literal bracket or brace characters. */
export function looksLikeGlob(s) {
  if (/[*?]/.test(s)) return true;
  let depth = 0;
  for (const ch of s) {
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (depth < 0) return true;
  }
  if (depth !== 0) return true;
  depth = 0;
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth < 0) return true;
  }
  if (depth !== 0) return true;
  for (const m of s.matchAll(/\[([^[\]]*)\]/g)) {
    if (/^[!^]/.test(m[1]) || SINGLE_CHAR_RANGE.test(m[1])) return true;
  }
  for (const m of s.matchAll(/\{([^{}]*)\}/g)) {
    if (m[1].includes(',') || m[1].includes('..')) return true;
  }
  return false;
}

/** Project-relative path in canonical form (forward slashes), or a RoutingInputError. Nothing absolute, no traversal, no glob. */
export function cleanPath(p) {
  const raw = String(p ?? '');
  const s = raw.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  const bad = !s || s === '.' || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').includes('..') || /[\0-\x1f]/.test(s) || looksLikeGlob(s);
  if (bad) throw new RoutingInputError(`not a plain project-relative path: ${raw.slice(0, 80)}`);
  return s;
}

/** The secret-pattern list applied to a path and to every directory above it (so ".ssh/known_hosts" is caught by ".ssh/"). */
export function isSecretPath(p) {
  const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = 1; i < parts.length; i++) if (secret(parts.slice(0, i).join('/'), true)) return true;
  return secret(parts.join('/'), false);
}

/** { ok: plannable paths in their original order, withheld: secret paths } */
export function guardPaths(paths) {
  const ok = [];
  const withheld = [];
  for (const p of paths) (isSecretPath(p) ? withheld : ok).push(p);
  return { ok, withheld };
}
