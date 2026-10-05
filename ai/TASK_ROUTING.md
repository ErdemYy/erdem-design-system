# Task Routing

Classify the task before loading context. Two independent labels: **types** (what kind of work) and **class** (how big and risky). Context levels and scopes: `CONTEXT_PROTOCOL.md`.

## Task types

A task has one or more types. Types shape *what* to read; the class sets *how far*.

| Type | Add to context | Floor it sets |
|---|---|---|
| UI change | design-system selective loading, component and style files, platform file | none |
| bug fix | reproduction or failing test, error text or log region, target and its callers | none |
| feature | subsystem index, decisions, the closest existing feature (reuse first) | none |
| refactor | direct consumers and tests of the target | impact depth at least direct consumers |
| performance | a measurement or profile first; the hot path only | no speculative changes without measurement |
| architecture | architecture docs, decisions, graph | class ARCHITECTURAL if layers or contracts change |
| documentation | the document and the code regions it describes | none |
| dependency | manifest, usage search for the dependency, release notes if needed (never the lockfile in full) | risk at least MEDIUM; HIGH if a shared or core dependency |
| configuration | the config file and its consumers (no secret values) | risk at least MEDIUM if it affects build, deploy or runtime |
| migration | schema or data definitions, versions, rollback path | risk at least HIGH; CRITICAL if data may be lost |
| test | the target and the project's existing test patterns | none |
| security | the affected trust boundary, auth, input handling, secrets policy | risk at least HIGH |

Combination rule: the context additions are unioned, the highest floor wins, and the class is chosen from scope and risk, never from the type alone.

## Classes

Choose the lowest class that honestly fits. Depth ceiling is the highest level reached by default (`CONTEXT_PROTOCOL.md` levels).

| Class | Typical scope | Depth ceiling | Scope | Expected files | Impact analysis | Validation |
|---|---|---|---|---|---|---|
| TRIVIAL | text, simple style, tiny config | Level 3, target region only | MINIMAL | the target file region | none beyond a check that the text or value is not shared | targeted sanity check |
| SMALL | one component, one local feature | Level 3 | TARGETED | target plus direct dependencies | direct consumers | lint/typecheck where applicable |
| MEDIUM | several related components; one subsystem | Level 4, one subsystem | SUBSYSTEM | the subsystem's relevant files, consumers, tests | consumers, tests, configuration | tests and relevant checks |
| LARGE | a feature across subsystems | Level 4 across subsystems; partial Level 5 (relationships among touched subsystems) | CROSS-SYSTEM | interfaces and touched parts of each subsystem | plus platform, API and design-system impact | tests, typecheck, lint, build if relevant |
| ARCHITECTURAL | architecture change, major refactor, cross-layer modification | Level 5, full relevant architecture | ARCHITECTURAL | architecture docs, decisions, graph, affected layers | transitive, using the graph or its fallback | full relevant validation |

Validation detail: `VALIDATION_PROTOCOL.md`. Impact detail: `CHANGE_IMPACT.md`. Full-repository reads are not part of any class; they need a stated justification.

## Classification signals

- **Scope:** one region or file → TRIVIAL or SMALL; one subsystem → MEDIUM; several subsystems → LARGE; layer boundaries or cross-layer contracts → ARCHITECTURAL.
- **Public surface** touched (`CHANGE_IMPACT.md`): at least MEDIUM.
- **Many consumers** of the target: raises the class by evidence, not by guess.
- **Reversibility:** hard to reverse changes (data, auth, public API) raise risk, not necessarily the class.
- Do not over-classify simple changes: a local text edit stays TRIVIAL even if the file is important.

## Procedure

1. Classify types and class from the request alone (Level 1), using targeted search if needed.
2. Load context to the class's ceiling only as far as the sufficiency rule requires (`CONTEXT_PROTOCOL.md`).
3. If discovery shows a larger scope or risk, reclassify upward and record it in task state (`SESSION_HANDOFF.md`).
4. Never lower a class to avoid validation or impact analysis.
5. If the class cannot be decided after a targeted search, choose the next higher class, state why, and ask if the ambiguity is about intent.
