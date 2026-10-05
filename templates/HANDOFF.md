# HANDOFF (template)

## Purpose

A snapshot given to the next session or agent so it can continue without the previous conversation. Short; points to other documents instead of copying (`ai/SESSION_HANDOFF.md`).

## Structure

```markdown
---
generatedAt: <ISO 8601>
source: <agent, free text, or "manual">
scope: session
from: <agent>
to: <agent or "any">
---
# Handoff

## Objective
## Completed
## Changed files
- <path>: <reason> [fingerprint: <optional>]
## Current state
## Next action
<one concrete step>
## Open issues
## Important decisions
- <path or D-nnn>
## Validation status
- <check>: passed | failed | not run (<reason>)
## Relevant indexes
- <path>
## Relevant graph nodes
- <node identifiers, or "no graph">
```

## Update rules

- Produce when work changes hands or a session ends with work remaining.
- State what was verified and what was assumed.
- Never edit an old handoff; write a new one.
- No transcripts and no secrets.
- Tooling writes a handoff with a canonical record that it can verify (`project-intel handoff create`, `ai/CONTINUITY.md`); the layout above stays valid for one written by hand, which the tooling cannot verify.
