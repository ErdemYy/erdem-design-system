# Design Token Contract

The shape, naming, layering, status and theming rules for tokens. **Values live only in `TOKEN_REGISTER.md`.** No other file may state a token's value (single source of truth).

Chain: reference (`EVIDENCE.md`) → decision (`DESIGN_DECISIONS.md`) → token (`TOKEN_REGISTER.md`).

## Token record

| Field | Meaning |
|---|---|
| `name` | canonical ID, see Naming |
| `value` | literal, or alias to another token (`→ name`), or `—` when unknown |
| `type` | `color` · `dimension` · `duration` · `easing` · `font-family` · `font-weight` · `number` · `shadow` · `composite` |
| `role` | purpose in design terms (never appearance) |
| `status` | see Status policy |
| `source` | evidence IDs from `EVIDENCE.md`, or a decision ID |
| `rationale` | one line: why this value and role |

Optional per token when relevant: `platformRelevance` (which platforms use it) and `accessibility` (contrast, size or motion implications). They are written in the rationale or in the owning guideline, not as extra columns.

## Status policy

| Status | Meaning | Official? |
|---|---|---|
| `verified` | value and role observed in a real reference (`EVIDENCE.md`) | yes |
| `approved` | explicitly decided by Erdem, recorded in `DESIGN_DECISIONS.md` | yes |
| `proposed` | suggested or derived (evidence may exist); awaiting confirmation | **no** |
| `experimental` | observed or trialled; not for general use | no |
| `deprecated` | superseded; kept for migration | no |
| `unresolved` | value not decided; candidates listed in rationale | no |
| `needs_reference` | needs a reference or example from Erdem before any decision | no |

Rules:
- Only `verified` and `approved` tokens are official. Implementations may use `proposed` tokens, but must treat them as provisional and flag them in the project's decisions.
- `verified` means observed or checked, not endorsed (DD-040). Promotion to `approved` is Erdem's explicit call. **No token is `approved` yet**; approved decisions currently set rules and policies, not values.
- Status names are case-insensitive: the register writes them lowercase, `EVIDENCE.md` uppercase.
- Never invent a value to fill a row. Use `unresolved` or `needs_reference` and leave the value `—`.
- A value that conflicts with a core rule is not `verified`; record the conflict in `EVIDENCE.md` and lower the status.

## Layers

```
foundation  →  semantic  →  component
 primitives     purpose       one component's decisions
```

| Layer | Holds | Referenced by |
|---|---|---|
| `foundation` | raw palette, font families, easing curves, unit scale | semantic only |
| `semantic` | purpose-based tokens (what the value is *for*) | components, projects, platforms |
| `component` | component-specific decisions, aliased to semantic | that component only |

Example chain: `foundation.color.neutral.950` → `semantic.color.background.primary` → `component.button.primary.foreground` is built from `semantic.color.text.inverse`.

Rules:
- Components and projects use semantic or component tokens, never foundation, never raw values.
- A semantic token may hold a literal only when no primitive is reused (e.g. durations). Move the literal to foundation when a second token needs it.
- Component tokens alias semantic tokens; they hold literals only for component-intrinsic values (e.g. button padding).

## Naming

Canonical form: `<layer>.<category>.<path…>`, lowercase, dot-separated, role-based.

- Roles, not appearance: `semantic.color.text.primary`, never `…white`.
- Short form: the `semantic.` prefix may be omitted in prose and in platform exports (`color.text.primary`, `spacing.md`, `motion.ease.standard`). `foundation.` and `component.` are never omitted.
- Scale words: `xs sm md lg xl 2xl`; breakpoints `small medium large xlarge`; motion `instant fast normal slow cinematic`.
- Variants and states are trailing segments: `component.button.primary.background.hover`.
- Categories: `color`, `typography`, `spacing`, `layout`, `radius`, `border`, `shadow`, `effect`, `elevation`, `z`, `motion`, `breakpoint`, `density`, `icon`.

## Where each category is explained

| Category | Rules in |
|---|---|
| typography | `TYPOGRAPHY.md` |
| color | `COLOR_SYSTEM.md` |
| spacing | `SPACING_SYSTEM.md` |
| layout, breakpoint, density, elevation, shadow, effect, z | `LAYOUT_SYSTEM.md` |
| radius, border, icon, component | `COMPONENT_SYSTEM.md` |
| motion | `MOTION_SYSTEM.md` |

Guidelines explain usage and constraints and refer to tokens by name only.

## Themes

A theme is a mapping from semantic tokens to foundation tokens. Components never change between themes.

| Theme | State |
|---|---|
| `dark` | default; the only mapping in the register (it is how all semantic color rows are currently defined) |
| `light` | architecture only; mapping `unresolved` (DD-036); no implementation |
| `high-contrast` | architecture only; must meet AAA contrast; unresolved |
| `custom-brand` | architecture only; may replace foundation palette and accent mapping, never semantic names |

Requirements for any theme: every semantic color token has a mapping; contrast rules in `ACCESSIBILITY.md` hold; non-color tokens (spacing, motion, type) are theme-independent unless a theme explicitly overrides them.

## Platform mapping

Same semantic names on every platform. A platform maps names mechanically (separator and casing changes only) and may change *how* a value renders, never *what it means*. For example `motion.duration.normal` is the same intent on web, Flutter, React Native, desktop and WebGL; the animation mechanism differs. Mechanisms live in `platforms/`.
