# Platform: Flutter

Inherits `MOBILE.md` and `core/`. Lists only what is Flutter-specific. Status: contract; no Flutter reference exists in the evidence (`core/EVIDENCE.md`), so everything here is `proposed`.

## What changes on Flutter

| Concern | Adaptation |
|---|---|
| Token mapping | semantic tokens are exposed through the app theme (a theme extension or equivalent), keeping names identical in meaning; component tokens map to component themes |
| Adaptive widgets | one codebase, separately composed layouts per size class derived from `core/TOKEN_REGISTER.md` breakpoints (not scaled phone layouts) |
| Material and platform conventions | may refine presentation (scroll physics, back gesture, system dialogs). Material defaults do not override `radius.none`, `border.*`, or the accent discipline: restyle default widgets to the tokens |
| Touch and feel | native-feeling scrolling and gestures; no hover-only affordances; targets meet the touch minimum (Material guidance is 48 dp, which is acceptable and larger) |
| Fonts | bundle the font families named in the register with their licenses; confirm extended Latin coverage |
| Motion | animation controllers with the token durations; easing curves use the token cubic-bezier values; reduced motion read from the platform accessibility setting |
| Accessibility | semantics tree provides names, roles and states; dynamic type scaling honored |

## Not changed

Design rules, token meaning, status policy: inherited from `core/`.
