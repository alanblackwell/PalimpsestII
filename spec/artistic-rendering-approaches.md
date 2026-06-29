# Artistic Rendering Approaches — Non-Outline Mode

Four proposed algorithms for lines and filled shapes when `outlineMode` is off.
Each section covers: the rendering goal, the proposed algorithm, estimated per-frame
execution cost, and a visual reference URL.

All four approaches use a **seeded pseudo-random number generator** keyed on the
layer's stable `debugName` (or a fixed numeric seed stored per layer). This ensures
the same parameters always produce the same output — essential for the dirty/cache
model — while still looking hand-made.

---

## Case 1 — Filled shapes: torn paper edges

**When applied:** `RectLayer`, `EllipseLayer`, `PathLayer`, `TextLayer`, and their
`Clip*` variants when rendered with a solid colour fill. The existing `stroke`
parameter controls tear scale.

### Proposed algorithm: noise-displaced boundary walk

1. **Sample the path boundary** at regular intervals (~4 px arc-length apart), yielding
   a list of `(x, y, nx, ny)` points with outward normals.
2. **Displace each point** along its normal by `strokeSize * noise1D(i * freq)`, where
   `noise1D` is a cheap 1D value-noise function (linear interpolation between random
   values at integer lattice points, seeded per layer). `freq` controls how "fine" the
   tears are; a good default is `freq = 0.15 / strokeSize` so large stroke → low
   frequency → big rough tears, small stroke → high frequency → fine fraying.
3. **Fill the displaced polygon** with the shape's colour using `ctx.fill()`. No stroke
   is drawn.
4. **Optional second pass:** for very large `strokeSize`, draw the displaced outline
   again with `ctx.stroke()` at ~1 px width and 0.3 alpha to add a slight shadow
   at the torn edge.

The boundary sampling and noise evaluation are both O(perimeter / 4) — for a typical
shape at ~300 px perimeter that is ~75 evaluations, each a few arithmetic ops. No
floating-point transcendentals are required. Recomputation is only triggered when the
shape geometry or `strokeSize` changes.

**Note:** `ctx.filter = 'url(#svg-tear)'` with an SVG `feTurbulence + feDisplacementMap`
filter is a zero-CPU-overhead alternative, but SVG filter references are not reliably
supported inside `OffscreenCanvas` across browsers. The boundary-walk approach works
everywhere and gives more artistic control.

**Visual reference:**
- Torn paper CodePen (noise-displaced boundary): https://codepen.io/wakana-k/pen/PogJKxX
- feTurbulence / feDisplacementMap technique (Codrops): https://tympanus.net/codrops/2019/02/19/svg-filter-effects-creating-texture-with-feturbulence/

---

## Case 2 — Thin lines: draughtsman's pencil

**When applied:** Shape outlines, `StrokeLayer`, `LineLayer` when the effective
stroke weight is ≤ ~2 px.

### Proposed algorithm: segmented alpha-varying multi-pass

