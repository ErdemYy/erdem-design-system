# Design Principles

Foundation of the Erdem Design System. Concrete values are in `TOKEN_REGISTER.md`; this file defines what must feel true and how to test it.
Precedence: `README.md` → Source of truth.

## Rule strength notation

- **[A]** approved by Erdem (Phase 0 and Phase 1 briefs; `DESIGN_DECISIONS.md` DD-001, DD-002, DD-030, DD-037, DD-039, DD-042) or required by a standard.
- **[P]** proposed heuristic derived from evidence; applies as guidance and is flagged in reviews until confirmed. Numbers marked [P] are calibration starting points, not measured facts.

## Design DNA

cinematic · premium · technical · editorial · minimal · futuristic · sophisticated · restrained · immersive **[A]**

Each trait is defined below by what you should be able to observe. A trait that cannot be observed in the result is not present.

| Trait | Observable criteria | Counter-signal |
|---|---|---|
| cinematic | one dominant subject per view; staged reveal with a clear order; light and darkness used for hierarchy | everything lit equally; all content appears at once |
| premium | few elements, generous space, consistent tokens, no placeholder-looking filler | many competing styles; decorative filler |
| technical | monospace labels and metadata, precise alignment, real data and honest status | invented metrics; vague claims |
| editorial | strong type hierarchy, deliberate measure and line breaks, rules instead of boxes | uniform card grids; centered everything |
| minimal | see Minimal criteria | |
| futuristic | restraint in finish; one signal accent on a near-black field; motion with physical logic | neon palettes; glow on everything |
| sophisticated | limited palette and families; contrast through scale and weight | many colors, many fonts |
| restrained | accent and effects are exceptions that guide attention | accent or effect present in every region |
| immersive | the subject (often 3D) carries the experience; interface recedes | interface chrome competes with the subject |

## Core principles **[A]**

1. **Less interface. More experience.** Remove chrome until only what serves the experience remains. Every visible element justifies itself.
2. **Technology should feel tangible.** Interactions have weight, response and consequence. Feedback is immediate and physical in character.
3. **Motion should communicate, not decorate.** Allowed purposes and limits: `MOTION_SYSTEM.md`.
4. **Mobile is a composition, not a scaled desktop.** Measurable rules: `LAYOUT_SYSTEM.md` → Mobile composition.
5. **3D is content when it explains something; otherwise it is decoration.** Selection test: `platforms/WEBGL_3D.md`.

## Minimal criteria **[P]**

"Minimal" is judged on five measurable axes, per view (one screen or one scroll stage):

| Axis | Criterion |
|---|---|
| Visual density | one primary focal object; supporting content visibly subordinate; unused space is intentional |
| Component repetition | at most one repeated container pattern per view; repeated items are separated by rules and spacing, not boxes |
| Decorative effect limits | at most one decorative effect family per view (e.g. grain or glow); functional effects (scrims, focus) do not count |
| Accent usage | at most one accent hue acting as attention color per view; accent covers a small minority of the area |
| Information hierarchy | at most three text emphasis tiers (`text.primary`, `text.secondary`, `text.muted`); hierarchy comes from size, case and spacing before color |

Calibration of "small minority" and "per view" counts happens in the first audit against a real product (open: DD-038).

## Design rule vs implementation rule

- **Design rule** (`core/`): what should feel true.
- **Implementation rule** (`platforms/`): how a platform makes it true.

Example: "Motion is subtle and intentional" is core; CSS + GSAP, Flutter animation controllers and Reanimated are platform mechanisms.

## Prohibited patterns **[A]** and their operational tests

Forbidden by default. A project may override one only through a recorded decision (`templates/DECISIONS.md`).

| Pattern | Operational test (how a reviewer decides) |
|---|---|
| Every section or feature as cards | A filled or bordered container must serve grouping, hierarchy, an interaction boundary, or state separation (`COMPONENT_SYSTEM.md` → Card principle). If removing the container loses nothing, remove it. |
| Generic SaaS dashboard look | uniform grid of equal tiles, stock icon rows, metric tiles without a focal element, gradient hero with centered CTA |
| Excessive gradients | gradients serve legibility (scrims) only; any decorative gradient fill fails **[P]** |
| Excessive glassmorphism | at most one translucent blurred layer in view, only over a scene or media; never the default panel. Material reflection is not glassmorphism (see Glass and reflection below) |
| Excessive rounded corners | `radius.none` is the default; `radius.full` only for inherently round elements |
| Random 3D | fails the 3D selection test in `platforms/WEBGL_3D.md` |
| Meaningless particles | particles are CONTENT (encode information or carry the narrative) or AMBIENT (atmosphere, depth, scale, continuity, under the rules below); anything else is removed |
| Unnecessary motion | motion with no purpose from `MOTION_SYSTEM.md` is removed |
| Tiny typography | functional text (label, body, heading, display) below `typography.size.min` (proposed) is flagged; `micro` text is allowed under its conditions in `TYPOGRAPHY.md` (DD-030). Interactive or primary text at a micro size fails |
| Poor contrast | below WCAG 2.2 AA thresholds in `ACCESSIBILITY.md` |
| Desktop layout scaled to mobile | fails the mobile composition checklist in `LAYOUT_SYSTEM.md` |

## Particles: content vs ambient **[A]** (DD-037)

- **Content particles** encode information (data flow, scale) or carry the narrative.
- **Ambient particles** are allowed only to support atmosphere, depth perception, spatial scale or environmental continuity. Rules: low visual priority; never obscure content; never become the main focus; reduced or disabled on mobile where appropriate; reduced or disabled under reduced motion; off by default for normal application UI.
- Particles that fit neither class are "meaningless" and prohibited.

## Glass and reflection **[A]** (DD-039)

Glass and reflection are optional atmospheric effects. They must support material perception; not reduce text readability; not become the primary visual element; not be applied globally; be reduced on mobile; and not be required for core usability. Excessive glassmorphism (translucent blurred panels as a default surface) stays prohibited; bounded material reflection on an illustrated or 3D object does not.

## Related files

Token contract: `DESIGN_TOKENS.md`. Register: `TOKEN_REGISTER.md`. Gate: `QUALITY_STANDARD.md`.
