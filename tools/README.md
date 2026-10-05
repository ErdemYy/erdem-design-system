# Tools: project-intel

Offline, deterministic, dependency-free tooling for the Erdem AI Development Protocol (`ai/`). It scans **other** repositories and writes derived context (index, fingerprints, summaries, dependency graph) into a dedicated output directory. It never runs on, and never writes into, this repository's own content.

Standard library only: Node 20 or newer, no `node_modules`, no package manager step. Version `0.1.0`; schema versions in `lib/constants.mjs`.

## Layout

```
tools/
  bin/project-intel.mjs      CLI (thin layer over the API)
  api.mjs                    public library API
  lib/                       shared engine: config, ignore/secrets, discovery, classification,
                             fingerprinting, scan, cache, change-only writers, language adapters
  lib/languages/             adapter registry: javascript (JS and TS), generic fallback
  graph/                     graph build, public surface, risk, cycles, views, Mermaid and DOT   -> graph/README.md
  index/                     AI_INDEX, directory and file indexes, summaries, stale detection    -> index/README.md
  analyze/                   graph query layer and impact                                         -> analyze/README.md
  automation/                automatic refresh, context routing, change impact, validation planning and execution -> automation/README.md
  lib/artifact-paths.mjs     the one set of derived-artifact names (shared by generator, router, refresh)
  validation/                reserved for Phase 5 (design/context/repository validation)
  test/                      test suites and fixture projects
  scripts/                   run-tests.mjs, check.mjs
```

## Commands

```
node tools/bin/project-intel.mjs index  [root] [--profile auto|none|lite|standard|full] [--rehash]
node tools/bin/project-intel.mjs graph  [root] [--view full|subsystem|file|impact --target <path> --depth n --max-nodes n --stdout]
node tools/bin/project-intel.mjs status [root] [--json]
node tools/bin/project-intel.mjs impact <file> [root] [--json]
node tools/bin/project-intel.mjs refresh [root] --relies-on <list> [--scope <paths>] [--class <c>] [--risk <r>] [--event <e>] [--check] [--json]
node tools/bin/project-intel.mjs change-impact [root] --modified <files> [--created <files>] [--deleted <files>] [--renamed old=new] [--class <c>] [--risk <r>] [--phase planned|completed] [--fresh-graph] [--json]
node tools/bin/project-intel.mjs validate [root] --modified <files> [--class <c>] [--risk <r>] [--run] [--confirm <planId>] [--update-state --owner <name>] [--json]
node tools/bin/project-intel.mjs handoff create|resume [root] --owner <name> [--reason <r> --to <name> --next-action <text>] [--accept --confirm <handoffId> [--acknowledge <digest>]] [--json]
node tools/bin/project-intel.mjs route [root] --class <c> --risk <r> --types <list> --targets <paths> [--reached <n>] [--answers 1=read,4=open,..] [--state <s>] [--json]
node tools/bin/project-intel.mjs adapters
```

Exit codes: `0` ok · `1` stale or missing artifacts (`status`), file not found (`impact`), a refresh decision that needs attention (`refresh`) · `2` usage or configuration error. Run `help` for all options. Library use: `import { runIndex, buildProjectGraph, createGraphQuery } from './tools/api.mjs'`.

## Output location

Everything derived goes under `<project>/.ai/` (configurable `outputDir`, must stay inside the project). The directory is the only place the tool writes, it is excluded from scanning, and it can be deleted at any time without losing information (it is regenerated).

```
.ai/AI_INDEX.md                      navigation map (Level 0)
.ai/FILE_INDEX.md                    important files only            (profile full)
.ai/directories/<dir>/DIRECTORY_INDEX.md   meaningful directories     (profile standard, full)
.ai/summaries/{files,directories}/*.json    concise summaries         (profile full)
.ai/index.json                       machine index: every file, category, fingerprint
.ai/graph/graph.json|graph.mmd|graph.dot    full graph and default view
.ai/graph/views/*                    subsystem and on-demand views
.ai/state/parse-cache.json           incremental cache (facts keyed by content hash)
.ai/state/report.json                diagnostics, withheld secret-pattern paths, ignored areas
```

Generated files say so in their header (`generated: true`, tool and schema version, `generatedAt`). Hand-written instructions never go in this directory. Whether to commit it is a project decision; most projects will git-ignore it.

## Configuration

Optional `project-intel.config.json` (comments and trailing commas allowed) in the project root. All values below are configurable defaults, not claims about any project. Invalid configuration fails with a clear message (exit 2).

| Key | Default | Meaning |
|---|---|---|
| `outputDir` | `.ai` | where derived files go (inside the project) |
| `ignore` | `[]` | extra gitignore-style patterns, added to the default ignores |
| `useDefaultIgnores`, `respectGitignore` | `true`, `true` | default ignore list and the root `.gitignore` |
| `secretPatterns` | `[]` | extra patterns treated as secrets (never read) |
| `maxHashBytes` | 5 MiB | larger files are metadata-only (no read, no hash) |
| `maxParseBytes` | 1 MiB | larger files are hashed but not parsed |
| `trustMtime` | `false` | opt-in: skip hashing when size and mtime match the previous index. `status` never uses it |
| `categoryRules`, `languageOverrides` | empty | override file categories or languages |
| `subsystemRoots` | `src packages apps libs modules services` | container directories for subsystem keys |
| `entryPoints`, `publicSurface.patterns`, `important.patterns`, `directories.patterns` | empty | explicit project knowledge |
| `publicSurface.sharedMinSubsystems` | `3` | importing subsystems needed for `shared-module` |
| `risk.fanInMedium`, `risk.fanInHigh`, `risk.rules` | `3`, `10`, `[]` | risk thresholds; rules are the only route to CRITICAL |
| `graph.maxNodes` | `60` | diagram size limit |
| `graph.explicitEdges` | `[]` | `[{source, target}]` relationships for unsupported languages |
| `profile`, `profileThresholds` | `auto`, `{lite: 40, standard: 400}` | index profile and the source-file counts that select it |

## Safety

- Reads only what it must: ignored folders are never entered; secret-pattern files (`.env*`, keys, certificates, credentials, tokens, and similar) are **never opened, hashed or parsed**; only their existence and path go to `state/report.json`. Secret values cannot reach an artifact because they are never read.
- Large files are metadata-only. Symbolic links are not followed (reported as warnings).
- Writes only inside the output directory. `outputDir` outside the project is rejected.
- A malformed file never stops a scan; every failure is a diagnostic with path, parser, code and severity.

## Testing and checks

```
npm test          (or: node tools/scripts/run-tests.mjs)   all suites, built-in node:test runner
npm run check     (or: node tools/scripts/check.mjs)       syntax of every module, no third-party imports
```

There is no linter and no type checker: both would be dependencies. `check` covers syntax and the dependency rule, and the test suite includes a self-scan proving every relative import inside the tools resolves.

Fixtures are small synthetic projects in `test/fixtures/` (never real project code). Cases that the repository's own `.gitignore` or common sense would exclude, such as ignored folders, secret-pattern files, large files, symbolic links and binary garbage, are created at test time in temporary directories.

## Known limitations

See the end of `graph/README.md` and `index/README.md`. In short: dependency analysis exists for JavaScript and TypeScript only; relationships are file-level; there is no call graph.
