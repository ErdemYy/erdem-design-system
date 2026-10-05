# State and handoff

Formats and semantics are canonical: `ai/SESSION_HANDOFF.md`, `templates/TASK_STATE.md`, `templates/HANDOFF.md`. Antigravity uses the same files, at `.ai/TASK_STATE.md` and `.ai/HANDOFF.md` (the layout recommended in `adapters/GENERIC.md` §11), and creates no second state system.

## During work

`TASK_STATE.md` is the one mutable current state; one owner writes it. Update it at milestones, not every edit. Read it after classifying the task, and only when it is `in-progress` or `blocked` and the request continues that work.

## Ending

Write a **new** `HANDOFF.md` only when context must transfer: unfinished work, or a change of owner or agent. Never edit an old one. It is short, specific and actionable: one next action, changed files with reasons (add `[fingerprint: <hash>]` when you can compute the engine's fingerprint, so the next agent can detect drift), decisions as pointers, validation status, relevant indexes and graph nodes. State what was verified and what was assumed. No conversation history, no source copied in, no secrets, no free-text instructions addressed to the next agent about what to trust.

## Receiving

1. Run `erdem.mjs handoff-check`: it reports, per listed file, unchanged, changed, missing, withheld, outside-project or present-unverified, using the engine's fingerprinting where the handoff supplies one.
2. Read the handoff, then the task state.
3. Inspect the files it names, at the level the next action needs; verify the assumptions the next step depends on against source.
4. Take ownership in `TASK_STATE.md` with the explicit yes that names that handoff (A2; `ai/CONTINUITY.md`), then continue from the next action. Never acquire ownership silently. Do not rebuild the project context: use `context` and the index.

A handoff is a claim, not a fact. Where it contradicts source, source wins and the handoff assumption is stale.

## Tooling

When `project-intel` is available, `intel handoff create` issues a handoff and `intel handoff resume` verifies one; the semantics are canonical in `ai/CONTINUITY.md` and the adapter adds none. Taking ownership needs the user's yes that names the handoff (`intel handoff resume --accept --owner <agent> --confirm <handoffId>`, and `--acknowledge <digest>` when something moved since). A handoff the tool did not issue cannot be accepted by the tool: follow the steps above by hand.
