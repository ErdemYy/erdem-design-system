# Tools: Validation

Status: contract only. **No validation code exists.** Planned for Phase 5. Related, already implemented: `project-intel status` (stale derived context, `tools/index/`) and `tools/scripts/check.mjs` (syntax and dependency rule for the tools themselves).

## Future responsibilities

- Design validation (against `core/QUALITY_STANDARD.md`)
- Context validation (indexes and summaries fresh, handoffs complete)
- Repository health (this repository's own consistency: manifest, links, duplicate knowledge)

## Contracts

- Reports pass/fail with reasons; never hides failures (`ai/VALIDATION_PROTOCOL.md`).

## Rules

- Design validation implements the criteria in `core/QUALITY_STANDARD.md` and the status policy in `core/DESIGN_TOKENS.md` (for example flagging use of non-official tokens); it does not redefine them.
