# Design Decision Record

Chain: reference (`EVIDENCE.md`) → **decision** → token (`TOKEN_REGISTER.md`).

## Status and approval

Statuses: `verified` · `approved` · `proposed` · `experimental` · `deprecated`, plus `open` (deferred, no value). Token status definitions: `DESIGN_TOKENS.md`.

- **verified** = observed in an existing project or checked against an official source.
- **approved** = officially accepted as part of the Erdem Design System. Only an explicit decision by Erdem makes a decision `approved` (DD-040).
- Verifying a token against real code does **not** approve it. No token is approved at this time; approved decisions below set rules and policies, not values.

Record format: **Decision · Reason · Evidence · Status · Impact.** Project-level overrides of core go in the project's own decisions file (`templates/DECISIONS.md`).

## Approved decisions

**DD-001 Design DNA and principles.** Decision: the nine DNA traits and five principles in `DESIGN_PRINCIPLES.md`. Reason: stated by Erdem. Evidence: Phase 0 brief §8. Status: approved. Impact: all of `core/`.

**DD-002 Prohibited patterns.** Decision: the twelve prohibited patterns; cards are not the default container. Reason: stated by Erdem. Evidence: Phase 0 brief §10, Phase 1 brief §23. Status: approved. Impact: `COMPONENT_SYSTEM.md`, `QUALITY_STANDARD.md`.

**DD-003 Evidence rule.** Decision: no design value without evidence; unknowns are `unresolved`, `proposed` or `needs_reference` and are not official. Reason: stated by Erdem. Evidence: Phase 1 brief §1, §35, §38. Status: approved. Impact: `TOKEN_REGISTER.md`.

**DD-004 Token architecture.** Decision: three layers (foundation, semantic, component); hierarchical dot names; theme architecture for dark, light, high contrast, custom brand without implementing light. Reason: stated by Erdem. Evidence: Phase 1 brief §30–§33. Status: approved. Impact: `DESIGN_TOKENS.md`.

**DD-030 Text roles and micro-text policy.** Decision: five roles: `micro`, `label`, `body`, `heading`, `display`. Functional UI text (label, body, heading, display) has a minimum size (`typography.size.min`). `micro` text (`typography.micro`, `typography.micro.spatial`) is allowed below that minimum only when it is secondary, non-interactive, not the sole carrier of essential information, has appropriate contrast, and the mobile composition stays readable. Interactive labels, form labels and primary content never use a micro size. 10 to 11 px text is not banned. Reason: the portfolio uses small uppercase metadata and 3D annotations that are secondary and non-interactive. Evidence: R1 `.label`, `.node-label`; R6. Status: approved (the policy; consistent with the reference for micro text). The numeric minimum for functional text stays `proposed` under DD-024 because the reference's button label is slightly below it. Impact: `typography.micro*`, `typography.label`, `TYPOGRAPHY.md`, `QUALITY_STANDARD.md`.

**DD-033 Radius.** Decision: rounded UI is not a requirement of the language; `radius.none` stays the default intent (DD-017); `radius.sm/md/lg` values stay `needs_reference`. Reason: no reliable source for intermediate radii. Evidence: R1, R6, R8 (not adopted). Status: approved (the principle only); values open. Impact: `semantic.radius.*`, `COMPONENT_SYSTEM.md`.

**DD-037 Particles: content vs ambient.** Decision: two classes. CONTENT particles encode information or carry the narrative. AMBIENT particles are allowed only to support atmosphere, depth perception, spatial scale or environmental continuity, and must be low priority, never obscure content, never become the main focus, be reduced or disabled on mobile where appropriate and under reduced motion, and be off by default for normal application UI. "Meaningless particles" remain prohibited. Reason: resolves the contradiction between the principle and the portfolio's dust field. Evidence: R4, R5. Status: approved. Impact: `DESIGN_PRINCIPLES.md`, `platforms/WEBGL_3D.md`, `QUALITY_STANDARD.md`. The portfolio's dust field is classed AMBIENT and stays `experimental` until audited against these rules.

**DD-039 Glass and reflection.** Decision: glass and reflection effects are optional atmospheric effects. They must support material perception, not reduce text readability, not become the primary visual element, not be applied globally, be reduced on mobile, and not be required for core usability. Excessive glassmorphism stays prohibited; material reflection in itself is not. Reason: resolves the reflection contradiction. Evidence: R1 `.screen-glass`. Status: approved. Impact: `DESIGN_PRINCIPLES.md`, `LAYOUT_SYSTEM.md`, `platforms/WEBGL_3D.md`, `QUALITY_STANDARD.md`.

