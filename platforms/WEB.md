# Platform: Web

Adaptation of the core language to the web. Core rules are inherited (`core/`); this file lists only what changes. Evidence IDs: `core/EVIDENCE.md`.

## Token mapping

Mechanical mapping: dots become hyphens in CSS custom properties, `semantic.` and `component.` dropped or kept consistently per project (for example `color.text.primary` → `--color-text-primary`). The observed reference exposes tokens through a utility framework theme layer plus CSS variables (R1). Never rename tokens.

## What changes on web

| Concern | Adaptation |
|---|---|
| Scroll | scroll can drive composition (staged chapters, camera). Scroll-linked motion uses `motion.ease.scrub` and stays reversible. Smooth-scroll libraries are optional and must be disabled under reduced motion |
| Pointer | hover and a custom cursor apply to fine pointers only; keyboard focus gets the same visible response as hover |
| Responsive | breakpoints from `core/TOKEN_REGISTER.md`; capability queries (pointer, hover) decide input behavior, breakpoints decide composition |
| Viewport | use small-viewport units for stages and display scaling so mobile browser chrome does not cause overflow (observed: svh) |
| Fluid type | display tokens are `clamp()` expressions bounded by width and height; use them as given |
| Reduced motion | honor the media query and any project-level toggle; collapse durations to `motion.duration.reduced`; keep content visible |
| Fonts | load through the framework's font optimization with swap; non-critical families (accent serif) must not block first paint |
| Language | `lang` attribute follows the active language; metadata follows the language |
| Skip link | first focusable element; `z.skip` |
| Overflow | clip horizontal overflow at the document level |

## Scrims over scenes (geometry)

Copy over a canvas uses a linear gradient from the scrim token at the copy side to transparent toward the subject. Observed geometry (R1): side scrims fade from the edge, roughly 38% mid-stop and fully clear by about 68% of the width; bottom scrims clear by the top of the block. On narrow screens the scrim becomes a vertical fade plus a flat base, because copy sits above the subject. This geometry is implementation detail and not a token.

## Mechanisms (examples)

- Motion: CSS transitions for state changes; GSAP for sequenced and scroll-linked motion (R6).
- Styling: utility CSS plus custom properties (R1); the choice is per project and recorded in its decisions.
- Cursor and hover: only behind a fine-pointer capability check.
