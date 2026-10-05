# Adapter: Generic

The baseline contract for **any** AI coding agent. It describes *how to consume* the Erdem Design System and the project intelligence engine, not *what they say*. Rules live in `ai/`, `core/` and `platforms/`; this file points to them and defines the order of operations. Every other adapter inherits this file and states only its differences.

Status: Phase 4A. Tool-agnostic: it assumes only that an agent can read files, search, and (optionally) run a command. It names no agent, vendor or proprietary API. If the agent cannot run commands, every step that needs a command has a stated fallback.

## How to read this file

| Question | Canonical source (not repeated here) |
|---|---|
| How much context, in what order, when to stop | `ai/CONTEXT_PROTOCOL.md` |
| Which task class and type | `ai/TASK_ROUTING.md` |
| Index, summary, fingerprint, staleness, update policy | `ai/INDEX_PROTOCOL.md` |
| Graph schema and queries | `ai/GRAPH_PROTOCOL.md`, `tools/analyze/README.md` |
| Impact, risk, public surfaces | `ai/CHANGE_IMPACT.md` |
| Search, large files, skip rules, secrets | `ai/TOKEN_EFFICIENCY.md` |
| Safe changes, reuse, decisions | `ai/SAFE_MODIFICATION.md` |
| Validation by class | `ai/VALIDATION_PROTOCOL.md` |
| Task state and handoff formats | `ai/SESSION_HANDOFF.md`, `templates/` |
| Tool commands, output layout, configuration | `tools/README.md` |
| Precedence of requirements | `README.md` → Source of truth |

If this file and a canonical source disagree, the canonical source wins and this file is wrong.

## 1. Locating the system

1. **Project root:** the directory that holds the project's own instructions and manifest; for a repository, its version-control root. If several candidates exist, the nearest ancestor of the working directory that contains the project's instruction file or `.ai/`.
2. **The design system:** found through the project's instructions or `AI_INDEX.md`. It is a folder containing `system-manifest.yaml`. Read that manifest, never the whole folder.
3. **The intelligence tooling** (`project-intel`): found through the same pointers, or on the command path. Tooling is *available* when a command that answers `status` can be run. Invocation forms, for example `node <design-system>/tools/bin/project-intel.mjs <command> [root]`, are in `tools/README.md`. The tool writes only inside the project's `.ai/` directory.
4. **Project knowledge** lives in the project: instructions, `AI_INDEX.md`, task state, handoff, decisions. The design system is never copied into the project.

## 2. Session start protocol

Run once per session, in order. Stop reading as soon as the task allows (step 10 is bounded by `ai/CONTEXT_PROTOCOL.md`).

| # | Step | Detail |
|---|---|---|
| 1 | Detect the project root | section 1 |
| 2 | Detect tooling | is a `status` command runnable? |
| 3 | Run **status** | section 3. First intelligence check whenever tooling exists |
| 4 | Classify derived context | one of **current**, **stale**, **unverifiable**, **partial**, **missing**, **unavailable** (section 3) |
| 5 | If current, or unverifiable (provisional: verify what you rely on in source) | read `.ai/AI_INDEX.md`; read the current task state if present; read a relevant handoff if present |
| 6 | If stale or partial | refresh only what the task needs (section 6), then continue as in 5 |
| 7 | If missing or unavailable | inspect the repository directly (section 9); do not scan content broadly |
| 8 | Classify the user's task | `ai/TASK_ROUTING.md`: types and class |
| 9 | Determine context depth | the class's ceiling and scope in `ai/TASK_ROUTING.md` |
| 10 | Proceed | progressive expansion, `ai/CONTEXT_PROTOCOL.md` → Selection algorithm |

"Relevant" handoff (step 5): read it in full when the task state is `in-progress` or `blocked`, when the user is continuing earlier work, or when the handoff is addressed to this agent or to `any`. Otherwise read only its header to learn it exists. A task state or handoff for unrelated work is not context for this task.

