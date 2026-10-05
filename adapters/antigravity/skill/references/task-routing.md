# Task routing

The classes, types and rules are canonical: `ai/TASK_ROUTING.md`. Antigravity uses them unchanged and adds no class of its own. The table below only maps each canonical class to its depth ceiling, scope and the Antigravity action; if it disagrees with `ai/TASK_ROUTING.md`, that file wins (an automated test compares them).

| Class | Ceiling | Scope | In Antigravity |
|---|---|---|---|
| TRIVIAL | Level 3 (target region only) | MINIMAL | read the target region; no impact query; targeted check |
| SMALL | Level 3 | TARGETED | target and direct dependencies; `intel impact` only if the file looks shared |
| MEDIUM | Level 4 | SUBSYSTEM | directory index, `intel impact`, consumers and tests it names |
| LARGE | Level 4 (partial Level 5) | CROSS-SYSTEM | `intel impact` and a graph view across the touched subsystems; record the impact in task state |
| ARCHITECTURAL | Level 5 | ARCHITECTURAL | architecture documents, decisions, graph; plan before changing |

Risk-aware escalation is canonical (`ai/CHANGE_IMPACT.md`): a public surface, HIGH or CRITICAL risk, or a change that is hard to reverse raises impact depth and validation even when the class stays the same. Examples of the same mapping: an isolated copy edit is TRIVIAL (minimal context); a component spacing change is SMALL (targeted); a subsystem redesign is MEDIUM; a cross-system refactor is LARGE; architecture, security and migration changes are ARCHITECTURAL or at least HIGH risk.

If discovery shows a larger scope, reclassify upward and record it in `.ai/TASK_STATE.md`; never reclassify downward to avoid validation. If the class cannot be decided after one targeted search, take the next higher class and say why, or ask when the doubt is about intent.
