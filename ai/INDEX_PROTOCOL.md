# Index Protocol

Contract for indexes, summaries, fingerprints and their upkeep. The reference implementation is `tools/` (`project-intel`); this file is the contract it follows. A project's indexes live in the project, not in this repository. By default the tooling writes them to `.ai/` inside the scanned project, as machine-written files separate from hand-written instructions (`generated: true` in their headers).

## Authority

**An index is the authoritative source of navigation, not a source of truth for code.** Index and summary are DERIVED (`CONTEXT_PROTOCOL.md`). If one disagrees with source, source wins and the derived artifact is stale (conflict table in `CONTEXT_PROTOCOL.md`).

## Metadata on every derived artifact

| Field | Meaning |
|---|---|
| `generatedAt` | ISO 8601 timestamp |
| `source` | what produced it: tool and version, or `manual`; and what it was produced from |
| `scope` | `file`, `directory`, `subsystem`, `project` or `session` |
| `fingerprint` | optional; see Fingerprint |

## Index types

Indexes stay compact, point rather than explain, and never copy implementation.

### AI_INDEX.md (project level)

Level 0 navigation map. It must be short enough to read whole. Sections:

1. **Identity:** name, purpose, platforms, `indexProfile` (see Scale-down)
2. **Architecture overview:** a few lines and a pointer to the architecture document
3. **Subsystems:** name, path, role, local index (if any)
4. **Important directories:** path and role
5. **Important files:** path and role
6. **Entry points**
7. **Generated folders:** present in this project, not to be edited
8. **Ignore-by-default folders:** those present (`TOKEN_EFFICIENCY.md`)
9. **Architecture decisions:** pointer to the decisions file
10. **Current task state:** pointer (`SESSION_HANDOFF.md`)
11. **Available summaries:** pointers with their status
12. **Available graphs:** pointers with their status
Also: design system in use, platform, and deviations (pointers); locations of state artifacts.

### DIRECTORY_INDEX.md (important directories only)

Only for meaningful architectural directories: one that has its own responsibility boundary, its own public surface, or non-obvious conventions. Trivial folders get none; the directory listing is enough.

| Field | Content |
|---|---|
| purpose | one line |
| importantFiles | path and role |
| subsystemRole | where it sits |
| entryPoints | |
| dependencies | what it uses outside itself |
| consumers | who uses it |
| localConstraints | rules that apply here |
| relatedDocs | pointers |

### FILE_INDEX.md (or equivalent file-level metadata)

Entries only for important files (public surface, entry points, files with non-obvious roles). One compact entry each. Equivalent forms are allowed: a section of a directory index, or a machine-readable file with the same field names.

| Field | Content |
|---|---|
| path | |
| purpose | one line |
| role | e.g. entry point, shared component, schema |
| publicApi | exported names or interface summary, not code |
| dependencies | important only |
| consumers | important only |
| tests | paths |
| platform | |
| summaryRef | pointer to the last known summary |
| fingerprint | optional |
| publicSurface | optional flag (`CHANGE_IMPACT.md`) |

Binary assets get path, type, size, dimensions if available, and purpose; never content (`TOKEN_EFFICIENCY.md`).

## Summary model

A summary is a short, replaceable description of one scope.

| Field | Content |
|---|---|
| path | what it describes |
| scope | file, directory, subsystem, project, session |
| generatedAt | |
| source | producer and the files it was derived from |
| fingerprint | optional hash of the source set (see Fingerprint) |
| purpose | short |
| role | architectural role |
| dependencies | important only |
| consumers | important only |
| constraints | rules that apply |
| risks | known fragile or high-impact points |

Kinds: architecture summary (project), subsystem summary, file summary, session summary (`SESSION_HANDOFF.md`).

Properties: **concise** (a few lines per field), **directional** (orients, does not specify), **replaceable** (a new summary replaces the old; no history), **invalidatable** (checkable against source). A summary never becomes authoritative: claims taken from it about code behavior are hypotheses until verified in source. Dependency and consumer lists are the most perishable parts because they can change without the described file changing; verify them by targeted search when relied on.

## Fingerprint

A lightweight record of the state of a source at generation time.

| Field | Meaning |
|---|---|
| path | file (or set identifier) |
| hash | content hash; the authoritative signal |
| algo | hash algorithm name, recorded so any tool can recompute |
| size | cheap pre-check |
| mtime | cheap pre-check; unreliable across checkouts and synced folders, so never decisive alone |
| generatedAt | when recorded |

Rules:
- Compute the hash over file content, normalized for line endings so that platform checkouts do not cause false staleness.
- For a directory or subsystem summary, the fingerprint covers a sorted list of the member paths and their hashes.
- Comparison order: size and mtime may rule out equality quickly; hash decides.
- Reference implementation: `tools/` (`project-intel`). It uses SHA-256 (recorded in each fingerprint), normalization `text-lf-nobom` for text (UTF-8 BOM removed, CRLF to LF) and `binary-raw` for binary content, and treats size and mtime as pre-checks only (an opt-in `trustMtime` skips re-hashing; `status` never uses it). Formats and commands: `tools/index/README.md`.

## Staleness

| State | Condition | Use |
|---|---|---|
| CURRENT | stored fingerprint equals the current fingerprint of its source | structurally current: the source has not changed. This does not prove the summary was ever correct |
| STALE | fingerprint differs, or a source file was moved, deleted or added to the set | hint only; regenerate when relied on |
| UNVERIFIABLE | no fingerprint | provisional; compare `generatedAt` with source change times if available |

The reference tooling additionally reports MISSING for an expected artifact that does not exist.

Do not regenerate eagerly: a stale summary is refreshed when it is needed, not on every change.

## Update policy

Indexes and summaries are not regenerated after every change.

| Class | Indexes | Summaries |
|---|---|---|
| TRIVIAL | no change unless the structure changed | none |
| SMALL | update if a file's path or role changed | invalidate the file summary if the implementation changed materially |
| MEDIUM | update the affected subsystem or directory index if structure changed | invalidate affected file and subsystem summaries |
| LARGE | review the indexes of every touched subsystem | invalidate and refresh affected summaries when next needed |
| ARCHITECTURAL | reconcile indexes broadly; refresh the architecture summary | invalidate broadly; refresh by need |

A material change is a semantic or structural one: behavior, public API, dependencies, role, location. Comments, formatting and renames of local variables are not.

## Scale-down

The intelligence layer must cost less than the discovery it saves. Choose the lightest profile that works, and declare it in `AI_INDEX.md` (`indexProfile`).

| Profile | Use when | Contains |
|---|---|---|
| none | an agent can orient from the directory listing and README in a few reads | nothing |
| lite | a small project with a few subsystems | `AI_INDEX.md` only |
| standard | several subsystems | `AI_INDEX.md` plus directory indexes for architectural directories |
| full | large or long-lived | plus file index for the public surface, summaries |

The machine graph and machine index are cheap and always produced by the reference tooling; the profile controls the Markdown and summary artifacts. Agents still query the graph selectively (`TOKEN_EFFICIENCY.md`).

Do not index what a directory listing already tells. Do not create an index "for completeness". Move up a profile only when agents repeatedly spend effort rediscovering the same structure.

## Secrets

Derived artifacts never contain secret values (`TOKEN_EFFICIENCY.md` → Default access rules). They may record that a file or setting exists, never its content.
