import { javascriptAdapter } from './javascript.mjs';
import { genericAdapter } from './generic.mjs';

/**
 * Language adapter registry.
 *
 * Adapter contract:
 *   id, version, languages[], supportsDependencies
 *   analyze(sourceText, {path, language}) -> {status, supported, imports[], reexports[], exports[], diagnostics[], purposeHint}
 *   createResolver(project)               -> (specifier, fromPath) => {kind, ...} | null
 * Adding a language means adding one module and listing it here. Adapters for Python, Dart, Java and C#
 * are planned and do NOT exist yet; those languages use the generic metadata-only fallback.
 */
const ADAPTERS = [javascriptAdapter];

export function adapterFor(language) {
  if (language) for (const a of ADAPTERS) if (a.languages.includes(language)) return a;
  return genericAdapter;
}

export function listAdapters() {
  return [...ADAPTERS, genericAdapter].map((a) => ({ id: a.id, version: a.version, languages: a.languages, supportsDependencies: a.supportsDependencies }));
}
