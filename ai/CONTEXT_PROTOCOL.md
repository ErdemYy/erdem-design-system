# Context Protocol

How an agent decides what to read. Tool-agnostic: it applies to any agent that can read files and search. Status: specification only; no scanner or generator exists.

## Principles

- **P1** Read the smallest sufficient context.
- **P2** Expand context progressively.
- **P3** Source code is authoritative; indexes and summaries are navigation aids.
- **P4** Do not re-read unchanged, unrelated information.

Other `ai/` files apply these and do not restate them.

## Artifact classes

| Class | Contains | Rule |
|---|---|---|
| **AUTHORITATIVE** | source code, tests, project instructions, decisions | the facts and the rules |
| **DERIVED** | indexes, summaries, graphs, reports | may be stale; never equivalent to source |
| **TEMPORARY** | caches, logs, analysis artifacts | never relied on; disposable; not committed by default |

A derived artifact carries metadata that lets it be checked (`INDEX_PROTOCOL.md`). Derived artifacts are not treated as equivalent to source, even when they are current.

## Persistent repository context

The set of repository artifacts that reduce repeated discovery: indexes, summaries, decisions, architecture docs, task state, fingerprints, handoffs, graph metadata.

This is **not** a model memory or a hidden cache. A new session or a different agent starts with no memory of earlier work; it recovers state only by reading these artifacts. They lower the expected cost of rediscovery; they do not guarantee savings, and they are only worth maintaining while they cost less than the discovery they replace (`INDEX_PROTOCOL.md` → Scale-down).

## Authority and conflicts

Two separate questions with two separate orders.

**What is true about the codebase** (evidence authority), highest first:

1. source code
2. tests
3. project-local instructions
4. architecture documents
5. decisions
6. indexes
7. summaries
8. generic assumptions

**What the product should do or look like** (requirement authority) is the order in `README.md` → Source of truth (explicit requirements first). It is not redefined here.

Resolutions:

| Conflict | Result |
|---|---|
| index or summary says A, code says B | **code wins**; mark the derived artifact stale |
| documentation says A, code says B | code describes current behavior; mark the documentation stale. If A is the intended behavior, record that as an open issue, do not "fix" either silently |
| architecture doc says A, explicit requirement says B | **requirement wins** (what to build); the architecture doc is stale or needs a decision |
| test contradicts an explicit requirement | requirement wins on intent; the test is flagged outdated |
| two decisions conflict | the **newer applicable** decision wins, unless the older one is explicitly marked higher priority (`templates/DECISIONS.md`) |
| generic assumption vs anything above | the assumption loses |

## Expansion levels

Each level adds only what the previous one could not answer. Do not jump to Level 5.

| Level | Name | Read | Purpose |
|---|---|---|---|
| 0 | Root orientation | project instructions; root README if relevant; AI index if available; current task state if available | know the project and any work in progress. Skip what is absent or already in context. For a named file in a known project, Level 0 may be a glance |
| 1 | Task scope | (mostly reasoning plus targeted search) | decide task type, likely subsystem, target platform, likely files, potential risk (`TASK_ROUTING.md`) |
| 2 | Subsystem | subsystem index; subsystem architecture summary; relevant decisions | know the local structure and rules |
| 3 | Target | target files; immediate related files; direct dependencies | read what will change |
| 4 | Impact | direct consumers; tests; configuration; related data; platform-specific files | know what the change can break (`CHANGE_IMPACT.md`) |
| 5 | Architecture | full relevant architecture; cross-subsystem relationships; graph information; migration impact | only for large or architectural changes |

Each class has a default depth ceiling (`TASK_ROUTING.md`). Going beyond it requires a stated reason.

## Context scopes

A scope controls information **volume**, not tokens. No token figure is defined, because it would depend on the model and the project.

| Scope | Meaning |
|---|---|
| MINIMAL | the target region only |
| TARGETED | target plus direct dependencies |
| SUBSYSTEM | the relevant parts of one subsystem |
| CROSS-SYSTEM | interfaces and touched parts of several subsystems |
| ARCHITECTURAL | the full architecture relevant to the change |

