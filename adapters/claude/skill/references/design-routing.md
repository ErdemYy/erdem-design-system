# Design routing

Which design-system documents to load for which task. Paths are relative to the design-system root (`erdem.mjs root`). The canonical principle is `ai/CONTEXT_PROTOCOL.md` → Design system selective loading and `adapters/GENERIC.md` §14; this table adds concrete task kinds for Claude. If it disagrees with those, they win.

Rules: load the row that matches, nothing else. Read `core/TOKEN_REGISTER.md` by searching token names (for example `color.text`, `spacing.`, `component.button`), never in full. Read `core/EVIDENCE.md` and `core/DESIGN_DECISIONS.md` only for questions of origin or status. Load the platform file only for the target platform (`<platform>` below). Project requirements and local instructions override all of it (`README.md` → Source of truth).

| Task | Load | Do not load |
|---|---|---|
| Change one component's spacing, size or shape | `core/COMPONENT_SYSTEM.md` (that component), `core/SPACING_SYSTEM.md`, `core/TOKEN_REGISTER.md` rows, `platforms/<platform>.md` | 3D, mobile composition, architecture, graph protocol |
| Add or change a component | `core/COMPONENT_SYSTEM.md`, `core/DESIGN_PRINCIPLES.md` (prohibited patterns), `core/TOKEN_REGISTER.md` rows, `core/ACCESSIBILITY.md`, `platforms/<platform>.md` | unrelated platform files |
| Typography | `core/TYPOGRAPHY.md`, `core/TOKEN_REGISTER.md` rows, `platforms/<platform>.md` | color, motion, 3D |
| Color, theme or contrast | `core/COLOR_SYSTEM.md`, `core/TOKEN_REGISTER.md` rows, `core/ACCESSIBILITY.md` | layout, motion, 3D |
| Web layout or responsive work | `core/LAYOUT_SYSTEM.md`, `core/SPACING_SYSTEM.md`, `platforms/WEB.md` | 3D, mobile toolkits |
| Redesign a mobile screen or flow | `platforms/MOBILE.md`, `core/LAYOUT_SYSTEM.md` (mobile composition), `core/TYPOGRAPHY.md`, `core/SPACING_SYSTEM.md`, `core/ACCESSIBILITY.md`, `core/COMPONENT_SYSTEM.md` (relevant components) | WebGL, desktop |
| Motion or interaction states | `core/MOTION_SYSTEM.md`, `core/ACCESSIBILITY.md` (reduced motion), `platforms/<platform>.md` | color, layout |
| 3D or WebGL scene | `platforms/WEBGL_3D.md`, `core/MOTION_SYSTEM.md`, `core/DESIGN_PRINCIPLES.md`, `core/ACCESSIBILITY.md` (3D) | component and typography documents |
| Copy or microcopy | `core/CONTENT_GUIDELINES.md` | everything else |
| Add, change or question a token | `core/DESIGN_TOKENS.md`, `core/TOKEN_REGISTER.md` rows, `core/DESIGN_DECISIONS.md` | guidelines for other categories |
| Design review of existing work | `core/QUALITY_STANDARD.md`, `core/DESIGN_PRINCIPLES.md`, plus the matching rows above for the reviewed area | documents for areas not under review |
| Backend, database, auth, build, infrastructure, shell | none | all design documents |

If a UI task also changes behavior across modules, add the `ai/` documents the task class needs (`context-routing.md`), not more design documents.

Performance and responsive notes for 3D live inside `platforms/WEBGL_3D.md`; add `core/LAYOUT_SYSTEM.md` (mobile composition) only when the scene must work on phones.
