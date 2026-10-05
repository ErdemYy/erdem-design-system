# Layout System

How content is composed on a surface. Values: `TOKEN_REGISTER.md` (layout, breakpoint, shadow, effect, elevation, z rows). Platform adaptation: `platforms/`.

## Structure

| Concept | Rule | Tokens |
|---|---|---|
| Edge spacing | content keeps a stepped gutter from the viewport edge | `layout.gutter.small/medium/large` |
| Container | the reference uses full-width layouts with gutters; no max-width container is defined | `layout.container.max` (unresolved, DD-032) |
| Reading width | running text has a bounded measure; no bound on narrow screens | `layout.measure.reading` |
| Grid | multi-column layouts use a column grid at medium and up; one column below | `layout.grid.columns` (proposed), `layout.grid.gap.*` |
| Section spacing | vertical space between major blocks | `layout.section.padding.*` (proposed) |
| Full-bleed | media, scenes and rules may run edge to edge; text never does (it stays inside the gutter) | |
| Alignment | text blocks align to a shared edge; mixing alignments in one block is avoided | |

## Composition: anchors and asymmetry

- **Strong visual anchor.** Every view has one dominant element (a display headline, a 3D subject, or a media object) that fixes the composition. Everything else is placed in relation to it.
- **Asymmetry is a tool, not a rule.** Use it when it clarifies hierarchy or makes room for the subject, for example copy on one side and the subject on the other, or a bottom-aligned headline under a scene. Symmetric or centered compositions are valid when the content calls for them. No view is required to be asymmetric, and asymmetry is not applied to every section.
- Copy side relative to the subject is chosen per view and paired with a scrim (`COLOR_SYSTEM.md`).

## Structure without cards

Separate items with hairlines (`color.border.subtle`, `border.width.subtle`) and `spacing.*`. Containers are governed by `COMPONENT_SYSTEM.md` → Card principle.

## Depth: elevation, shadow, effects

Dark interfaces carry little visible shadow. Depth is built in this order:

1. **Contrast and surface change**: `elevation.raised` (a surface step plus a hairline).
2. **Light**: emissive elements emit glow (`shadow.glow.screen`); 3D uses scene lighting.
3. **Opacity and overlay**: scrims and menus (`elevation.overlay`).
4. **Blur**: `effect.blur.control`, one blurred layer per view **[P]**, only over a scene or media.
5. **Scale**: subtle scale changes that communicate focus (`MOTION_SYSTEM.md`).

Principle (DD-041): depth comes from contrast, surface change, light, opacity, scale and composition; shadow and elevation are used only when needed. No shadow scale is defined. Conventional drop shadows (`shadow.drop.*`) are `needs_reference`: the reference uses none, so do not add them. Reflection and glow on emissive or illustrated objects follow the glass and reflection rules in `DESIGN_PRINCIPLES.md`. Text over 3D may use `shadow.text.legibility`. Inset falloff (`shadow.inset.vignette`) is for illustrated screens only.

Stacking order uses `z.*` tokens only (`base`, `content`, `menu`, `header`, `transition`, `loading`, `skip`, `cursor`). The skip link sits above the loading screen so keyboard users are never blocked.

## Responsive system

Semantic breakpoints: `breakpoint.small` (base), `medium`, `large`, `xlarge`. Extra signals: `breakpoint.compact` (very small phones) and `breakpoint.height.short` (short landscape). Exact values are in the register (verified from the primary reference); do not introduce other thresholds.

| Range | Intent |
|---|---|
| small | single-focus composition, touch first, reduced density and effects |
| medium | transitional: two columns allowed, touch and pointer both possible |
| large | full desktop composition |
| xlarge | more space, not more content; max width decided in DD-032 |

Rules:
- Breakpoints change **composition**, not just size (`DESIGN_PRINCIPLES.md` principle 4).
- Short landscape screens (`breakpoint.height.short`) do not use viewport-tall pinned stages; content sets the height.
- Pointer and touch are detected by capability, not by breakpoint (a large tablet is touch; a small window can be pointer).

## Mobile composition

Checklist; each item is a heuristic **[P]** except where noted. A view passes "mobile is a composition" when:

| # | Criterion |
|---|---|
| 1 | one primary focal object at a time (observed in the reference) |
| 2 | at most three simultaneous visual layers (for example scene, scrim, copy) |
| 3 | secondary labels and annotations present on desktop may be removed on small screens |
| 4 | text blocks use the narrow-screen reading leading and no desktop max width (verified) |
| 5 | primary actions are reachable by thumb and meet touch-target size; they may form a dedicated action area |
| 6 | decorative effects are reduced or removed, never added |
| 7 | hover-only affordances are replaced, not carried |
| 8 | scroll length per section is shorter than desktop; content priority decides what remains |
| 9 | headings are recomposed (`TYPOGRAPHY.md`), not just shrunk |

Mobile visual density **[P]**:

| Dimension | Heuristic |
|---|---|
| simultaneous primary focal objects | 1 |
| competing visual layers | ≤ 3 |
| text density | one idea per screen of copy; secondary text is deferred |
| interaction density | one primary action cluster visible at a time |
| decorative effect density | lower than desktop, never higher |

Density modes (`density.*`) are `needs_reference`.
