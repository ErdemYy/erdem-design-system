# Quality Standard

The acceptance criteria every deliverable using this system is judged against. This is a **manual review standard**. It is not wired to automation; automated validation arrives in Phase 5 (`tools/validation/`) and will implement these criteria, not redefine them.

## Verdicts

| Verdict | Meaning |
|---|---|
| PASS | criterion met |
| WARNING | acceptable only with a note: uses a `proposed`/`unresolved` token, a [P] heuristic is exceeded, or a deviation is recorded but not yet confirmed |
| FAIL | a prohibited pattern, a WCAG 2.2 AA failure, an invented value, or an unrecorded deviation from core |

Overall: any FAIL → the deliverable fails. WARNINGs must be listed with a reason; many unaddressed WARNINGs in one category are a FAIL for that category.

## Criteria by category

| Category | PASS | WARNING | FAIL |
|---|---|---|---|
| **Typography** | every style belongs to a text role; at most one sans, one accent serif, one mono; accent family limited to accent words; micro text meets its conditions | uses `unresolved` steps (caption, body.sm) or `proposed` label/heading aliases; functional text below `typography.size.min` that is not a micro size | unscaled ad-hoc sizes; extra families without decision; accent family for paragraphs; interactive, form or primary text at a micro size |
| **Color** | only semantic tokens; one attention accent per view; scrims under text on scenes; control boundaries use `color.border.strong` | uses `proposed` color tokens; second accent beyond its restricted use | raw color values in components; decorative gradients; invented status colors; a control identified only by a boundary below 3:1 |
| **Spacing** | scale and gutter tokens only | uses `proposed` spacing steps | raw spacing values; inconsistent rhythm within a view |
| **Layout** | one anchor per view; hairline structure; breakpoints from tokens | unconfirmed container width; section tokens from single-use evidence | uniform card grid; invented breakpoints; text full-bleed to edge |
| **Interaction** | hover and focus equivalent; touch targets met; states defined | pressed/selected states are `needs_reference` and handled provisionally | hover-only information; no focus indicator; pointer targets below the WCAG 2.5.8 minimum without one of its exceptions |
| **Motion** | every motion has a purpose from `MOTION_SYSTEM.md`; tokens used; reduced motion handled | uses `proposed` duration or easing tokens | decorative motion; more than one ambient loop; no reduced-motion behavior |
| **Responsive** | passes the mobile composition checklist | some checklist items are [P] heuristics exceeded with reason | desktop layout scaled down; horizontal scroll at 320 px |
| **Accessibility** | meets the WCAG 2.2 AA baseline in `ACCESSIBILITY.md` | recommendations (Part C) or AAA items not met, with reason | any AA criterion failed |
| **3D** | passes the 3D selection test; roles for light and camera used; non-3D fallback; tiers defined; particles are content or compliant ambient; reflection bounded | numeric budgets are `unresolved` (not yet profiled); ambient particles not yet audited | 3D with no semantic link to content; no fallback; random camera motion; bloom as a default; particles that are neither content nor compliant ambient; global or readability-reducing glass or reflection |
| **Performance** | degrades by tier; no render cost without tier control; models and textures optimized | no measured frame data yet | black screen when a capability is missing; unbounded particle or light counts on mobile |
| **Content** | specific, honest, concise; semantic keys; both languages complete | placeholders visibly marked | invented claims or metrics; buzzword filler; hard-coded strings |
| **Consistency** | one definition per rule; same token for the same role everywhere | deviation recorded as proposed | conflicting values for the same role; unrecorded override of core |

## Review procedure

1. Identify the deliverable and its platform; load `platforms/<platform>.md`.
2. Walk the categories above; record PASS / WARNING / FAIL with a one-line reason.
3. List every `proposed`, `unresolved` or `needs_reference` token used.
4. List deviations from core and confirm each has a recorded decision (`templates/DECISIONS.md`).
5. State the overall verdict.

## Performance metrics

Numeric budgets (frame time, load size, memory) are `unresolved`: no measured profile exists yet. Phase 6 (real-world validation) sets them from profiling. Until then the Performance category is judged by the tier and fallback criteria above.
