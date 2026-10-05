# TASK_STATE (template)

## Purpose

Live, concise state of the current task so any agent can resume without rediscovery. Field definitions: `ai/SESSION_HANDOFF.md`. For a snapshot at a point of transfer use `HANDOFF.md`.

## Structure

```markdown
---
updatedAt: <ISO 8601>
owner: <agent, free text>
---
# Task State

## Goal
## Status
not-started | in-progress | blocked | done

## Class and risk
Class: TRIVIAL | SMALL | MEDIUM | LARGE | ARCHITECTURAL
Risk: LOW | MEDIUM | HIGH | CRITICAL
Reclassified: <from → to, and why, or "no">

## Completed
- <done and verified>

## Changed files
- <path>: <reason>

## Remaining
1.

## Known problems
- <including adjacent issues found and not fixed>

## Open decisions
- <question>

## Blocked
- <what, waiting on what>

## Relevant files
- <path>: <why>; indexes or summaries consulted: <paths>; worked without: <missing artifacts, if any>

## Last validation
- <check>: passed | failed | not run (<reason>)
```

## Update rules

- Update at milestones, not every edit. Only the owner writes it.
- No conversation transcripts, no secrets, no copied source.
- Record reclassification and why.
- Record adjacent problems here instead of fixing them silently.
- Replace or archive when the task ends.
- The generated `## Continuity` block (task identity, pending handoff, last transfer) is written only by `project-intel handoff` (`ai/CONTINUITY.md`); do not edit it by hand.
