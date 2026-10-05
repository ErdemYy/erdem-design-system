# Safe Modification

Rules for changing a project. Applies at every class; depth scales with the class (`TASK_ROUTING.md`).

## Before modifying

1. Identify the scope: what must change and why (`CONTEXT_PROTOCOL.md` sufficiency questions).
2. Identify affected files (`CHANGE_IMPACT.md`).
3. Inspect the current implementation of the target.
4. **Search decisions first.** For architectural or non-obvious changes, search `DECISIONS.md`. If a decision applies, reuse it unless requirements changed. If a new decision is made, record it.
5. **Reuse before create** (below).
6. Keep to the scope (below).
7. Preserve existing behavior unless the task requires a change.
8. Validate after (`VALIDATION_PROTOCOL.md`), update task state, and invalidate derived context if needed (`INDEX_PROTOCOL.md`).

## Reuse before create

Before adding an abstraction (component, hook, helper, type, module), search for an existing one by name, by purpose and by usage pattern.

Preference order: **reuse**, then **extend**, then **compose**, and only then **create**.

- If a `Button` exists, do not add a second button component, such as `PrimaryButton2`, without a justification.
- If a `useModal` exists, do not add `useNewModal` unless the requirements actually differ.
- Create only when the requirement differs in substance. Record the reason in task state, or as a decision if the abstraction is shared.
- Do not produce a second version of an existing component.

## No unnecessary refactor

A task does not trigger unrelated cleanup.

- Bad: "change the login button" leads to refactoring the authentication architecture.
- Good: change the requested component, validate the impacted files, stop.

Do not make broad changes only because they would be cleaner. No formatting-only or rename-only changes outside the task. When something adjacent is wrong, record it in task state under knownProblems and continue, unless it blocks the task.

## Decisions

- Format and fields: `templates/DECISIONS.md` (id, decision, reason, scope, status, date, impact; optional priority and supersedes).
- Consumption: search before architectural or non-obvious changes; conflicts are resolved by `CONTEXT_PROTOCOL.md` (newer applicable decision wins unless the older is marked higher priority).
- Append new decisions; never rewrite history; mark superseded ones.

## Prohibitions

An agent does not:

- change files unrelated to the task
- silently change behavior, public interfaces or data shapes
- revert or overwrite changes it did not make without confirmation
- take destructive or hard-to-reverse actions without confirmation
- read or write secrets (`TOKEN_EFFICIENCY.md`)
- promote or alter design tokens' status as a side effect of a coding task (`core/DESIGN_TOKENS.md`)

## Design changes

Design decisions follow `core/` and the precedence in `README.md` → Source of truth. A deviation from core needs a recorded project requirement.
