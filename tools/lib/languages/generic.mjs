/**
 * Generic fallback adapter: metadata only. It creates no dependency edges and makes no claims about
 * the file's contents. Relationships for unsupported languages can only come from explicit project
 * configuration (`graph.explicitEdges`).
 */
export const genericAdapter = Object.freeze({
  id: 'generic',
  version: '1',
  languages: ['*'],
  supportsDependencies: false,
  analyze() {
    return { status: 'unsupported', supported: false, imports: [], reexports: [], exports: [], diagnostics: [], purposeHint: null };
  },
  createResolver() {
    return null;
  },
});
