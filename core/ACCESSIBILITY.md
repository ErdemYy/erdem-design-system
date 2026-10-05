# Accessibility

Accessibility bounds every other core file: within `core/`, a stylistic rule that fails the baseline below must change.

## How claims are classified

Every accessibility claim in this repository is exactly one of:

| Class | Meaning | Source |
|---|---|---|
| **STANDARD** | a normative WCAG 2.2 success criterion, with its level (A, AA or AAA) | official W3C pages (`EVIDENCE.md`) |
| **RECOMMENDATION** | an Erdem Design System practice that goes beyond or interprets the standard | this system |
| **PREFERENCE** | a product or taste choice with no accessibility claim | Erdem |

A recommendation or preference is never described as a WCAG requirement. STANDARD claims below were verified against W3C on 2026-10-03. Whether WCAG conformance is legally required depends on jurisdiction and product; that is not assessed here, and this file treats WCAG 2.2 AA as the technical baseline only.

---

# Part A. WCAG 2.2 AA baseline (STANDARD)

Every product built with this system meets these. Terms: SC = success criterion.

## Contrast

| SC | Level | Requirement |
|---|---|---|
| 1.4.3 Contrast (Minimum) | AA | text at least **4.5:1**; large text at least **3:1**. Large text is at least 18 point, or 14 point bold (with the CSS definition of 1 pt = 1/72 in, about 24 and 18.67 CSS px). Exceptions: inactive UI components, purely decorative text, invisible text, text in pictures with other significant visual content, logotypes |
| 1.4.11 Non-text Contrast | AA | **3:1** against adjacent colors for visual information required to identify UI components and their states, and for parts of graphics required to understand content. Exceptions: inactive components; appearance determined by the user agent and not modified by the author; graphics where a particular presentation is essential |

Rules following from these:
- Text over scenes or media is measured against what is actually behind it (the scrim and scene together). This has not been measured for the portfolio's scrims; treat as open (see audit).
- A border or boundary that is the visual information identifying a control meets 3:1. A boundary that is only a decorative separator, or a control already identified by other means, is not subject to this.
- Placeholder text is text and meets 1.4.3.

## Resize, reflow, spacing

| SC | Level | Requirement |
|---|---|---|
| 1.4.4 Resize Text | AA | text resizes up to 200% without assistive technology, without loss of content or function (captions and images of text excepted) |
| 1.4.10 Reflow | AA | no two-dimensional scrolling at a width equivalent to 320 CSS px (vertical content) or a height of 256 CSS px (horizontal content), except content that needs two-dimensional layout |
| 1.4.12 Text Spacing | AA | no loss of content when text spacing is increased |
| 1.4.13 Content on Hover or Focus | AA | content shown on hover or focus is dismissible, hoverable and persistent |

## Keyboard and focus

| SC | Level | Requirement |
|---|---|---|
| 2.1.1 Keyboard | A | all functionality is operable by keyboard |
| 2.1.2 No Keyboard Trap | A | focus can always move away |
| 2.4.1 Bypass Blocks | A | a mechanism to skip repeated blocks (a skip link is the common one) |
| 2.4.3 Focus Order | A | focus order preserves meaning and operability |
| 2.4.7 Focus Visible | AA | a keyboard focus indicator is visible |
| 2.4.11 Focus Not Obscured (Minimum) | AA | a focused component is not **entirely** hidden by author-created content (partial covering, such as by a fixed header, is not a failure of this level) |
| 1.4.11 applies to the focus indicator itself | AA | the indicator is a UI state, so it has 3:1 against adjacent colors |

Custom focus indicators must be visible and meet 3:1 against their surroundings. 2.4.13 Focus Appearance is **AAA**, not part of this baseline (Part B).

## Target size

| SC | Level | Requirement |
|---|---|---|
| 2.5.8 Target Size (Minimum) | AA | pointer targets are at least **24 by 24 CSS px**, except: (spacing) undersized targets are positioned so that a 24 CSS px circle centered on each does not intersect another target or another undersized target's circle; (equivalent) another target for the same function meets the size; (inline) the target is within a sentence or text block; (user agent) appearance is determined by the user agent; (essential) a particular presentation is essential |
| 2.5.1 Pointer Gestures | A | path-based or multipoint gestures have a single-pointer alternative |
| 2.5.7 Dragging Movements | AA | drag operations have a single-pointer alternative |

## Motion and flashing

