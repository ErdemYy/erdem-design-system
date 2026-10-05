# Token Efficiency

Practices that reduce information the agent does not need. Principles P1 to P4 are in `CONTEXT_PROTOCOL.md`. Context volume is controlled by scopes there; this file is about conduct.

These practices lower expected discovery cost. They do not guarantee a saving: a poorly maintained index can cost more than it saves (`INDEX_PROTOCOL.md` → Scale-down).

## Do

- Search before opening.
- Inspect the relevant region of a file, not the whole file.
- Reuse indexes, summaries (after checking staleness), decisions and task state.
- Use the graph selectively: neighbors of the target.
- Read only files related to the task.
- Say a thing once; point to where it is documented.

## Do not

- re-read the same unchanged file repeatedly within a task; keep what you learned in task state if needed
- reload the whole architecture for a local change
- read generated output or build artifacts
- copy large source into summaries or handoffs
- repeat decisions already documented
- create redundant indexes
- open a file to see whether it is relevant when a search can answer that

## Search first

Before opening broad files, search. Then inspect the matching region, and expand only if needed.

| Need | Search for |
|---|---|
| a function, class or constant | the exact symbol name |
| who uses a module | its path or module name in import statements |
| a route or page | the route string or the route definition |
| a component | its name in definitions and usages |
| a type or schema | the type name and its fields |
| a setting | the config key |
| an error | the exact message text |

## Large files

Do not load a large file whole when a region is enough. Large is relative: too big to read fully without crowding out the rest of the task, or when the needed region is a small part of it.

1. Check size or line count first.
2. Search for the symbol or text; get line numbers.
3. Read a range around the match with a small margin.
4. Use a symbol or heading outline if available.
5. Expand by adjacent ranges only as needed.

The same applies to logs (filter by time, level or identifier; read the tail first) and documentation (headings first, then one section).

## Binary assets

Images, video, 3D models, archives and other binary files are not read as text. Use metadata (type, size, dimensions, name, purpose). Inspect the content only when the task is about the asset, and then only what is needed. An index may hold path, type, size, dimensions and purpose without embedding content (`INDEX_PROTOCOL.md`).

## Default access rules

Skip by default; access when the task requires it and says so.

| Category | Detect by |
|---|---|
| dependency folders | `node_modules/`, `vendor/`, virtual environments, package caches |
| build output | `dist/`, `build/`, `.next/`, `out/` and framework equivalents |
| coverage and reports | `coverage/` and similar |
| generated code | `generated/`, files marked generated in their header |
| cache and temporary | `cache/`, `tmp/`, tool cache directories, logs |
| large binary assets | by type and size |

Rules:
- Detect from the actual repository contents and its ignore files; do not assume a project has any of these.
- Lockfiles and minified bundles are not read in full; search them.
- When access is needed, state why before reading.

### Secrets

Never read, print or copy secret material by default: `.env` and `.env.*`, credentials, private keys, certificates, tokens, secret stores. Access only when a task explicitly requires it and the environment allows it, and then read only what is needed. Never write secret values into indexes, summaries, graphs, task state, handoffs, commits or messages; record existence and path only. If a secret appears in output, do not repeat it.