1. **Divide the path** into short segments of ~12 px arc-length.
2. **For each segment**, sample two values from 1D value-noise:
   - `alpha(i)` in [0.15, 0.65] — overall opacity of the segment (the "fades from
     view" effect; occasional dips below 0.2 make the line nearly invisible).
   - `jitter(i)` in [-1, +1] px — perpendicular offset from the ideal path.
3. **Draw each segment** as a short line displaced by `jitter`, at `lineWidth = 0.6`
   and `globalAlpha = alpha(i)`. Use `ctx.lineCap = 'round'` and a very slightly
   desaturated version of the shape colour (pencil graphite reads as slightly cool grey
   over colour).
4. **Second pass (optional, for strokes longer than ~80 px):** repeat at `lineWidth =
   0.3`, `globalAlpha` halved, jitter doubled — gives a faint ghost line beside the
   main one, like a graphite "halo".

No noise library is needed: 1D value-noise with a period of 32 values and cosine
interpolation is ~10 lines of code and trivially fast.

Cost: O(path_length / 12) draw calls. For a 400 px stroke: ~33 segments × 2 passes =
66 short `lineTo` calls. Negligible. The main cost is the extra `ctx.save/restore`
overhead for per-segment `globalAlpha` — batch into a single path per alpha level
if profiling shows this matters.

**Visual reference:**
- Harmony-style canvas drawing techniques (pencil and sketchy brushes): https://perfectionkills.com/exploring-canvas-drawing-techniques/
- p5.brush library (pencil brush with hatch/fade): https://github.com/acamposuribe/p5.brush

---

## Case 3 — Medium lines: dip-nib ink pen

**When applied:** Shape outlines, `StrokeLayer`, `LineLayer` when stroke weight is in
the medium range (~3–8 px).

### Proposed algorithm: variable-width ribbon + scatter bleeds

#### Ribbon construction
1. **Walk the path**, computing `(x, y, tangent_angle)` at each point.
2. **Compute nib width** at each point:
   ```
   nib_factor = 0.5 + 0.5 * sin(tangent_angle - NIB_ANGLE)²
   base_width = strokeSize * nib_factor
   noisy_width = base_width * (1 + 0.25 * noise1D(i * 0.08))
   ```
   `NIB_ANGLE = π/4` (45°) gives maximum width on strokes going NE/SW and minimum
   on NW/SE — the classic pointed-nib characteristic seen in Searle/Scarfe's line work.
3. **Build a ribbon polygon**: for each path point emit two offset vertices
   (`left = point + normal * noisy_width/2`, `right = point - normal * noisy_width/2`),
   then fill the resulting closed polygon with `ctx.fill()`.
4. **Cap the ends** with small semicircles (radius = half the width at the endpoint)
   to avoid blunt polygon ends.

#### Bleed/blot scatter
5. After drawing the ribbon, walk the path a second time. At each point, with
   probability `0.04` (seeded noise, not `Math.random()`), draw a bleed:
   - **Small bleed:** ellipse of radius ~(strokeSize * 0.4) at a random offset
     ≤ 1 px from the edge, at 0.6 alpha, slightly elongated along the ink-flow direction.
   - **Occasional larger blot** (probability 0.006): filled circle of radius
     `strokeSize * 0.8`, at 0.45 alpha, with a radial gradient from full ink colour
     to transparent.

Cost: O(n) ribbon construction (dominant), O(n) bleed scatter. For a 400 px stroke at
~6 px stroke: ~80 polygon vertices + ~3 bleeds on average. One `ctx.fill()` for the
ribbon, 3 small `ctx.arc()` calls for bleeds. Fast.

**Visual reference:**
- Ink bleed effect (CodePen): https://codepen.io/andyjakubowski/details/gOXvwRo
- Realistic canvas paint tool (bristle + variable width): https://dev.to/ascorbic/a-more-realistic-html-canvas-paint-tool-313b
- InkField technical docs (ink physics / bleed modes): https://ileivoivm.github.io/inkField/tech/en/index.html

---

## Case 4 — Thick lines: brush calligraphy

**When applied:** Shape outlines, `StrokeLayer`, `LineLayer` when stroke weight is
large (~9 px and above).

### Proposed algorithm: tapered ribbon with brush-splay edges

This builds on Case 3's ribbon construction but with three additions: direction-
proportional width, tapered ends, and dry-brush edge bristles.

#### Tapered, direction-proportional ribbon
1. Walk the path as in Case 3, but compute the brush width differently:
   ```
   // Wider when brush moves perpendicular to its flat axis (like a flat brush)
   // Narrower when moving parallel — gives the Lichtenstein/sumi-e contrast
   direction_factor = 0.3 + 0.7 * abs(sin(tangent_angle - BRUSH_ANGLE))
   taper_factor = smoothstep(0, 0.12, t) * smoothstep(1, 0.88, t)
     // t ∈ [0,1] along stroke; rises quickly, peaks in middle, falls to point
   width = strokeSize * direction_factor * taper_factor
   ```
   `BRUSH_ANGLE = 0` (horizontal brush axis) by default; exposable as a Direction
   slot on the layer if desired.
2. Build the ribbon polygon as in Case 3, filling with near-opaque ink colour
   (`globalAlpha ≈ 0.92`).

#### Dry-brush edge bristles
3. After filling the ribbon, draw 3–5 individual 0.6 px bristle lines at each
   end of the stroke (the final 20% of arc-length), diverging outward from the
   ribbon edge by ≤ 4 px and drawn at alpha 0.2–0.4. This gives the frayed,
   ink-starved end that is the signature of both sumi-e and Lichtenstein's
   Ben-Day-era brushwork.

#### Edge roughness
4. Apply a very small noise perturbation (amplitude ~1.5 px) to the ribbon's
   outer edge vertices — enough to break the ruler-straight silhouette without
   obscuring the confident stroke. (Omit on the inner edge, which stays smooth
   — this asymmetry is characteristic of a loaded brush.)

Cost: Slightly more than Case 3 — the taper calculation adds one `smoothstep` per
sample (3 muls + 2 clamps, cheap), and the bristle lines add ~10 extra `lineTo` calls
at stroke ends only. For a 400 px stroke: ~80 polygon vertices, 1 fill, ~8 bristle
lines. Still very fast.

**Visual reference:**
- Canvas calligraphy (variable-width ribbon, tapered): https://codepen.io/tomhodgins/pen/NRBWXo
- Exploring canvas drawing techniques (ink/ribbon brush section): https://perfectionkills.com/exploring-canvas-drawing-techniques/
- Brushes.js (pen, marker, charcoal brush objects for Canvas2D): https://github.com/jimschubert/brushes.js/

---

## Shared infrastructure needed

All four cases require the same small utilities — worth implementing once:

| Utility | Used by | ~Lines of code |
|---|---|---|
| 1D value-noise with cosine interp, seeded | Cases 1–4 | ~20 |
| Path boundary sampler (arc-length parameterised) | Cases 1, 3, 4 | ~40 |
| `smoothstep(a, b, t)` | Case 4 | 3 |
| Ribbon polygon builder (left/right offset arrays → closed path) | Cases 3, 4 | ~30 |

Total shared code: ~100 lines. Each case's unique logic adds another 30–60 lines.

## Suggested evaluation approach

Implement all four as a standalone `ArtisticStrokeLayer` (Image output, no slots) that
renders a fixed test path — a few horizontal strokes, a tight curve, and a long
diagonal — with controls for `strokeSize` and `caseIndex`. This keeps the proof-of-
concept isolated from the rest of the layer system and lets you compare the four styles
side-by-side before any integration work.
