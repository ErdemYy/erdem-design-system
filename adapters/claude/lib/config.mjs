import path from 'node:path';
import { readJson, splitCommand } from './util.mjs';

/**
 * Adapter configuration (schema v1). No source edits are ever required.
 * Precedence, highest first: environment variables, project override file, user config file, defaults.
 */
export const CONFIG_SCHEMA_VERSION = 1;

export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  designSystemRoot: null, // path to a checkout or installation of the design system
  autoStatus: 'light', // session-start check: off | light (no content reads) | verify (time-boxed real status)
  autoSkill: true, // false: the skill is installed for explicit /erdem use only
  autoSessionHandoff: false, // true: the session-start line asks for a handoff when meaningful work ends
  projectIntelCommand: null, // string or argv array; default: <root>/tools/bin/project-intel.mjs run with node
  preferredProfile: 'auto', // index profile used when the skill refreshes the index
  hookWhenUnavailable: 'line', // line | silent: what the hook prints when no project intelligence exists
});

const ENV = {
  ERDEM_DESIGN_SYSTEM_ROOT: ['designSystemRoot', (v) => v],
  ERDEM_AUTO_STATUS: ['autoStatus', (v) => v],
  ERDEM_AUTO_SKILL: ['autoSkill', (v) => parseBool(v)],
  ERDEM_AUTO_HANDOFF: ['autoSessionHandoff', (v) => parseBool(v)],
  ERDEM_PROJECT_INTEL: ['projectIntelCommand', (v) => splitCommand(v)],
  ERDEM_PREFERRED_PROFILE: ['preferredProfile', (v) => v],
};

function parseBool(v) {
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  return v; // left invalid so validation reports it
}

const RULES = {
  designSystemRoot: (v) => v === null || (typeof v === 'string' && v.length > 0),
  autoStatus: (v) => ['off', 'light', 'verify'].includes(v),
  autoSkill: (v) => typeof v === 'boolean',
  autoSessionHandoff: (v) => typeof v === 'boolean',
  projectIntelCommand: (v) => v === null || (typeof v === 'string' && v.length > 0) || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')),
  preferredProfile: (v) => ['auto', 'none', 'lite', 'standard', 'full'].includes(v),
  hookWhenUnavailable: (v) => ['line', 'silent'].includes(v),
};

/** Validate a partial config. Returns {clean, errors, warnings}; invalid values are dropped, never used. */
export function validateConfig(input, label) {
  const clean = {};
  const errors = [];
  const warnings = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { clean, errors: [`${label}: must be a JSON object`], warnings };
  }
  for (const [k, v] of Object.entries(input)) {
    if (k === 'schemaVersion') {
      if (v !== CONFIG_SCHEMA_VERSION) errors.push(`${label}: schemaVersion ${JSON.stringify(v)} is not supported (expected ${CONFIG_SCHEMA_VERSION})`);
    } else if (!(k in RULES)) warnings.push(`${label}: unknown key "${k}" ignored`);
    else if (!RULES[k](v)) errors.push(`${label}: invalid value for "${k}"`);
    else clean[k] = v;
  }
  return { clean, errors, warnings };
}

/** Resolve a relative designSystemRoot against the file that declared it. */
function anchorRoot(value, baseDir) {
  if (typeof value !== 'string' || path.isAbsolute(value)) return value;
  return path.resolve(baseDir, value);
}

/**
 * Load the effective configuration.
 * files: {userConfigPath, projectConfigPath?}. Missing files are fine; unreadable or invalid files are reported
 * in `errors` and ignored, so a bad config can degrade the adapter but never break a session.
 */
export function loadAdapterConfig({ env = process.env, userConfigPath, projectConfigPath } = {}) {
  const config = { ...DEFAULT_CONFIG };
  const sources = Object.fromEntries(Object.keys(DEFAULT_CONFIG).map((k) => [k, 'default']));
  const errors = [];
  const warnings = [];
  const apply = (layer, name, baseDir) => {
    for (const [k, v] of Object.entries(layer)) {
      config[k] = k === 'designSystemRoot' ? anchorRoot(v, baseDir) : v;
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
    apply(v.clean, name, path.dirname(file));
  }
  const fromEnv = {};
  for (const [name, [key, convert]] of Object.entries(ENV)) {
    if (env[name] !== undefined && env[name] !== '') fromEnv[key] = convert(env[name]);
  }
  const v = validateConfig(fromEnv, 'environment');
  errors.push(...v.errors);
  apply(v.clean, 'env', process.cwd());
  return { config, sources, errors, warnings };
}
