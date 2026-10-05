# Token Register

The single source of truth for every token value. Contract and status definitions: `DESIGN_TOKENS.md`. Sources: `EVIDENCE.md`. Decisions: `DESIGN_DECISIONS.md`.

Official = `verified` or `approved`. `→ x` means alias of token `x`. `—` means no value (unresolved). Short ids in `source` locate the evidence; `[n]` counts are usage counts observed in R6.

Theme: all semantic color rows below are the **dark** mapping (DD-036 for others).

## Foundation: color

| name | value | type | role | status | source | rationale |
|---|---|---|---|---|---|---|
| foundation.color.neutral.950 | #060709 | color | near-black base | verified | R1 `--color-ink`, html/body; R2 themeColor | near-black, not pure black (DD-012) |
| foundation.color.neutral.925 | #0b0c0f | color | 3D-screen UI surface | experimental | R1 `.screen-surface`; R6 raw hex | observed raw hex, not tokenized in R1; keep or merge into 900 is open |
| foundation.color.neutral.900 | #101216 | color | raised dark surface | verified | R1 `--color-graphite`; R6 media frames [3] | |
| foundation.color.neutral.800 | #1a1d23 | color | second raised surface | verified | R1 `--color-steel` | defined in R1, unused in components |
| foundation.color.neutral.500 | #8b8f98 | color | muted grey | verified | R1 `--color-mute` | |
| foundation.color.neutral.100 | #ecebe6 | color | soft white | verified | R1 `--color-bone` [68] | warm off-white, not pure white |
| foundation.color.signal.500 | #ff5b2e | color | primary accent | verified | R1 `--color-signal` [29] | |
| foundation.color.tech.500 | #4f8cff | color | technical blue | verified | R1 `--color-tech`; R3 3D lights | 0 DOM uses; light/data only (DD-015) |
| foundation.color.blue.glow | #7896ff | color | screen glow tint | verified | R1 `.screen-surface` box-shadow | |
| foundation.alpha.hairline | 0.12 | number | hairline border opacity | verified | R1 `--color-line` | R1 base is rgba(236,234,228), 2 channels off from neutral.100; treated as equal |
| foundation.alpha.text.secondary | 0.72 | number | secondary text opacity | verified | R1 `.body-copy` | |
| foundation.alpha.text.dim | 0.58 | number | placeholder text opacity | verified | R1 `.placeholder-text` | |
| foundation.alpha.border.emphasis | 0.35 | number | emphasis border opacity | verified | R1 `.node-category` (3D overlay) | measured below 3:1 against neutral.950 (ACCESSIBILITY contrast audit) |

## Semantic: color (dark theme)