| SC | Level | Requirement |
|---|---|---|
| 2.2.2 Pause, Stop, Hide | A | moving, blinking or scrolling information that starts automatically, lasts more than five seconds, and is presented in parallel with other content has a mechanism to pause, stop or hide it, unless essential. Auto-updating information has a similar mechanism |
| 2.3.1 Three Flashes or Below Threshold | A | nothing flashes more than three times in any one-second period, or the flash is below the general and red flash thresholds |

2.3.3 Animation from Interactions is **AAA** (Part B).

## Structure, names, language, forms, color

| SC | Level | Requirement |
|---|---|---|
| 1.1.1 Non-text Content | A | text alternatives for meaningful non-text content; decorative content is ignorable |
| 1.3.1 Info and Relationships | A | structure conveyed visually is available programmatically |
| 1.4.1 Use of Color | A | color is not the only visual means of conveying information |
| 3.1.1 Language of Page | A | the page language is programmatically set |
| 3.1.2 Language of Parts | AA | language of passages is set where it differs |
| 3.3.1 Error Identification | A | errors are identified and described in text |
| 3.3.2 Labels or Instructions | A | labels or instructions are provided for input |
| 3.3.3 Error Suggestion | AA | where known, correction suggestions are given |
| 4.1.2 Name, Role, Value | A | name, role and state are programmatically available for UI components |

## Contrast audit

Method: WCAG relative luminance and contrast ratio, sRGB, with semi-transparent tokens blended against the stated background. Tokens: `TOKEN_REGISTER.md`. Backgrounds: B1 `color.background.primary`, S1 `color.surface.primary`, S2 `color.surface.secondary`. Thresholds: AA 4.5 for normal text (3 for large text), AAA 7 for normal text (4.5 for large text). Text sizes in the system are below the large-text size except display sizes, so normal-text thresholds are applied to all non-display roles.

| Role | Foreground | Background | Ratio | AA (4.5) | AAA (7) | Notes |
|---|---|---|---|---|---|---|
| primary text | `color.text.primary` | B1 | 16.88 | pass | pass | |
| primary text | `color.text.primary` | S1 | 15.71 | pass | pass | |
| primary text | `color.text.primary` | S2 | 14.14 | pass | pass | |
| secondary text | `color.text.secondary` | B1 | 8.78 | pass | pass | |
| secondary text | `color.text.secondary` | S1 | 8.44 | pass | pass | |
| secondary text | `color.text.secondary` | S2 | 7.86 | pass | pass | |
| muted text | `color.text.muted` | B1 | 6.22 | pass | **fail** | meets AAA only as large text (4.5) |
| muted text | `color.text.muted` | S1 | 5.79 | pass | **fail** | |
| muted text | `color.text.muted` | S2 | 5.21 | pass | **fail** | |
| placeholder | `color.text.placeholder` | B1 | 5.90 | pass | **fail** | placeholder is text; not exempt |
| placeholder | `color.text.placeholder` | S1 | 5.87 | pass | **fail** | |
| placeholder | `color.text.placeholder` | S2 | 5.57 | pass | **fail** | |
| accent text | `color.accent.primary` | B1 | 6.51 | pass | **fail** | |
| accent text | `color.accent.primary` | S1 | 6.06 | pass | **fail** | |
| accent text | `color.accent.primary` | S2 | 5.46 | pass | **fail** | |
| technical accent text | `color.accent.secondary` | B1 | 6.26 | pass | **fail** | |
| technical accent text | `color.accent.secondary` | S1 | 5.83 | pass | **fail** | |
| technical accent text | `color.accent.secondary` | S2 | 5.25 | pass | **fail** | |
| primary button label | `color.text.inverse` | `color.accent.primary` fill | 6.51 | pass | **fail** | label text is normal-size text |
| inverted hover label | `color.text.inverse` | `color.text.primary` fill | 16.88 | pass | pass | |
| text over scenes | `color.text.*` | scene + scrim | not measured | n/a | n/a | open: depends on scene and fade position |

Non-text (SC 1.4.11, threshold 3):

| Element | Colors | Against | Ratio | Result | Notes |
|---|---|---|---|---|---|
| focus indicator | `color.focus.ring` | B1 | 6.51 | pass | baseline 1 px style |
| focus indicator | `color.focus.ring` | S1 / S2 | 6.06 / 5.46 | pass | |
| control boundary | `color.border.strong` | B1 / S1 / S2 | 6.22 / 5.79 / 5.21 | pass | proposed token, DD-035 |
| emphasis outline | `color.border.default` | B1 | 2.78 | **fail** if it identifies a control | decorative use only |
| hairline separator | `color.border.subtle` | B1 | 1.27 | not required | decorative separator, not identifying a control |