**DD-040 Approval policy.** Decision: VERIFIED (observed) and APPROVED (accepted) are separate. Tokens are not approved because they are verified. Reason: stated by Erdem. Evidence: Phase 1 calibration brief §18. Status: approved. Impact: `DESIGN_TOKENS.md`, this file.

**DD-042 Accessibility claim classes.** Decision: every accessibility claim is classed STANDARD (official WCAG 2.2 criterion and level), RECOMMENDATION (system practice) or PREFERENCE (product taste). WCAG 2.2 AA is the baseline; AAA criteria are listed separately; Erdem's preferred practice is never presented as a WCAG requirement. Normative claims are verified against W3C only. Reason: stated by Erdem; a prior draft mixed memory-sourced values. Evidence: W3C pages listed in `EVIDENCE.md`. Status: approved. Impact: `ACCESSIBILITY.md`.

## Proposed decisions (awaiting Erdem)

**DD-010 Primary reference.** Decision: the portfolio (R1 to R6) is primary evidence; `web-site` (R7) secondary; R8 not adopted. Reason: most recent, matches the DNA, has explicit tokens and documented mobile rules. Evidence: R1 to R8. Status: proposed. Impact: all token sources.

**DD-011 Type system.** Decision: one sans family for display, heading and body; one serif italic for accent words only; one mono for labels and technical text (families in `foundation.typography.family.*`). Reason: matches R1 and R2; R7 shares the serif and mono but uses a different sans (recorded, not adopted). Evidence: R1, R2, R7. Status: proposed. Impact: `TYPOGRAPHY.md`.

**DD-012 Near-black, not pure black.** Decision: the page background is a near-black token; pure black requires a recorded project decision. Reason: R1 uses near-black, leaving room for scrims, fog and vignette to be darker than the page; the reasoning is design judgment, not measured. Evidence: R1, R7. Status: proposed. Impact: `COLOR_SYSTEM.md`.

**DD-013 Structure by hairline, not by container.** Decision: separate items with rules and spacing; containers only where `COMPONENT_SYSTEM.md` allows. Reason: dominant structure in R6. Evidence: R6. Status: proposed. Impact: `LAYOUT_SYSTEM.md`, `COMPONENT_SYSTEM.md`.

**DD-014 Functional gradients only.** Decision: gradients exist for legibility (scrims). Reason: R1 gradients are scrims, a fallback grid and one bounded reflection (DD-039). Evidence: R1. Status: proposed. Impact: `COLOR_SYSTEM.md`.

**DD-015 Accent discipline.** Decision: the primary accent guides attention; the secondary accent is restricted to technical content. Reason: R1 comment; usage counts. Evidence: R1, R6. Status: proposed. Impact: `COLOR_SYSTEM.md`.

**DD-016 Stepped gutters.** Decision: edge spacing steps by breakpoint; the fluid alternative from R7 is experimental. Evidence: R6, R7. Status: proposed. Impact: `layout.gutter.*`.

**DD-017 Rectilinear by default.** Decision: `radius.none` default; `radius.full` for inherently round elements. Evidence: R1, R6. Status: proposed (principle approved in DD-033). Impact: `COMPONENT_SYSTEM.md`.

**DD-018 Motion role mapping.** Decision: durations and eases map from observed clusters; `ease.emphasis` unresolved. Evidence: R1, R6, S2. Status: proposed. Impact: `motion.*`.

**DD-019 Accessibility baseline.** Decision: WCAG 2.2 AA is the baseline; AAA targets and Erdem preferences are labeled as such (see DD-042). Evidence: W3C pages. Status: proposed (baseline choice); classification approved in DD-042. Impact: `ACCESSIBILITY.md`.

**DD-020 Focus indicator.** Decision: keep the verified existing focus style as the AA baseline (visible, and measured against 3:1 for the backgrounds in the audit). Define an enhanced style (`border.width.focus.enhanced`) aimed at SC 2.4.13 (AAA), recommended for the high-contrast theme and AAA-targeted products. Reason: the 1 px ring meets the applicable AA criteria on the audited backgrounds; AAA Focus Appearance needs a 2 CSS px perimeter-equivalent area. Evidence: R1; SC 2.4.7, 1.4.11, 2.4.13; audit. Status: baseline VERIFIED; enhanced proposed. Impact: `border.width.focus*`, `ACCESSIBILITY.md`, `COMPONENT_SYSTEM.md`. Open: confirm focus is not entirely hidden by the fixed header (SC 2.4.11).

