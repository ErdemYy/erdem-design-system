# Adapter: OpenAI Codex

Status: implemented in `codex/` (Phase 4C). Inherits `GENERIC.md`; this file is the summary of what is specific to Codex. Everything Codex-specific lives under `adapters/codex/`; nothing Codex-specific exists in `core/`, `ai/`, `platforms/` or `templates/`.

## Inherited (see `GENERIC.md`)

Locating the system, session start, status first, context loading, graph use, source authority, safe modification, task state, handoff, cross-agent continuity, fallback, security, git policy, design-system selective loading.

## Specific to Codex

- **Entry points:** the `$erdem` skill (`codex/skill/`, in `<repo>/.agents/skills` or `~/.agents/skills`) and an optional small managed block in `AGENTS.md` (`codex/agents-block.md`).
- **Pointer, not copy:** neither contains core or `ai/` rules; they point to the canonical documents and call the canonical engine.
- **Safe by construction:** explicit install, dry run, idempotent, ownership markers, no `config.toml` or hook changes (`codex/scripts/`).
- **Codex features used:** skills and AGENTS.md. Hooks are not shipped (file-based registration unverified); the protocol remains valid without any Codex feature.

Install, doctor, scope, verified and unverified integration points, limitations: `codex/README.md`.

## Not allowed here

Design rules, platform rules, or protocol text. If a rule is needed, it belongs in `core/`, `platforms/` or `ai/`.
