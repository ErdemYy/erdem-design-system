# Evidence Register

Every design value in `TOKEN_REGISTER.md` cites an entry here. Chain: **reference → decision → token** (`DESIGN_DECISIONS.md`, `DESIGN_TOKENS.md`).

This file records *where facts came from*. It refers to tokens by name and does not restate token values (those live only in the register). Contrast measurements are in `ACCESSIBILITY.md` → Contrast audit.

## Evidence status

| Status | Meaning |
|---|---|
| VERIFIED | observed directly in a real file, or checked against an official source |
| PROPOSED | derived or suggested from evidence; not confirmed |
| UNRESOLVED | evidence exists but does not settle the question |
| NEEDS_REFERENCE | no evidence found; a reference from Erdem is required |
| EXPERIMENTAL | observed but outside the intended system, or unaudited |

These are the same words as token statuses (`DESIGN_TOKENS.md` → Status policy; the register writes them in lowercase). VERIFIED means *observed or checked*, never *approved*.

## Normative accessibility sources (official W3C)

Checked on 2026-10-03 against the W3C pages below. Use only these for normative claims. Levels are those stated by W3C.

| SC | Title | Level | Source |
|---|---|---|---|
| 1.4.3 | Contrast (Minimum) | AA | https://www.w3.org/TR/WCAG22/#contrast-minimum |
| 1.4.6 | Contrast (Enhanced) | AAA | https://www.w3.org/TR/WCAG22/#contrast-enhanced |
| 1.4.11 | Non-text Contrast | AA | https://www.w3.org/TR/WCAG22/#non-text-contrast |
| 2.5.8 | Target Size (Minimum) | AA | https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html |
| 2.5.5 | Target Size (Enhanced) | AAA | https://www.w3.org/TR/WCAG22/#target-size-enhanced |
| 2.4.7 | Focus Visible | AA | https://www.w3.org/TR/WCAG22/ |
| 2.4.11 | Focus Not Obscured (Minimum) | AA | https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html |
| 2.4.13 | Focus Appearance | AAA | https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html |
| 1.4.4 | Resize Text | AA | https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html |
| 1.4.10 | Reflow | AA | https://www.w3.org/WAI/WCAG22/Understanding/reflow.html |
| 2.2.2 | Pause, Stop, Hide | A | https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html |
| 2.3.1 | Three Flashes or Below Threshold | A | https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html |
| 2.3.3 | Animation from Interactions | AAA | https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html |
| 1.1.1, 1.3.1, 1.4.1, 1.4.12, 1.4.13, 2.1.1, 2.1.2, 2.4.1, 2.4.3, 2.5.1, 2.5.7, 3.1.1, 3.1.2, 3.3.1, 3.3.2, 3.3.3, 4.1.2 | levels confirmed in the WCAG 2.2 success-criteria listing | A or AA as listed in `ACCESSIBILITY.md` | https://www.w3.org/TR/WCAG22/ |

Normative wording used (summarized from the pages above, each verified): 1.4.3 requires 4.5:1 for text and 3:1 for large text, where large is "at least 18 point or 14 point bold"; 1.4.6 requires 7:1 and 4.5:1 for large; 1.4.11 requires 3:1 against adjacent colors for visual information needed to identify UI components and states and for parts of graphics needed to understand content; 2.5.8 requires 24 by 24 CSS px with five exceptions (spacing, equivalent, inline, user agent control, essential); 2.5.5 requires 44 by 44 CSS px with exceptions; 2.4.13 requires an indicator area at least as large as a 2 CSS px thick perimeter of the component and a 3:1 change between focused and unfocused pixels; 2.4.11 requires the focused component to be "not entirely hidden"; 2.2.2 applies to automatic content lasting more than five seconds presented in parallel with other content.

## Non-normative sources

| ID | Source | Status | Use |
|---|---|---|---|
| S2 | Standard easing equivalents (easings.net) and GSAP ease naming (power1 quad, power2 cubic, power3 quart, power4 quint) | PROPOSED | cubic-bezier equivalents only; not fetched this session |
| S3 | Platform guidance: Apple HIG 44 pt, Material 48 dp touch targets | NEEDS_REFERENCE (not fetched) | context for Erdem preferred touch size; never cited as normative |