**DD-021 Breakpoint names.** Decision: `small`, `medium`, `large`, `xlarge`, plus `compact` and short-landscape signals. Evidence: R1, R5. Status: proposed. Impact: `breakpoint.*`.

**DD-022 Naming forms.** Decision: canonical IDs carry the layer prefix; `semantic.` may be dropped in prose and exports. Evidence: briefs §30–§31. Status: proposed. Impact: `DESIGN_TOKENS.md`.

**DD-023 3D semantics.** Decision: camera move vocabulary, light roles, post-processing stance; per-scene light values are scene data. Evidence: R3, R4, R5. Status: proposed. Impact: `platforms/WEBGL_3D.md`.

**DD-024 Minimum functional text size.** Decision: `typography.size.min` is a design recommendation for functional text; WCAG has no minimum text size. `typography.label` is set at that minimum; the button label uses it. The portfolio's button label is slightly smaller than that minimum (observed value in the register rationale), a recorded deviation. Reason: Erdem prefers functional UI text not at micro sizes. Evidence: R1 `.btn`; DD-030. Status: proposed. Impact: `typography.size.min`, `typography.label`, `component.button.label.size`.

**DD-031 Heading aliases.** Decision: `typography.heading.xl/lg/md` alias `display.lg/md/sm` respectively. Page titles use the display tokens directly. Reason: observed usage clusters by heading level but overlaps (section titles use two sizes; item titles use two), so the mapping is a simplification. Evidence: R6. Status: proposed (provisional; no separate heading scale invented). Impact: `typography.heading.*`, `TYPOGRAPHY.md`.

**DD-035 Control border contrast.** Decision: Option A. `color.border.strong` maps to the muted neutral, an existing verified foundation value measured well above 3:1 on every audited background. `color.border.default` (emphasis alpha) measures below 3:1 and is limited to decorative emphasis; it is not used to identify a control. Buttons are identified by their text label and states, so their border is not the sole identifying cue (option B applies there; this is the system's interpretation of SC 1.4.11 and should be confirmed in an audit). Inputs, checkboxes, radios and switches use `color.border.strong`. Reason: preserves the language (hairline, restrained) while meeting 3:1. Evidence: audit in `ACCESSIBILITY.md`; SC 1.4.11. Status: proposed. Impact: `color.border.strong`, `COMPONENT_SYSTEM.md`.

**DD-041 Shadow and elevation principle.** Decision: depth is built from contrast, surface change, light, opacity, scale and composition; shadow and elevation are used only when needed. No shadow scale is defined; `shadow.drop.*` stays `needs_reference`. The existing elevation tokens are composites of surface, border and overlay, not shadows. Reason: the reference uses no drop shadows. Evidence: R1, R6. Status: proposed (principle); tokens needs_reference. Impact: `LAYOUT_SYSTEM.md`, `shadow.*`, `elevation.*`.

## Open decisions (deferred, no value invented)

**DD-032 Container maximum width.** Decision: deferred. Reason: the reference uses full-width layouts with gutters and no maximum. Evidence: R1, R6. Status: open (`unresolved`). Impact: `layout.container.max`.

**DD-034 Status colors.** Decision: success, warning, error and info remain `needs_reference`; no palette is invented. Where they will be required: form validation and field errors (error), saved or sent confirmations (success), irreversible or quota-limited actions (warning), neutral notices and system messages (info), destructive buttons (error), data and system status indicators. Until defined, status is communicated with text, shape and position, never color alone, and the accent is not used to mean success or error. Evidence: none in R1 to R7. Status: open (`needs_reference`). Impact: `color.status.*`, `component.button.destructive`, `component.input.*`.

**DD-036 Light and high-contrast mappings.** Decision: architecture only; no mapping, no values. The high-contrast theme is expected to use the enhanced focus style and AAA contrast. Status: open (`unresolved`). Impact: `DESIGN_TOKENS.md` Themes.

**DD-038 Promotion of proposed tokens.** Decision: none promoted. Promotion requires Erdem's explicit approval per token or group. Status: open. Impact: all `proposed` tokens.

## Notes

- Items kept provisional (no promotion without evidence): spacing scale, most durations, standard and exit easing, section padding, elevation, container width, heading aliases, status colors, radius, shadows, special button types.
- IDs DD-030 to DD-038 keep their numbers; DD-039 to DD-042 are new. Nothing was renumbered.