| name | value | type | role | status | source | rationale |
|---|---|---|---|---|---|---|
| semantic.color.background.primary | → foundation.color.neutral.950 | color | page background | verified | R1 html, body | |
| semantic.color.background.secondary | → foundation.color.neutral.900 | color | alternate page band | proposed | R1 token only | role unobserved |
| semantic.color.surface.primary | → foundation.color.neutral.900 | color | raised surface, media frame | verified | R6 `bg-graphite` [3] | |
| semantic.color.surface.secondary | → foundation.color.neutral.800 | color | second raised surface | proposed | R1 token only | role unobserved |
| semantic.color.text.primary | → foundation.color.neutral.100 | color | main text | verified | R1 body | see contrast audit |
| semantic.color.text.secondary | → foundation.color.neutral.100 @ foundation.alpha.text.secondary | color | reading text | verified | R1 `.body-copy` | see contrast audit |
| semantic.color.text.muted | → foundation.color.neutral.500 | color | labels, metadata | verified | R1 `.label` | see contrast audit |
| semantic.color.text.placeholder | → foundation.color.neutral.100 @ foundation.alpha.text.dim | color | placeholder, dim text | verified | R1 `.placeholder-text` | see contrast audit |
| semantic.color.text.inverse | → foundation.color.neutral.950 | color | text on light or accent fill | verified | R1 `.btn` hover, `.btn-solid`, `::selection` | see contrast audit |
| semantic.color.border.subtle | → foundation.color.neutral.100 @ foundation.alpha.hairline | color | hairline rules, separators | verified | R1 `--color-line`; R6 `border-line` [18] | decorative separator; see contrast audit |
| semantic.color.border.default | → foundation.color.neutral.100 @ foundation.alpha.border.emphasis | color | decorative emphasis outline (not for control identification) | proposed | R1 `.node-category` | measured below 3:1, so it must not be the only cue identifying a control (DD-035) |
| semantic.color.border.strong | → foundation.color.neutral.500 | color | control boundary and state outline | proposed | measured above 3:1 on neutral.950, 900 and 800 (ACCESSIBILITY contrast audit); value verified, role new | satisfies SC 1.4.11 where a boundary identifies a control (DD-035) |
| semantic.color.accent.primary | → foundation.color.signal.500 | color | CTA, active, focus, selection, key metadata | verified | R1 `.btn-solid`, `:focus-visible`, `::selection` | see contrast audit |
| semantic.color.accent.secondary | → foundation.color.tech.500 | color | technical, data, 3D light | verified | R1 @theme note; R3 | restricted use (DD-015) |
| semantic.color.focus.ring | → semantic.color.accent.primary | color | focus indicator | verified | R1 `:focus-visible` | |
| semantic.color.selection.background | → semantic.color.accent.primary | color | text selection fill | verified | R1 `::selection` | |
| semantic.color.status.success | — | color | success | needs_reference | none in R1–R7 | DD-034 |
| semantic.color.status.warning | — | color | warning | needs_reference | none in R1–R7 | DD-034 |
| semantic.color.status.error | — | color | error | needs_reference | none in R1–R7 | DD-034 |
| semantic.color.status.info | — | color | information | needs_reference | none in R1–R7 | DD-034 |
| semantic.color.overlay.scrim.strong | → foundation.color.neutral.950 @ 0.86 (at the edge, fading to 0) | color | copy-over-scene scrim, desktop | verified | R1 `.scrim-left/right` | gradient geometry in `platforms/WEB.md` |
| semantic.color.overlay.scrim.bottom | → foundation.color.neutral.950 @ 0.90 (at the edge, fading to 0) | color | bottom copy scrim | verified | R1 `.scrim-bottom` | |
| semantic.color.overlay.scrim.mobile | → foundation.color.neutral.950 @ 0.94 (at the edge, fading to 0) | color | scrim on narrow screens | verified | R1 max-width 767 | stronger on mobile |
| semantic.color.overlay.scrim.dim | → foundation.color.neutral.950 @ 0.70 | color | flat dim over scene | verified | R1 `.project-dim` | |
| semantic.color.overlay.menu | → foundation.color.neutral.950 @ 0.95 | color | full-screen menu backdrop | verified | R6 Header `bg-ink/95` | |

3D light colors are per-scene data (R3), not tokens (DD-023). Light roles are in `platforms/WEBGL_3D.md`.

## Foundation and semantic: typography

