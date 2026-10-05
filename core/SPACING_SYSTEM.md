# Spacing System

Values: `TOKEN_REGISTER.md` (spacing and layout rows). Layout use: `LAYOUT_SYSTEM.md`.

## Scale

A base unit (`foundation.space.unit`) multiplied into steps; the semantic scale picks the steps in use:

`spacing.xs` · `spacing.sm` · `spacing.md` · `spacing.lg` · `spacing.xl` · `spacing.2xl`

The semantic steps are `proposed` (derived from usage frequency in the primary reference, not yet confirmed). The base unit is `verified`. Do not add steps without a recorded need; do not use raw values.

## Levels

| Level | Use | Tokens |
|---|---|---|
| Component | inside one component (padding, inner gaps) | `spacing.xs` to `spacing.md`, plus component tokens (e.g. `component.button.padding`) |
| Grouping | between related components | `spacing.md` to `spacing.xl`; `layout.grid.gap.*` for grids |
| Section | between major content blocks | `layout.section.padding.*` (proposed) |
| Page / edge | page margins | `layout.gutter.*` (verified) |

## Mobile vs desktop

- The scale is the same on every device; **usage** changes. Smaller screens use smaller levels (for example grid gap steps down, section padding steps down) via the responsive tokens, not a global multiplier.
- Touch targets define minimum spacing between controls (`ACCESSIBILITY.md`), regardless of the scale.
- Edge spacing is stepped by breakpoint (`layout.gutter.small/medium/large`). A fluid alternative is `experimental` (DD-016).

## Rules

- Vertical rhythm: use the scale consistently within a view; related items closer than unrelated items (proximity creates grouping, so do not box them).
- Space is a design material, not leftover. Generous space is part of the "premium" and "restrained" criteria (`DESIGN_PRINCIPLES.md`).
- Section-level tokens are single-use evidence; confirm before wide reuse.
