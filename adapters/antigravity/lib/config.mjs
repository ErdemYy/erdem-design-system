import path from 'node:path';
import { readJson, splitCommand } from './helpers.mjs';

/**
 * Antigravity adapter configuration (schema v1). No source edits are required.
 * Precedence, highest first: environment variables, project file (.agents/erdem-adapter.json),
 * user file (<config home>/erdem-adapter/config.json), defaults.
 */
export const CONFIG_SCHEMA_VERSION = 1;

export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  designSystemRoot: null, // checkout or installation of the design system; relative = project-local copy
  projectIntelCommand: null, // string or argv array; default: the engine inside the design-system root, run with node
  preferredProfile: 'auto', // index profile used when refreshing
});

const ENV = {
  ERDEM_DESIGN_SYSTEM_ROOT: ['designSystemRoot', (v) => v],
  ERDEM_PROJECT_INTEL: ['projectIntelCommand', (v) => splitCommand(v)],
  ERDEM_PREFERRED_PROFILE: ['preferredProfile', (v) => v],
};

const RULES = {
  designSystemRoot: (v) => v === null || (typeof v === 'string' && v.length > 0),
  projectIntelCommand: (v) => v === null || (typeof v === 'string' && v.length > 0) || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')),
  preferredProfile: (v) => ['auto', 'none', 'lite', 'standard', 'full'].includes(v),
};

export function validateConfig(input, label) {
  const clean = {};
  const errors = [];
  const warnings = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { clean, errors: [`${label}: must be a JSON object`], warnings };
  for (const [k, v] of Object.entries(input)) {
    if (k === 'schemaVersion') {
      if (v !== CONFIG_SCHEMA_VERSION) errors.push(`${label}: schemaVersion ${JSON.stringify(v)} is not supported (expected ${CONFIG_SCHEMA_VERSION})`);
    } else if (!(k in RULES)) warnings.push(`${label}: unknown key "${k}" ignored`);
    else if (!RULES[k](v)) errors.push(`${label}: invalid value for "${k}"`);
    else clean[k] = v;
  }
  return { clean, errors, warnings };
}

/** Invalid or unreadable files are reported and ignored; a bad config degrades the adapter, never breaks it. */
export function loadAdapterConfig({ env = process.env, userConfigPath, projectConfigPath } = {}) {
  const config = { ...DEFAULT_CONFIG };
  const sources = Object.fromEntries(Object.keys(DEFAULT_CONFIG).map((k) => [k, 'default']));
  const errors = [];
  const warnings = [];
  const apply = (layer, name, baseDir) => {
    for (const [k, v] of Object.entries(layer)) {
      config[k] = k === 'designSystemRoot' && typeof v === 'string' && !path.isAbsolute(v) ? path.resolve(baseDir, v) : v;
      sources[k] = name;
    }
  };
  for (const [file, name] of [[userConfigPath, 'user'], [projectConfigPath, 'project']]) {
    if (!file) continue;
    const r = readJson(file);
    if (!r.exists) continue;
    if (r.error) {
      errors.push(`${file}: invalid JSON (${r.error})`);
      continue;
    }
    const v = validateConfig(r.data, file);
    errors.push(...v.errors);
    warnings.push(...v.warnings);
    // a relative root in the project file means a project-local copy, anchored at the project directory
    apply(v.clean, name, name === 'project' ? path.dirname(path.dirname(file)) : path.dirname(file));
  }
  const fromEnv = {};
  for (const [name, [key, convert]] of Object.entries(ENV)) if (env[name] !== undefined && env[name] !== '') fromEnv[key] = convert(env[name]);
  const v = validateConfig(fromEnv, 'environment');
  errors.push(...v.errors);
  apply(v.clean, 'env', process.cwd());
  return { config, sources, errors, warnings };
}
