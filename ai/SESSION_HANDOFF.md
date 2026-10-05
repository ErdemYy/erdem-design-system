# Session State and Handoff

State lives in repository artifacts, not in a conversation. This is what lets any agent continue the work of any other. Blank formats: `templates/`. Principle: **point, do not copy**.

## Artifacts

| Artifact | Purpose | Lifetime |
|---|---|---|
| `TASK_STATE.md` | live state of the current task | updated at milestones; replaced when the task ends |
| `DECISIONS.md` | durable decisions | append-only (see `SAFE_MODIFICATION.md`) |
| `HANDOFF.md` | snapshot given to the next agent or session | written when work changes hands; never edited afterwards |

Paths are declared in the project's `AI_INDEX.md`. Without an index, look for these names at the project root and in its docs directories. Whether state files are committed is a project choice. They never contain secrets or conversation transcripts (`TOKEN_EFFICIENCY.md`).

## TASK_STATE.md

Concise. Fields:

| Field | Content |
|---|---|
| goal | one or two sentences |
| status | not-started, in-progress, blocked, done |
| class and risk | task class and risk level (`TASK_ROUTING.md`, `CHANGE_IMPACT.md`); note any reclassification |
| completed | work done and verified |
| changedFiles | path and one-line reason |
| remaining | ordered |
| knownProblems | including adjacent issues found but not fixed |
| openDecisions | questions needing an answer |
| blocked | what, and waiting on what |
| relevantFiles | pointers, with indexes or summaries consulted |
| lastValidation | what ran and the result, or not run and why |
| owner | the agent currently responsible (free text) |
| updatedAt | ISO 8601 |

Update at milestones, not every edit. Single writer: only the owner updates it; a handoff transfers ownership.

## HANDOFF.md

Snapshot for the next agent. Fields:

| Field | Content |
|---|---|
| objective | current objective |
| completed | |
| changedFiles | path and reason; optionally a fingerprint (`INDEX_PROTOCOL.md`) to detect later drift |
| currentState | where things stand now |
| nextAction | one concrete next step |
| openIssues | |
| importantDecisions | pointers to decision IDs or paths |
| validationStatus | what passed, failed, was not run |
| relevantIndexes | pointers |
| relevantGraphNodes | node identifiers, if a graph exists |
| from, to | agent names, free text, informational |
| generatedAt | ISO 8601 |

Rules: short; report facts and what was verified versus assumed; reference documents instead of repeating them; do not edit an old handoff, write a new one. Header metadata follows `INDEX_PROTOCOL.md`.

## Cross-agent continuity

Any agent to any other agent, in any direction, without reading the previous conversation. This works because:

- the formats above are plain Markdown with no agent-specific syntax; agent names appear only in free-text fields
- everything the next agent needs is a repository artifact or a pointer to one
- how each agent finds and writes the artifacts is described in `adapters/`, not here

Receiving agent:

1. Read the handoff, then the task state (Level 0 of `CONTEXT_PROTOCOL.md`).
2. Check drift: do the changed files still match (fingerprint if given; otherwise version-control status or a targeted look)?
3. Load only the pointed indexes, decisions and files, at the level `nextAction` needs.
4. Verify claims that the next step depends on against source; treat the rest as provisional.
5. Take ownership in `TASK_STATE.md` with the explicit yes that names that handoff (A2; `ai/CONTINUITY.md`), then continue from `nextAction`. Issuing a handoff does not transfer ownership, and reading one does not take it.

If the handoff is missing or incomplete, proceed from task state and source (`CONTEXT_PROTOCOL.md` → Missing or stale context).

## Canonical continuity

Ownership states, the transfer rule, handoff identity and integrity, the receiver's verification, drift and idempotency are defined once in `CONTINUITY.md`; the reference implementation is `project-intel handoff` (`tools/automation/README.md`). The artifacts above remain the only ones: when the tooling issues a handoff, `TASK_STATE.md` also carries one generated `## Continuity` block (task identity, pending handoff, last transfer) and the handoff carries its canonical record, both plain Markdown. A handoff written by hand stays valid, but the tooling cannot verify it.