| name | value | type | role | status | source | rationale |
|---|---|---|---|---|---|---|
| foundation.typography.family.grotesk | Space Grotesk | font-family | primary sans | verified | R2 | SIL OFL (R5) |
| foundation.typography.family.serif | Instrument Serif | font-family | accent italic | verified | R2, R7 | SIL OFL (R5); weight 400 only; non-blocking load |
| foundation.typography.family.mono | JetBrains Mono | font-family | technical text | verified | R2, R7 | SIL OFL (R5) |
| semantic.typography.family.display | → grotesk, fallback `sans-serif` | font-family | display text | verified | R1 `.display` | |
| semantic.typography.family.heading | → semantic.typography.family.display | font-family | headings | proposed | R1 reuses display for headings | no separate heading font observed |
| semantic.typography.family.body | → grotesk, fallback `system-ui, sans-serif` | font-family | body text | verified | R1 body | |
| semantic.typography.family.mono | → mono, fallback `ui-monospace, monospace` | font-family | labels, code | verified | R1 `.label`; R7 | |
| semantic.typography.family.accent | → serif, fallback `serif` | font-family | accent words | verified | R1 `.serif` | one or two words per heading |
| semantic.typography.weight.display | 600 | font-weight | display | verified | R1 `.display` | |
| semantic.typography.weight.body | 400 | font-weight | body | proposed | R1 unset (default) | |
| semantic.typography.weight.mono | 400 | font-weight | mono | proposed | R1 unset; R7 loads 300, 400 | |
| semantic.typography.weight.accent | 400 | font-weight | accent | verified | R1 `.serif`; R2 | |
| semantic.typography.style.accent | italic | composite | accent | verified | R1 `.serif` | |
| semantic.typography.case.display | uppercase | composite | display | verified | R1 `.display` | |
| semantic.typography.case.micro | uppercase | composite | micro text | verified | R1 `.label` | DD-030 |
| semantic.typography.case.label | uppercase | composite | functional labels, buttons | verified | R1 `.btn` | |
| semantic.typography.tracking.display | -0.045em | dimension | display | verified | R1 `.display` | |
| semantic.typography.tracking.display.sub | -0.03em | dimension | display subline | verified | R6 HeroSection [1] | |
| semantic.typography.tracking.accent | -0.02em | dimension | accent | verified | R1 `.serif` | |
| semantic.typography.tracking.micro | 0.26em | dimension | micro text | verified | R1 `.label` | R6 range 0.18 to 0.3em across micro labels |
| semantic.typography.tracking.label | 0.24em | dimension | functional labels | proposed | R1 `.btn` (verified for buttons only) | generalized from the button value |
| semantic.typography.leading.display | 0.86 | number | display | verified | R1 `.display` | |
| semantic.typography.leading.display.sub | 1.05 | number | display subline | verified | R6 HeroSection [1] | |
| semantic.typography.leading.body | 1.55 | number | default body | verified | R1 body | |
| semantic.typography.leading.reading | 1.6 | number | reading paragraphs | verified | R1 `.body-copy` | 1.7 below `breakpoint.medium` |
| semantic.typography.leading.reading.small | 1.7 | number | reading, narrow screens | verified | R1 max-width 767 | |
| semantic.typography.leading.micro | 1.4 | number | micro text | verified | R1 `.label` | |
| semantic.typography.display.xl | clamp(3.1rem, min(11.5vw, 19svh), 11.5rem) | dimension | largest display | verified | R1 `.display-xl` | width and height bound |
| semantic.typography.display.lg | clamp(2.1rem, min(8vw, 13svh), 8rem) | dimension | page title | verified | R1 `.display-lg` | |
| semantic.typography.display.md | clamp(1.8rem, min(5.4vw, 9svh), 5.2rem) | dimension | section title | verified | R1 `.display-md` | |
| semantic.typography.display.sm | clamp(1.35rem, min(3vw, 5.2svh), 2.6rem) | dimension | sub-title | verified | R1 `.display-sm` | |
| semantic.typography.heading.xl | → semantic.typography.display.lg | dimension | section title | proposed | R6: display.lg on 5 section titles, display.xl on 1 page title, display.md on 5 | alias only; observed use overlaps (DD-031) |
| semantic.typography.heading.lg | → semantic.typography.display.md | dimension | sub-section / item title | proposed | R6: display.md on 5 section and 2 item titles | alias only (DD-031) |
| semantic.typography.heading.md | → semantic.typography.display.sm | dimension | small item title | proposed | R6: display.sm on 5 item titles and sublines | alias only (DD-031) |
| semantic.typography.body.lg | clamp(1rem, 1.15vw, 1.15rem) | dimension | reading copy | verified | R1 `.body-copy` | |
| semantic.typography.body.md | 1rem | dimension | default body | verified | R1 body 16px | |
| semantic.typography.body.sm | — | dimension | small body | unresolved | R7 candidate clamp(0.82rem, 0.95vw, 0.95rem) | role in R7 unconfirmed |
| semantic.typography.caption | — | dimension | caption | unresolved | none | |
| semantic.typography.micro | 0.6875rem | dimension | secondary metadata, kickers, non-interactive annotations | verified | R1 `.label` | must satisfy the micro conditions in `TYPOGRAPHY.md` (DD-030) |
| semantic.typography.micro.spatial | 10px | dimension | non-interactive 3D scene annotations | verified | R1 `.node-label`, `.node-tech` | same conditions; never interactive (DD-030) |
| semantic.typography.label | 0.75rem | dimension | functional text: button, tab, form label, interactive label | proposed | DD-024, DD-030; R1 `.btn` observed 0.72rem (0.03rem below) | set to the functional minimum; observed value not adopted |
| semantic.typography.size.min | 0.75rem | dimension | minimum for functional text (label, body, heading, display) | proposed | DD-024 | design recommendation; WCAG sets no minimum text size; `micro` roles are governed by DD-030 |

