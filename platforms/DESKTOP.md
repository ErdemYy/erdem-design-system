# Platform: Desktop

Inherits `core/`. Lists only what is desktop-specific. Status: contract; no desktop-application reference exists in the evidence (`core/EVIDENCE.md`), so this file is `proposed`. Web delivered on desktop follows `WEB.md`.

## What changes on desktop

| Concern | Adaptation |
|---|---|
| Keyboard | keyboard-first operation: complete tab order, visible focus, shortcuts for frequent actions, shortcuts discoverable and not conflicting with the OS |
| Mouse and pointer | precise pointers allow smaller hit areas than touch but never below the AA minimum (`core/ACCESSIBILITY.md`); hover states are allowed and match keyboard focus |
| Window resizing | layouts respond continuously to arbitrary window sizes, mapped to the semantic breakpoints; minimum window size is defined per product; multi-window and multi-monitor are expected |
| Density | desktop tools may need denser layouts; density modes are `needs_reference` (`density.*`) and must still pass contrast and target rules |
| Menus and system integration | native menu bar, context menus and dialogs follow OS conventions; they adopt the tokens for color and type where the toolkit allows |
| Motion | same tokens; no scroll-jacking in tool-like applications |
| Token mapping | the same semantic names, exposed through the toolkit's theming; no renaming |

## Not changed

Design rules, token meaning, status policy: inherited from `core/`.