Summary: every measured text role meets AA. Only primary and secondary text (and the inverted hover label) also meet AAA at normal size. Muted text, placeholder, accent text and the primary button label meet AA but not AAA. Text over scenes is unmeasured.

## Open baseline items

- Measure text over scrim and scene (reading copy and labels) at the worst-case position.
- Check fixed header and menu against 2.4.11 (focused item not entirely hidden).
- The scroll cue is an automatic, indefinite loop beside other content: review against 2.2.2 (conflict C-5). Honoring reduced motion alone should not be assumed to satisfy it.
- Verify language-of-parts markup for mixed-language content.

---

# Part B. WCAG 2.2 AAA criteria (STANDARD, above baseline)

Not required by the AA baseline. Listed so the system can adopt them knowingly.

| SC | Level | Requirement |
|---|---|---|
| 1.4.6 Contrast (Enhanced) | AAA | **7:1** for text; **4.5:1** for large text. A stricter target, not the AA minimum |
| 2.5.5 Target Size (Enhanced) | AAA | at least **44 by 44 CSS px**; exceptions: inline, user agent controlled, essential |
| 2.4.13 Focus Appearance | AAA | the focus indicator area is at least as large as a 2 CSS px thick perimeter of the unfocused component, and has at least 3:1 between the same pixels in focused and unfocused states |
| 2.3.3 Animation from Interactions | AAA | motion animation triggered by interaction can be disabled unless essential |

---

# Part C. Erdem Design System preferred practice (RECOMMENDATION / PREFERENCE)

These are this system's choices. Where a row refers to a WCAG level, it is only pointing at the related criterion.

| Practice | Class | Basis |
|---|---|---|
| Reading text uses `color.text.primary` or `color.text.secondary` (both meet 7:1 at normal size); `color.text.muted` is for secondary metadata only | RECOMMENDATION | aims at SC 1.4.6 (AAA) for reading content |
| Important mobile and touch controls are **44 by 44 CSS px or larger** (`component.button.min-height.touch`); ordinary pointer targets meet at least the AA 24 by 24 rule | RECOMMENDATION | aims at SC 2.5.5 (AAA); platform guidance (Apple 44 pt, Material 48 dp) is context, not normative |
| Default focus style is the verified baseline (`border.width.focus`); an **enhanced focus style** (`border.width.focus.enhanced`) is available and recommended for the high-contrast theme and AAA-targeted products | RECOMMENDATION | aims at SC 2.4.13 (AAA) |
| Form controls use `color.border.strong` for their boundary so identification does not depend on a fill | RECOMMENDATION | satisfies SC 1.4.11 where a boundary identifies the control |
| Functional text is at least `typography.size.min`; `micro` roles follow the conditions in `TYPOGRAPHY.md` | RECOMMENDATION | WCAG has **no** minimum text size |
| Honor the user's reduced-motion setting everywhere; ambient loops are limited (`MOTION_SYSTEM.md`) | RECOMMENDATION | aims at SC 2.3.3 (AAA) and supports SC 2.2.2 |
| A skip link is the first focusable element and sits above all layers (`z.skip`) | RECOMMENDATION | technique for SC 2.4.1 |
| Dialogs trap and restore focus; Escape closes | RECOMMENDATION | supports SC 2.1.1 and 2.1.2 |
| A non-3D fallback with the same content for 3D experiences; essential copy and actions are DOM text | RECOMMENDATION | robustness; not a WCAG criterion by itself |
| Camera motion in 3D is reduced or removed under reduced motion | RECOMMENDATION | supports SC 2.3.3 |
| No effect that approaches flashing (strobing bloom, grain pulses) | RECOMMENDATION | stays well inside SC 2.3.1 |
| Visible persistent labels on form controls; errors in text associated with the control; color never the only status cue | RECOMMENDATION | supports SC 3.3.1, 3.3.2, 1.4.1 |
| Mixed-case source text with uppercase applied by styling, so locale rules apply | PREFERENCE | consistency across English and Turkish |

## Platform notes

Mobile, Flutter, React Native, desktop and WebGL files adapt these rules; they do not weaken Part A. Details: `platforms/`.