A scope is a ceiling on breadth, not a target to fill. Class-to-scope mapping: `TASK_ROUTING.md`.

## Selection algorithm

Input: the user's task.

1. **Classify** the task: types and class (`TASK_ROUTING.md`).
2. **Identify the platform** (web, mobile, flutter, react-native, desktop, webgl-3d, other).
3. **Identify the subsystem** from the AI index or directory structure.
4. **Search the indexes** (and decisions) for the target and related terms.
5. **Load the minimum sufficient context** for the class, starting at Level 0.
6. **Inspect source** at the target: search, then read the matching region (`TOKEN_EFFICIENCY.md`).
7. **Expand only when uncertainty remains**, one level at a time.
8. **Impact analysis** if the class or risk calls for it (`CHANGE_IMPACT.md`).
9. **Implement** within scope (`SAFE_MODIFICATION.md`).
10. **Validate** in proportion to the class (`VALIDATION_PROTOCOL.md`).
11. **Update task state** (`SESSION_HANDOFF.md`).
12. **Invalidate or update derived context** if the change calls for it (`INDEX_PROTOCOL.md` update policies).

## Sufficiency: when to stop reading

Stop expanding when all five can be answered with evidence from source, tests or instructions you have actually read:

1. What file(s) must change?
2. Why do they need to change?
3. What constraints apply?
4. What depends on them?
5. What validation is required?

"Sufficient confidence" means each answer rests on read evidence, not assumption. For HIGH or CRITICAL risk, question 4 must be answered from search or graph results, not estimated.

## Uncertainty

1. Context insufficient → expand one level.
2. Still uncertain → targeted search.
3. Still several plausible interpretations → **ask a clarifying question**.

More reading is not a substitute for clarification. Do not read the whole repository to resolve ambiguity in the request.

## Missing or stale context

Missing or stale derived context never blocks work. Fall back to source.

| Situation | Behavior |
|---|---|
| no AI index | inspect the repository structure directly (listing, README, manifests); do not scan content broadly |
| no directory or file index | list the directory; open the target |
| no summary | inspect the target source |
| stale summary | treat as a hint only; verify what you rely on in source; refresh it if you rely on it again |
| unverifiable summary (no fingerprint) | treat as provisional |
| no graph | targeted import, usage and reference search (`CHANGE_IMPACT.md`) |
| no decisions file | no recorded decisions are known; check source for conventions; record any new decision you make |
| no task state | reconstruct from the request and version-control status if available; start a task state |
| no handoff | proceed from task state and source; do not ask the previous agent to replay the conversation |

State in the task state that you worked without a given artifact when it affects confidence.

## Design system selective loading

`core/` is design authority; `platforms/` is platform adaptation. Neither is loaded wholesale. Project requirements and local instructions still take precedence (`README.md` → Source of truth).

| Task | Load |
|---|---|
| change a component's spacing | the component's entry in `core/COMPONENT_SYSTEM.md`, `core/SPACING_SYSTEM.md`, and the matching rows of `core/TOKEN_REGISTER.md` found by token-name search |
| add a form field | `core/COMPONENT_SYSTEM.md` (Input and forms), `core/ACCESSIBILITY.md` (forms), color-border and typography rows of the register |
| copy change | `core/CONTENT_GUIDELINES.md` |
| redesign a whole mobile flow | `platforms/MOBILE.md` and the toolkit file, `core/LAYOUT_SYSTEM.md` (mobile composition), `core/TYPOGRAPHY.md`, `core/SPACING_SYSTEM.md`, `core/ACCESSIBILITY.md`, plus project context |
| add or change a 3D scene | `platforms/WEBGL_3D.md`, `core/MOTION_SYSTEM.md`, `core/ACCESSIBILITY.md` (3D) |
| add or change a token | `core/DESIGN_TOKENS.md`, the affected register rows, `core/DESIGN_DECISIONS.md` (status policy) |

Rules:
- Read the register by token-name search, not in full.
- Read `core/EVIDENCE.md` and `core/DESIGN_DECISIONS.md` only for questions of origin or status, or when changing tokens.
- An agent applying the design system does not change token statuses; promotion is the owner's decision.
- Load the platform file only for the target platform.
