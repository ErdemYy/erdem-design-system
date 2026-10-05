import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG_FILE } from './constants.mjs';
import { parseJsonc, stableStringify } from './json.mjs';

/** Directories and files that are not read by default (gitignore syntax). */
export const DEFAULT_IGNORES = Object.freeze([
  'node_modules/',
  '.git/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.vercel/',
  '.cache/',
  'cache/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  'vendor/',
  'tmp/',
  'temp/',
  'temporary/',
  '.tmp/',
  'generated/',
  '__generated__/',
  '__pycache__/',
  '.venv/',
  'venv/',
  '.gradle/',
  '.dart_tool/',
  '.idea/',
  '.vscode/',
  '.vs/',
  '/target/',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
]);

/** Every value here is a configurable default, not a claim about any project. */
export const DEFAULTS = Object.freeze({
  outputDir: '.ai',
  useDefaultIgnores: true,
  respectGitignore: true,
  ignore: [],
  secretPatterns: [],
  maxHashBytes: 5 * 1024 * 1024,
  maxParseBytes: 1024 * 1024,
  trustMtime: false,
  categoryRules: [],
  languageOverrides: {},
  subsystemRoots: ['src', 'packages', 'apps', 'libs', 'modules', 'services'],
  entryPoints: [],
  publicSurface: { patterns: [], sharedMinSubsystems: 3, frameworks: true },
  important: { patterns: [], minFanIn: 3, maxFiles: 60 },
  directories: { patterns: [], maxIndexes: 40, minSourceFiles: 2 },
  risk: { fanInMedium: 3, fanInHigh: 10, rules: [] },
  graph: { maxNodes: 60, includeTests: false, includeExternal: false, explicitEdges: [], maxSubsystemViews: 20 },
  summaries: { max: 50 },
  profile: 'auto',
  profileThresholds: { lite: 40, standard: 400 },
});

export class ConfigError extends Error {}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function expect(problems, cond, message) {
  if (!cond) problems.push(message);
}

export function validateConfig(cfg) {
  const p = [];
  const strArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const posInt = (v) => Number.isInteger(v) && v > 0;
  expect(p, typeof cfg.outputDir === 'string' && cfg.outputDir.length > 0, 'outputDir must be a non-empty string');
  if (typeof cfg.outputDir === 'string') {
    const norm = path.posix.normalize(cfg.outputDir.replace(/\\/g, '/'));
    expect(p, !path.isAbsolute(cfg.outputDir) && !norm.startsWith('..') && norm !== '.', 'outputDir must be a relative directory inside the project');
  }
  expect(p, typeof cfg.useDefaultIgnores === 'boolean', 'useDefaultIgnores must be a boolean');
  expect(p, typeof cfg.respectGitignore === 'boolean', 'respectGitignore must be a boolean');
  expect(p, strArr(cfg.ignore), 'ignore must be an array of strings');
  expect(p, strArr(cfg.secretPatterns), 'secretPatterns must be an array of strings');
  expect(p, posInt(cfg.maxHashBytes), 'maxHashBytes must be a positive integer');
  expect(p, posInt(cfg.maxParseBytes), 'maxParseBytes must be a positive integer');
  expect(p, typeof cfg.trustMtime === 'boolean', 'trustMtime must be a boolean');
  expect(p, strArr(cfg.subsystemRoots), 'subsystemRoots must be an array of strings');
  expect(p, strArr(cfg.entryPoints), 'entryPoints must be an array of strings');
  expect(p, Array.isArray(cfg.categoryRules) && cfg.categoryRules.every((r) => r && typeof r.pattern === 'string' && typeof r.category === 'string'), 'categoryRules must be [{pattern, category}]');
  expect(p, Array.isArray(cfg.risk.rules) && cfg.risk.rules.every((r) => r && typeof r.pattern === 'string' && ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(r.level)), 'risk.rules must be [{pattern, level: LOW|MEDIUM|HIGH|CRITICAL, reason?}]');
  expect(p, Array.isArray(cfg.graph.explicitEdges) && cfg.graph.explicitEdges.every((e) => e && typeof e.source === 'string' && typeof e.target === 'string'), 'graph.explicitEdges must be [{source, target}]');
  expect(p, posInt(cfg.graph.maxNodes), 'graph.maxNodes must be a positive integer');
  expect(p, posInt(cfg.publicSurface.sharedMinSubsystems), 'publicSurface.sharedMinSubsystems must be a positive integer');
  expect(p, ['auto', 'none', 'lite', 'standard', 'full'].includes(cfg.profile), 'profile must be auto, none, lite, standard or full');
  if (p.length) throw new ConfigError('Invalid configuration:\n  - ' + p.join('\n  - '));
  return cfg;
}

/** Load the effective configuration for a project: defaults, then the optional config file, then overrides. */
export function loadConfig(root, { configPath, overrides } = {}) {
  let fromFile = {};
  const file = configPath ? path.resolve(configPath) : path.join(root, CONFIG_FILE);
  if (fs.existsSync(file)) {
    try {
      fromFile = parseJsonc(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new ConfigError(`Cannot parse ${file}: ${e.message}`);
    }
    if (!isPlainObject(fromFile)) throw new ConfigError(`${file} must contain a JSON object`);
  } else if (configPath) {
    throw new ConfigError(`Config file not found: ${file}`);
  }
  const cfg = deepMerge(deepMerge(DEFAULTS, fromFile), overrides ?? {});
  cfg.outputDir = path.posix.normalize(String(cfg.outputDir).replace(/\\/g, '/')).replace(/\/$/, '');
  return validateConfig(cfg);
}

/** Digest of the effective configuration; part of derived-artifact metadata. */
export function configDigest(cfg) {
  return createHash('sha256').update(stableStringify(cfg)).digest('hex');
}
