import fs from 'node:fs';
import path from 'node:path';
import { createMatcher } from './glob.mjs';
import { DEFAULT_IGNORES } from './config.mjs';
import { createSecretMatcher } from './secret-patterns.mjs';
import { cmp } from './util.mjs';

/**
 * Build the ignore function. Hard rules (.git, the output directory) and the defaults can never be
 * negated by a project's own ignore file; project and .gitignore patterns follow gitignore semantics.
 * Returns (rel, isDir) => reason | null.
 */
export function createIgnore(root, cfg) {
  const hard = createMatcher(['.git/', `/${cfg.outputDir}/`]);
  const defaults = cfg.useDefaultIgnores ? createMatcher([...DEFAULT_IGNORES]) : () => false;
  let gitignoreLines = [];
  if (cfg.respectGitignore) {
    try {
      gitignoreLines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/);
    } catch {
      gitignoreLines = [];
    }
  }
  const user = createMatcher([...gitignoreLines, ...cfg.ignore]);
  return (rel, isDir) => {
    if (hard(rel, isDir)) return 'output';
    if (defaults(rel, isDir)) return 'default';
    if (user(rel, isDir)) return 'project';
    return null;
  };
}

/**
 * Walk the project. Ignored directories are pruned, secret-pattern entries are withheld (never opened),
 * symbolic links are not followed. Output is sorted for determinism.
 */
export function discover(root, cfg, diagnostics) {
  const ignore = createIgnore(root, cfg);
  const isSecret = createSecretMatcher(cfg.secretPatterns);
  const files = [];
  const dirs = [];
  const withheld = [];
  const ignored = [];
  let ignoredFiles = 0;

  function walk(relDir) {
    const abs = relDir ? path.join(root, relDir) : root;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      diagnostics.push({ path: relDir || '.', severity: 'error', parser: 'discover', code: 'unreadable-directory', message: e.code ?? e.message });
      return;
    }
    entries.sort((a, b) => cmp(a.name, b.name));
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        // Directory entry types are unreliable on some file systems (for example cloud-synced folders on Windows
        // report ordinary files as links), so confirm with lstat before treating anything as a link.
        let st = null;
        try {
          st = fs.lstatSync(path.join(root, rel));
        } catch {
          st = null;
        }
        if (!st || st.isSymbolicLink()) {
          diagnostics.push({ path: rel, severity: 'warning', parser: 'discover', code: 'symlink-skipped', message: 'symbolic link not followed; its target is not part of the index' });
          continue;
        }
        isDir = st.isDirectory();
        isFile = st.isFile();
      }
      if (isDir) {
        if (isSecret(rel, true)) {
          withheld.push({ path: rel + '/', reason: 'secret-directory' });
          continue;
        }
        const why = ignore(rel, true);
        if (why) {
          // the tool's own output directory and .git are infrastructure, not project content worth reporting
          if (why !== 'output') ignored.push({ path: rel + '/', reason: why });
          continue;
        }
        dirs.push(rel);
        walk(rel);
        continue;
      }
      if (!isFile) continue;
      if (isSecret(rel, false)) {
        withheld.push({ path: rel, reason: 'secret-pattern' });
        continue;
      }
      if (ignore(rel, false)) {
        ignoredFiles++;
        continue;
      }
      try {
        const st = fs.statSync(path.join(root, rel));
        files.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
      } catch (e) {
        diagnostics.push({ path: rel, severity: 'error', parser: 'discover', code: 'unreadable-file', message: e.code ?? e.message });
      }
    }
  }

  walk('');
  files.sort((a, b) => cmp(a.rel, b.rel));
  dirs.sort(cmp);
  withheld.sort((a, b) => cmp(a.path, b.path));
  ignored.sort((a, b) => cmp(a.path, b.path));
  return { files, dirs, withheld, ignored, ignoredFiles };
}
