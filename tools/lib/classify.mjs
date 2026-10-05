import path from 'node:path';
import { createMatcher } from './glob.mjs';

/** extension -> language. Languages without an adapter are handled by the generic fallback. */
export const LANGUAGE_BY_EXT = Object.freeze({
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.dart': 'dart',
  '.java': 'java',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.html': 'html',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.sql': 'sql',
  '.sh': 'shell',
  '.ps1': 'powershell',
  '.glsl': 'glsl',
  '.wgsl': 'wgsl',
});

const DOC_EXT = new Set(['.md', '.mdx', '.rst', '.adoc', '.txt']);
const ASSET_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp', '.tiff',
  '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg', '.flac',
  '.glb', '.gltf', '.fbx', '.obj', '.stl', '.hdr', '.ktx2',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.pdf',
]);
const CONFIG_EXT = new Set(['.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf']);
const CONFIG_BASENAMES = new Set([
  'package.json', 'Dockerfile', 'Makefile', 'pyproject.toml', 'pubspec.yaml', 'pom.xml', 'go.mod', 'Cargo.toml',
  '.gitignore', '.editorconfig', '.babelrc', 'vercel.json', 'netlify.toml', 'project-intel.config.json',
]);
const CONFIG_REGEX = [
  /^tsconfig(\.[\w.-]+)?\.json$/,
  /^jsconfig(\.[\w.-]+)?\.json$/,
  /^[\w.-]*\.config\.(js|cjs|mjs|ts|mts|cts|json)$/,
  /^\.eslintrc(\.[\w]+)?$/,
  /^\.prettierrc(\.[\w]+)?$/,
  /^Dockerfile(\.[\w.-]+)?$/,
  /^docker-compose(\.[\w.-]+)?\.ya?ml$/,
  /^build\.gradle(\.kts)?$/,
  /\.csproj$/,
  /\.sln$/,
];
const GENERATED_REGEX = [
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.generated\./,
  /\.gen\./,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock)$/,
];
const TEST_REGEX = [
  /(^|\/)(__tests__|tests?|spec|e2e)\//,
  /\.(test|spec)\.[^/]+$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(go|py|dart|rs)$/,
  /Tests?\.(java|cs|kt)$/,
];

export function languageOf(ext, cfg) {
  return cfg.languageOverrides[ext] ?? LANGUAGE_BY_EXT[ext] ?? null;
}

/** Classify by path; project categoryRules win. A header check for generated code happens during the scan. */
export function classifyPath(rel, ext, cfg, ruleMatchers) {
  const language = languageOf(ext, cfg);
  const base = path.posix.basename(rel);
  for (const { match, category } of ruleMatchers) {
    if (match(rel, false)) return { language, category };
  }
  if (GENERATED_REGEX.some((r) => r.test(rel))) return { language, category: 'generated' };
  if (ASSET_EXT.has(ext)) return { language: null, category: 'asset' };
  if (TEST_REGEX.some((r) => r.test(rel)) && language) return { language, category: 'test' };
  if (CONFIG_BASENAMES.has(base) || CONFIG_REGEX.some((r) => r.test(base))) {
    return { language, category: 'config' };
  }
  if (language) return { language, category: 'source' };
  if (DOC_EXT.has(ext) || /^(README|LICENSE|CHANGELOG|CONTRIBUTING|CODEOWNERS)/i.test(base)) {
    return { language: null, category: 'documentation' };
  }
  if (CONFIG_EXT.has(ext)) return { language: null, category: 'config' };
  return { language: null, category: 'unknown' };
}

export function compileCategoryRules(cfg) {
  return cfg.categoryRules.map((r) => ({ match: createMatcher([r.pattern]), category: r.category }));
}
