# ARCHITECTURE (template)

## Purpose

The human-level description of a project's structure: the human graph (`ai/GRAPH_PROTOCOL.md`) in prose and diagram form. Not a file-by-file listing.

## Structure

```markdown
---
generatedAt: <ISO 8601>
source: manual
scope: project
---
# Architecture: <project name>

## Overview
<what the system does and how it is shaped>

## Layers and subsystems
| Name | Responsibility | Depends on |
|---|---|---|

## Data flow
<short description or Mermaid diagram>

## External services
- <service> – <purpose>

## Key constraints
- <constraint>
```

## Update rules

- Update on structural change only (new/removed subsystem, changed layer boundary, new external service).
- Record the reason for structural change in `DECISIONS.md`, not here.
- Keep it short enough to load whole for ARCHITECTURAL tasks.
