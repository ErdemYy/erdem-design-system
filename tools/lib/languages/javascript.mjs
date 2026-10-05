import path from 'node:path';
import { tokenize, leadingComment } from './javascript-lexer.mjs';
import { cmp } from '../util.mjs';

/**
 * JavaScript / TypeScript adapter.
 *
 * analyze():  static facts from one file (imports, re-exports, exports) without a full parser.
 * createResolver(): turns an import specifier into a project file, an external package, or "unresolved".
 *
 * Detected: ES imports (including side-effect and type-only), `import x = require()`, dynamic `import("lit")`,
 * `require("lit")`, `export * from`, `export {…} from`, `export * as ns from`, named/default exports and the
 * common CommonJS export forms. Not detected: computed specifiers, runtime call graphs, multi-declarator
 * `export const a = 1, b = 2` beyond the first name, destructured exports.
 */

export const ADAPTER_ID = 'javascript';
export const ADAPTER_VERSION = '1';

const STATEMENT_STOP = new Set(['import', 'export', 'const', 'let', 'var', 'function', 'class', 'return']);
const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs', 'index.mts', 'index.cts', 'index.json'];
const JS_TO_TS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

function literal(tok) {
  if (!tok) return null;
  if (tok.t === 'str') return tok.v;
  if (tok.t === 'tpl' && !tok.x) return tok.v;
  return null;
}
const isPunct = (tok, v) => tok && tok.t === 'punct' && tok.v === v;
const isId = (tok, v) => tok && tok.t === 'id' && (v === undefined || tok.v === v);

/** Name declared by an `export <modifiers> <keyword> name` form, starting at the first token after `export`. */
function declaredName(t, j) {
  for (let guard = 0; guard < 4; guard++) {
    if (isId(t[j], 'declare') || isId(t[j], 'async') || isId(t[j], 'abstract')) j++;
    else if (isId(t[j], 'const') && isId(t[j + 1], 'enum')) j++;
    else break;
  }
  const k = t[j];
  if (!k || k.t !== 'id') return null;
  switch (k.v) {
    case 'function': {
      let m = j + 1;
      if (isPunct(t[m], '*')) m++;
      return isId(t[m]) ? t[m].v : null;
    }
    case 'class':
      return isId(t[j + 1]) && !['extends', 'implements'].includes(t[j + 1].v) ? t[j + 1].v : null;
    case 'interface':
    case 'enum':
    case 'namespace':
    case 'module':
    case 'type':
    case 'const':
    case 'let':
    case 'var':
      return isId(t[j + 1]) ? t[j + 1].v : null;
    default:
      return null;
  }
}

/** Parse `{ a, b as c, type D }` starting at the opening brace. Returns {names, aliases, end}. */
function parseBraceList(t, open) {
  const entries = [];
  let cur = [];
  let q = open + 1;
  for (; q < t.length && !isPunct(t[q], '}'); q++) {
    if (isPunct(t[q], ',')) {
      entries.push(cur);
      cur = [];
    } else cur.push(t[q]);
  }
  entries.push(cur);
  const items = [];
  for (let e of entries) {
    if (e.length === 0) continue;
    let typeOnly = false;
    if (isId(e[0], 'type') && e.length >= 2 && !isId(e[1], 'as')) {
      typeOnly = true;
      e = e.slice(1);
    }
    const name = e[0]?.v;
    const alias = isId(e[1], 'as') && e[2] ? e[2].v : name;
    if (name) items.push({ name, alias, typeOnly });
  }
  return { items, end: q };
}

