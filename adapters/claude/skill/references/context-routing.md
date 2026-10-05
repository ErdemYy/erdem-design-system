# Context routing

How Claude consumes the AI protocol. The rules are in `ai/` and `adapters/GENERIC.md`; this file only says which one to open when, and how to run the tooling from Claude. Paths are relative to the design-system root.

## Which canonical document, when

| Moment | Open | Only if |
|---|---|---|
| Classifying the task | `ai/TASK_ROUTING.md` | not already clear from the request |
| Unsure how far to read | `ai/CONTEXT_PROTOCOL.md` (levels, sufficiency, uncertainty) | you are about to read beyond the target |
| Searching, large files, skip rules, secrets | `ai/TOKEN_EFFICIENCY.md` | first time in the session, or a file is large |
| Index or summary looks old | `ai/INDEX_PROTOCOL.md` (staleness, update policy) | you rely on it |
| Task is MEDIUM or larger, or a public surface is touched | `ai/CHANGE_IMPACT.md` | always for those |
| Before editing | `ai/SAFE_MODIFICATION.md` | the change is not trivial |
| Before finishing | `ai/VALIDATION_PROTOCOL.md` | always |
| Writing or receiving a handoff | `ai/SESSION_HANDOFF.md`, `templates/HANDOFF.md`, `templates/TASK_STATE.md` | the work spans sessions |
| Graph questions | `ai/GRAPH_PROTOCOL.md`, `tools/analyze/README.md` | you need field meanings or limits |

Do not open the others by default.

## Tooling through the launcher

`erdem.mjs` runs from the skill folder and finds the engine; the working directory is the project. All commands are read-only except `index` and `graph`, which write only inside `.ai/`.

| Need | Command |
|---|---|
| Is derived context current? | `erdem.mjs context` (compact, verified when the engine is available) |
| Authoritative status | `erdem.mjs intel status` |
| Refresh index, summaries, graph | `erdem.mjs intel index` (add `--profile <p>`; the configured `preferredProfile` is the default choice) |
| Refresh the graph only | `erdem.mjs intel graph` |
| Refresh because the task relies on stale or missing artifacts | `erdem.mjs intel refresh --relies-on <graph|impact|dependents|public-surface|index|directory-index|summary...> [--scope <paths>] [--class <c>] [--risk <r>] [--config <file> when the intelligence was produced with one] [--declined <reasons the user declined this session>]`: decides under `<root>/ai/AUTOMATION_PROTOCOL.md`; runs the incremental refresh only when allowed, otherwise NO_REFRESH, PROPOSE_REFRESH (ask first) or BLOCKED. Never a first index, rehash, profile change or deletion |
| What depends on a file | `erdem.mjs intel impact <path>` |
| What a change affects (bounded, deterministic; never runs tests or refreshes) | `erdem.mjs intel change-impact --modified <files> [--created <files>] [--deleted <files>] [--renamed old=new] [--class <c>] [--risk <r>] [--types <list>] [--signals <list>] [--phase planned\|completed] [--fresh-graph]`: dependents, tests, public surface, the five dimensions, risk, validation depth, stale intelligence, context to reopen (through the router) |
| What validation a change needs (depth V0 to V4, checks from the project's own manifests, A1 automatic, A2 proposed, A3 never; plans only unless `--run`) | `erdem.mjs intel validate --modified <files> [--created <files>] [--deleted <files>] [--renamed old=new] [--class <c>] [--risk <r>] [--types <list>]` |
| What to read next for a task | `erdem.mjs intel route --class <c> --risk <r> --types <list> --targets <paths> [--signals <list>] [--platform <p>] [--concerns <list>] [--reached <n>] [--answers 1=read,4=open,...] [--state <s>]`: the next level's files and queries (paths only, read-only, one level at a time); stops when the five sufficiency questions are answered; decides nothing about refreshing |
| A focused diagram | `erdem.mjs intel graph --view subsystem --target <dir> --stdout` |

## Graph states

| State | Do |
|---|---|
| current | query it (`impact`, views); read the neighbors it points to |
| stale | use it only if the task needs structural impact; otherwise targeted search is enough; refresh with `intel graph` when you will rely on it |
| unverifiable | usable as provisional; verify in source what you rely on |
| partial | use the artifacts that are current; targeted search for the rest |
| missing | targeted search: symbols, imports, routes, config keys |
| language without dependency analysis | targeted search; never invent edges. The graph says `dependencyAnalysis: none` per node |

Treat impact as a superset (file-level analysis) and risk as advisory.

## Task state and handoff relevance

Read `.ai/TASK_STATE.md` after classifying the task, only if it is `in-progress` or `blocked` and the request continues that work, or the user refers to earlier work. A new, unrelated task does not load it. Read `.ai/HANDOFF.md` in full only if it is addressed to this session's work (`to` is any or Claude) and is newer than the task state; otherwise its existence is enough. A handoff is a claim, not a fact: check referenced files, fingerprints if given, and `git status` before relying on it.

## Index update after a change

Use the table in `adapters/GENERIC.md` §8. In Claude terms: TRIVIAL and most SMALL changes need no refresh; MEDIUM and larger run `erdem.mjs intel index` once at the end, then check `erdem.mjs context`.