## Foundation and semantic: spacing and layout

| name | value | type | role | status | source | rationale |
|---|---|---|---|---|---|---|
| foundation.space.unit | 0.25rem | dimension | base unit; step n = n × unit | verified | R1 Tailwind v4 default | |
| foundation.space.2 | 0.5rem | dimension | step 2 | verified | arithmetic of unit; R6 `gap-2` | |
| foundation.space.3 | 0.75rem | dimension | step 3 | verified | arithmetic of unit; R6 `gap-3` | |
| foundation.space.4 | 1rem | dimension | step 4 | verified | arithmetic of unit; R6 `gap-4` | |
| foundation.space.6 | 1.5rem | dimension | step 6 | verified | arithmetic of unit; R6 `gap-6` | |
| foundation.space.10 | 2.5rem | dimension | step 10 | verified | arithmetic of unit; R6 `gap-10`, `md:px-10` | |
| foundation.space.16 | 4rem | dimension | step 16 | verified | arithmetic of unit; R6 `lg:px-16` | |
| semantic.spacing.xs | → foundation.space.2 | dimension | tight gaps | proposed | R6 `gap-2` [20] | |
| semantic.spacing.sm | → foundation.space.3 | dimension | related items | proposed | R6 `gap-3` [21] | |
| semantic.spacing.md | → foundation.space.4 | dimension | default gap | proposed | R6 `gap-4` [18] | |
| semantic.spacing.lg | → foundation.space.6 | dimension | grouped blocks | proposed | R6 `gap-6` [6] | |
| semantic.spacing.xl | → foundation.space.10 | dimension | major blocks | proposed | R6 `gap-10` [5] | |
| semantic.spacing.2xl | → foundation.space.16 | dimension | page-level | proposed | R6 `lg:px-16` [16] | |
| semantic.layout.gutter.small | 1.25rem | dimension | edge spacing, below medium | verified | R6 `px-5` [31]; R7 minimum 20px | |
| semantic.layout.gutter.medium | 2.5rem | dimension | edge spacing, medium | verified | R6 `md:px-10` [18] | |
| semantic.layout.gutter.large | 4rem | dimension | edge spacing, large and up | verified | R6 `lg:px-16` [16] | |
| semantic.layout.gutter.fluid | clamp(20px, 5.2vw, 88px) | dimension | alternative fluid gutter | experimental | R7 `--gutter` | DD-016 |
| semantic.layout.grid.gap.small | → foundation.space.6 | dimension | grid gap, small | verified | R6 `gap-6` [2 grids] | |
| semantic.layout.grid.gap.medium | → foundation.space.10 | dimension | grid gap, medium and up | verified | R6 `md:gap-10` [2 grids] | |
| semantic.layout.grid.columns | 12 | number | column count, medium and up | proposed | R6 `md:grid-cols-12` [1] | single use |
| semantic.layout.section.padding.small | 3rem | dimension | section vertical padding | proposed | R6 `py-12` [1] | single use |
| semantic.layout.section.padding.medium | 4rem | dimension | section vertical padding, medium+ | proposed | R6 `md:py-16` [1] | single use |
| semantic.layout.measure.reading | 34rem | dimension | max reading width | verified | R1 `.body-copy` | none on narrow screens |
| semantic.layout.container.max | — | dimension | max content width | unresolved | R1 has none (full width with gutters) | DD-032 |
| semantic.density.compact / regular / comfortable | — | composite | density modes | needs_reference | none | |

