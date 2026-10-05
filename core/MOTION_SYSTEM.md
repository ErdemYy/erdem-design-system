# Motion System

Principle: **motion communicates, it does not decorate.** Values: `TOKEN_REGISTER.md` (motion rows). Mechanisms (CSS, GSAP, Flutter controllers, Reanimated, render loops) are in `platforms/`.

## Tokens

- Durations: `motion.duration.instant / fast / normal / slow / cinematic`, plus `reduced`. Role mapping is proposed (DD-018).
- Easing: `motion.ease.standard / enter / exit / emphasis / scrub`. `emphasis` is unresolved; do not substitute a different curve silently.
- Supporting: `motion.stagger.*`, `motion.distance.*`.

Every platform uses the same names with the same intent (`DESIGN_TOKENS.md` → Platform mapping).

## Allowed purposes

Motion must serve at least one, and the purpose should be nameable:

| Purpose | Meaning | Typical duration token |
|---|---|---|
| orientation | shows where you are or where something went | fast to normal |
| hierarchy | stages what to read first | normal to slow |
| transition | connects two states or views | normal to slow |
| feedback | confirms an input | instant to fast |
| storytelling | scene-level sequence that carries meaning | slow to cinematic |
| spatial continuity | keeps the sense of one space (camera, scroll) | scrub, or per scene |

## When to animate / when not to

Animate when: a state changes and the change itself is information; a new element enters or leaves; the viewer needs continuity across a transition; input needs acknowledgement.

Do not animate when: the movement explains nothing; the element is already in view and unchanged; it would compete with the primary subject; the user has requested reduced motion (see below); content must be read at the time (never animate text that is being read, except in-place state feedback).

## Limits **[P]**

- Decorative motion is limited to **one** continuous ambient loop per view, and it must be quiet. The only observed loop is the scroll cue (`component.scroll.cue.duration`). An automatic loop lasting beyond five seconds beside other content is subject to WCAG 2.2.2 (Level A); it needs a pause, stop or hide mechanism or a justified exception (open item in `ACCESSIBILITY.md`).
- No more than one primary moving subject at a time; supporting motion is subordinate.
- Entrances use `ease.enter`, exits use `ease.exit`, continuous or symmetric moves use `ease.standard`, scroll-linked motion uses `ease.scrub` (exact and reversible: scrolling back reverses exactly).
- Staggered reveals stagger by `motion.stagger.*`; do not stack staggers.
- Motion never delays access to content: first meaningful content is readable while any entrance plays.

## Reduced motion

Honor the user's reduced-motion preference everywhere (system recommendation, related to WCAG 2.3.3, an AAA criterion; see `ACCESSIBILITY.md`):
- Durations collapse to `motion.duration.reduced` for transitions and animations that are not essential.
- Parallax, camera sway, orbit and dolly are reduced or removed; ambient loops stop; scroll smoothing is disabled.
- All content stays visible; reveals become immediate or simple fades.
- Essential state feedback remains available through non-motion means (color or text change).

## Micro-interactions

| State | Principle | Status |
|---|---|---|
| Hover (pointer only) | a calm response in color or a drawn underline, same duration as keyboard focus; never carries information that touch users cannot reach | observed (button inversion, underline draw) |
| Focus | the same visible response as hover plus the focus ring; instant to fast; never removed | observed |
| Press | tactile: immediate (`duration.instant`), small and physical (slight scale or tone shift) | needs_reference (no pressed state observed) |
| Selected | state is shown by persistent form (accent, rule, weight), not by animation alone | needs_reference |
| Loading | communicates progress or activity without implying completion; no spinner-only waiting for long operations | observed (loading screen with progress); detail needs_reference |
| Success | brief, quiet confirmation; no celebration | needs_reference |
| Error | immediate, text-based, at the field or action; motion is secondary | needs_reference |

**Touch is not hover.** Desktop hover effects are not ported to touch. Touch platforms use press, selection and gesture feedback instead. Hover and custom cursor behavior apply only to fine-pointer devices (observed: the custom cursor is enabled for fine pointers only). Pointer-driven parallax is disabled on touch.

## Review questions

1. Which allowed purpose does this motion serve?
2. What is lost if it is removed?
3. Is it the only moving subject, and is it quiet enough?
4. What does it do under reduced motion?
