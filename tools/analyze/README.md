# Tools: Analyze

Implemented (Phase 3): the **query layer** that future change-impact and task-scope tooling builds on. Task-scope analysis and architecture analysis are not implemented. CLI: `project-intel impact <file>`. Library: `analyze/query.mjs` (`createGraphQuery`).

## Query API

Pure and read-only over a machine graph (schema v1); it never touches the file system and never mutates the graph. References accept a node id or a project-relative path (`./` and either slash are tolerated). An edge's source depends on its target.

| Question | Function |
|---|---|
| What does this file import? | `getDependencies(ref, {types, includeExternal, includeTests, includeTypeOnly})` |
| What imports this file? | `getDependents(ref, opts)` |
| What does it depend on, transitively? | `getTransitiveDependencies(ref, {maxDepth})` |
| What depends on it, transitively? | `getTransitiveDependents(ref, {maxDepth})` |
| What is its dependency neighborhood? | `getNeighborhood(ref, depth, {direction: 'both'|'in'|'out'})` |
| What is affected if it changes? | `getImpact(ref, {maxDepth})` |
| Which tests depend on it? | `getTests(ref)` |
| Is it a public surface, why? | `isPublicSurface(ref)`, `findPublicSurfaces({reason})` |
| What risk, on what evidence? | `getRisk(ref)` |
| Shortest dependency chain? | `shortestPath(from, to)` |
| Cycles, subsystems | `getCycles()`, `listSubsystems()`, `getSubsystem(key)` |
| Node data | `getNode(ref)`, `resolveId(ref)` |

`getImpact` returns the target's risk and public-surface reasons, direct dependents, every affected node with its distance, affected tests, public surfaces among the affected, the highest risk among them, whether the target is in a cycle, and notes about the limits of the answer. Traversals use visited sets, so cycles terminate.

## Capability matrix

The authoritative statement of which graph questions can be answered how. Adapters and protocol documents point here instead of restating it. **CLI** means a `project-intel` command reaches it; **library** means only code that imports `analyze/query.mjs` (or the `query` object returned by `lib/pipeline.mjs`) does; **data** means the answer is in the written `graph.json`; **unavailable** means no implementation exists.

| Question | CLI | Library | Notes |
|---|---|---|---|
| Direct dependencies of a file | `impact <file> --json` (`dependencies`) | `getDependencies` | |
| Transitive dependencies | unavailable | `getTransitiveDependencies` | |
| Direct dependents | `impact <file>` (`directDependents`) | `getDependents` | |
| Transitive dependents with distance | `impact <file>` (`affected`) | `getTransitiveDependents` | |
| Neighborhood | `graph --view file\|subsystem --target <path> --depth <n> --stdout` (a Mermaid diagram, not data) | `getNeighborhood` | |
| Impact | `impact <file>` | `getImpact` | superset: file-level analysis |
| Tests affected | `impact <file>` (`tests`) | `getTests` | |
| Public surface of the target and among the affected | `impact <file>` | `isPublicSurface` | |
| All public surfaces of a project | data (`graph.json`) | `findPublicSurfaces` | |
| Risk | `impact <file>` (`risk`) | `getRisk` | advisory |
| Cycles | `impact <file>` (`inCycle` for the target); data (`graph.json` `cycles`) | `getCycles` | |
| Shortest dependency chain between two files | **unavailable** | `shortestPath(from, to)` | **library-only**; returns an array of node ids, or `null` when there is no path or an id is unknown. Tested in `test/query.test.mjs` |
| Subsystems | `graph --view subsystem` (diagram); data | `listSubsystems`, `getSubsystem` | |
| Node data | data (`graph.json`) | `getNode`, `resolveId` | |

Every row works on dependency edges only, and dependency analysis exists for JavaScript and TypeScript (see Limits). An agent that cannot import the library answers a library-only question by reading `graph.json` or by targeted search, and says that no query was run.

## Limits

- File-level: which exported names a dependent actually uses is not resolved, so impact is a superset of the real impact.
- For languages without dependency analysis the target's own dependencies are unknown (the result says so); dependents found through analyzed files remain valid.
- The graph may be stale. `project-intel impact` rebuilds the graph in memory from the current sources, so its answer is current; a graph loaded from `graph.json` is as current as its `status`.

## How agents use it

Level 4 of `ai/CONTEXT_PROTOCOL.md` and `ai/CHANGE_IMPACT.md`: query neighbors and impact for the target instead of reading consumers by hand, then read the consumers the query points to. No graph or an unsupported language means falling back to targeted search, as those documents describe.
