/**
 * Static tables for context routing. They map task facts to canonical documents and graph questions to the
 * capability matrix. They restate no rule: each row points at the document that owns the rule, and tests compare
 * these tables with those documents (ai/TASK_ROUTING.md, ai/CONTEXT_PROTOCOL.md → Design system selective loading,
 * tools/analyze/README.md → Capability matrix).
 */

/** Context levels (ai/CONTEXT_PROTOCOL.md → Expansion levels). */
export const CONTEXT_LEVELS = Object.freeze([
  { level: 0, name: 'Root orientation' },
  { level: 1, name: 'Task scope' },
  { level: 2, name: 'Subsystem' },
  { level: 3, name: 'Target' },
  { level: 4, name: 'Impact' },
  { level: 5, name: 'Architecture' },
]);

/** The five sufficiency questions (ai/CONTEXT_PROTOCOL.md → Sufficiency). */
export const SUFFICIENCY_QUESTIONS = Object.freeze({
  1: 'What file(s) must change?',
  2: 'Why do they need to change?',
  3: 'What constraints apply?',
  4: 'What depends on them?',
  5: 'What validation is required?',
});

/** Default depth ceiling per class (ai/TASK_ROUTING.md). LARGE may reach Level 5 only partially and with a stated reason. */
export const CLASS_CEILING = Object.freeze({ TRIVIAL: 3, SMALL: 3, MEDIUM: 4, LARGE: 4, ARCHITECTURAL: 5 });
export const CLASS_SCOPE = Object.freeze({ TRIVIAL: 'MINIMAL', SMALL: 'TARGETED', MEDIUM: 'SUBSYSTEM', LARGE: 'CROSS-SYSTEM', ARCHITECTURAL: 'ARCHITECTURAL' });

/** Task types (ai/TASK_ROUTING.md → Task types), as keys. */
export const TASK_TYPES = Object.freeze({
  ui: 'UI change',
  bugfix: 'bug fix',
  feature: 'feature',
  refactor: 'refactor',
  performance: 'performance',
  architecture: 'architecture',
  documentation: 'documentation',
  dependency: 'dependency',
  configuration: 'configuration',
  migration: 'migration',
  test: 'test',
  security: 'security',
});

/** Validation depth per class (ai/AUTOMATION_PROTOCOL.md → Validation); raised by risk through ai/VALIDATION_PROTOCOL.md. */
export const CLASS_VALIDATION_DEPTH = Object.freeze({ TRIVIAL: 0, SMALL: 1, MEDIUM: 2, LARGE: 3, ARCHITECTURAL: 4 });

/** Reasons that allow going beyond the class ceiling (ai/CONTEXT_PROTOCOL.md: "a stated reason"). */
export const ESCALATION_REASONS = Object.freeze([
  'dependency-uncertainty',
  'risk',
  'public-surface',
  'configuration-or-api-impact',
  'validation',
  'scope-growth',
  'security-boundary',
  'migration',
  'architectural-dependency',
]);

/** Concerns of the design system, each to the document that owns its rules (core/). */
export const DESIGN_CONCERNS = Object.freeze({
  principles: ['core/DESIGN_PRINCIPLES.md'],
  tokens: ['core/DESIGN_TOKENS.md'],
  'token-values': ['core/TOKEN_REGISTER.md'],
  typography: ['core/TYPOGRAPHY.md'],
  color: ['core/COLOR_SYSTEM.md'],
  spacing: ['core/SPACING_SYSTEM.md'],
  layout: ['core/LAYOUT_SYSTEM.md'],
  motion: ['core/MOTION_SYSTEM.md'],
  components: ['core/COMPONENT_SYSTEM.md'],
  content: ['core/CONTENT_GUIDELINES.md'],
  accessibility: ['core/ACCESSIBILITY.md'],
  quality: ['core/QUALITY_STANDARD.md'],
  origin: ['core/EVIDENCE.md', 'core/DESIGN_DECISIONS.md'],
});

/** Platform guidance: only the target platform's file(s) (ai/CONTEXT_PROTOCOL.md → Design system selective loading). */
export const PLATFORM_SOURCES = Object.freeze({
  web: ['platforms/WEB.md'],
  mobile: ['platforms/MOBILE.md'],
  flutter: ['platforms/MOBILE.md', 'platforms/FLUTTER.md'],
  'react-native': ['platforms/MOBILE.md', 'platforms/REACT_NATIVE.md'],
  desktop: ['platforms/DESKTOP.md'],
  'webgl-3d': ['platforms/WEBGL_3D.md'],
});

