# Validation

Validation is proportional to the task class and risk. The rules are canonical: `ai/VALIDATION_PROTOCOL.md`; the class table is `ai/TASK_ROUTING.md`. This file only says how Antigravity applies them.

- **Choose commands from the project**, not from assumptions: its manifest or instructions name the lint, typecheck, test and build commands. Run the narrowest check that covers the change (a file-level check or a targeted test before the whole suite).
- **Escalate** when the class rises, when impact analysis shows HIGH or CRITICAL risk or a public surface, or when the change touches configuration, dependencies or build-time code. A build is run only when the change can affect the build.
- **Design work** is also reviewed against `core/QUALITY_STANDARD.md` (manual review; no automation exists yet).
- **Report faithfully:** what ran, what passed, what failed, what was not run and why. A failing check is fixed or reported, never hidden. Record the result in `.ai/TASK_STATE.md` under last validation.
- **Sandbox limits are not validation results.** If a command cannot run in the session (no network, no permission, missing tool), say so; do not claim the check passed.
- **After the change:** refresh derived context only as the class requires (`adapters/GENERIC.md` §8), then re-check with `erdem.mjs context`.
