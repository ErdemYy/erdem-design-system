import { SCHEMA, TOOL } from './constants.mjs';
import { readJsonIfExists } from './write.mjs';

export const INDEX_FILE = 'index.json';
export const CACHE_FILE = 'state/parse-cache.json';
export const REPORT_FILE = 'state/report.json';

/**
 * Previous derived state used for incremental runs: the last index (for the optional size/mtime pre-check)
 * and the parse cache (facts per file keyed by content hash and adapter version). Unreadable or
 * incompatible state is ignored, never trusted.
 */
export function loadPrevious(root, cfg) {
  const index = readJsonIfExists(root, `${cfg.outputDir}/${INDEX_FILE}`);
  const cache = readJsonIfExists(root, `${cfg.outputDir}/${CACHE_FILE}`);
  const validIndex = index && index.schema === 'erdem.index' && index.schemaVersion === SCHEMA.index && Array.isArray(index.files) ? index : null;
  const validCache = cache && cache.schema === 'erdem.parse-cache' && cache.schemaVersion === SCHEMA.cache && cache.files ? cache : null;
  return {
    index: validIndex ? { ...validIndex, filesByPath: new Map(validIndex.files.map((f) => [f.path, f])) } : null,
    cache: validCache,
  };
}

/** Parse cache for the next run: one entry per file whose facts are known. */
export function buildCache(scan, now) {
  const files = {};
  for (const f of scan.files) if (f.cacheEntry) files[f.path] = f.cacheEntry;
  return { schema: 'erdem.parse-cache', schemaVersion: SCHEMA.cache, tool: TOOL, generatedAt: now, files };
}