## Semantic: breakpoints

| name | value | type | role | status | source | rationale |
|---|---|---|---|---|---|---|
| semantic.breakpoint.compact | 23.75rem (380px) | dimension | very small phones (extra signal) | verified | R1 `--breakpoint-xs`; R5 | |
| semantic.breakpoint.small | 0 | dimension | base; phones | verified | R1, R5 (`<768`) | |
| semantic.breakpoint.medium | 48rem (768px) | dimension | tablets | verified | R1, R5 | |
| semantic.breakpoint.large | 64rem (1024px) | dimension | desktop | verified | R1, R5 | |
| semantic.breakpoint.xlarge | 96rem (1536px) | dimension | large desktop | verified | R1, R5 | |
| semantic.breakpoint.height.short | 520px (landscape, max-height) | dimension | short landscape signal | verified | R1 media query | |

R5 also names a JS threshold `narrow` (<900) used to choose compact 3D-screen UI. It is an authoring threshold for 3D screens, not a layout breakpoint, and is not tokenized (see `platforms/WEBGL_3D.md`).

## Semantic: radius, border

| name | value | type | role | status | source | rationale |
|---|---|---|---|---|---|---|
| semantic.radius.none | 0 | dimension | default | verified | R1 buttons, panels | DD-017 |
| semantic.radius.sm | — | dimension | | needs_reference | none | DD-033 |
| semantic.radius.md | — | dimension | | needs_reference | none | DD-033 |
| semantic.radius.lg | — | dimension | | needs_reference | none | DD-033 |
| semantic.radius.full | 9999px | dimension | inherently round elements | verified | R1 `.cursor-dot/ring`; R6 dots [17] | |
| semantic.border.width.subtle | 1px | dimension | hairlines | verified | R1 `.hairline` | |
| semantic.border.width.default | 1px | dimension | outlines | verified | R1 `.btn` | |
| semantic.border.width.strong | — | dimension | | unresolved | none for UI (2px only on illustrated phone frame) | |
| semantic.border.width.focus | 1px | dimension | focus ring, AA baseline | verified | R1 `:focus-visible` | meets SC 2.4.7 and SC 1.4.11 against the measured backgrounds (DD-020) |
| semantic.border.width.focus.enhanced | 2px | dimension | focus ring, enhanced (AAA-oriented) | proposed | SC 2.4.13 (2 CSS px thick perimeter area) | opt-in: high-contrast theme and AAA targets (DD-020) |
| semantic.focus.offset | 4px | dimension | focus ring offset | verified | R1 `:focus-visible` | |

## Semantic: shadow, effect, elevation, z

