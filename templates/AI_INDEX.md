# AI_INDEX (template)

## Purpose

Level 0 navigation map of a project for AI agents. Navigation only; source code wins (`ai/INDEX_PROTOCOL.md`). Blank template: do not fill it with invented structure.

## Structure

Copy into the project as `AI_INDEX.md`. Keep it short enough to read whole.

```markdown
---
generatedAt: <ISO 8601>
source: manual | <tool and version>
scope: project
fingerprint: <optional>
indexProfile: none | lite | standard | full
---
# AI Index: <project name>

## Identity
Purpose: <one or two sentences> · Platforms: <list>

## Architecture overview
<few lines> · Details: <path to architecture document>

## Subsystems
| Subsystem | Path | Role | Local index |
|---|---|---|---|

## Important directories
| Path | Role |
|---|---|

## Important files
| Path | Role |
|---|---|

## Entry points
- <path>: <role>

## Generated folders (do not edit)
- <path or "none">

## Ignore by default (present in this project)
- <path or "none">

## Decisions
- <path to DECISIONS.md>

## Current task state
- <path to TASK_STATE.md, or "none">

## Available summaries
| Path | Scope | Status |
|---|---|---|

## Available graphs
| Path | Format | Status |
|---|---|---|

## Design system
- Erdem Design System: <path or version> · platform: <list>
- Deviations from core: <pointers to decisions, or "none">

## State artifacts
- Handoff: <path> · Task state: <path>
```

## Update rules

Policy by task class: `ai/INDEX_PROTOCOL.md` → Update policy. In short: update only when a subsystem, directory or entry point is added, removed, moved or changes role; remove stale entries; if it disagrees with code, fix the index. Never record secret values.
