# Adapter: Antigravity

Status: implemented in `antigravity/` (Phase 4D). Inherits `GENERIC.md`; this file is the summary of what is specific to Antigravity. Everything Antigravity-specific lives under `adapters/antigravity/`; nothing Antigravity-specific exists in `core/`, `ai/`, `platforms/` or `templates/`.

## Inherited (see `GENERIC.md`)

Locating the system, session start, status first, context loading, graph use, source authority, safe modification, task state, handoff, cross-agent continuity, fallback, security, git policy, design-system selective loading.

## Specific to Antigravity

- **Entry points:** the `erdem` skill (`antigravity/skill/`, in `<project>/.agents/skills` or `~/.gemini/config/skills`) and an optional small managed block in the project's `AGENTS.md` (`antigravity/agents-block.md`).
- **Pointer, not copy:** neither contains core or `ai/` rules; they point to the canonical documents and call the canonical engine.
- **Safe by construction:** explicit install, dry run, idempotent, ownership markers, no hooks, MCP, plugin or rule changes (`antigravity/scripts/`).
- **Antigravity features used:** skills and AGENTS.md. Hooks are documented but not shipped. Runtime behavior inside Antigravity is not verified; see the adapter README.

Install, doctor, scope, verified and unverified integration points, limitations: `antigravity/README.md`.

## Not allowed here

Design rules, platform rules, or protocol text. If a rule is needed, it belongs in `core/`, `platforms/` or `ai/`.