| name | value | type | role | status | source | rationale |
|---|---|---|---|---|---|---|
| semantic.shadow.glow.screen | 0 0 60px foundation.color.blue.glow @ 0.12 | shadow | light emitted by a screen | verified | R1 `.screen-surface` | light, not drop shadow |
| semantic.shadow.inset.vignette | inset 0 0 70px rgba(0,0,0,0.4) | shadow | edge falloff on illustrated screens | verified | R1 `.screen-glass` | |
| semantic.shadow.text.legibility | 0 0 8px foundation.color.neutral.950 @ 0.9 | shadow | text over 3D | verified | R1 `.node-label` | |
| semantic.shadow.drop.* | — | shadow | conventional drop shadow | needs_reference | none in R1 | R1 uses no drop shadows |
| semantic.effect.blur.control | 6px | dimension | backdrop blur on controls over scene | verified | R1 `.btn` | one blurred layer per view (see `LAYOUT_SYSTEM.md`) |
| semantic.elevation.base | → background.primary | composite | level 0 | proposed | DD-013 | |
| semantic.elevation.raised | → surface.primary + border.subtle | composite | level 1 | proposed | R6 media frames | |
| semantic.elevation.overlay | → overlay.scrim / overlay.menu | composite | level 2 | proposed | R6 menu | |
| semantic.elevation.glow | → shadow.glow.screen | composite | emissive element | proposed | R1 | |
| semantic.z.base | 0 | number | | verified | R6 `z-0` | |
| semantic.z.content | 10 | number | content above canvas | verified | R6 `z-10` [4] | |
| semantic.z.menu | 40 | number | menu, progress indicator | verified | R6 Header, ProgressIndicator | |
| semantic.z.header | 50 | number | header | verified | R6 Header | |
| semantic.z.transition | 80 | number | route transition | verified | R6 RouteTransition | |
| semantic.z.loading | 90 | number | loading screen | verified | R6 LoadingScreen | |
| semantic.z.skip | 95 | number | skip link | verified | R6 Experience | above loading screen |
| semantic.z.cursor | 100 | number | custom cursor | verified | R1 `.cursor-dot` | |

## Foundation and semantic: motion

| name | value | type | role | status | source | rationale |
|---|---|---|---|---|---|---|
| foundation.motion.curve.out-quint | cubic-bezier(0.22, 1, 0.36, 1) | easing | decelerating | verified | R1 link underline, `screen-in`; R6 GSAP `power4.out` [2] | S2 equivalence |
| foundation.motion.curve.in-out-cubic | cubic-bezier(0.65, 0, 0.35, 1) | easing | symmetric | verified | R1 scroll cue; R6 GSAP `power2.inOut` [2] | |
| foundation.motion.curve.in-cubic | cubic-bezier(0.32, 0, 0.67, 0) | easing | accelerating | proposed | R6 GSAP `power2.in` [1]; S2 | bezier from S2 |
| foundation.motion.curve.out-quart | cubic-bezier(0.25, 1, 0.5, 1) | easing | scroll-to easing | verified | R6 `lib/lenis.ts` (1−(1−t)^4) | scroll only |
| semantic.motion.duration.instant | 80ms | duration | micro feedback | proposed | R6 GSAP 0.08 [2] | DD-018 |
| semantic.motion.duration.fast | 200ms | duration | state change | proposed | R6 0.2 [3]; R1 language fade 0.17 | |
| semantic.motion.duration.normal | 400ms | duration | standard transition | proposed | R1 `.btn` 0.4 [3]; R6 0.45, 0.5 | |
| semantic.motion.duration.slow | 700ms | duration | large reveal | proposed | R6 0.7 [2]; R1 `screen-in` 0.6 | |
| semantic.motion.duration.cinematic | 1500ms | duration | hero or scene-level entrance | proposed | R6 HeroSection 1.5s [1] | |
| semantic.motion.duration.reduced | 0.01ms | duration | reduced-motion collapse | verified | R1 `html.reduced-motion` | |
| semantic.motion.ease.standard | → foundation.motion.curve.in-out-cubic | easing | continuous or symmetric motion | proposed | R1, R6 | role mapping is a decision |
| semantic.motion.ease.enter | → foundation.motion.curve.out-quint | easing | things entering | verified | R1, R6 | |
| semantic.motion.ease.exit | → foundation.motion.curve.in-cubic | easing | things leaving | proposed | R6 [1] | |
| semantic.motion.ease.emphasis | — | easing | emphasized moments | unresolved | no distinct curve observed | candidate: out-quart |
| semantic.motion.ease.scrub | linear | easing | scroll-linked motion | verified | R6 GSAP `none` [2] | |
| semantic.motion.stagger.line | 90ms | duration | between revealed lines | proposed | R6 HeroSection [1] | |
| semantic.motion.stagger.fade | 120ms | duration | between faded items | proposed | R6 HeroSection [1] | |
| semantic.motion.distance.small | 16px | dimension | reveal offset | proposed | R6 HeroSection [1] | |
| semantic.motion.distance.medium | 36px | dimension | chapter in/out offset | proposed | R6 Chapter [1] | |

