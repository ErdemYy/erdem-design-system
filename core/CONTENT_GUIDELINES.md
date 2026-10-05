# Content Guidelines

Copy is part of the design. It follows the same restraint as the visuals.

## Voice

Copy is:

- **concise**: remove words until meaning would break
- **direct**: say the thing; no wind-up
- **technically confident**: precise terms, stated plainly, without hedging or bragging
- **not exaggerated**: no superlatives without proof
- **honest**: no fake claims, no invented metrics, testimonials or client names; statuses are accurate (for example a project is in progress, not completed)
- **free of buzzwords**: ban empty words ("revolutionary", "seamless", "cutting-edge", "next-generation", "leverage", "synergy") and generic AI-sounding filler

If a sentence could appear on any website, rewrite it with something specific, or delete it.

## Headings

Short, strong, clear. A heading names the idea; it does not summarize the paragraph. One accent word at most (`TYPOGRAPHY.md` → Accent word rule), chosen for meaning.

## Labels and microcopy

- Sentence case for readable UI text; uppercase is a presentation style applied to short mono labels, not typed in the source text (so casing can follow locale rules).
- Labels are nouns or imperative verbs; buttons say what happens ("View project", not "Click here").
- Error text states what happened and what to do; no blame, no jargon.
- Empty and loading states are brief and factual.
- Placeholders for missing real content are visibly marked as placeholders and are never published as final copy.

## Preventing generic generated copy

Before accepting AI-written copy, check: Is every claim true and sourced from real data? Does it use the owner's actual facts? Does it contain a buzzword from the ban list? Can it be shorter? If not specific, replace it. Real project data (`data` sources) outranks drafted text.

## English and Turkish

Both languages carry the same **meaning**, not the same words.

- Write each language natively; do not translate word-for-word. Idioms and tone adapt.
- Technology and product names are not translated.
- Layout tolerates length difference between languages: components must not break when text grows or shrinks by roughly a third **[P]**.
- Uppercase and lowercase transforms use locale-aware rules (Turkish dotted and dotless I).
- Set the document language and update it when the language changes (`ACCESSIBILITY.md`).
- Dates, numbers and units follow the active locale.
- Text in images and in 3D screens is also localized; avoid baking text into media.

## Semantic text keys

All UI text is managed through semantic keys, never hard-coded in components.

- Key form: `<area>.<element>` (for example `about.kicker`, `ui.close`), named by role, not by wording.
- One source defines the shape of the dictionary; every language must match it exactly, and a missing key is a build-time error or a visible fallback, never `undefined`.
- Internal values (statuses, categories) stay language-neutral; only their display labels are keys.
- Accent-word markup in headings is part of the string format, defined once per project.

This describes the pattern observed in the primary reference (`EVIDENCE.md` R5, R6). Storage, loading and routing of languages are implementation concerns for `platforms/` and projects.
