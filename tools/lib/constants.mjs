export const TOOL = Object.freeze({ name: 'project-intel', version: '0.1.0' });

/** Stable schema versions of the persisted formats. */
export const SCHEMA = Object.freeze({
  index: 1,
  summary: 1,
  graph: 1,
  fingerprint: 1,
  cache: 1,
  report: 1,
});

export const HASH_ALGO = 'sha256';

export const NORMALIZATION = Object.freeze({
  text: 'text-lf-nobom',
  binary: 'binary-raw',
});

export const CONFIG_FILE = 'project-intel.config.json';