/** Concerns a platform brings with it (the canonical 3D row: WEBGL_3D, MOTION_SYSTEM, ACCESSIBILITY). */
export const PLATFORM_IMPLIED_CONCERNS = Object.freeze({ 'webgl-3d': ['motion', 'accessibility'] });

/** Protocol documents for a security-sensitive task (AI safety, modification, validation, secrets policy). */
export const SECURITY_SOURCES = Object.freeze(['ai/SAFE_MODIFICATION.md', 'ai/VALIDATION_PROTOCOL.md', 'ai/TOKEN_EFFICIENCY.md']);

/**
 * Graph questions and how each can be answered, from the capability matrix in tools/analyze/README.md.
 * cli: arguments for `project-intel` (read-only). cliWritesDerived: the only command form writes derived files, so
 * routing never plans it. library: the function in analyze/query.mjs. data: answer is in graph.json.
 * matrixRow: the first words of the row in the matrix (a test compares them).
 */
export const GRAPH_QUERIES = Object.freeze({
  dependencies: { matrixRow: 'Direct dependencies of a file', cli: ['impact', '<target>', '--json'], field: 'dependencies', library: 'getDependencies' },
  'transitive-dependencies': { matrixRow: 'Transitive dependencies', library: 'getTransitiveDependencies' },
  dependents: { matrixRow: 'Direct dependents', cli: ['impact', '<target>', '--json'], field: 'directDependents', library: 'getDependents' },
  'transitive-dependents': { matrixRow: 'Transitive dependents with distance', cli: ['impact', '<target>', '--json'], field: 'affected', library: 'getTransitiveDependents' },
  neighborhood: { matrixRow: 'Neighborhood', cliWritesDerived: ['graph', '--view', 'file', '--target', '<target>'], library: 'getNeighborhood', substitute: 'dependents' },
  impact: { matrixRow: 'Impact', cli: ['impact', '<target>', '--json'], library: 'getImpact' },
  tests: { matrixRow: 'Tests affected', cli: ['impact', '<target>', '--json'], field: 'tests', library: 'getTests' },
  'public-surface': { matrixRow: 'Public surface of the target', cli: ['impact', '<target>', '--json'], field: 'publicSurface', library: 'isPublicSurface' },
  risk: { matrixRow: 'Risk', cli: ['impact', '<target>', '--json'], field: 'risk', library: 'getRisk' },
  cycles: { matrixRow: 'Cycles', cli: ['impact', '<target>', '--json'], field: 'inCycle', data: 'cycles', library: 'getCycles' },
  'shortest-path': { matrixRow: 'Shortest dependency chain', library: 'shortestPath' },
});

/** Search used instead of a graph query when the graph is not trustworthy (ai/CHANGE_IMPACT.md → Dimensions). */
export const SEARCH_FALLBACK = Object.freeze({
  dependencies: 'the target\'s imports and references',
  dependents: 'the target\'s path, module name and exported symbols',
  consumers: 'the target\'s path, module name and exported symbols',
  tests: 'test paths for the target\'s names; nearby test files',
  config: 'the target\'s names in config files (never print secret values)',
  data: 'the types and table, collection or key names the target reads or writes',
  platform: 'platform-specific files and conditionals',
  api: 'exported names, route definitions, type definitions',
  'design-system': 'token names and theme files',
});

/** Root-level files that help orientation when no index can be trusted; matched only against names the caller listed. */
export const ORIENTATION_CANDIDATES = Object.freeze([/^readme(\.\w+)?$/i, /^(agents|claude|gemini)\.md$/i, /^package\.json$/i, /^pubspec\.yaml$/i, /^pyproject\.toml$/i, /^cargo\.toml$/i, /^go\.mod$/i, /^pom\.xml$/i]);

/** Facts about a task that raise class, risk, ceiling or impact need. The caller states them; routing never infers them from text. */
export const SIGNALS = Object.freeze([
  'publicSurface', 'crossSubsystem', 'layerBoundary', 'dependencyUncertain', 'sharedDependency', 'buildOrRuntime', 'dataLoss',
  'securityBoundary', 'architectureUnresolved', 'maybeShared', 'configImpact', 'apiImpact', 'dataImpact', 'platformImpact', 'designSystemImpact',
]);

/** Which derived artifact kinds each index profile produces (ai/INDEX_PROTOCOL.md → Scale-down); the others are not missing, just not expected. */
export const PROFILE_KINDS = Object.freeze({
  none: ['graph', 'index'],
  lite: ['graph', 'index'],
  standard: ['graph', 'index', 'directoryIndex'],
  full: ['graph', 'index', 'directoryIndex', 'fileIndex', 'summary'],
});