## Component

| name | value | type | role | status | source | rationale |
|---|---|---|---|---|---|---|
| component.button.primary.background | → semantic.color.accent.primary | color | | verified | R1 `.btn-solid` | |
| component.button.primary.foreground | → semantic.color.text.inverse | color | | verified | R1 `.btn-solid` | |
| component.button.primary.border | → semantic.color.accent.primary | color | | verified | R1 `.btn-solid` | |
| component.button.primary.background.hover | → semantic.color.text.primary | color | | verified | R1 `.btn-solid:hover` | |
| component.button.secondary.background | → semantic.color.background.primary @ 0.35 | color | translucent over scene | verified | R1 `.btn` | |
| component.button.secondary.foreground | → semantic.color.text.primary | color | | verified | R1 `.btn` | |
| component.button.secondary.border | → semantic.color.border.subtle | color | | verified | R1 `.btn` | |
| component.button.secondary.background.hover | → semantic.color.text.primary | color | | verified | R1 `.btn:hover` | foreground becomes text.inverse |
| component.button.padding | 0.95rem 1.5rem | dimension | | verified | R1 `.btn` | |
| component.button.padding.small | 0.85rem 1.1rem | dimension | below medium | verified | R1 max-width 767 | |
| component.button.min-height.touch | 44px | dimension | touch target | verified | R1 `.touch-actions .btn`; S1 SC 2.5.5; S3 | |
| component.button.label.size | → semantic.typography.label | dimension | button label (functional text) | proposed | R1 `.btn` observed 0.72rem | uses the label role, not micro (DD-030) |
| component.button.label.tracking | 0.24em | dimension | | verified | R1 `.btn` | |
| component.button.duration | → semantic.motion.duration.normal | duration | hover transition | proposed | R1 0.4s | |
| component.button.ease | → semantic.motion.ease.standard | easing | | proposed | R1 uses CSS default (conflict 5) | |
| component.link.underline.thickness | 1px | dimension | tertiary link | verified | R1 `.link-underline` | |
| component.link.underline.duration | 0.5s | duration | | verified | R1 `.link-underline` | |
| component.panel.border | → semantic.color.border.subtle | color | media frame | verified | R6 [3] | |
| component.panel.background | → semantic.color.surface.primary | color | media frame | verified | R6 [3] | |
| component.scroll.anchor.duration | 2.2s | duration | scroll-to-section | verified | R6 `lib/lenis.ts` | |
| component.scroll.cue.duration | 2.4s | duration | looping scroll cue | verified | R1 `.scroll-cue-line` | only permitted loop |
| component.input.* | — | composite | form controls | needs_reference | none in R1–R7 | rules in `COMPONENT_SYSTEM.md` |
| component.button.ghost | — | composite | low-emphasis action | needs_reference | none | |
| component.button.icon | — | composite | icon action | needs_reference | none | needs `icon.*` |
| component.button.destructive | — | composite | irreversible action | needs_reference | none | needs `color.status.error` (DD-034) |
| semantic.icon.* | — | composite | iconography | needs_reference | R1 has no icon library | |
