/**
 * The one place that names derived artifacts under the output directory. The generator writes through these
 * functions; the context router and the refresh decision resolve and match artifact paths through the same ones, so
 * the three can never disagree. Pure: no file access.
 *
 * Generated names replace every character outside A-Z a-z 0-9 . _ / - with "_" ("src/my dir" becomes "src/my_dir",
 * "src/Ünlü" becomes "src/_nl_"). The function is not injective; two different directories can share a slug. Matching
 * code therefore compares slugs (a collision can only make an artifact look relevant, never hide one).
 */

export const slugPath = (p) => String(p).replace(/[^A-Za-z0-9._/-]/g, '_');

/** Paths relative to the output directory. */
export const directoryIndexRel = (dir) => `directories/${slugPath(dir)}/DIRECTORY_INDEX.md`;
export const fileSummaryRel = (id) => `summaries/files/${slugPath(id)}.json`;
export const directorySummaryRel = (dir) => `summaries/directories/${slugPath(dir)}.json`;

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What a project-relative artifact path under `outputDir` describes: { type, covers } where `covers` is the slug of the
 * source directory or file, or null when the path is not a per-source artifact.
 */
export function describeArtifactPath(outputDir, projectRelPath) {
  const out = escapeRe(norm(outputDir));
  const p = norm(projectRelPath);
  let m = new RegExp(`^${out}/directories/(.+)/DIRECTORY_INDEX\\.md$`).exec(p);
  if (m) return { type: 'directory-index', covers: m[1] };
  m = new RegExp(`^${out}/summaries/files/(.+)\\.json$`).exec(p);
  if (m) return { type: 'file-summary', covers: m[1] };
  m = new RegExp(`^${out}/summaries/directories/(.+)\\.json$`).exec(p);
  if (m) return { type: 'directory-summary', covers: m[1] };
  return null;
}

/** Is a source path (a task's scope) inside, or an ancestor of, what an artifact covers? Compared as slugs. */
export function scopeRelatesTo(covers, scopePath) {
  const a = slugPath(norm(covers));
  const b = slugPath(norm(scopePath));
  if (!b || b === '.' || !a || a === '.') return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
