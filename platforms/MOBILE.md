# Platform: Mobile (toolkit-neutral)

Shared by `FLUTTER.md` and `REACT_NATIVE.md`, and applicable to mobile web together with `WEB.md`. Core rules are inherited; this file lists only what changes. Composition rules and density heuristics are core and live in `core/LAYOUT_SYSTEM.md` → Mobile composition; they are not repeated here.

## What changes on mobile

| Concern | Adaptation |
|---|---|
| Touch | no hover. Replace hover affordances with press, selection and visible state. Targets at least `component.button.min-height.touch`, with spacing (`core/ACCESSIBILITY.md`) |
| Safe areas | content respects notches, rounded corners and system bars; edge spacing is added to the safe inset, not replaced. Specifics are `needs_reference` (no reference handles them) |
| Gestures | every gesture has a visible alternative; gestures are never the only route; no conflict with system gestures |
| Bottom navigation and reach | primary actions in thumb reach (lower part of the screen); destructive actions are not placed where mis-taps are likely |
| Orientation | portrait is the primary composition; short landscape uses content-driven height instead of pinned stages (`breakpoint.height.short`) |
| Performance | lighter tier by default; fewer effects; image and model budgets lower than desktop; battery and thermal limits respected |
| Input | correct keyboard types and autofill; layout adapts to the on-screen keyboard |
| Motion | same tokens; gesture-driven motion follows the finger and settles with `motion.ease.enter`; reduced motion honored via the OS setting |
| Pointer effects | custom cursor, pointer parallax and hover reveals are off |

## Platform conventions

Native conventions (navigation patterns, system dialogs, back behavior) may refine presentation. They never override accessibility or token meaning (`README.md` → Source of truth). Where a convention conflicts with a core rule, record a decision.
