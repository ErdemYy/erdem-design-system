# Platform: WebGL / 3D

Adapts the core language to real-time 3D. Core rules are inherited, not repeated: `core/DESIGN_PRINCIPLES.md` (principle 5), `core/MOTION_SYSTEM.md`, `core/ACCESSIBILITY.md` (3D section), `core/QUALITY_STANDARD.md` (3D, Performance). Evidence IDs: `core/EVIDENCE.md`. Statuses follow `core/DESIGN_TOKENS.md`.

Libraries (Three.js, React Three Fiber, drei, postprocessing, GSAP, Lenis) are the mechanisms observed in the primary reference. They are examples of implementation, not requirements (`README.md`).

**Main principle: 3D must communicate.** A model that merely looks good is not a reason to include it.

## 3D selection

A 3D element is included only if it passes all three:

1. **Semantic link**: it can be stated in one sentence what the object says about the content (a desk setup represents a developer's workspace; a rack represents backend work).
2. **Explanation**: removing it would remove information or meaning, not only atmosphere.
3. **Support**: the page works without it (fallback below), and text content is not trapped inside it.

Fails any of the three → use 2D or nothing. Models are chosen for the content they stand for; license and attribution are recorded (R5: CC BY 4.0 credits listed in an asset registry).

## Camera

Camera motion is a vocabulary. Each move has one purpose. Random or ambient camera motion is prohibited.

| Move | Meaning | Use when | Avoid when | Evidence |
|---|---|---|---|---|
| reveal | opens the scene from darkness or distance | first view; establishing the subject | repeated within a session | R5 hero: wide establishing shot with intro reveal |
| approach | travels toward a new subject | the narrative moves to something else | the subject has not changed | R5: station-to-station travel |
| orbit | slow arc around a subject | introducing a subject and its character | reading text is required at the same time | R5 About: slow orbit |
| push | continuous move toward the subject during a stage | rising importance within one subject | the subject is already filling the frame | R5 Projects: push toward focal objects |
| pull | moves back to widen context | showing relationship or scale | needed detail would be lost | R5 build stage: pulled back before travelling |
| focus | settles close on a surface to be read or operated | content lives on the subject (a screen) | the surface is not legible at the target size | R5 laptop: closes in on the screen, content advances with scroll |
| transition | blends two poses (camera, light, fog together) | changing stage | the two poses are unrelated | R5: blend of two waypoints by scroll progress |
| departure | pulls far away, ending the experience | closing; contact | mid-experience | R5 contact: camera pulls far away |

All eight are observed in R5; the names and when/avoid rules are a proposed vocabulary (DD-023).

Rules:
- Scroll-driven camera is deterministic: the same scroll position gives the same shot, and reversing scroll reverses exactly (observed).
- Movement is damped, never snapped. A tiny pointer parallax is allowed on pointer devices only; it is off on touch and under reduced motion.
- Lens: observed field of view stays in a narrow, telephoto-leaning range (about 32 to 44 degrees across poses); phones use a wider lens instead of dollying through other objects. These are scene data, not tokens.
- Reduced motion shrinks orbit, dolly and sway and stops parallax.

## Composition

- One subject per stage, framed with space for copy; copy placement is paired with a scrim (`core/COLOR_SYSTEM.md`).
- Each camera pose is authored relative to the subject, so moving a subject moves its shots with it.
- Phones get a separate pose (single-focus), not a cropped desktop pose.
- DOM content is the readable layer; the canvas is the spatial layer.

## Lighting

Lighting builds visual hierarchy: what is lit is what matters.

| Role | Purpose |
|---|---|
| key | main source; defines form and the focal object |
| fill | softens shadow areas; low intensity so contrast remains |
| rim | separates the subject from the background |
| ambient | base level so nothing is fully lost |
| accent | highlights one meaningful thing (a screen, a signal); off unless the stage needs it |

Rules:
- Roles and relative balance are the contract; per-scene intensities and tints are scene data (R3 varies them by stage; not tokens, DD-023).
- Accent light color derives from the semantic accent tokens (`core/COLOR_SYSTEM.md`), keeping the accent restricted.
- Light profiles blend between stages together with camera and fog, so the whole scene moves as one.
- Intensities scale up on the intro so the scene lights as it reveals.
- Maximum light count per model or scene is `unresolved` until profiled. Observed: 5 lights on the highest tier, 3 on the lowest (R4); real-time shadow maps are not used.

## Glass and reflection

Rules in `core/DESIGN_PRINCIPLES.md` (DD-039). In 3D: reflection and glass on illustrated screens or models are optional material cues; they sit over content only if text stays readable, apply per object and never globally, are reduced on mobile tiers, and the experience never depends on them.

## Materials

- Use the asset's own PBR materials; do not restyle each model with unrelated effects.
- Textures are compressed and capped (observed: WebP textures up to 1024 px, meshopt-compressed GLB, about 90% byte reduction; R5). Exact limits `proposed` until profiled.
- Soft contact shading is baked or blob-based instead of real-time shadows (observed R5), consistent with low shadow use in `core/LAYOUT_SYSTEM.md`.
- Environment lighting is procedural where possible, avoiding heavy HDR downloads (observed R5).
- Emissive surfaces are the only things that should glow.

## Depth

- Atmospheric depth uses exponential fog whose color matches the page background token, so far geometry dissolves into the page. Observed density range 0.014 to 0.03 per stage (R3); scene data.
- Depth is also built by lighting falloff and vignette. Blur-based depth of field is not used.

## Particles

Classes are defined in `core/DESIGN_PRINCIPLES.md` (DD-037): **content** particles encode information or carry the narrative; **ambient** particles support atmosphere, depth perception, spatial scale or environmental continuity. In 3D experiences ambient particles follow these rules: low visual priority; never obscure content; never the main visual focus; counts tiered, cut on phones and off on the lowest tier; thinned or stopped under reduced motion. They are off by default for normal application UI.

The observed dust field (R4) is classified ambient and stays `experimental` until audited against these rules.

## Post-processing

| Effect | Stance | Rule |
|---|---|---|
| Tone mapping | recommended | filmic mapping on all tiers (the renderer's own on the lowest tier) |
| Antialiasing | recommended | method by tier (SMAA, MSAA, none) |
| Vignette | optional | low strength, supports focus on the subject |
| Bloom | optional | never a default; high threshold so only emissive sources bloom; strength per stage; off on the lowest tier |
| Noise / grain | optional | subtle; reduced further under reduced motion; off on lower tiers |
| Chromatic aberration, glitch, motion blur, heavy depth of field | avoid | decorative; not observed |

"Bloom as default decoration" is a FAIL (`core/QUALITY_STANDARD.md`). Strobing or flashing effects are never allowed (`core/ACCESSIBILITY.md`).

## Loading

- First paint shows the hero asset only; remaining assets stream behind it.
- Stations mount one stage before needed and unmount (dispose GPU buffers) after the camera leaves (observed on lower tiers).
- A loading state communicates progress and never blocks readable content longer than necessary (`z.loading`, `z.skip` ordering in `core/LAYOUT_SYSTEM.md`).
- A failing model never crashes the experience (error boundary).
- Missing optional assets (audio) do not cause failed requests.

## Transitions

- Stage-to-stage: pose blend (camera, light, fog, bloom) driven by scroll progress.
- Content on screens: reveal with a clip-style open (`motion.ease.enter`).
- Route changes: a short covering transition above content (`z.transition`) that does not reload or reset the scene when avoidable.
- Language switch: text fades, scene is untouched.

## Performance

Tiers: **high / medium / low**, chosen by capability detection (memory, cores, pointer type, viewport, data-saver, software renderer), overridable for testing, and only ever stepped **down** at runtime when frame rate drops (observed R4). Every GPU or CPU cost is a field of the tier, so components never sniff devices.

Observed tier profile (R4) as a **proposed** default; budgets await profiling (Phase 6):

| | high | medium | low |
|---|---|---|---|
| intended | desktop | tablets, modern phones | weak phones, software GL, data-saver |
| pixel-ratio cap | 2 | 1.25 | 1 |
| post-processing | bloom, vignette, grain, SMAA | reduced bloom, vignette | none |
| particles | 650 | 240 | 0 |
| lights | key, rim, accent, hemisphere, ambient | same, no pulses | key, hemisphere, ambient |
| environment map | 256 | 128 | 64 |
| models | all, streamed | stations near the current stage | same, one stage look-ahead |

Other observed practices: instanced repeated meshes, one line object per graph, no real-time shadows, DPR clamps, render-loop mutation instead of UI-framework re-renders on scroll, context and cache teardown on unmount.

## Mobile adaptation

Phones get their own experience (`core/LAYOUT_SYSTEM.md` → Mobile composition):
- Portrait-specific camera poses with a single focus; wider lens.
- Lighter tier by default; no composer on lower tiers; fewer particles (share of desktop count); pointer parallax off.
- Fewer on-scene labels; secondary annotations dropped.
- Shorter scroll length per stage; short-landscape screens use content-driven height.
- Interfaces on 3D screens are authored at a smaller canvas size and the lens widens until the glass fits.
- Primary actions live in a thumb-reach area outside the scene.

## Fallback and accessibility

- No WebGL or canvas failure → a lightweight editorial page with the same content, never a black screen.
- Copy and actions are DOM text over the canvas; scrim ensures contrast.
- Reduced motion: see Camera; content stays visible.
- See `core/ACCESSIBILITY.md` → 3D / WebGL.

## Token mapping

Colors and spacing used by 3D overlays come from the semantic tokens (`core/TOKEN_REGISTER.md`); there are no 3D-specific color tokens. Convert token colors with the renderer's color management; do not hand-copy hex values into scene code.

## Open items

Light-count limits, particle policy (DD-037), texture and polygon budgets, frame-time targets: all `unresolved` until profiled.