## Project references

Folders next to this repository (`../<name>`). Snapshot inspected 2026-10-03, not pinned to commits.

| ID | Repository | Weight |
|---|---|---|
| R1 | `erdem-portfolio` (styles) | primary |
| R2 | `erdem-portfolio` (layout, fonts) | primary |
| R3 | `erdem-portfolio` (3D choreography) | primary |
| R4 | `erdem-portfolio` (performance, post-processing, lighting) | primary |
| R5 | `erdem-portfolio` (README) | primary |
| R6 | `erdem-portfolio` (components, scroll utilities, i18n) | primary, usage counts |
| R7 | `web-site` | secondary |
| R8 | `portfolyo`, `havalı`, `dark-port` | not adopted: different systems |

Not examined: `AITrade`, `AegisQuant`, `aibot`, `WORLDSEED` and other folders. No screenshots, Figma files or brand files were found.

## Observation log (code-derived)

Each row: repository · file · selector / token / usage → observation → token(s) → status. Values are in the register.

| ID | File | Selector / usage | Observation | Token(s) | Status |
|---|---|---|---|---|---|
| R1 | `app/globals.css` | `@theme` colors | five neutrals, one signal accent, one blue, a hairline alpha; comment states one controlled accent plus one sparingly used blue | `foundation.color.*`, `foundation.alpha.hairline` | VERIFIED |
| R1 | `app/globals.css` | `html`, `body`, `::selection` | near-black page, soft-white text, accent selection | `color.background.primary`, `color.text.primary`, `color.selection.*` | VERIFIED |
| R1 | `app/globals.css` | `.display`, `.display-xl/lg/md/sm` | uppercase sans display with tight tracking and leading, fluid sizes bounded by width and height | `typography.display.*` | VERIFIED |
| R1 | `app/globals.css` | `.label` | uppercase mono, small, widely tracked, muted color; used for secondary metadata | `typography.micro`, `typography.tracking.micro` | VERIFIED |
| R1 | `app/globals.css` | `.btn`, `.btn-solid` | square corners, mono uppercase label slightly under the functional minimum, accent fill primary, translucent outlined secondary, 0.4s CSS-default easing, smaller padding on narrow screens | `component.button.*` | VERIFIED |
| R1 | `app/globals.css` | `:focus-visible` | single-line accent outline with offset | `border.width.focus`, `focus.offset`, `color.focus.ring` | VERIFIED |
| R1 | `app/globals.css` | `.scrim-*` | ink-based gradients from the copy edge; stronger on narrow screens | `color.overlay.scrim.*` | VERIFIED |
| R1 | `app/globals.css` | `.screen-surface`, `.screen-glass` | glow shadow; faint diagonal reflection and inset falloff confined to illustrated 3D screens | `shadow.glow.screen`, `shadow.inset.vignette` | VERIFIED (reflection: see DD-039) |
| R1 | `app/globals.css` | `.cursor-*`, `has-custom-cursor` | custom cursor for fine pointers only | (behavior) | VERIFIED |
| R1 | `app/globals.css` | `html.reduced-motion` | transitions and animations collapse | `motion.duration.reduced` | VERIFIED |
| R1 | `app/globals.css` | `.scroll-cue-line` | infinite looping cue animation | `component.scroll.cue.duration` | VERIFIED (see conflict C-5) |
| R1 | `app/globals.css` | `@theme --breakpoint-xs`, media queries | compact, 767 / 768 split, short-landscape query | `breakpoint.*` | VERIFIED |
| R1 | `app/globals.css` | `.touch-actions .btn` | minimum height for thumb-reach actions | `component.button.min-height.touch` | VERIFIED |
| R2 | `app/layout.tsx` | font imports, `themeColor`, `colorScheme` | three families via the framework font loader; accent serif not preloaded; dark color scheme | `foundation.typography.family.*` | VERIFIED |
| R3 | `lib/choreography.ts` | light profiles, fog, bloom, fov | five light roles per stage, varying intensities and tints, narrow field-of-view range, wider mobile lens | (scene data; `platforms/WEBGL_3D.md`) | VERIFIED |
| R4 | `lib/performance.ts` | `perfConfig` | three tiers controlling DPR, post-processing, particles, lights, environment map, streaming | (platform profile) | VERIFIED |
| R4 | `components/three/PostProcessing.tsx` | composer | bloom with high threshold, vignette, optional grain, filmic tone mapping, SMAA by tier | (platform profile) | VERIFIED |
| R4 | `components/three/Lighting.tsx` | lights | key, rim, accent, hemisphere (fill), ambient; no real-time shadows | (platform profile) | VERIFIED |
| R4/R5 | particle field, README tiers | dust field with tiered counts, thinned under reduced motion and on phones | ambient atmosphere without encoded meaning | (platform profile) | EXPERIMENTAL → classified AMBIENT (DD-037) |
| R5 | `README.md` | camera table | per-stage camera moves | `platforms/WEBGL_3D.md` camera vocabulary | VERIFIED |
| R5 | `README.md` | mobile section | single-focus mobile poses, shorter stages, lighter tiers | `core/LAYOUT_SYSTEM.md` mobile composition | VERIFIED |
| R5 | `README.md` | content rules | honest status, no skill levels, placeholders marked | `core/CONTENT_GUIDELINES.md` | VERIFIED |
| R6 | `components/**` | `px-5 / md:px-10 / lg:px-16` | stepped gutters by breakpoint | `layout.gutter.*` | VERIFIED |
| R6 | `components/**` | `gap-2/3/4/6/10` usage | spacing steps in frequent use | `spacing.*` | PROPOSED (derived) |
| R6 | `components/**` | `border-t border-line`, `bg-graphite` frames | hairline rules and media frames structure content, not cards | `color.border.subtle`, `component.panel.*` | VERIFIED |
| R6 | `components/**` | `rounded-full`; larger radii | round only for dots; larger radii only on illustrated phone hardware | `radius.full` | VERIFIED |
| R6 | `components/**` | `z-*` classes | eight stacking layers | `z.*` | VERIFIED |
| R6 | `components/**` | `<h1>`, `<h3>`, `MaskLines` | page titles use display xl or lg; section titles lg or md; item titles md or sm; usage overlaps | `typography.heading.*` | PROPOSED (alias) |
| R6 | `components/**` | GSAP `duration` / `ease` | clustered durations and power-n eases | `motion.*` | PROPOSED (role mapping) |
| R6 | `components/**` | raw hex in components | two raw hexes bypass tokens (a screen surface and a duplicate of a defined neutral) | `foundation.color.neutral.925` | EXPERIMENTAL |
| R6 | `lib/lenis.ts` | scroll-to | long duration with quart ease-out | `component.scroll.anchor.duration` | VERIFIED |
| R6 | `i18n/en.ts` | dictionary | semantic keys, accent markup, TR and EN parity enforced by types | `core/CONTENT_GUIDELINES.md` | VERIFIED |
| R7 | `app/globals.css`, `layout.tsx` | fluid gutter, other sans, pure-black background | alternative choices, same mono and serif | `layout.gutter.fluid` | EXPERIMENTAL / not adopted |
| R8 | `portfolyo`, `havalı`, `dark-port` | styles | light themes, pixel fonts, cards and shadows, serif-only | none | not adopted |

## Conflicts and their status

| ID | Observation | Resolution |
|---|---|---|
| C-1 | micro text sizes in R1 are small | classified by role, not banned (DD-030) |
| C-2 | button label slightly under the functional minimum | `typography.label` proposed at the minimum (DD-030, DD-024) |
| C-3 | focus ring is thin | AA baseline kept as VERIFIED; enhanced style PROPOSED (DD-020) |
| C-4 | emphasis border below 3:1 | not used to identify controls; `color.border.strong` PROPOSED (DD-035) |
| C-5 | scroll cue loops indefinitely (starts automatically, lasts beyond five seconds, runs beside other content) | must be reviewed against SC 2.2.2; ambient-loop limit in `MOTION_SYSTEM.md`; open in `ACCESSIBILITY.md` |
| C-6 | glass reflection on illustrated screens | allowed as a bounded atmospheric effect (DD-039) |
| C-7 | raw hex in components | tracked as EXPERIMENTAL token; open |
| C-8 | pure black only in R7 | not adopted (DD-012) |
| C-9 | dust particle field | classified AMBIENT with rules (DD-037) |
