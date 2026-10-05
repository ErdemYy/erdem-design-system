# Color System

Rules for color. Values: `TOKEN_REGISTER.md` (color rows). Contract: `DESIGN_TOKENS.md` (layers, themes). Thresholds: `ACCESSIBILITY.md`.

## Raw vs semantic

- **Raw palette** is `foundation.color.*` and `foundation.alpha.*`. Only theme mappings read it.
- **Semantic color** is `semantic.color.*`: what a color is for. Components, projects and platforms use semantic names only.
- Do not add raw colors to a component. If a needed role has no token, add a semantic token (with status) first.

## Semantic roles

| Group | Tokens | Purpose |
|---|---|---|
| Background | `color.background.primary/secondary` | page fields |
| Surface | `color.surface.primary/secondary` | raised areas, media frames |
| Text | `color.text.primary/secondary/muted/placeholder/inverse` | three emphasis tiers plus placeholder and inverse |
| Border | `color.border.subtle/default/strong` | subtle: decorative hairlines; default: decorative emphasis only; strong: control boundaries (needs 3:1) |
| Accent | `color.accent.primary/secondary` | attention and technical signal |
| Status | `color.status.success/warning/error/info` | feedback (all `needs_reference`) |
| Overlay | `color.overlay.scrim.*`, `color.overlay.menu` | legibility layers over scenes |
| Focus, selection | `color.focus.ring`, `color.selection.*` | interaction indicators |
| Glow | `shadow.glow.screen` | light emitted by an emissive element |
| 3D light | scene data (`platforms/WEBGL_3D.md`) | not tokens |

## Dark system

The Erdem visual language is dark by default (DD-001 DNA; the only mapping currently defined).

- Background is a near-black, not `#000000` (DD-012). Pure black is allowed only with a recorded project decision stating why (for example a display-specific requirement) and must be checked against scrim, fog and vignette needs.
- Text is a warm soft white, not pure white.
- Depth between background, surface and text comes from tonal steps and hairlines, not shadows (`LAYOUT_SYSTEM.md` → Depth).
- Every text/background pair must meet the AA baseline in `ACCESSIBILITY.md`. Role-level measurements for the current palette are in its Contrast audit; not every role meets AAA, and text over scenes is unmeasured.

## Accent system

Principle: **accent guides attention; it does not color the interface.**

Accent may be used for: primary call to action, active state, focus state, selected navigation, important metadata, and data visualization or 3D highlights.

Limits **[P]**:
- At most one accent hue as attention color per view. `accent.primary` is that hue.
- `accent.secondary` is restricted to technical content: data, diagrams, 3D light. It is not a second brand color for the interface.
- Accent never fills large areas or backgrounds of sections.
- Accent text must still pass contrast; accent is never the only signal of meaning (`ACCESSIBILITY.md` → Part A, SC 1.4.1 Use of Color).
- No gradients between accent colors, and no gradient fills of any kind except functional scrims (DD-014).

## Overlays and legibility

When copy sits over a scene or media, it sits on a scrim token. The scrim fades toward the subject, so the subject stays unobstructed and copy stays readable. Narrow screens use the stronger scrim because copy and subject overlap more. Geometry of the fade is platform detail (`platforms/WEB.md`).

## Status colors

Success, warning, error and info are `needs_reference` (DD-034); no palette is invented. They will be required for: form validation and field errors, saved or sent confirmations, warnings before irreversible or limited actions, neutral notices, destructive buttons, and data or system status indicators. Until defined: communicate status with text, shape and position, never color alone (WCAG 1.4.1), and use `accent.primary` only for emphasis, never to mean "success" or "error".

## Themes

Architecture for dark, light, high-contrast and custom-brand themes: `DESIGN_TOKENS.md` → Themes. Light is not implemented.
