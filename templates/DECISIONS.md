# DECISIONS (template)

## Purpose

An append-only record of decisions that agents and people must respect and not re-litigate. Includes any override of Erdem Design System core (`README.md` → Source of truth). Consumption rules: `ai/SAFE_MODIFICATION.md`; conflict resolution: `ai/CONTEXT_PROTOCOL.md`.

## Structure

```markdown
# Decisions: <project name>

## D-001: <title>
- Date: <YYYY-MM-DD>
- Status: accepted | superseded by D-nnn | rejected
- Scope: <area, subsystem or whole project>
- Decision: <what was decided>
- Reason: <why>
- Impact: <what follows, including risks>
- Priority: normal | high   (optional; high beats a newer conflicting decision)
- Supersedes: <D-nnn or none>   (optional)
- Overrides: <core or platform rule overridden, or "none">
```

## Update rules

- Append; never rewrite history. Mark old entries superseded.
- Number sequentially (`D-001`, `D-002`, …). One decision per entry, kept short.
- Search before architectural or non-obvious changes; reuse an applicable decision.
- Record a new decision when an architectural or non-obvious choice is made.
- Newer applicable decision wins over older, unless the older is `Priority: high`.