/** Keys of `module.exports = { a, b: 1, c() {} }`. */
function objectKeys(t, open) {
  const keys = [];
  let bd = 0;
  let pd = 0;
  for (let q = open; q < t.length; q++) {
    const tk = t[q];
    if (tk.t === 'punct') {
      if (tk.v === '{') bd++;
      else if (tk.v === '}') {
        bd--;
        if (bd === 0) break;
      } else if (tk.v === '(' || tk.v === '[') pd++;
      else if (tk.v === ')' || tk.v === ']') pd--;
      continue;
    }
    if (bd === 1 && pd === 0 && (tk.t === 'id' || tk.t === 'str') && (isPunct(t[q - 1], '{') || isPunct(t[q - 1], ','))) {
      const nx = t[q + 1];
      if (isPunct(nx, ',') || isPunct(nx, ':') || isPunct(nx, '}') || isPunct(nx, '(')) keys.push(tk.v);
    }
  }
  return keys;
}

export function analyze(src, { path: filePath = '' } = {}) {
  const diagnostics = [];
  if (src.includes('\u0000')) {
    return failed('binary-content', 'file contains NUL bytes and is not treated as source');
  }
  // JSX text may contain apostrophes; only plain .ts/.mts/.cts files treat an unterminated string as a warning
  const jsx = !/\.(ts|mts|cts)$/i.test(filePath);
  const { tokens: t, diagnostics: lexDiag, structuralError } = tokenize(src, { jsx });
  for (const d of lexDiag) diagnostics.push(d);

  const imports = new Map();
  const reexports = new Map();
  const exportsSet = new Set();
  const consumed = new Set();
  const nonLiteral = { dynamic: 0, require: 0 };

  const addImport = (specifier, kind, typeOnly) => {
    imports.set(`${specifier}\0${kind}\0${typeOnly ? 1 : 0}`, { specifier, kind, typeOnly: !!typeOnly });
  };
  const addReexport = (specifier, names, star, typeOnly) => {
    const key = `${specifier}\0${star ? '*' : names.join(',')}\0${typeOnly ? 1 : 0}`;
    reexports.set(key, { specifier, names: [...names].sort(cmp), star, typeOnly: !!typeOnly });
  };

  for (let k = 0; k < t.length; k++) {
    const tk = t[k];
    if (tk.t !== 'id') continue;
    const prevDot = isPunct(t[k - 1], '.');

    // CommonJS require("literal"), any depth
    if (tk.v === 'require' && !prevDot && !consumed.has(k) && isPunct(t[k + 1], '(')) {
      const spec = literal(t[k + 2]);
      if (spec !== null && (isPunct(t[k + 3], ')') || isPunct(t[k + 3], ','))) addImport(spec, 'require', false);
      else nonLiteral.require++;
      continue;
    }

    // dynamic import("literal"), any depth
    if (tk.v === 'import' && !prevDot && isPunct(t[k + 1], '(')) {
      const spec = literal(t[k + 2]);
      if (spec !== null && (isPunct(t[k + 3], ')') || isPunct(t[k + 3], ','))) addImport(spec, 'dynamic', false);
      else nonLiteral.dynamic++;
      continue;
    }

    // CommonJS exports
    if (tk.v === 'module' && !prevDot && isPunct(t[k + 1], '.') && isId(t[k + 2], 'exports')) {
      if (isPunct(t[k + 3], '=') && !isPunct(t[k + 4], '=')) {
        exportsSet.add('module.exports');
        if (isPunct(t[k + 4], '{')) for (const key of objectKeys(t, k + 4)) exportsSet.add(key);
      } else if (isPunct(t[k + 3], '.') && isId(t[k + 4]) && isPunct(t[k + 5], '=') && !isPunct(t[k + 6], '=')) {
        exportsSet.add(t[k + 4].v);
      }
      continue;
    }
    if (tk.v === 'exports' && !prevDot && isPunct(t[k + 1], '.') && isId(t[k + 2]) && isPunct(t[k + 3], '=') && !isPunct(t[k + 4], '=')) {
      exportsSet.add(t[k + 2].v);
      continue;
    }

    if (tk.d !== 0 || prevDot) continue;

    if (tk.v === 'import') {
      if (isPunct(t[k + 1], '.')) continue; // import.meta
      let p = k + 1;
      const side = literal(t[p]);
      if (side !== null) {
        addImport(side, 'side-effect', false);
        continue;
      }
      let typeOnly = false;
      if (isId(t[p], 'type') && !(isId(t[p + 1], 'from') && literal(t[p + 2]) !== null) && !isPunct(t[p + 1], '=')) {
        typeOnly = true;
        p++;
      }
      // import x = require("m")
      if (isId(t[p]) && isPunct(t[p + 1], '=') && isId(t[p + 2], 'require') && isPunct(t[p + 3], '(')) {
        const spec = literal(t[p + 4]);
        consumed.add(p + 2);
        if (spec !== null) addImport(spec, 'require', typeOnly);
        continue;
      }
      let q = p;
      let found = -1;
      for (; q < t.length && q - p < 4000; q++) {
        if (isPunct(t[q], ';')) break;
        if (q > p && t[q].t === 'id' && STATEMENT_STOP.has(t[q].v) && t[q].d === 0) break;
        if (isId(t[q], 'from') && literal(t[q + 1]) !== null) {
          found = q;
          break;
        }
      }
      if (found < 0) continue;
      let inlineTypeOnly = false;
      const braceAt = t.slice(p, found).findIndex((x) => isPunct(x, '{'));
      if (braceAt >= 0) {
        const open = p + braceAt;
        const before = t.slice(p, open).filter((x) => isId(x) && x.v !== 'type');
        const { items } = parseBraceList(t, open);
        inlineTypeOnly = before.length === 0 && items.length > 0 && items.every((x) => x.typeOnly);
      }
      addImport(literal(t[found + 1]), 'static', typeOnly || inlineTypeOnly);
      continue;
    }

    if (tk.v === 'export') {
      const nx = t[k + 1];
      if (!nx) continue;
      if (isPunct(nx, '*')) {
        let q = k + 2;
        let alias = null;
        if (isId(t[q], 'as') && isId(t[q + 1])) {
          alias = t[q + 1].v;
          q += 2;
        }
        if (isId(t[q], 'from') && literal(t[q + 1]) !== null) {
          addReexport(literal(t[q + 1]), alias ? [alias] : ['*'], !alias, false);
          exportsSet.add(alias ?? '*');
        }
        continue;
      }
      if (isPunct(nx, '=')) {
        exportsSet.add('export=');
        continue;
      }
      let braceAt = -1;
      let typeOnly = false;
      if (isPunct(nx, '{')) braceAt = k + 1;
      else if (isId(nx, 'type') && isPunct(t[k + 2], '{')) {
        braceAt = k + 2;
        typeOnly = true;
      } else if (isId(nx, 'type') && isPunct(t[k + 2], '*')) {
        let q = k + 3;
        if (isId(t[q], 'from') && literal(t[q + 1]) !== null) addReexport(literal(t[q + 1]), ['*'], true, true);
        continue;
      }
      if (braceAt >= 0) {
        const { items, end } = parseBraceList(t, braceAt);
        const aliases = items.map((x) => x.alias);
        if (isId(t[end + 1], 'from') && literal(t[end + 2]) !== null) {
          addReexport(literal(t[end + 2]), aliases, false, typeOnly || (items.length > 0 && items.every((x) => x.typeOnly)));
        }
        for (const a of aliases) exportsSet.add(a);
        continue;
      }
      if (isId(nx, 'default')) {
        exportsSet.add('default');
        continue;
      }
      const name = declaredName(t, k + 1);
      if (name) exportsSet.add(name);
    }
  }

  if (nonLiteral.dynamic > 0) {
    diagnostics.push({ severity: 'info', code: 'dynamic-import-non-literal', message: `${nonLiteral.dynamic} dynamic import(s) with a computed specifier were not resolved` });
  }
  if (nonLiteral.require > 0) {
    diagnostics.push({ severity: 'info', code: 'require-non-literal', message: `${nonLiteral.require} require() call(s) with a computed specifier were not resolved` });
  }
  const status = structuralError ? 'partial' : 'parsed';
  return {
    status,
    supported: true,
    imports: [...imports.values()].sort((a, b) => cmp(a.specifier, b.specifier) || cmp(a.kind, b.kind) || Number(a.typeOnly) - Number(b.typeOnly)),
    reexports: [...reexports.values()].sort((a, b) => cmp(a.specifier, b.specifier) || cmp(a.names.join(','), b.names.join(','))),
    exports: [...exportsSet].sort(cmp),
    diagnostics,
    purposeHint: leadingComment(src),
  };

  function failed(code, message) {
    return {
      status: 'failed',
      supported: true,
      imports: [],
      reexports: [],
      exports: [],
      diagnostics: [{ severity: 'error', code, message }],
      purposeHint: null,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

const norm = (p) => {
  const s = path.posix.normalize(p);
  return s.startsWith('./') ? s.slice(2) : s;
};

/** Try a base path (no extension handling yet) against the known project files. */
export function resolveFileCandidate(base, fileSet) {
  const candidates = [];
  const ext = path.posix.extname(base);
  if (JS_TO_TS[ext]) {
    const stem = base.slice(0, -ext.length);
    for (const e of JS_TO_TS[ext]) candidates.push(stem + e);
  }
  candidates.push(base);
  for (const e of SCRIPT_EXTENSIONS) candidates.push(base + e);
  for (const f of INDEX_FILES) candidates.push(path.posix.join(base, f));
  for (const c of candidates) {
    const cand = norm(c);
    if (fileSet.has(cand)) return cand;
  }
  return null;
}

/** tsconfig/jsconfig `extends` chain, relative extends only. */
function effectiveTsconfig(file, raws, depth = 0, seen = new Set()) {
  const raw = raws.get(file);
  if (!raw || seen.has(file) || depth > 8) return { baseUrl: null, paths: [] };
  seen.add(file);
  const dir = path.posix.dirname(file);
  let result = { baseUrl: null, paths: [] };
  if (typeof raw.extends === 'string' && raw.extends.startsWith('.')) {
    const ext = norm(path.posix.join(dir, raw.extends));
    const parentPath = raws.has(ext) ? ext : raws.has(ext + '.json') ? ext + '.json' : null;
    if (parentPath) result = effectiveTsconfig(parentPath, raws, depth + 1, seen);
  }
  if (typeof raw.baseUrl === 'string') result = { ...result, baseUrl: norm(path.posix.join(dir, raw.baseUrl)) };
  if (raw.paths && typeof raw.paths === 'object') {
    const root = result.baseUrl ?? dir;
    result = {
      ...result,
      paths: Object.entries(raw.paths)
        .filter(([, targets]) => Array.isArray(targets))
        .map(([pattern, targets]) => ({ pattern, targets: targets.filter((x) => typeof x === 'string'), dir: root })),
    };
  }
  return result;
}

function externalName(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
}

/**
 * project: { fileSet: Set<string>, tsconfigs: Map<path, {extends, baseUrl, paths}>,
 *            workspacePackages: Map<name, {dir, pkg}> }
 * Returns (specifier, fromRel) => {kind: 'local'|'external'|'unresolved'|'ignored', ...}
 * Dependency folders are never resolved into project files: they are not part of the scanned set.
 */
export function createResolver(project) {
  const { fileSet, tsconfigs, workspacePackages } = project;
  const configCache = new Map();
  const effective = (file) => {
    if (!configCache.has(file)) configCache.set(file, effectiveTsconfig(file, tsconfigs));
    return configCache.get(file);
  };
  const nearestConfig = (fromRel) => {
    let dir = path.posix.dirname(fromRel);
    for (;;) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const cand = dir === '.' ? name : `${dir}/${name}`;
        if (tsconfigs.has(cand)) return cand;
      }
      if (dir === '.' || dir === '') return null;
      dir = path.posix.dirname(dir);
    }
  };

  function tryAliases(spec, fromRel) {
    const cfgFile = nearestConfig(fromRel);
    if (!cfgFile) return null;
    const eff = effective(cfgFile);
    const matches = [];
    for (const entry of eff.paths) {
      const star = entry.pattern.indexOf('*');
      if (star < 0) {
        if (spec === entry.pattern) matches.push({ entry, rest: '', weight: entry.pattern.length });
      } else {
        const pre = entry.pattern.slice(0, star);
        const post = entry.pattern.slice(star + 1);
        if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) {
          matches.push({ entry, rest: spec.slice(pre.length, spec.length - post.length), weight: pre.length });
        }
      }
    }
    matches.sort((a, b) => b.weight - a.weight);
    for (const m of matches) {
      for (const target of m.entry.targets) {
        const hit = resolveFileCandidate(norm(path.posix.join(m.entry.dir, target.replace('*', m.rest))), fileSet);
        if (hit) return { path: hit, via: 'tsconfig-paths' };
      }
    }
    if (eff.baseUrl) {
      const hit = resolveFileCandidate(norm(path.posix.join(eff.baseUrl, spec)), fileSet);
      if (hit) return { path: hit, via: 'baseUrl' };
    }
    return matches.length ? { unresolved: 'alias-target-not-found' } : null;
  }

  function tryWorkspace(spec) {
    if (!workspacePackages || workspacePackages.size === 0) return null;
    const name = externalName(spec);
    const ws = workspacePackages.get(name);
    if (!ws) return null;
    const rest = spec.slice(name.length).replace(/^\//, '');
    if (rest) {
      const hit = resolveFileCandidate(norm(path.posix.join(ws.dir, rest)), fileSet) ?? resolveFileCandidate(norm(path.posix.join(ws.dir, 'src', rest)), fileSet);
      return hit ? { path: hit, via: 'workspace' } : { unresolved: 'workspace-subpath-not-found' };
    }
    const leaves = [];
    const pkg = ws.pkg;
    if (typeof pkg.module === 'string') leaves.push(pkg.module);
    if (typeof pkg.main === 'string') leaves.push(pkg.main);
    for (const l of pkg.exportsLeaves ?? []) leaves.push(l);
    leaves.push('src/index', 'index');
    for (const l of leaves) {
      const hit = resolveFileCandidate(norm(path.posix.join(ws.dir, l)), fileSet);
      if (hit) return { path: hit, via: 'workspace' };
    }
    return { unresolved: 'workspace-entry-not-found' };
  }

  return function resolve(spec, fromRel) {
    if (!spec) return { kind: 'unresolved', reason: 'empty-specifier' };
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec) && !spec.startsWith('node:')) return { kind: 'ignored', reason: 'url-or-data-specifier' };
    if (spec.startsWith('node:')) return { kind: 'external', name: spec };
    if (spec.startsWith('#')) return { kind: 'unresolved', reason: 'package-imports-unsupported' };
    if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
      const base = norm(path.posix.join(path.posix.dirname(fromRel), spec));
      const hit = resolveFileCandidate(base, fileSet);
      return hit ? { kind: 'local', path: hit } : { kind: 'unresolved', reason: 'relative-target-not-found' };
    }
    if (spec.startsWith('/')) return { kind: 'unresolved', reason: 'absolute-path' };
    const alias = tryAliases(spec, fromRel);
    if (alias?.path) return { kind: 'local', path: alias.path, via: alias.via };
    if (alias?.unresolved) return { kind: 'unresolved', reason: alias.unresolved };
    const ws = tryWorkspace(spec);
    if (ws?.path) return { kind: 'local', path: ws.path, via: ws.via };
    if (ws?.unresolved) return { kind: 'unresolved', reason: ws.unresolved };
    return { kind: 'external', name: externalName(spec) };
  };
}

export const javascriptAdapter = Object.freeze({
  id: ADAPTER_ID,
  version: ADAPTER_VERSION,
  languages: ['javascript', 'typescript'],
  supportsDependencies: true,
  analyze,
  createResolver,
});
