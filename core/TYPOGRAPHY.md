# Typography

Rules for type. Values are in `TOKEN_REGISTER.md` (typography rows); evidence in `EVIDENCE.md`. Strength notation: `DESIGN_PRINCIPLES.md`.

## Font roles

Default: one sans family, one optional accent serif, one mono family (DD-011). Do not add families without a recorded decision.

| Role | Token | Status | Usage | Prohibited usage |
|---|---|---|---|---|
| Display | `typography.family.display` | verified | large titles in uppercase, tight tracking and leading | body text; long paragraphs; mixed case at display sizes unless a decision says so |
| Heading | `typography.family.heading` | proposed | headings; follows display until a heading scale exists (DD-031) | |
| Body | `typography.family.body` | verified | reading text, UI text | all-caps paragraphs |
| Mono | `typography.family.mono` | verified | labels, metadata, buttons, code, technical readouts, uppercase and widely tracked | body paragraphs |
| Accent | `typography.family.accent` | verified | one or two words inside a display line, in italic | whole headings; body; labels; anything the viewer must read as continuous text |

Family names, fallbacks, sources and licenses are in the register. Font files carry their own licenses, which are not covered by this repository's license (`LICENSE`).

## Weights, styles, case

Weight, style and case tokens: `typography.weight.*`, `typography.style.accent`, `typography.case.*`. Hierarchy is built from size, case, tracking and spacing before weight or color. Do not synthesize bold or italic for a family that lacks it (`typography.family.accent` exists in one weight only).

## Letter spacing and line height

Tokens: `typography.tracking.*` (display, display.sub, accent, micro, label) and `typography.leading.*` (display, display.sub, body, reading, reading.small, micro).

- Display text is tight in tracking and leading; verify line collisions at every size and language.
- Uppercase text with wide tracking is for short labels only; it is not used for sentences.
- Reading text uses `leading.reading` and the measure `layout.measure.reading`. Narrow screens use `leading.reading.small` and may drop the max width.

## Text roles

Five roles. Every text style belongs to exactly one (DD-030, approved).

| Role | Purpose | Size tokens | Floor |
|---|---|---|---|
| `display` | large titles | `typography.display.xl/lg/md/sm` | scale |
| `heading` | titles of sections and items | `typography.heading.xl/lg/md` (aliases of display, proposed) | scale |
| `body` | reading and general UI text | `typography.body.lg/md` | `typography.size.min` |
| `label` | functional UI text: buttons, tabs, form labels, any interactive label | `typography.label` (proposed) | `typography.size.min` |
| `micro` | secondary metadata, kickers, non-interactive annotations, 3D scene annotations | `typography.micro`, `typography.micro.spatial` | below the minimum, under the conditions below |

**Micro conditions.** Micro text is allowed below the functional minimum only when all hold: it is secondary; it is non-interactive; it is not the sole carrier of essential information; its contrast is appropriate for its size (WCAG 1.4.3 applies to it as normal text); and the mobile composition remains readable. Interactive labels, form labels and primary content never use a micro size. Small sizes in general (10 to 11 px) are not banned.

**Button labels** are functional text. They use the `label` role, not `micro`.

## Type scale

| Semantic step | Token | Status |
|---|---|---|
| Display XL / LG / MD / SM | `typography.display.xl/lg/md/sm` | verified |
| Heading XL / LG / MD | `typography.heading.xl/lg/md` | proposed aliases of `display.lg/md/sm`; page titles use display tokens directly (DD-031) |
| Body LG / MD | `typography.body.lg/md` | verified |
| Body SM | `typography.body.sm` | unresolved |
| Caption | `typography.caption` | unresolved |
| Label | `typography.label` | proposed |
| Micro | `typography.micro`, `typography.micro.spatial` | verified |

Rules:
- Every text style must resolve to a scale step. No ad-hoc sizes.
- Functional text (label, body, heading, display) is not below `typography.size.min` (proposed, DD-024). Micro text follows the micro conditions above.
- Hierarchy keeps the observed display-driven heading basis; no separate heading scale is invented.
- Text must remain legible at 200% zoom and respect user font-size settings (`ACCESSIBILITY.md`).

## Responsive scaling

- Display sizes scale fluidly between a floor and ceiling, bounded by both viewport width and viewport height, so tall narrow screens and short landscape screens do not overflow.
- Body sizes scale in a narrow band and stay at or above the default body size on small screens.
- **Recomposition, not shrinking.** On small screens, do not merely reduce desktop headings. Reconsider the composition: shorten the headline, reduce the number of lines, move supporting copy below the subject, or change which words carry the accent. A heading that needs the smallest scale step to fit is a content problem to fix first.
- Mechanism for fluid scaling is platform-specific (`platforms/`); the token value is the contract.

## Accent word rule

The accent family appears in at most one or two words per heading, chosen for meaning (the idea the sentence turns on), never for decoration. It is loaded so that its absence never blocks first paint.

## Localization

Type must hold in English and Turkish: extended Latin glyph coverage is required for every family; uppercase transforms must use locale-aware casing; see `CONTENT_GUIDELINES.md`.
