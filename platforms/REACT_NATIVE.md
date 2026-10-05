# Platform: React Native

Inherits `MOBILE.md` and `core/`. Lists only what is React-Native-specific. Status: contract; no React Native reference exists in the evidence (`core/EVIDENCE.md`), so everything here is `proposed`.

## What changes on React Native

| Concern | Adaptation |
|---|---|
| Token mapping | semantic tokens are exposed as a theme object with the same names (path segments as nested keys); no raw values in components |
| Components | prefer native components; custom rendering only for the distinctive parts of the language. Native defaults are restyled to the tokens (square corners by default, hairline borders) |
| Styling units | token dimensions are mapped to density-independent units; viewport-bounded display clamps are re-expressed as bounded responsive sizes with the same minimum and maximum intent |
| Motion | animation library running on the UI thread where possible; durations and cubic-bezier easings from tokens; gestures and animations avoid JS-thread dependence |
| Effects | blur, glow and shadows differ per OS; fall back to surface change and hairline (`core/LAYOUT_SYSTEM.md` → Depth) rather than approximating blur |
| Touch and a11y | accessibility roles, labels and states set explicitly; touch targets meet the touch minimum; reduced motion read from the platform setting |
| 3D | if used, follows `WEBGL_3D.md` principles with tier selection tuned to mobile |

## Not changed

Design rules, token meaning, status policy: inherited from `core/`.
