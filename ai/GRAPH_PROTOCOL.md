# Graph Protocol

Contract for dependency graphs. Implemented by `tools/graph/` (graph schema v1). Consumption rules for agents: `CHANGE_IMPACT.md`. Principles: `CONTEXT_PROTOCOL.md`.

## Purposes

1. Human architecture understanding
2. AI context navigation
3. Change impact analysis (`CHANGE_IMPACT.md`)
4. Documentation

## Two layers

| Layer | Audience | Content | Produced by |
|---|---|---|---|
| Human graph | people | high-level architecture: subsystems, layers, services, data flow | hand-written (`templates/ARCHITECTURE.md`), or the filtered views below |
| Machine graph | tools and agents | files, dependency edges, importers, consumers, public surfaces, risk | `tools/graph/` (`graph.json`) |

## Authority

The graph is DERIVED (`CONTEXT_PROTOCOL.md`). Code wins. It carries the metadata and staleness states of `INDEX_PROTOCOL.md`. Only relationships that can be detected reliably are emitted; nothing is inferred from names or guessed.

## Machine graph schema v1

File: `graph.json`. Machine-checkable schema: `tools/graph/schema/graph.schema.v1.json`.

Top level:

| Field | Meaning |
|---|---|
| `schema` | always `erdem.graph` |
| `schemaVersion` | `1` |
| `tool` | `{name, version}` of the generator |
| `generatedAt` | ISO 8601 (the only non-deterministic field) |
| `project` | `{name}`, when discoverable |
| `configDigest` | digest of the effective configuration |
| `fingerprint` | set fingerprint of the structure files (`INDEX_PROTOCOL.md` → Fingerprint) |
| `stats` | counts and analysis coverage |
| `cycles` | strongly connected groups of node ids with more than one member, or a self-dependency |
| `nodes`, `edges` | sorted lists |

### Node

| Field | Type | Meaning |
|---|---|---|
| `id` | string | stable id: the project-relative path for files, `ext:<package>` for external packages |
| `type` | `file` or `external` | |
| `path` | string or null | project-relative POSIX path; null for external |
| `language` | string or null | detected language; null for external or unknown |
| `imports` | string[] | ids this node depends on through `imports` edges |
| `importers` | string[] | ids that depend on this node through `imports` edges |
| `exports` | string[] | exported names found in the file (`default`, `*` for a star re-export) |
| `consumers` | string[] | ids that depend on this node through any edge type |
| `publicSurface` | boolean | evidence-based, see below |
| `risk` | `LOW` `MEDIUM` `HIGH` `CRITICAL` or null | null when evidence is insufficient |
| `fingerprint` | object or null | `{algo, hash, size, normalization}`; `hash` null when the file cannot be fingerprinted |
| `metadata` | object | `category`, `subsystem`, `entryPoint`, `publicSurfaceReasons`, `riskBasis`, `parseStatus`, `dependencyAnalysis`, `inCycle`, `externalImports` |

All id lists are sorted. `importers` and `consumers` differ only when a node is re-exported or linked by a configured reference.

### Edge

| Field | Meaning |
|---|---|
| `source` | id of the dependent node |
| `target` | id of the dependency |
| `type` | `imports`, `exports`, `references` (the schema also reserves `calls`, `extends`, `implements`, `uses`; they are never emitted) |
| `kind` | `static`, `side-effect`, `dynamic`, `require`, `reexport`, `configured` |
| `typeOnly` | `true` only for type-only imports and re-exports |

Emitted relationships:

| Relationship | Edge | Detection |
|---|---|---|
| ES module import, side-effect import, TypeScript `import x = require()` | `imports` static / side-effect / require | JavaScript and TypeScript adapter |
| dynamic `import("...")` with a string literal | `imports` dynamic | same |
| CommonJS `require("...")` with a string literal | `imports` require | same |
| `export * from`, `export {…} from`, `export * as ns from` | `exports` reexport | same |
| a relationship stated in project configuration | `references` configured | any language |

Not emitted: `calls`, `extends`, `implements`, `uses` (they need type or runtime resolution); relationships through computed specifiers; relationships inferred from file names; imports that resolve into dependency folders. Unresolved project-local imports are reported as diagnostics, not as edges.

Edges are unique per `(source, target, type, kind, typeOnly)` and sorted.

### Public surface

A node is a public surface only on evidence, recorded in `metadata.publicSurfaceReasons`:

| Reason | Evidence |
|---|---|
| `package-entry` | resolved target of `main`, `module`, `types`, `bin` or `exports` in a package manifest |
| `framework-route` | route-convention file, only when the package depends on the framework (Next.js app and pages routes, SvelteKit routes) |
| `shared-module` | imported from at least a configured number of distinct other subsystems (default 3), tests excluded |
| `global-config` | build or runtime configuration file at the project root |
| `configured` | matches a pattern in project configuration |

An export alone never makes a surface.

### Risk

`risk` is conservative and carries its evidence in `metadata.riskBasis`. Rules, strongest wins: configured rule (the only way to reach CRITICAL); `package-entry` or `global-config` → HIGH; dependents (any edge type, tests excluded) at or above the high fan-in threshold → HIGH; at or above the medium threshold, `shared-module` or `framework-route` → MEDIUM; otherwise LOW. Tests are LOW. A node whose language has no dependency analysis, or whose parse failed, has `risk: null`. Names such as "auth" or "migration" never raise risk by themselves.

### Subsystem

`metadata.subsystem` is the first path segment, or the first two when the first is a configured container directory (default `src`, `packages`, `apps`, `libs`, `modules`, `services`) and the path is deeper than that; root-level files belong to `.`.

## Outputs

| File | Content |
|---|---|
| `graph.json` | the full graph |
| `graph.mmd` | Mermaid `flowchart TD` of a filtered view |
| `graph.dot` | Graphviz DOT of the same view |
| `views/*.mmd`, `views/*.dot` | per-subsystem and on-demand views |

Mermaid and DOT use stable safe identifiers derived from the node id, never raw paths; labels are escaped. Graphviz is not needed to produce `.dot`.

## Views

| View | Content |
|---|---|
| FULL | the whole graph as an overview: files when they fit in `maxNodes`, otherwise aggregated by subsystem; if even that is too large, a summary with a pointer to the JSON |
| SUBSYSTEM | one subsystem plus its direct outside neighbors |
| FILE | a target and its neighbors to a depth |
| IMPACT | a target and everything that depends on it, to a depth |

Views exclude tests and external packages by default. A view larger than `maxNodes` is aggregated or truncated deterministically and says so (details in `tools/graph/README.md`).

## Determinism

Same sources and configuration give the same graph apart from `generatedAt`. Nodes, edges and every id list are sorted by code-unit order.

## Rules

- A graph is a navigation aid; code wins.
- A stale graph is a hint (`INDEX_PROTOCOL.md` → Staleness); the generator's `status` command reports it.
- Agents query neighbors and never load a whole graph (`TOKEN_EFFICIENCY.md`).
- `exports`, `publicSurface` and `risk` (requested of this phase in `CHANGE_IMPACT.md`) are defined above.
