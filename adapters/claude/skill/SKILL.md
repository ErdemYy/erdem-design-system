---
name: erdem
description: "Erdem Design System and project-intelligence workflow. Use when the task is UI, visual or interaction design, responsive or mobile layout, 3D/WebGL scenes, portfolio work, a design-system question or review, or a context-heavy change in a project that follows the Erdem system (it has .ai/, or the user mentions Erdem or the design language). Do not use for backend, database, shell, build or unrelated documentation tasks."
argument-hint: "[design|review|context|handoff] [what to do]"
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/erdem.mjs *)
---

# /erdem

Request: $ARGUMENTS

Helper: `node "${CLAUDE_SKILL_DIR}/scripts/erdem.mjs" <command>` with `context`, `root`, or `intel <project-intel arguments>` (runs the engine from the project root). Paths written `<root>/…` are relative to the design-system root that `root` prints. This skill points to canonical documents; it does not restate them. Load only what a step names.

## Mode

First word of the request: `design`, `review`, `context` or `handoff`. If absent: changing or building something is `design`; critiquing existing work is `review`.

- **context**: run `context`, show its output unchanged, stop. Read nothing else.
- **handoff**: see Handoff.
- **review**: `references/claude-workflow.md` → Review. Findings only; change no code unless asked.
- **design**: the workflow below.

## Workflow

1. **Locate the system:** `root`. Not found: continue without design documents and say so once (`references/troubleshooting.md`).
2. **Status first:** if the session-start line already says the intelligence is current, skip; otherwise run `context` once. Classify it as one of current, stale, unverifiable, partial, missing or unavailable (`<root>/adapters/GENERIC.md` §3); the session-start line shows `intelligence=<state>`.
3. **Classify the task:** `<root>/ai/TASK_ROUTING.md` (types, class, depth). Depth and stopping: `<root>/ai/CONTEXT_PROTOCOL.md`.
4. **Design references:** `references/design-routing.md`. Load only the rows that match the task. Never all of `core/`, `ai/` or `platforms/`.
5. **Project context:** `.ai/AI_INDEX.md`, then a directory index, then the target. Task state and handoff only if the work continues earlier work (`references/context-routing.md`).
6. **Search before reading;** read regions, not files (`<root>/ai/TOKEN_EFFICIENCY.md`). Source wins over index, summary and graph.
7. **Impact** for MEDIUM or larger: `intel impact <file>` when the graph is usable, otherwise targeted search (`references/context-routing.md`).
8. **Change within scope** (`<root>/ai/SAFE_MODIFICATION.md`), then validate in proportion to the class (`<root>/ai/VALIDATION_PROTOCOL.md`).
9. **Close:** update `.ai/TASK_STATE.md` when it exists or the task spans sessions; refresh derived context only as `<root>/adapters/GENERIC.md` §8 says; write a handoff only when work remains.

Stop reading when the five sufficiency questions in `<root>/ai/CONTEXT_PROTOCOL.md` are answered.

## Intelligence states

- **current**: use the index and graph for navigation; verify what you rely on in source.
- **stale**: do not rebuild by reflex. Rebuild only what the task needs: `intel index` (incremental) or `intel graph`.
- **unverifiable**: usable as provisional; verify what you rely on in source.
- **partial**: use what is current; targeted search for the rest; refresh only what the task needs.
- **missing**: no derived data exists; inspect the repository directly, or run `intel index` if the task benefits.
- **unavailable**: status could not run, timed out or failed; inspect the repository directly. Never block on missing derived data.
- **graph stale or missing**: targeted search unless structural impact analysis is required. For languages without dependency analysis, never invent relationships.

## Handoff

Write `.ai/HANDOFF.md` only for a meaningful transition: unfinished work or a change of owner. Format: `<root>/templates/HANDOFF.md`. One next action, changed files, decisions as pointers, validation status. No conversation history, no secrets, no copied source. Update `.ai/TASK_STATE.md` as well. When receiving a handoff, verify it before trusting it (`<root>/adapters/GENERIC.md` §13). With `project-intel`, `intel handoff create` issues and `intel handoff resume` verifies a handoff (`<root>/ai/CONTINUITY.md`); taking ownership needs the user's yes naming the handoff (`--accept --owner <agent> --confirm <handoffId>`).

## Boundaries

- Three scopes stay separate: Claude's auto memory (personal), project state in `.ai/` and the project's own files, and Erdem rules in the design system. Do not store in auto memory what a repository file already records (`references/claude-workflow.md`).
- Never read or record secrets. Never copy design-system documents into the project. Never promote a token's status.
- Unrelated work: stop using this skill.