A session does not rebuild the index by default. It reads what exists and refreshes only what it needs.

## 3. Status first

When tooling exists, `status` is the first intelligence check. It is read-only and re-hashes sources, so run it once at session start and again only after you have made structural changes, not before every step.

**Vocabulary.** Three layers, one meaning. The engine reports a state per artifact: CURRENT, STALE, UNVERIFIABLE, MISSING (`tools/index/status.mjs`; the first three are defined in `ai/INDEX_PROTOCOL.md` → Staleness, MISSING is the tooling's addition). This section combines them into one session-level state, written in lowercase. An adapter may add explanatory words to that state (for example "unverifiable, use with caution"), but it must show the state itself and must not rename it or fold it into another: it never reports unverifiable as current, missing as unavailable, or a timed-out status as anything but unavailable. The first match in this order wins:

| Result | Session state |
|---|---|
| exit `2`, the command cannot run or times out, unreadable output, or no tooling | **unavailable** (cannot tell) |
| exit `1` with any STALE artifact | **stale**; the `changes` list names the files that moved |
| every expected artifact MISSING (including no `.ai/`), tooling working | **missing** (nothing derived exists; see "fresh checkout" below) |
| some artifacts MISSING and some present | **partial**: use what is current, search for the rest |
| exit `0` with UNVERIFIABLE artifacts and none stale or missing | **unverifiable**: usable as provisional (the former "current, with caution") |
| exit `0`, every artifact CURRENT | **current** |

The engine's own `ok` is true only when nothing is STALE or MISSING; UNVERIFIABLE does not make it false, which is why it is its own state here.

Status answers, and the agent records for the session:

| Question | Where the answer comes from |
|---|---|
| Is an index available? | `.ai/AI_INDEX.md` and `.ai/index.json` present in the status artifact list |
| Is it current? | the status result above |
| Are summaries stale? | per-artifact states for `summaries/` entries |
| Is a graph available, current? | the `graph/graph.json` entry |
| Which profile is active? | `indexProfile` in the `AI_INDEX.md` header (or `profile` in `index.json`) |
| Last known task state? | the task state file, if present (`updatedAt`, `status`, `owner`) |
| Is there a handoff? | the handoff file, if present (`generatedAt`, `from`, `to`) |

Task state, handoff and decisions are plain files and are not part of `status`; check for them directly in `.ai/`, then at the project root and its docs directories (`ai/SESSION_HANDOFF.md`). The generated `AI_INDEX.md` does not list files inside `.ai/`, so absence from its pointer section does not mean absence on disk.

**Fresh checkout.** Machine artifacts that a project chooses not to track (section 11) will be MISSING on a new clone. That is expected, not an error: refresh (section 6) if the task benefits from the graph or index, otherwise work from the tracked artifacts and the source.

Without tooling there is no status: classify as **unavailable**. A tracked `AI_INDEX.md` may still be read, but as unverified derived data (`ai/INDEX_PROTOCOL.md` → Staleness, UNVERIFIABLE).

## 4. Index and context loading

After status, read the minimum. Default order:

`AI_INDEX` → task state → handoff (if relevant) → subsystem or directory index → target → direct dependencies → impact → architecture (only when needed)

This is Levels 0 to 5 of `ai/CONTEXT_PROTOCOL.md`; how far to go is set by the class, the scope and the sufficiency rule there. The adapter adds only operating habits:

- Use the index to find *where*; open source to learn *what*. Never decide an implementation question from an index or summary alone.
- Prefer search to reading (`ai/TOKEN_EFFICIENCY.md` → Search first, Large files).
- Do not re-read what you have already read and has not changed.
- Skip folders and binaries by default and never open secret files (section 10).

## 5. Task routing

Classify with `ai/TASK_ROUTING.md` (types, class, depth ceiling, impact depth, validation). This adapter does not restate the table. If discovery shows a larger scope or risk, reclassify upward and record it in the task state; never reclassify downward to avoid work.

## 6. Stale handling and refresh

Refresh is lazy (`ai/INDEX_PROTOCOL.md` → Staleness, Update policy). A stale artifact is a hint, not an error.

| Situation | Action |
|---|---|
| The task does not touch what is stale | leave it; note it |
| You rely on a stale summary or index entry | verify the point in source; refresh if you will rely on it again |
| The graph is stale and the task needs impact analysis | refresh the graph (`graph` command), or use targeted search |
| `AI_INDEX.md`, summaries or directory indexes are stale and you need them | refresh with the incremental `index` command (unchanged artifacts keep their bytes) |
| Many artifacts stale after a pull | one `index` run, then re-check `status` |
| The refresh command cannot run | fall back (section 9) |

Choose the narrowest command that covers the need. Never refresh as a reflex; never refresh with a tool version whose schema is unknown to you (check the `schemaVersion` fields).

## 7. Graph usage

When a graph exists and is current (or you have verified the part you use), prefer queries to reading consumers by hand: dependencies, dependents, neighborhood, impact, tests, public surfaces, risk, cycles, shortest dependency chain. Which of these has a command form and which is library-only (shortest path is library-only; transitive dependencies too) is defined once, in the capability matrix of `tools/analyze/README.md`. Use the command form (`impact <file>`, filtered `graph` views) or the library API, whichever the environment allows; for a library-only question without the library, read `graph.json` or search, and say that no query was run. Read neighbors, never the whole graph (`ai/TOKEN_EFFICIENCY.md`).

When no graph exists, the language has no dependency analysis (`dependencyAnalysis: none` in node metadata), or the graph is stale for the area you need: use targeted symbol search, import and reference search, route and configuration-key search (`ai/CHANGE_IMPACT.md` → Dimensions). Work is never blocked by a missing graph. Treat graph impact as a superset (file-level analysis) and its risk as advisory.

## 8. Working loop

Source authority, sufficiency and uncertainty are defined in `ai/CONTEXT_PROTOCOL.md` (Authority and conflicts, Sufficiency, Uncertainty). Applying them:

1. **Authoritative:** source code, tests, project instructions, decisions, architecture documents. **Derived:** `AI_INDEX`, summaries, graphs, reports. Derived data that contradicts source loses; mark it stale.
2. **Stop reading** when all five sufficiency questions (what must change, why, what constraints apply, what depends on it, what validation is required) can be answered from evidence you have read. Do not read more to feel safe.
3. **Before changing a file:** read the current implementation; search for an existing abstraction; check impact in proportion to the class; search decisions; keep to the task (`ai/SAFE_MODIFICATION.md`).
4. **After changing:** validate in proportion to the class and risk (`ai/VALIDATION_PROTOCOL.md`); update the task state; invalidate or refresh derived context only as the table below says.
5. **If still ambiguous:** ask, rather than reading the repository (`ai/CONTEXT_PROTOCOL.md` → Uncertainty).

**Automation.** What may happen without asking, what needs a confirmation and what never happens automatically is defined in `ai/AUTOMATION_PROTOCOL.md`; this adapter does not restate or loosen it.

**Index update after a change** (policy: `ai/INDEX_PROTOCOL.md` → Update policy). The adapter's mapping to actions:

| Class | After the change |
|---|---|
| TRIVIAL | no structural refresh |
| SMALL | refresh only if a file's path, role or exports changed |
| MEDIUM | refresh the affected subsystem's artifacts (the incremental `index` run) |
| LARGE | review the indexes of every touched subsystem; refresh as needed |
| ARCHITECTURAL | reconcile indexes broadly and refresh the graph; re-check `status` |

## 9. Fallback behavior

Derived intelligence is an optimization, not a dependency. Missing or stale artifacts never block work; the fallback is the actual repository (`ai/CONTEXT_PROTOCOL.md` → Missing or stale context lists each case). In operating terms:

| Missing | Do this |
|---|---|
| tooling | skip `status`; inspect structure directly: directory listing, root README, manifests, the instruction file |
| `AI_INDEX.md` | same; do not scan file contents broadly |
| directory or file index, summary | list the directory; open the target |
| graph | targeted search (section 7) |
| fingerprint or stored hash | treat dependent artifacts as UNVERIFIABLE; verify in source |
| decisions file | no recorded decisions are known; look for conventions in source; record new decisions you make |
| task state | rebuild from the request and version-control status if available; start a task state |
| handoff | continue from task state and source; never ask a previous agent to replay a conversation |

Note in the task state which artifacts you worked without when it affects confidence.

## 10. Security

Defined in `ai/TOKEN_EFFICIENCY.md` → Default access rules (Secrets) and `ai/INDEX_PROTOCOL.md` → Secrets. As operating rules:

- Do not read secret files by default (environment files, keys, certificates, credentials, tokens). The tooling already withholds them and records only existence and path.
- Never write a secret value into an index, summary, graph, task state, handoff, commit or message. Record existence and path only, and only where useful.
- If a task genuinely requires a secret and the environment allows it, read only what is needed, do not echo it, and note the access in the task state without the value.
- Treat any path the tooling reports as withheld as off limits unless the task explicitly requires it.

## 11. Git policy for `.ai/` (recommended, not enforced)

Separate **portable project context** (worth sharing between people, machines and agents) from **local generated cache** (cheap to rebuild, noisy in diffs, machine specific). This is a recommendation; nothing here changes a project automatically, and a project may choose otherwise (record the choice as a decision).

| Class | Track in version control | Layout the tooling produces |
|---|---|---|
| **Portable project context** | yes | `.ai/AI_INDEX.md`, `.ai/TASK_STATE.md`, `.ai/HANDOFF.md`, `.ai/DECISIONS.md`, `.ai/summaries/`; also `.ai/FILE_INDEX.md` and `.ai/directories/` when produced |
| **Local generated cache** | no (ignore) | `.ai/state/` (parse cache, report), `.ai/index.json` (every file with hash and mtime), and the placeholder names `.ai/cache/`, `.ai/fingerprints/`, `.ai/temporary/` for tooling that uses them |
| **Graph artifacts** | optional | `.ai/graph/graph.mmd` and `.ai/graph/graph.dot` are small and useful; track them if wanted. `.ai/graph/graph.json` and `.ai/graph/views/` may be large: track only if small and useful |

Notes:

- `TASK_STATE.md`, `HANDOFF.md` and `DECISIONS.md` are hand- or agent-written, not generated by the tooling, and the tooling never deletes them. Their recommended home is `.ai/`; the formats are in `templates/`.
- The tooling's own layout uses `state/` and `index.json` for what the placeholder names `cache/` and `fingerprints/` describe; ignore whichever of them exist.
- Tracked generated files carry a fingerprint, so after a pull they may be STALE; that is normal. Unchanged artifacts keep their bytes, so a refresh produces diffs only where content changed.
- Starter ignore entries for a project that follows this policy: `.ai/state/`, `.ai/index.json`, `.ai/cache/`, `.ai/fingerprints/`, `.ai/temporary/`.
- Machine artifacts that are untracked will be MISSING on a fresh clone (section 3); refresh them when needed.

## 12. Task state and handoff

State lives in repository files, never in conversation history (`ai/SESSION_HANDOFF.md`; formats `templates/TASK_STATE.md`, `templates/HANDOFF.md`).

- **During work:** keep the task state current at milestones (not every edit); one owner writes it.
- **At the end of a session** (or when work changes hands, or when stopping with work remaining): update the task state, and write a new handoff. A handoff is **short, specific and actionable**: one objective, what is done and verified, changed files with reasons, one next action, open issues, important decisions as pointers, validation status, relevant indexes and graph nodes as pointers. Say what was verified versus assumed.
- Do not copy conversation history, large source, or secrets into either file. Do not edit an old handoff; write a new one.

## 13. Receiving work from another agent

Any agent to any agent, with no access to the previous conversation. Follow `ai/SESSION_HANDOFF.md` → Cross-agent continuity:

1. Read the handoff.
2. Read the task state.
3. Detect drift (do the changed files still match? use the fingerprints if the handoff gives them, otherwise version-control status or a targeted look).
4. Inspect the referenced files, at the level `nextAction` needs.
5. Verify assumptions that the next step depends on, against source.
6. Take ownership in the task state with the explicit yes that names that handoff (A2; `ai/CONTINUITY.md`) and continue from the next action. Never acquire ownership silently.

Never accept another agent's summary as correct without verification when implementation changes are involved. Treat claims about behavior as hypotheses until checked in source or tests.

With the project tooling present, `project-intel handoff create` issues a handoff and `project-intel handoff resume` verifies one (integrity, task identity, ownership, drift, intelligence); taking ownership needs the user's yes that names the handoff (`ai/CONTINUITY.md`). An adapter passes the command through and adds no semantics.

## 14. Design system: selective loading

`core/` is design authority; `platforms/` adapts it to a platform. Load them by task, never wholesale (`ai/CONTEXT_PROTOCOL.md` → Design system selective loading has the table). Project requirements and local instructions take precedence (`README.md` → Source of truth).

| Task | Load | Do not load |
|---|---|---|
| UI change in a component | that component's entry in `core/COMPONENT_SYSTEM.md`, matching token rows in `core/TOKEN_REGISTER.md` (by name search), the platform file for the target platform | unrelated core files |
| Mobile UI | `platforms/MOBILE.md` and the toolkit file, `core/LAYOUT_SYSTEM.md` (mobile composition), `core/ACCESSIBILITY.md`, the relevant tokens | desktop and 3D files |
| 3D scene | `platforms/WEBGL_3D.md`, `core/MOTION_SYSTEM.md`, `core/ACCESSIBILITY.md` (3D), lighting and camera guidance within `WEBGL_3D.md` | web-only component files |
| Backend, data, build, infrastructure | nothing from the visual design system | all of `core/` and `platforms/` |
| Copy | `core/CONTENT_GUIDELINES.md` | everything else |
| New or changed token | `core/DESIGN_TOKENS.md`, the register rows, `core/DESIGN_DECISIONS.md` | |

An agent applying the design system never changes token statuses or promotes `proposed` values; that is the owner's decision. Do not paraphrase core rules into project files; link to them.

## 15. Conformance checklist

A generic agent conforms when it can show:

- [ ] session start in order (section 2), with tooling detected or its absence noted
- [ ] `status` run first when tooling exists, and its result classified (section 3)
- [ ] the index used for navigation only (section 4)
- [ ] tasks routed through `ai/TASK_ROUTING.md` (section 5)
- [ ] context expanded progressively and stopped by the sufficiency rule (sections 4 and 8)
- [ ] graph queried when available and replaced by search when not (section 7)
- [ ] source treated as authoritative, derived data verified or marked stale (section 8)
- [ ] safe modification and proportional validation (section 8)
- [ ] stale artifacts refreshed lazily with the narrowest command (section 6)
- [ ] task state kept current and a short, actionable handoff written (section 12)
- [ ] incoming handoffs verified before reuse (section 13)
- [ ] no secret read, copied or recorded (section 10)
- [ ] git policy applied as a recommendation, never forced (section 11)
- [ ] design documents loaded selectively (section 14)
- [ ] every fallback honored when derived context is missing (section 9)

## Not allowed here

Design rules, platform rules, protocol text, or agent-, vendor- or API-specific behavior. Those belong in `core/`, `platforms/`, `ai/` and the specific adapters.
