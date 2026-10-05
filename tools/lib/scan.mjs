import fs from 'node:fs';
import path from 'node:path';
import { HASH_ALGO } from './constants.mjs';
import { loadConfig, configDigest } from './config.mjs';
import { discover } from './discover.mjs';
import { classifyPath, compileCategoryRules } from './classify.mjs';
import { hashContent, makeFingerprint } from './fingerprint.mjs';
import { adapterFor } from './languages/registry.mjs';
import { parseJsonc } from './json.mjs';
import { cmp, countBy } from './util.mjs';

const GENERATED_HEADER = /@generated\b|DO NOT EDIT/;
const README = /^README(\.[A-Za-z]+)?$/i;
const TSCONFIG = /^(ts|js)config(\.[\w.-]+)?\.json$/;

function firstParagraph(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (const raw of lines) {
    const l = raw.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim();
    if (l && !/^(\[!\[|<|!\[|---|===)/.test(l)) return l.length > 200 ? l.slice(0, 197) + '...' : l;
  }
  return null;
}

function summarizePackage(obj) {
  const leaves = [];
  const collect = (v) => {
    if (typeof v === 'string') leaves.push(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) collect(x);
  };
  collect(obj.exports);
  const bin = typeof obj.bin === 'string' ? [obj.bin] : obj.bin && typeof obj.bin === 'object' ? Object.values(obj.bin).filter((x) => typeof x === 'string') : [];
  const deps = new Set([
    ...Object.keys(obj.dependencies ?? {}),
    ...Object.keys(obj.devDependencies ?? {}),
    ...Object.keys(obj.peerDependencies ?? {}),
  ]);
  const ws = Array.isArray(obj.workspaces) ? obj.workspaces : Array.isArray(obj.workspaces?.packages) ? obj.workspaces.packages : null;
  return {
    name: typeof obj.name === 'string' ? obj.name : null,
    description: typeof obj.description === 'string' ? obj.description : null,
    main: typeof obj.main === 'string' ? obj.main : null,
    module: typeof obj.module === 'string' ? obj.module : null,
    types: typeof obj.types === 'string' ? obj.types : typeof obj.typings === 'string' ? obj.typings : null,
    bin,
    exportsLeaves: leaves.filter((l) => l.startsWith('.')).sort(cmp),
    workspaces: ws?.filter((w) => typeof w === 'string') ?? null,
    dependencies: [...deps].sort(cmp),
  };
}

function readFile(abs, rel, diagnostics) {
  try {
    return fs.readFileSync(abs);
  } catch (e) {
    diagnostics.push({ path: rel, severity: 'error', parser: 'scan', code: 'unreadable-file', message: e.code ?? e.message });
    return null;
  }
}

/**
 * Scan a project once: discover files, fingerprint each (one read per file), parse supported languages
 * (reusing cached facts when the hash and adapter version match), and collect package and tsconfig facts.
 *
 * options: { config, previous: {index, cache}, parse (default true), now }
 */
export function scanProject(rootInput, options = {}) {
  const root = path.resolve(rootInput);
  const cfg = options.config ?? loadConfig(root);
  const now = options.now ?? new Date().toISOString();
  const previous = options.previous ?? { index: null, cache: null };
  const wantParse = options.parse !== false;
  const diagnostics = [];
  const disc = discover(root, cfg, diagnostics);
  const rules = compileCategoryRules(cfg);
  const files = [];
  const packages = new Map();
  const tsconfigs = new Map();
  let parsedFresh = 0;
  let parsedCached = 0;

  for (const entry of disc.files) {
    const rel = entry.rel;
    const abs = path.join(root, rel);
    const ext = path.extname(rel).toLowerCase();
    const base = path.posix.basename(rel);
    const { language, category: initialCategory } = classifyPath(rel, ext, cfg, rules);
    let category = initialCategory;
    const mtime = new Date(Math.floor(entry.mtimeMs)).toISOString();
    const rec = {
      path: rel,
      ext,
      language,
      category,
      size: entry.size,
      mtime,
      fingerprint: null,
      parse: null,
      parseStatus: 'n/a',
      adapter: null,
      hint: null,
      fresh: false,
      cacheEntry: null,
    };

    // 1. fingerprint (one read per file)
    let buffer = null;
    const prev = previous.index?.filesByPath?.get(rel);
    if (cfg.trustMtime && prev?.fingerprint?.hash && prev.size === entry.size && prev.mtime === mtime) {
      rec.fingerprint = { ...prev.fingerprint, mtime };
    } else if (entry.size > cfg.maxHashBytes) {
      rec.fingerprint = makeFingerprint({ hash: null, size: entry.size, mtime, reason: 'too-large' });
      diagnostics.push({ path: rel, severity: 'info', parser: 'scan', code: 'metadata-only-too-large', message: `larger than maxHashBytes (${cfg.maxHashBytes}); not read` });
    } else {
      buffer = readFile(abs, rel, diagnostics);
      if (buffer) {
        const { hash, normalization } = hashContent(buffer);
        rec.fingerprint = makeFingerprint({ hash, normalization, size: entry.size, mtime });
      } else {
        rec.fingerprint = makeFingerprint({ hash: null, size: entry.size, mtime, reason: 'unreadable' });
      }
    }

    // 2. generated-code header
    if (buffer && (category === 'source' || category === 'unknown') && language) {
      if (GENERATED_HEADER.test(buffer.toString('latin1', 0, Math.min(buffer.length, 400)))) category = 'generated';
    }

    // 3. parse supported languages
    if (wantParse && (category === 'source' || category === 'test' || category === 'generated') && language) {
      const adapter = adapterFor(language);
      rec.adapter = { id: adapter.id, version: adapter.version };
      if (!adapter.supportsDependencies) {
        rec.parseStatus = 'unsupported';
      } else if (entry.size > cfg.maxParseBytes) {
        rec.parseStatus = 'skipped-too-large';
        diagnostics.push({ path: rel, severity: 'info', parser: adapter.id, code: 'parse-skipped-too-large', message: `larger than maxParseBytes (${cfg.maxParseBytes}); metadata only` });
      } else {
        const cached = previous.cache?.files?.[rel];
        if (rec.fingerprint.hash && cached && cached.hash === rec.fingerprint.hash && cached.adapter === adapter.id && cached.adapterVersion === adapter.version) {
          rec.parse = cached.facts;
          rec.parseStatus = cached.facts.status;
          rec.fromCache = true;
          rec.cacheEntry = cached;
          parsedCached++;
        } else {
          if (!buffer) buffer = readFile(abs, rel, diagnostics);
          if (buffer) {
            try {
              const facts = adapter.analyze(buffer.toString('utf8'), { path: rel, language });
              rec.parse = facts;
              rec.parseStatus = facts.status;
              rec.fresh = true;
              parsedFresh++;
              if (rec.fingerprint.hash) {
                rec.cacheEntry = { hash: rec.fingerprint.hash, adapter: adapter.id, adapterVersion: adapter.version, facts };
              }
            } catch (e) {
              rec.parseStatus = 'failed';
              diagnostics.push({ path: rel, severity: 'error', parser: adapter.id, code: 'adapter-exception', message: String(e.message ?? e) });
            }
          } else {
            rec.parseStatus = 'failed';
          }
        }
        if (rec.parse) {
          rec.hint = rec.parse.purposeHint ?? null;
          for (const d of rec.parse.diagnostics) diagnostics.push({ path: rel, parser: adapter.id, ...d });
        }
      }
    }

    // 4. package manifests, tsconfig files, README hints
    if (buffer) {
      if (base === 'package.json') {
        try {
          packages.set(rel, summarizePackage(JSON.parse(buffer.toString('utf8'))));
        } catch (e) {
          diagnostics.push({ path: rel, severity: 'warning', parser: 'package-json', code: 'invalid-json', message: String(e.message) });
        }
      } else if (TSCONFIG.test(base)) {
        try {
          const raw = parseJsonc(buffer.toString('utf8'));
          tsconfigs.set(rel, {
            extends: typeof raw.extends === 'string' ? raw.extends : null,
            baseUrl: typeof raw.compilerOptions?.baseUrl === 'string' ? raw.compilerOptions.baseUrl : null,
            paths: raw.compilerOptions?.paths && typeof raw.compilerOptions.paths === 'object' ? raw.compilerOptions.paths : null,
          });
        } catch (e) {
          diagnostics.push({ path: rel, severity: 'warning', parser: 'tsconfig', code: 'invalid-json', message: String(e.message) });
        }
      } else if (README.test(base) && entry.size <= 200 * 1024) {
        rec.hint = firstParagraph(buffer.toString('utf8'));
      }
    }

    rec.category = category;
    files.push(rec);
  }

  files.sort((a, b) => cmp(a.path, b.path));
  diagnostics.sort((a, b) => cmp(a.path ?? '', b.path ?? '') || cmp(a.code ?? '', b.code ?? '') || cmp(a.message ?? '', b.message ?? ''));

  return {
    root,
    config: cfg,
    configDigest: configDigest(cfg),
    generatedAt: now,
    hashAlgo: HASH_ALGO,
    files,
    dirs: disc.dirs,
    withheld: disc.withheld,
    ignored: disc.ignored,
    ignoredFileCount: disc.ignoredFiles,
    packages,
    tsconfigs,
    diagnostics,
    stats: {
      files: files.length,
      byCategory: countBy(files, (f) => f.category),
      byLanguage: countBy(files.filter((f) => f.language), (f) => f.language),
      parsedFresh,
      parsedCached,
      withheld: disc.withheld.length,
      ignoredDirectories: disc.ignored.length,
      ignoredFiles: disc.ignoredFiles,
    },
  };
}
