# Validation Protocol

Validation is proportional to the task class (`TASK_ROUTING.md`). Do not run the heaviest command after every small change.

| Class | Validation |
|---|---|
| TRIVIAL | targeted sanity check (the changed file or behavior) |
| SMALL | lint and typecheck where applicable |
| MEDIUM | tests plus the relevant checks (lint, typecheck) |
| LARGE | tests, typecheck, lint, and build if relevant |
| ARCHITECTURAL | full relevant validation |

## Rules

- "Where applicable" and "relevant" mean: use the checks the project actually provides (found in its manifest or instructions; do not assume commands) and that the change can affect.
- Raise validation when risk is HIGH or CRITICAL (`CHANGE_IMPACT.md`), whatever the class. To raise means: HIGH uses the validation of the next class up (ARCHITECTURAL stays as it is); CRITICAL uses the validation of ARCHITECTURAL.
- Prefer the narrowest check that covers the change: a targeted test before the whole suite, a file-level check before the whole project.
- Run a build only when the change can affect the build (configuration, dependencies, build-time code, public exports).
- Report faithfully: what ran, what passed, what failed, what was not run and why. A failing check is fixed or reported, never hidden.
- Record the result in task state `lastValidation` (`SESSION_HANDOFF.md`).
- UI work is also reviewed against `core/QUALITY_STANDARD.md`; this is a manual review until automation exists.

## Future tooling

Design, context and repository validation: `tools/validation/README.md`.
