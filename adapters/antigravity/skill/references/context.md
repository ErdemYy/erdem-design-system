# Context

How Antigravity applies the canonical context model. The model itself is `ai/CONTEXT_PROTOCOL.md`; the generic session procedure is `adapters/GENERIC.md` §2 to §9. This file only maps them to Antigravity.

## Levels

Use the six levels exactly as defined (0 root orientation, 1 task scope, 2 subsystem, 3 target, 4 impact, 5 architecture) and stop when the five sufficiency questions are answered: what changes, why, what constraints exist, what depends on it, how it will be validated. Antigravity adds no level of its own.

## How Antigravity reaches each level

| Level | In Antigravity |
|---|---|
| 0 | Directory rule files (`AGENTS.md`, `GEMINI.md`) the agent has loaded for the files it opens are already in context (Antigravity deduplicates them per conversation); add `.ai/AI_INDEX.md` and the `context` command result |
| 1 | Reasoning plus a targeted search; classification per `task-routing.md` |
| 2 | A directory index under `.ai/directories/`, then the relevant decisions file |
| 3 | The target region (search, then read a range) and its direct dependencies |
| 4 | `erdem.mjs intel impact <path>` and the consumers, tests and configuration it names |
| 5 | `.ai/graph/` views and architecture documents, only for LARGE or ARCHITECTURAL work |

## Intelligence states

`erdem.mjs context` runs the engine's read-only `status` and reports one state. The engine's content-hash comparison is the authority; the adapter never judges freshness itself.

| State | Meaning | Do |
|---|---|---|
| missing | no derived artifacts (no `.ai/` index) | inspect the repository directly; do not pretend an index or graph exists |
| current | all artifacts match the sources | read `.ai/AI_INDEX.md`; query the graph for neighbors and impact |
| stale | a source changed, was added or removed, or the configuration changed | treat artifacts as hints; verify in source; refresh only what the task needs |
| unverifiable | a source cannot be safely fingerprinted (too large, unreadable) | provisional; verify in source |
| partial | some artifacts exist, some are missing (for example an untracked graph on a fresh clone) | use what is current; targeted search for the rest; refresh if the task needs the graph |
| unavailable | `project-intel` cannot run, timed out, or reported an error | direct inspection; say what was unavailable |

Refresh lazily, with the narrowest command: `erdem.mjs intel graph` for the graph, `erdem.mjs intel index` (incremental; the configured `preferredProfile` is the default choice) for the index and summaries. Update policy by class: `adapters/GENERIC.md` §8 and `ai/INDEX_PROTOCOL.md`. When the task relies on stale or missing artifacts, `erdem.mjs intel refresh --relies-on <what the task relies on> [--scope <paths>] [--class <c>] [--risk <r>] [--config <file> when the intelligence was produced with one] [--declined <reasons the user declined this session>]` decides under `<root>/ai/AUTOMATION_PROTOCOL.md` and runs the incremental refresh only when it is allowed (index exists, status stale or partial, the task relies on it, the derived files are not version-tracked); otherwise it says NO_REFRESH, PROPOSE_REFRESH (ask first) or BLOCKED. It never creates a first index, never rehashes, never changes the profile and never deletes. To plan which context to read next, `erdem.mjs intel route [--class <c>] [--risk <r>] [--types <list>] [--targets <paths>] [--signals <list>] [--platform <p>] [--concerns <list>] [--reached <n>] [--answers 1=read,4=open,...]` returns the next level's files and queries (paths only, read-only, one level at a time) and stops when the five sufficiency questions are answered; add `--state <s>` to reuse the status you already hold. It decides nothing about refreshing. To see what a change affects, `erdem.mjs intel change-impact --modified <files> [--created <files>] [--deleted <files>] [--renamed old=new] [--class <c>] [--risk <r>] [--types <list>] [--signals <list>] [--phase planned|completed] [--fresh-graph]` returns a bounded, deterministic report (dependents, tests, public surface, the five dimensions, risk, validation depth, which intelligence went stale, and the context to reopen through the router). The change set is explicit; nothing is scanned for, renames are never inferred, tests are not run and nothing is refreshed. To plan the validation a change needs, `erdem.mjs intel validate --modified <files> [--created <files>] [--deleted <files>] [--renamed old=new] [--class <c>] [--risk <r>] [--types <list>]` returns the depth (V0 to V4), the checks, which are automatic (A1), which need a yes (A2) and which are never automatic (A3), all taken from the project's own manifests. It runs nothing unless `--run` is given, and then only the A1 part.

## `.ai/` artifacts

As produced by the engine (`tools/README.md`): `AI_INDEX.md`, `FILE_INDEX.md`, `directories/**/DIRECTORY_INDEX.md`, `summaries/`, `index.json`, `graph/` (`graph.json`, `graph.mmd`, `graph.dot`, `views/`), `state/`. State and handoff files `TASK_STATE.md`, `HANDOFF.md`, `DECISIONS.md` are plain files written by agents; the engine never generates or deletes them, and the generated `AI_INDEX.md` does not list them (check `.ai/` directly). Which files a project tracks: `adapters/GENERIC.md` §11.

## Graph

When the graph is usable, use the engine rather than reading consumers by hand, and do not implement graph logic in the session. Which question has a command form and which is library-only is defined once in the capability matrix of `<root>/tools/analyze/README.md`. In short here:

| Question | Use |
|---|---|
| dependencies, dependents, affected tests, public surface, risk, cycle membership, impact | `intel impact <path> --json` |
| neighborhood, overview, impact picture | `intel graph --view file|subsystem|impact|full --target <path> --depth <n> --stdout` (a diagram) |
| transitive dependencies, all cycles, shortest dependency chain | **library-only** (`createGraphQuery` in `<root>/tools/analyze/query.mjs`): no command form. Without importing it, read `graph.json` edges or search imports, and say that no query was run |

For languages without dependency analysis, or no graph, use targeted search for symbols, imports, routes and configuration keys, and never invent relationships. Details: `<root>/ai/CHANGE_IMPACT.md`.

## Not found or degraded

If the design system cannot be found, work without its documents and say so once. Set `ERDEM_DESIGN_SYSTEM_ROOT` or configure `designSystemRoot`; run the adapter doctor. Missing derived context never blocks work (`adapters/GENERIC.md` §9).
