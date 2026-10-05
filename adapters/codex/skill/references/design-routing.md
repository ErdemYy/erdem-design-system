# Design routing

Whether a task needs the design system, and which documents. The selective-loading principle and examples are canonical: `ai/CONTEXT_PROTOCOL.md` → Design system selective loading and `adapters/GENERIC.md` §14. Paths are relative to the design-system root (`erdem.mjs root`).

## Task kind

| Kind | Meaning | Design documents |
|---|---|---|
| **Design** | decides how something looks, feels or behaves: layout, type, color, spacing, motion, components, copy, accessibility, 3D scenes | yes, by concern below |
| **Implementation** | behavior, data, build, infrastructure, or code with no visual decision | none |
| **Mixed** | implementation that also changes visible output | only the concerns the visible change touches; implementation context follows the task class |

Requests that sound visual but only move code (rename a prop, fix a type) are implementation. Design needs a visual decision.

## Concern index

Load the one or two documents that match the concern, not the whole list. Rules for a concern live only in that document.

| Concern | Document |
|---|---|
| principles, prohibited patterns | `core/DESIGN_PRINCIPLES.md` |
| token model and status policy | `core/DESIGN_TOKENS.md` |
| token values (authoritative; read by searching names) | `core/TOKEN_REGISTER.md` |
| type | `core/TYPOGRAPHY.md` |
| color, themes, contrast | `core/COLOR_SYSTEM.md` |
| spacing | `core/SPACING_SYSTEM.md` |
| layout, responsive, mobile composition, depth | `core/LAYOUT_SYSTEM.md` |
| motion, interaction states | `core/MOTION_SYSTEM.md` |
| components, cards, buttons, forms | `core/COMPONENT_SYSTEM.md` |
| copy, English and Turkish | `core/CONTENT_GUIDELINES.md` |
| accessibility | `core/ACCESSIBILITY.md` |
| acceptance criteria, review | `core/QUALITY_STANDARD.md` |
| origin or status of a value or decision | `core/EVIDENCE.md`, `core/DESIGN_DECISIONS.md` |

## Platform

Load the platform file only for the target platform: `platforms/WEB.md`, `platforms/MOBILE.md` (plus `platforms/FLUTTER.md` or `platforms/REACT_NATIVE.md`), `platforms/DESKTOP.md`, `platforms/WEBGL_3D.md`.

## Rules

- `core/TOKEN_REGISTER.md` is the only token registry. Do not create or copy one. Use semantic tokens; do not invent a value for a token whose status is `proposed`, `unresolved` or `needs_reference`: say it is provisional.
- Never promote a token's status; that is the owner's decision.
- Project requirements and local instructions override the design system (`README.md` → Source of truth); record a deviation as a decision.
- Review mode: read-only. Report findings most severe first with severity, evidence (`path:line`), the rule and its status (verified, approved, proposed, WCAG standard, recommendation, preference), and a suggested fix; end with what was not reviewed.
