# Component System

Components are classified by **design intent**, not by framework. This file is platform-neutral; code lives in projects. Tokens: `TOKEN_REGISTER.md` (radius, border, component rows). Component tokens that exist: button, link, panel, scroll.

## Common rules

- Components use semantic and component tokens only (`DESIGN_TOKENS.md` → Layers).
- Shape: `radius.none` by default; `radius.full` only for inherently round elements (status dots, cursors). Not every element is rounded. `radius.sm/md/lg` are `needs_reference`.
- Borders: hairline (`border.width.subtle`, `color.border.subtle`) by default. A boundary that identifies a form control uses `color.border.strong` (proposed, DD-035). `color.border.default` is decorative only.
- Focus: every interactive element shows `color.focus.ring` with `border.width.focus` (AA baseline, verified) and `focus.offset`. `border.width.focus.enhanced` (proposed) is the enhanced style for the high-contrast theme and AAA-targeted products (`ACCESSIBILITY.md`).
- States considered for every interactive component: default, hover (pointer only), focus, pressed, selected, disabled, loading, error.
- Touch targets: `component.button.min-height.touch` or larger for all touch-reachable controls.

## Card principle

A card is **not** the default content container. Use a bordered or filled container only when it provides one of:

1. **grouping**: related items that proximity alone cannot group
2. **hierarchy**: separating a distinct level of content
3. **interaction boundary**: a clearly clickable or draggable unit
4. **state separation**: a unit with its own state (selected, loading, error)

Default alternative: a hairline rule plus spacing. "Every section becomes cards" is forbidden (DD-002). Media frames (`component.panel.*`) are panels, not cards: they exist to contain media of fixed proportion.

## Component classes

Each entry: purpose · when to use · when not to use · visual rules · interaction rules · responsive rules. Entries marked *(principles only)* have intent defined but no verified visual tokens yet.

### Navigation
- Purpose: orient and move between destinations.
- Use: persistent site/app navigation; section progress.
- Not: as a decorative strip; more than one primary nav per view.
- Visual: text-first, mono labels; selected item uses `accent.primary` or a rule; sits at `z.header`.
- Interaction: keyboard reachable, skip link present, visible focus; menu covers the screen on small screens using `overlay.menu`.
- Responsive: collapses to a full-screen menu on small screens; reachable one-handed.

### Button
Semantic types: **primary**, **secondary**, **tertiary**, **ghost**, **icon**, **destructive**. Do not add more.

| Type | Intent | Status |
|---|---|---|
| primary | the single main action of a view: accent fill, inverse text | verified |
| secondary | outlined, translucent over scenes; hover inverts to soft white | verified |
| tertiary | text link with a drawn underline | verified (as link) |
| ghost | low-emphasis action without outline | needs_reference |
| icon | action represented by an icon | needs_reference (`icon.*`) |
| destructive | irreversible action | needs_reference (needs `color.status.error`) |

- Use: one primary per view. Not: several primaries; buttons for navigation that should be links.
- Visual: mono uppercase label, wide tracking, square corners; accessible, clear, tactile, consistent.
- Interaction: hover and focus give the same visible response; pressed state is `needs_reference`.
- Responsive: smaller padding below `breakpoint.medium`; touch target at least `component.button.min-height.touch`; stacked or in a thumb-reach action area on small screens.
- Label text uses the `label` text role (`component.button.label.size` aliases `typography.label`, proposed), never `micro` (DD-030).

### Input and forms
Controls: **Input, Select, Textarea, Checkbox, Radio, Switch, File upload**. Tokens: `component.input.*` (`needs_reference`). Base rules apply now:
- Every control has a visible, persistent label (not placeholder-only). Placeholder uses `color.text.placeholder`.
- States: label, default, focus, error, help, disabled, loading. Error appears as text associated with the control, not color alone.
- Control boundaries use `color.border.strong`, which meets 3:1 on the audited backgrounds (DD-035).
- Help text and errors are programmatically associated (`ACCESSIBILITY.md` → Form accessibility).
- Disabled controls remain legible; loading shows activity and prevents double submission.
- Touch: targets meet the touch-target minimum; native pickers preferred on touch for Select and file upload.
- Responsive: single column on small screens; labels above controls.

### Card
See Card principle. Use rarely and only for the four reasons. Visual: hairline border, `surface.primary` only if separation requires it, `radius.none`.

### Panel
- Purpose: contain media or a fixed-proportion region.
- Visual: `component.panel.border`, `component.panel.background`; no shadow.
- Responsive: keeps its aspect; may become full-bleed on small screens.

### Dialog and Sheet *(principles only)*
- Dialog: blocking decision or short task; centered; focus is trapped and restored; closable by keyboard; uses overlay and `z` tokens.
- Sheet: contextual panel that enters from an edge, preferred on touch for secondary tasks.
- Not: for content that should be a page; for non-essential announcements.

### List and Table
- List: items separated by hairline rules, not boxes; label/value pairs use mono label and body value.
- Table: for comparable data only; aligned numerals; headers marked up semantically; on small screens, restructure rows instead of horizontal scrolling where possible.

### Data visualization
- Uses `accent.secondary` and neutral tiers; color is never the only encoding; labels are direct; no decorative charts. Evidence is limited: `needs_reference` for chart tokens.

### Media object
- Purpose: image, video or 3D with caption. Fixed aspect ratio, `component.panel.*`, lazy loading, text alternative. Attribution shown where required by the asset license.

### Project showcase
- Purpose: present work. The project is the subject; chrome recedes. Real data only; honest status labels; actions appear only when the target exists; placeholders are visibly marked as placeholders.
- Layout: one featured project with a strong anchor; remaining projects as a list separated by rules, with filters if needed.

### Timeline
- Purpose: ordered events. Vertical on all screens by default; rules and mono dates; no decorative nodes.

### Hero
- Purpose: establish subject and tone. One anchor (display headline or 3D subject), one primary action at most, scrim for legibility, entrance staged by `motion.duration.cinematic` and not blocking content.

### Section
- Purpose: a titled block of content. Mono label, display or heading title, content. Spacing by `layout.section.padding.*` or scroll stage. Separated by rule or space, not a container.

## Iconography

`icon.*` tokens are `needs_reference`; the primary reference has no icon library. Rule until defined: icons are optional, never decorative filler, and every icon-only control has an accessible name.
