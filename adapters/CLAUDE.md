# Adapter: Claude Code

Status: implemented in `claude/` (Phase 4B). Inherits `GENERIC.md`; this file is the summary of what is specific to Claude Code. Everything Claude-specific lives under `adapters/claude/`; nothing Claude-specific exists in `core/`, `ai/`, `platforms/` or `templates/`.

## Inherited (see `GENERIC.md`)

Locating the system, session start, status first, context loading, graph use, source authority, safe modification, task state, handoff, cross-agent continuity, fallback, security, git policy, design-system selective loading.

## Specific to Claude Code

- **Entry points:** a small managed block in the project's or user's `CLAUDE.md` (`claude/CLAUDE.md`), the `/erdem` skill (`claude/skill/`), and an optional SessionStart status line (`claude/hooks/session-start.mjs`).
- **Pointer, not copy:** none of these contain core or `ai/` rules; they point to the canonical documents and load them by task.
- **Safe by construction:** explicit install, dry run, idempotent, ownership markers, backups, existing hooks preserved (`claude/scripts/`).
- **Claude features used:** skills, SessionStart hooks, CLAUDE.md. Memory, subagents and path-scoped rules are described but not required; the protocol remains valid without any of them.

Install, configuration, doctor and troubleshooting: `claude/README.md`.

## Not allowed here

Design rules, platform rules, or protocol text. If a rule is needed, it belongs in `core/`, `platforms/` or `ai/`.
