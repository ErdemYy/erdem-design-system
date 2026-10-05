# Tools: Graph

Implemented (Phase 3). Builds the machine graph defined in `ai/GRAPH_PROTOCOL.md` (schema v1) and renders it. Library entry points: `graph/build.mjs` (`buildGraph`), `graph/views.mjs` (`buildView`), `graph/render-mermaid.mjs`, `graph/render-dot.mjs`. CLI: `project-intel graph`.

## Pipeline

```
scan (lib/scan.mjs)  ->  language adapters  ->  resolve specifiers  ->  nodes + edges
                                              ->  public surface, risk, cycles  ->  graph.json
graph.json  ->  view (full | subsystem | file | impact)  ->  Mermaid / DOT
```

## Language support

| Language | Support |
|---|---|
| TypeScript (`.ts .tsx .mts .cts`), JavaScript (`.js .jsx .mjs .cjs`) | dependency analysis |
| everything else (Python, Dart, Java, C#, CSS, …) | **metadata only**: nodes exist, no edges, `risk: null` |

Planned, not implemented: Python, Dart, Java, C#. Adding a language is one adapter module (`lib/languages/`, contract in `lib/languages/registry.mjs`) plus a registry entry. Unsupported languages can be linked only by explicit `graph.explicitEdges` configuration (edge type `references`).

### What the JavaScript/TypeScript adapter detects

ES module imports (default, named, namespace, side-effect, type-only), `import x = require()`, dynamic `import("literal")`, `require("literal")`, `export * from`, `export {…} from`, `export * as ns from`, exported names, and common CommonJS exports.

Resolution: relative specifiers (extension swap `./x.js` to `x.ts/.tsx`, directory `index`), `tsconfig.json`/`jsconfig.json` `baseUrl` and `paths` (comments and trailing commas allowed, relative `extends` followed), and workspace packages when the root manifest declares `workspaces`. Dependency folders are never resolved into project files; bare specifiers become `ext:<package>` nodes. Unresolved project-local imports are warnings in `state/report.json`, never edges.

Not detected (so never emitted): computed specifiers, runtime calls, `extends`/`implements`/`uses`/`calls` edges, `package.json#imports`, conditional `exports` subpaths, destructured exports, names after the first in `export const a = 1, b = 2`.

## Outputs

| Command | Writes |
|---|---|
| `project-intel graph` | `graph/graph.json` (full), `graph/graph.mmd` and `graph/graph.dot` (FULL overview) |
| `project-intel graph --view subsystem --target src/shared` | `graph/views/subsystem-….{mmd,dot}` |
| `--view file --target <file> [--depth n]`, `--view impact --target <file>` | `graph/views/{file,impact}-….{mmd,dot}` |
| `--stdout` | prints the Mermaid view |

`project-intel index` also writes the full graph and, with the standard and full profiles, one subsystem view per important directory.

## Views and size control

FULL shows files when they fit in `maxNodes` (default 60), otherwise one node per subsystem with edge counts, and a summary note; beyond that it keeps the largest subsystems and says how many were omitted. SUBSYSTEM, FILE and IMPACT views truncate deterministically (target first, then by distance and fan-in) and add a `+N more … omitted` node. Tests and external packages are hidden unless requested (`--include-tests`, `--include-external`; IMPACT shows tests by default). `graph.json` always has everything.

## Formats

- **JSON**: schema `schema/graph.schema.v1.json`, keys sorted, ids sorted.
- **Mermaid**: `flowchart TD`; node identifiers are hashes (`n` + hex), never paths; labels are quoted and escaped (`#`, `"`, `<`, `>`, backtick); subgraphs per subsystem; dotted edges for dynamic and type-only imports, thick for re-exports.
- **DOT**: valid Graphviz without Graphviz installed; same identifiers; rendering (`dot -Tsvg`) is optional and not done by the tool.
- The test suite validates Mermaid and DOT with structural checkers (not the official parsers) and DOT is not run through Graphviz because it is not a dependency.

## Risk and public surface

Conservative and evidence-based; rules and thresholds are in `ai/GRAPH_PROTOCOL.md` and the configuration table in `../README.md`. CRITICAL is reachable only through `risk.rules`.

## Known limitations

- File-level dependencies: which exported names a consumer uses is not resolved, so impact is a superset.
- JSX text is tokenized heuristically; apostrophes in JSX text are tolerated, but unusual constructs (a backtick or `/*` inside JSX text) can hide a few statements on the affected line.
- Regular expressions inside template-literal expressions are not parsed.
- Only the root `.gitignore` is read; nested ignore files are not.
- Symbolic links are skipped; TypeScript project references and `include`/`exclude` are not interpreted.
