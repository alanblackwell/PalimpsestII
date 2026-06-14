# PalimpsestII — Feature implementation log

Historical, per-feature implementation notes — moved out of `CLAUDE.md` to
keep that file to evergreen architecture and conventions. Entries here
describe *how a specific feature was built*, including constant names,
formulas, and one-off decisions. Cross-cutting patterns that recur across
multiple layers (suspend-on-touch sliders, hidden helpers, the `Clip<Shape>`
family, event-slot toggles, self-perpetuating recompute, etc.) are documented
once in `CLAUDE.md`'s "Conventions and recurring patterns" section — this log
focuses on the specific layers/files each entry applies to. Most of this is
also directly recoverable by reading the named source file.

## MaskLayer specifics

`MaskLayer` combines up to 4 `MaskSource` inputs (shape slots) with a
freehand-painted `OffscreenCanvas`. Final mask = black background ∪ painted
strokes ∪ all bound shape masks, composited with `source-over`.

`ShapeLayer` (and its subclasses `RectLayer`, `EllipseLayer`) produce both
`ValueType.Point` and `ValueType.Mask`. The mask is a full-canvas
white-on-transparent rasterisation of the filled shape, regenerated in
`recompute()` using `Node.canvasWidth/Height`.

## MaskLayer UX improvements

- **Default paint mode**: `_activeTool` initialises to `'paint'` — ready to paint immediately on creation.
- **Brush preview on slider drag**: the brush outline circle is shown at the cursor position while the size slider is being dragged.
- **Pixel-pick suppression**: `readonly blockPixelPick = true` on MaskLayer (see "Pixel-pick layer selection" in CLAUDE.md).

## ClipLayer transform handles

`ClipLayer` has move / scale / rotate handles (identical geometry and colours to `ImageLayer`) and two parameter slots:

- **`positionSlot`** (Point) — overrides the manual move handle
- **`scaleSlot`** (Amount) — overrides the manual scale handle

The clipped content (which pixels are included) is fixed by the mask and source image in their original canvas positions. Only the rendered output is transformed: the full-canvas `_offscreen` is drawn with `translate → rotate → scale`, centred on `_position`. Default: canvas centre, scale 1, rotation 0 — identical to the previous (untransformed) behaviour.

## AmountLayer point-coordinate slots

Two `ValueType.Point` input slots derive an Amount from a Point's canvas coordinates:

- **x position slot** — `point.x / canvasWidth` → [0, 1] (left→right)
- **y position slot** — `point.y / canvasHeight` → [0, 1] (top→bottom)

If both are active the value is their average. Point slots take precedence over the existing Amount slot; if nothing is active the slider is user-controlled (suspend-on-touch — see CLAUDE.md). `SliderRegion` gained a `setOnDragStart(fn)` callback to support this; the guard `if (!this._interactive) return false` in `handlePointerDown` was removed so the slider is always draggable.

Panel shows three slot indicators right-to-left: **A** (Amount, blue), **x** (Point, purple), **y** (Point, purple).

## ColourLayer hue/position slots

`ColourLayer` has two extra input slots, active only while the main Colour slot is unbound:

- **hue slot** (Amount) — drives the hue strip; `amount [0,1] → hue [0,360)`
- **position slot** (Point) — drives the SV cursor; canvas `x → saturation`, `y → 1 - value`

`ColourPickerRegion` has `setHue`/`setSatVal` (driven from the slot values each `recompute`), and per-zone `hueInteractive`/`svInteractive` flags. Dragging a zone locked by an active slot calls `setOnHueDragStart`/`setOnSvDragStart` (suspend-on-touch). Slot indicators **P** (position) and **H** (hue) are drawn right-to-left in the panel using the ●/◐/○ convention.

`renderPanel` on `ColourLayer` and `AmountLayer` calls `_drawPill` once (not once for `this.bounds` and once for the canvas-space panel — an earlier duplicate call against `this.bounds` was removed).

## ColourLayer hue/position and image-sample slot rows

`ColourLayer` derives its colour either from the bound `_slot` (Colour), from
the `_hueSlot`/`_posSlot` pair that drive the HSV picker directly (above), or
by sampling pixels from another image around a point. All six slots
(`_slot, _hueSlot, _posSlot, _sampleEnableSlot, _sampleImageSlot,
_samplePointSlot`) are pushed onto `this.slots[]` in that order and get
standard bind rows from `Layer.renderSlots`, starting at the default
`panelBottom` — `panelBottom` is **not** overridden.

The three sample slots:

- **`_sampleEnableSlot`** (Event) — rising edge toggles `_sampleEnabled`, same
  rising-edge pattern as `RootLayer.toggleSlot`
- **`_sampleImageSlot`** (Image) — source to sample from
- **`_samplePointSlot`** (Point) — canvas-space location to sample around

`override renderSlots` calls `super.renderSlots(ctx)` (six standard rows),
then draws an additive accent-bordered group (`SAMPLE_ACCENT` = Colour accent
`#e8944a`) around the three sample-slot rows plus one extra row for a
`_sampleRadius` slider (`[2,100]` px, manual only — `_sampleGroupGeom()`/
`_sampleSliderGeom()` compute this geometry from
`this.slots.indexOf(_sampleEnableSlot)` and `panelBottom`). An
enable/disable toggle button (`_sampleToggleBounds`,
`_handleSampleToggle()` — standard Bound→suspend/SuspendedBound→resume/
Unbound→flip, same as `RootLayer._handleToggle`) is overlaid on the
`_sampleEnableSlot` row, coloured with `EV_ACCENT` (`#e0e060`).

`recompute()`: after computing `_colour` via the existing slot/picker logic,
a rising edge on `_sampleEnableSlot` flips `_sampleEnabled`; if enabled,
`_sampleFromImage()` is called and — if non-null — overrides `_colour` and
sets `_picker.interactive = false`. `_sampleFromImage()` reads the sample
image's pixels (`getImageData`, `ImageBitmap` first drawn to a temporary
`OffscreenCanvas` as in `TileLayer._contentBbox`), returning the
alpha-weighted average colour of pixels within `_sampleRadius` of the sample
point, or `null` if either slot is unbound, the image is unavailable, or the
sampled area is fully transparent.

`hitTestSelf`/`handlePointerDown/Move/Up` check the toggle button
(`_sampleToggleBounds`) and slider (`_sliderHit`) before falling back to
`_picker.hitTest(point)`.

## Edit-mode drop shadow and depth fade

In `Evaluator.render()`, the current (selected/top) layer's drop shadow uses
the legacy `ctx.shadowColor` / `ctx.shadowBlur` / `ctx.shadowOffsetY`
properties instead of `ctx.filter = 'drop-shadow(...)'` — the `filter` form
is not rendered on older Safari.

The progressive fade of layers below the top one is not done via
`ctx.globalAlpha` (many layers' `renderSelf` set their own
`ctx.globalAlpha = this._opacity`, which would clobber a depth-based value
set by the Evaluator). Instead, after rendering each non-top layer, a
full-canvas `rgba(255,255,255,0.25)` rectangle is composited over everything
rendered so far ("atmospheric haze") — layers further down accumulate more
washes and fade toward white. Both effects only run in edit mode (the loop
over `layers[]` in `render()`), never in display mode.

## TileLayer

`src/layers/TileLayer.ts` takes any `Image` source (`sourceSlot`), finds the
bounding box of its non-transparent content (`_contentBbox` — exact
full-resolution `getImageData` scan, no downsampling), and either:

- **tile mode** (default) — repeats that bbox content horizontally and
  vertically to cover the canvas, anchored to the bbox's original position.
  An adjustable pixel `_margin` (default 0, `[−]`/`[+]` buttons in the panel)
  adds a gap between copies.
- **fit mode** — scales the bbox content up uniformly (using whichever
  dimension needs the larger scale factor) so it covers the whole canvas,
  centred.

A `[Tile/Fit]` button in the panel toggles modes. `autoBindRules()` binds
`sourceSlot` to the nearest `Image`-producing layer below, with
`sendToBackgroundAfterBind: true`.

## FilterLayer

`src/layers/FilterLayer.ts` is a composable image-filter chain. Each filter is
a draggable pill with a toggle, an intensity slider, and two parameter slots
(Event → toggle, Amount → intensity). Pills reflow into additional columns when
they exceed the canvas height.

**14 filters:** blur, brightness, contrast, saturate, hue-rotate, grayscale,
invert, sepia, threshold, edges (Sobel), solarise, pixelise, mosaic (Voronoi),
shadow (drop shadow).

**Source slot** sits above column 0, bound to the nearest `Image` layer below
via `autoBindRules`. Source and per-step intermediate thumbnails are drawn to
the right of each pill column.

### WebGL pipeline (`src/layers/FilterGL.ts`)

A singleton (`filterGL`) owns one hidden `<canvas>` + WebGL context shared
across all `FilterLayer` instances (browsers cap WebGL contexts; avoid creating
one per layer).

Architecture:
- **3 FBO textures**: A and B ping-pong for the filter chain; C saves the
  pre-shadow input for the composite pass.
- **Separate `_srcTex`**: the uploaded source image (never an FBO target).
- **Transfer canvas**: `OffscreenCanvas` is not a valid WebGL 1 `texImage2D`
  source on all Safari versions, so the source is drawn to a hidden
  `HTMLCanvasElement` before upload. `UNPACK_FLIP_Y_WEBGL = true` keeps all
  textures (source and FBO) in the same GL coordinate space.
- **19 GLSL programs**, lazily compiled and cached: one per filter + `blur_h`,
  `blur_v`, `shadow_setup`, `shadow_comp`, `_pt` (passthrough).
- **Multi-pass filters**: blur = 3 × (H + V); shadow = setup + 3 × (H + V) +
  composite (shadow blur radius uses `t * 0.8` as the intensity to match the
  CPU `t * 16` scaling).
- **Thumbnails**: after each step the current result is blitted to the GL canvas
  and captured via `drawImage` into a small `OffscreenCanvas`.

`FilterLayer.recompute()` uses the GL pipeline when `filterGL.supported` is
true; falls back to the original `ImageData` CPU path otherwise.

`filterGL.canvas` (an `HTMLCanvasElement`) holds the final result after
`apply()` returns; FilterLayer copies it to `this._result` via `drawImage`.

## VideoLayer

`src/layers/VideoLayer.ts` captures webcam input and produces `ValueType.Image`.

- Camera enumeration via `navigator.mediaDevices.enumerateDevices()` after a brief
  permission-unlock `getUserMedia` call. ◀ / ▶ nav buttons in the canvas-space pill
  cycle through cameras when more than one is present.
- **Frame loop**: `recompute()` calls `queueMicrotask(() => forceDirty())` while live
  and in the stack (see "Self-perpetuating recompute" in CLAUDE.md). Loop self-terminates when
  `_frozen || _stream === null || outsideStack`.
- **Freeze toggle**: `enableSlot` (Event) — rising edge toggles `_frozen`, standard toggle convention.
- The hidden `<video>` element must remain in the DOM for Safari to deliver frames
  (positioned at `top: -9999px`).
- Panel follows the two-pill convention: strip pill at `this.bounds`, camera-selector
  pill at `{ x: 300, y: 50, width: 260, height: bounds.height }`.

## RootLayer background controls

`RootLayer` has two parameter slots and interactive controls:

- **`toggleSlot`** (Event) — rising edge flips `_transparent`. Default `false` = white
  fill. `true` = checkerboard (signals no fill). Manual toggle button in the slot row.
- **`colourSlot`** (Colour) — when bound, overrides the white fill with the bound colour.
  Unbound = white (`{ r:1, g:1, b:1, a:1 }`).

`renderSelf` uses `Node.canvasWidth/Height` (not `this.bounds`) because `this.bounds`
covers the full canvas rect for the checkerboard — do **not** use `this.bounds` for
panel geometry in RootLayer. Fixed constants `STRIP_X/Y/W/H` and `PANEL_X/Y/W` are
used instead. `panelBottom` is overridden to return `PANEL_Y + STRIP_H + 8 = 94`.

## LayerStackWidget thumbnail visibility

`Layer.thumbnailOnlyWhenSelected` (see CLAUDE.md) was introduced for
`RootLayer`: its white-fill thumbnail is invisible at startup and reappears
only when Root is selected. `LayerStackWidget._drawCard` skips the entire
card (body, shadow, thumbnail, border) for such a layer unless it's selected.

## MenuLayer — responsive button grid

The "Add layer" button grid centres itself in the space to the right of the
LayerStackWidget and shrinks to fit narrow canvases. `MenuLayer._layout()`
(in `src/layers/MenuLayer.ts`) computes:

- **Columns**: starts at `COLS_MAX = 4`; if 4 columns at `BTN_W_MAX = 120`px
  don't fit in the available width, drops to 3, then 2.
- **Button width**: shrinks down to `BTN_W_MIN = 64`px to fill the available
  width at the chosen column count (clamped to `[BTN_W_MIN, BTN_W_MAX]`).
- **Centring**: `panX = contentLeft(canvasWidth) + leftover / 2`, so any extra
  width beyond the grid's natural size becomes equal margins on both sides.

`_drawGrid` and `_btnIndexAt` both call `_layout()` so rendering and hit-testing
stay in sync. Button labels are clipped to their button (`ctx.clip()`) and the
font shrinks (11px → 10px → 9px) as `btnW` drops below 95px / 75px, so labels
don't overflow into neighbouring buttons on narrow grids.

## Startup flow

At launch the stack is `root → startupLayer` — no MenuLayer. `StartupLayer`
(`src/layers/StartupLayer.ts`) renders two 140×140 dark rounded-rect buttons
centred in the visible canvas area (x ≥ 300, right of the StackWidget):

- **"Menu"** (left) — removes StartupLayer, inserts MenuLayer above root,
  calls `refreshStack(menuLayer)`.
- **"Tutorial"** (right) — removes StartupLayer, inserts MenuLayer above root,
  then inserts a new TutorialLayer above MenuLayer, calls `refreshStack(tl)`.

`blockPixelPick = true` on StartupLayer prevents accidental layer selection
when clicking the white background area between or around the buttons.

`refreshStack` walks up from `root` rather than `menuLayer` so it finds the
correct stack top even when MenuLayer is not yet present.

`TutorialLayer` (`src/layers/TutorialLayer.ts`) is a multi-page guided tour.
It is also available at the end of the MenuLayer button grid (grey-blue `#a0a4b8` accent).

### TutorialLayer details

- **Panel**: strip pill at `this.bounds` + canvas-space panel at `{ x:300, y:50, width:460 }`.
  Height is computed dynamically from text + button rows + nav row.
- **Pages**: defined in the module-level `PAGES` constant (`TutPage[]`), each with a title,
  paragraphs (word-wrapped at render time), and layer-creation buttons.
- **Buttons**: same visual style as MenuLayer buttons (BTN_W=120, BTN_H=34, BTN_GAP=8,
  BTN_COLS=3). Each calls `_onAdded(layer)`, which inserts the new layer just below the
  TutorialLayer and calls `refreshStack(tl)` — keeping TutorialLayer selected so multiple
  layers can be created in sequence (same behaviour as MenuLayer).
- **Navigation**: ◀ / ▶ buttons at bottom-left / bottom-right; Prev hidden on page 1.
  Page indicator (`n / total`) shown when there is more than one page.
- **`setOnAdded(fn)`**: must be called after construction (in `main.ts`'s
  `wireTutorialLayer()` helper) to provide the layer-insertion callback. Called from
  both the startup Tutorial button handler and the MenuLayer `onAdded` callback.
- **`blockPixelPick = true`**: suppresses pixel-pick scan while Tutorial is selected.

`wireTutorialLayer` calls `postInsertLayer(newLayer)` before `refreshStack(tl)`, so
Tutorial buttons get identical auto-binding behaviour to Menu buttons (AnimPath shape/phase
wiring, CollectionLayer eject callback, etc.).

Current pages:
1. **Welcome** — layer stack navigation (Up/Down/Delete/drag), then Ellipse/Rect/Text buttons.
2. **Images and Video** — Image (file load + OS drag-and-drop), Video (camera), with Image/Video buttons.
3. **Values and Binding** — parameter slots, bind-drag gesture, click-to-create shortcut, with Colour/Amount/Point buttons.
4. **Masks and Animation Paths** — masking shapes, AnimPath auto-wiring of shape + Clock/Rate, with Mask/AnimPath buttons.

StartupLayer is **not** listed in the MenuLayer button grid — it is only
ever shown at launch and is destroyed when a mode is chosen.

## StrokeLayer

`src/layers/StrokeLayer.ts` — freehand stroke layer. Produces `ValueType.Point`,
`ValueType.Image`, and `ValueType.Mask`.

### Drawing

While selected, clicking "✎ draw" enters draw mode. `hitTestSelf` returns `this` for
all points in draw mode (`blockPixelPick = true` suppresses pixel-pick concurrently).
On pointer-up the raw polyline is:
1. Simplified with Ramer-Douglas-Peucker (ε = 8 px)
2. Fitted to G1-continuous cubic Bézier segments using Catmull-Rom tangents
   (control-point distance = chord/3)
3. Normalised into local coordinates (centroid at origin, `_scale = 1, _rotation = 0`)

### Coordinate system

Local segments (`_localSegs: Seg[]`) are centred at origin. The transform
`(_cx, _cy, _scale, _rotation)` is the **base** transform set by the draw step and
handle drags. `recompute()` derives a **computed** transform
`(_computedCx, _computedCy, _computedScale, _computedRotation)` from the base +
slot bindings, and `_localToCanvas` uses the computed values. `_localToCanvasRaw`
uses only the base values (needed inside `recompute` to find the stable start anchor).

### Handles (ImageLayer style)

Three handles drawn in `renderPanel` (edit mode only):
- **⊕ Move** (circle+crosshair, white/blue-grey) — translates `_cx/_cy`
- **□ Scale** (square, cyan/blue-grey) — uniform scale, at local bbox lower-right
- **○ Rotate** (circle on 85 px arm) — rotates around centre

Dimmed (blue-grey) when `startSlot` or `endSlot` is active. Dragging any handle
while an endpoint slot is active calls `_suspendEndpointSlots()`, which toggles
the BindingLayers to `SuspendedBound` and bakes the computed transform into base.

### Slots

- **`widthSlot`** (Amount) — stroke width 0–30 px
- **`colourSlot`** (Colour) — stroke colour
- **`startSlot`** (Point) — pins the start; clicking an empty slot creates a
  PointLayer initialised to `getStrokeStart()` (base transform, no computed offset)
- **`endSlot`** (Point) — when active, `recompute` derives `_computedScale` and
  `_computedRotation` so the stroke's start stays fixed (anchored by the base
  transform) and the rendered end exactly reaches the bound point. Both scale and
  rotation are adjusted (rubber-band behaviour):
  ```
  _computedScale    = ptDist(startRaw, target) / ptDist(ls, le)
  _computedRotation = atan2(target − startRaw) − atan2(le − ls)
  ```

### Arc-length parameterisation / AnimPath source

`samplePerimeter(t)` — arc-length-parameterised position along the open stroke
(t=0 → start, t=1 → end). An AnimPath using a StrokeLayer as its shape will
traverse the stroke end-to-end and then jump back to the start (because the stroke
is open, not closed).

`getPoint()` returns the stroke midpoint; used as fallback when AnimPath calls
`samplePerimeter` but `samplePerimeter` isn't detected.

### Mask source

`getMask()` returns an `OffscreenCanvas` with the closed stroke region (the open
stroke path + a virtual straight line back to the start), white-on-transparent,
suitable for MaskLayer.

### Image source / thumbnail

`getImage()` returns a separate `_imageCanvas` with the stroke rendered at its
actual line width and colour (no closing line). Since `ValueType.Image` appears
before `ValueType.Mask` in `thumbnail.ts`'s type-check order, the thumbnail shows
the rendered stroke rather than the closed boundary silhouette.

## TextLayer transform handles

`TextLayer` has move / scale / rotate handles, drawn in `renderPanel` (panel-only,
per the "Transform handles are panel-only" convention) with the same geometry/glow
helpers as `ImageLayer`/`ClipLayer`:

- **⊕ Move** — drags `_manualPosition` (used as the unmasked anchor when
  `positionSlot` is unbound). **Hidden entirely when `maskSlot.isActive`** —
  masked text ignores `_position`, so manual move would have no visible effect.
- **□ Scale** — adjusts `_manualSize` directly (the same value the `[−]`/`[+]`
  size buttons control), clamped to `[MIN_SIZE, MAX_SIZE]`. Dimmed/disabled when
  `sizeSlot.isActive`. The handle offset is proportional to `_size`
  (`SCALE_OFFSET_FACTOR = 1.6`), so it tracks the text's current display size.
- **○ Rotate** — always draggable (no slot controls rotation), sets `_rotation`.
  Works identically whether or not a mask is bound.

**Handle pivot**: unmasked, handles pivot about `_position`. Masked, they pivot
about the canvas centre — the same point the mask-rotation logic below rotates
about.

### Rotation within a mask

Masked text flow (`_renderMasked`, scanline word-wrap) is computed in the text's
own *unrotated* frame, then the whole render is wrapped in a rotation transform:

- `_sampleMask` — when `_rotation !== 0`, the mask is first drawn into a temp
  `OffscreenCanvas` counter-rotated by `-_rotation` about the canvas centre,
  *then* sampled into `_maskRows`. The rows therefore describe the mask as seen
  from the text's own frame.
- `_renderMasked` — wraps its existing scanline-fill loop in
  `translate(cx,cy) → rotate(_rotation) → translate(-cx,-cy)` (canvas centre
  pivot). Drawing the rows computed above under this forward rotation places the
  wrapped text back inside the *true* (unrotated) mask outline, rotated as a
  whole by `_rotation`.

`_renderUnmasked` rotates about `_position` directly (`translate → rotate`,
lines drawn relative to local origin).

## Direction `rotationSlot` — per-layer details

`ImageLayer`, `ClipLayer`, `TextLayer`, and `StrokeLayer` each have a manual
rotate handle (`_rotation`, in radians) and a `rotationSlot`
(`ValueType.Direction`), pushed onto `this.slots[]`. See "Transform handles are
panel-only" in CLAUDE.md for the shared pattern. Per-layer specifics:

- **`recompute()`** — when `rotationSlot.isActive`, `_rotation` is overwritten
  from `(rotationSlot.source as DirectionSource).getDirection().angle`
  (magnitude is unused). For `StrokeLayer` this sets the *base* `_rotation`,
  which then flows through the existing `_computedRotation` rubber-banding
  (start/end Point slots) exactly as a manual drag would.
- **Rotate handle glow** — dims to `#666688` (`#446688` for StrokeLayer, to
  match its existing dimmed-handle colour) when `rotationSlot.isActive`.
- **Panel indicator** — `ImageLayer`/`ClipLayer`/`TextLayer` add a `rot`
  ●/○ indicator (accent `#7ecfcf`, the `Direction` type colour) to their
  existing slot-indicator row. `StrokeLayer`'s panel has no per-slot
  indicators; the new slot only gets the automatic bind-target row from the
  base `Layer.renderSlots`.

### ShapeLayer (Rect/Ellipse/Path)

The same pattern is implemented once in `ShapeLayer`, the abstract base for
`RectLayer`, `EllipseLayer`, and `PathLayer`, since all three share `_angle`
and the `H_ROTATE` bounding-box handle:

- **`recompute()`** — when `rotationSlot.isActive`, `_angle` is overwritten
  from the bound `DirectionSource`.
- **H_ROTATE marker** — dims to `rgba(102,102,136,0.85)` when
  `rotationSlot.isActive`.
- **`_drawPill`** — the existing `∠ <deg>°` angle readout gets a ●/○
  indicator (`DIR_ACCENT = '#7ecfcf'`) to its left.

`RectLayer` and `EllipseLayer` get all of this for free (no overrides).
`PathLayer` overrides `renderPanel`/`hitTestSelf`/`handlePointerDown`/
`handlePointerMove` with its own spline control-point UI and has no
bbox/`H_ROTATE` handle, so it needed its own implementation of the same
pattern:

- `PathLayer` has no separate width/height/angle render transform — its
  geometry **is** `_points` (canvas-space control points). Rotation is
  therefore applied directly to `_points` (rotated about the centroid),
  with `_angle` kept only as a running total for the indicator and for
  computing the next delta.
- **`recompute()` override** — when `rotationSlot.isActive`, computes
  `delta = newAngle - this._angle`, rotates `_points` by `delta` about
  `_centroid()`, then calls `super.recompute()` (which sets `_angle =
  newAngle` and rebuilds the mask/image offscreens from the rotated points).
- **New rotate handle** (`_rotateHandlePos()`) — orbits the centroid at
  `_angle - 90°`, distance `maxR + ROT_OFF` (mirrors `_sizeHandlePos()`,
  offset by a quarter turn so the two handles don't collide). Dragging it
  rotates `_dragStartPts` by the pointer's angle delta about the centroid
  (same `'center'`/`'size'`-drag style as the existing handles) and updates
  `_angle` to match. Drag start suspends `rotationSlot` if bound.
- **`_drawPill`** — the previous `(x, y)` current-point readout was replaced
  with the same `∠ <deg>°` + ●/○ indicator as the other shapes (panel width
  is too narrow for both).

## `Clip<Shape>` family — per-layer details

See "`Clip<Shape>` layer family" in CLAUDE.md for the shared pattern
(`imageSlot`/mask-tracker slot, hidden `MaskLayer` helper, `setMaskTracker`).
Per-layer specifics:

- **`ClipRectLayer`** (`src/layers/ClipRectLayer.ts`) was the first of the
  family — `extends RectLayer` directly. `maskSlot` is **not read** by
  `recompute()`; it exists purely so the slot row can be bound to the hidden
  mask-tracker helper, making that helper exposable via the standard
  "click a bound slot whose source is a hidden helper" gesture.
- **`ClipEllipseLayer`** (`extends EllipseLayer`) and **`ClipPathLayer`**
  (`extends PathLayer`) follow the identical pattern. `ClipPathLayer`'s
  `recompute()` calls `super.recompute()` (PathLayer's override, which applies
  `rotationSlot` to `_points` then chains to `ShapeLayer.recompute()`) —
  `getMask()`/`getImage()` are inherited unchanged from `ShapeLayer`, so the
  clip-compositing step is identical to `ClipRectLayer`'s. Its constructor
  passes `undefined` for `points` (uses `PathLayer`'s `defaultPoints(cx, cy)`
  hexagon).

## TextLayer as a MaskSource

`TextLayer` declares `ValueType.Mask` in `types` and `implements
MaskSource`, so it can be bound into any `Mask`-typed slot — including a
`MaskLayer`'s four shape slots (drag-drop, default-binding, and the
slot-click-to-create/select gesture all key off `source.types.has(slot.type)`,
so no special-casing was needed elsewhere).

`getMask()` returns `_maskCanvas`, a white-on-transparent silhouette rebuilt
in `recompute()` by `_updateMaskCanvas()`: it sets `ctx.fillStyle = '#ffffff'`
(no shadow) and calls the same `_renderMasked`/`_renderUnmasked` layout logic
as `renderSelf` — so the mask exactly matches whatever glyphs are currently
drawn, whether flowing inside a bound `maskSlot` shape or centred at
`_position`.

This was the prerequisite for `ClipTextLayer`.

## TextLayer as an ImageSource

`TextLayer` also declares `ValueType.Image` in `types` and `implements
ImageSource`, so it can be bound into any `Image`-typed slot — `FilterLayer`'s
source slot, `CompositeLayer`'s left/right slots, `TileLayer`, `ClipRectLayer`
etc. — the same way `RectLayer`/`EllipseLayer`/`PathLayer` already do via
`ShapeLayer`.

`getImage()` returns `_imageCanvas`, rebuilt in `recompute()` by
`_updateImageCanvas()`: clears the canvas and calls `_renderCanvas(ctx,
false)` — the same method `renderSelf` uses (which calls it with
`withShadow = true`), but with the drop-shadow `ctx.shadow*` properties
skipped — so the image is just the glyphs at their actual colour/typography,
in whatever layout (masked word-wrap or unmasked centred lines) is currently
active.

Since `ValueType.Image` is checked before `ValueType.Mask` in both
`thumbnail.ts` and `typeColor()`, `TextLayer`'s thumbnail and accent colour
now show the rendered text (green `#7ecf7e`, the Image accent) rather than
the glyph-silhouette mask — matching `StrokeLayer`'s precedent.

## ClipTextLayer

`src/layers/ClipTextLayer.ts` follows the `ClipRectLayer` template —
`extends TextLayer` directly (keeps TextLayer's own move/scale/rotate
handles, typography controls, and text-editing panel unchanged), and renders
`imageSlot`'s image clipped to `this.getMask()` (TextLayer's glyph-silhouette
mask) instead of filled, coloured text. `recompute()`/`renderSelf`/
`getImage()`/`autoBindRules()` are identical in structure to
`ClipRectLayer`'s.

**Slot-naming note**: TextLayer already has a `maskSlot` (Mask) — an
*input* that flows the glyph layout inside a bound mask shape (a
pre-existing, independent feature; it still affects the glyph layout and
therefore the clip silhouette too). The mask-tracker-exposure slot that the
other `Clip<Shape>` layers call `maskSlot` is therefore named
**`clipMaskSlot`** on `ClipTextLayer` to avoid colliding with it.
`postInsertLayer` (`main.ts`) has a separate `if (newLayer instanceof
ClipTextLayer)` block (after the shared `ClipRectLayer | ClipEllipseLayer |
ClipPathLayer` block) that is otherwise identical — plain hidden `MaskLayer`
helper, `setMaskTracker`, `BindingLayer.create(maskHelper,
newLayer.clipMaskSlot)`.

## ClipDrawingLayer

`src/layers/ClipDrawingLayer.ts` extends `MaskLayer` directly — same shape
slots, freehand paint/erase tools, brush slider and mask-overlay panel as a
plain `MaskLayer` (all inherited unchanged), but renders `imageSlot`'s image
clipped to `this.getMask()` (its own painted/composited mask) instead of
just visualising the mask. `types` is widened to
`Set([ValueType.Mask, ValueType.Image])` (`override`) since it is now also
an `ImageSource`.

- **`recompute()`** — `super.recompute()` (MaskLayer's, rebuilds
  `this._offscreen` = the composited mask), then composites `imageSlot`'s
  image through `this.getMask()` into `_clippedImage`. `renderSelf` draws
  `_clippedImage`; `getImage()` returns it. (Named `_clippedImage`, not
  `_offscreen`, to avoid shadowing `MaskLayer`'s private `_offscreen` which
  `getMask()` still reads.)
- **`autoBindRules()`** — `[...super.autoBindRules(), imageSlot → nearest Image]`,
  i.e. keeps MaskLayer's own `shape 1 → nearest Mask` rule in addition to the
  new image rule.
- **Hidden helper** — same `maskSlot` (Mask) + plain hidden `MaskLayer` +
  `setMaskTracker`/`trackedShape`/`markDirty` pattern as `ClipRectLayer`,
  folded into the same `postInsertLayer` `instanceof` union (no naming
  collision here, unlike `ClipTextLayer`). The helper is somewhat redundant
  since this layer already has its own paint tools, but keeps the pattern —
  and the "click bound slot to expose" gesture — consistent across all
  `Clip<X>` layers.

## NoiseLayer slider panel

`NoiseLayer`'s panel (`src/layers/NoiseLayer.ts`) has one slider per row for
**scale**, **speed**, **warp**, and **drift** — FilterLayer-style (label +
track + thumb + value text + ●/○ bind indicator), replacing earlier
`[−]/[+]`/`[‹]/[›]` steppers. The panel is 5 rows (161px): row 1 is the type
cycler, seed, and `time`/`pos` indicators; rows 2-5 are the sliders.
`MenuLayer`'s `BUTTONS` entry for `'Noise'` is `height: 161` to match.

- **scale** — manual fallback `_scale` (`[0,1]`, default ≈0.16); the slider
  maps `[0,1] → frequency [MIN_FREQ, MAX_FREQ]` (same mapping as the bound
  case) and displays the resolved frequency.
- **speed** / **warp** — sliders directly on `_speed`/`_detail` (`[0,1]`),
  displaying the value to 2 decimals.
- **drift** — slider `[0,1] ↔ angle [0, 2π)`, displaying degrees.

Dragging any slider while its slot is bound suspends that binding
(suspend-on-touch). Slider fill colour is the Amount accent `#4a8fe8`
(scale/speed/warp) or Direction accent `#7ecfcf` (drift) when the slot is
active, otherwise the noise accent `#b8a050`. `NoiseLayer` has
`handlePointerMove`/`handlePointerUp` to track slider drags via
`_sliderDrag`.

## CollectionLayer index slot

`CollectionLayer` has a `Count`-typed `indexSlot` (label "index"). When bound
and active (`indexSlot.isActive`), `recompute()` renders only
`_layers[selectedIndex()]` into `_compositeCanvas` instead of compositing all
ingested layers — so both `renderSelf` and `getImage()` (the `ImageSource`
output) become that single item.

`selectedIndex()` reads the bound `CountSource`'s count and wraps it modulo
`_layers.length` (`((raw % n) + n) % n`), so indices run 0..N-1 regardless of
the bound count's range or sign.

The header pill shows `#i of N layers` instead of `N layers` while indexed,
and the selected thumbnail in the grid gets a thicker `#a0a0a0` (Count accent)
border. `panelBottom` is overridden to sit below the thumbnail grid.

## FillLayer (renamed from GradientLayer)

`src/layers/FillLayer.ts` (formerly `GradientLayer.ts`) is a procedural
fill/gradient `ImageSource`. The mode cycler (`[◀] <type> [▶]`) has three
entries — `'fill' | 'linear' | 'radial'` — with `'fill'` as the default
(conic mode was removed):

- **fill** — the whole canvas is filled with `colourASlot`'s colour (and its
  own alpha). `colourBSlot`/`positionSlot`/`directionSlot` are ignored.
- **linear** / **radial** — linear spans the canvas diagonal at
  `directionSlot.angle`, centred on `positionSlot`; radial is concentric
  circles with radius `direction.magnitude × diagonal`. Stop colours come
  from `_resolveStops()`:
  - both colour slots active → use them as-is
  - only one active → that colour at its own stop, fading to **fully
    transparent** (`a: 0`) at the other stop, instead of mixing in the
    unbound side's black/white default
  - neither active → falls back to `DEFAULT_COL_A` (black) /
    `DEFAULT_COL_B` (white)

**`opacitySlot`** (`ValueType.Amount`, label "opacity") — overall multiplier
applied via `ctx.globalAlpha` in `_draw()`. Manual fallback `_opacity`
(default 1) with the suspend-on-touch slider pattern. Rendered in its own
pill directly below the main controls pill (`_opacityPillBounds()`,
`OPACITY_H = 36`), FilterLayer/NoiseLayer-style track+thumb slider with a
●/○ bind indicator. `panelBottom` is overridden to sit below this second
pill.

### Auto-binding colours at creation time

`postInsertLayer` (`main.ts`) has a `FillLayer` branch that searches down the
stack from the new layer for up to two `Colour`-producing layers: the first
found is bound to `colourASlot`, the second (if any) to `colourBSlot`. Mode
stays `'fill'` (the default), so `colourBSlot` is inert until the user
switches to a gradient mode — this is purely "wire up nearby colours in case
they're wanted later".

The colour-A/B swatches in the main pill show fully transparent
(`TRANSPARENT = { r:0, g:0, b:0, a:0 }`) when their slot is unbound, instead
of the black/white `DEFAULT_COL_A`/`DEFAULT_COL_B` fallback used for the
actual fill/gradient rendering — so an unbound slot reads as "empty" rather
than implying a specific colour is in effect.

### Swap-colours button

A `⇄` button (`_swapBtnBounds()`, `SWAP_W = 18`) sits between the two colour
swatches in the main pill. `_swapColours()` swaps the
`colourASlot`/`colourBSlot` bindings using the same find/remove/create
pattern as `CompositeLayer._swapLeftRight()` — any combination of
bound/unbound is handled. `_colourASlot`/`_colourBSlot` are labelled `'colour
a'`/`'colour b'` (previously the default Colour-type label) so their
auto-generated slot rows read clearly now that there are two of them.

## Mask-drop-on-image clipping shortcut

Dragging a Mask-producing layer's card out of the `LayerStackWidget` and
dropping it onto a selected `ImageLayer`, `FillLayer`, `NoiseLayer`, or
`VideoLayer` (the set returned by `isClippableImageLayer()` in
`ClipLayer.ts`) wraps that layer in a `ClipLayer`:

- A new `ClipLayer` takes the target layer's stack position
  (`clip.bounds = {...target.bounds}`).
- `clip.imageSlot` is bound to the target layer, `clip.maskSlot` to the
  dropped mask layer (both via `BindingLayer.create`).
- Both the target layer and the dropped mask layer are moved to
  `backgroundLayer`.
- `postInsertLayer(clip)` wires the new Clip's "replace with
  ClipRect/ClipEllipse/..." buttons (`wireClipLayer`) and runs
  `applyDefaultBindings` (a no-op here, since both slots are already bound).

This is implemented as a new bind-drag drop path in `InteractionSystem`:
`_handleUp`'s widget-capture branch now tries, in order, a slot hit
(`_onBound`), `_tryIngest` (CollectionLayer-style, now returns `boolean`),
then — if neither consumed the drop — `_onMaskDrop` (`setMaskDropCallback`,
wired in `main.ts`). The callback no-ops unless the dragged source's `types`
includes `ValueType.Mask` and the drop target is `isClippableImageLayer`.

### Dropping a shape (Rect/Ellipse/Path/Text)

`RectLayer`, `EllipseLayer`, `PathLayer`, and `TextLayer` all declare
`ValueType.Mask` in `types`, so they pass the same `source.types.has(Mask)`
check as a dedicated `MaskLayer` — but their mask output (a silhouette of the
shape itself) isn't normally what you'd want as a clip region directly, and
they have no stack-position-independent way to be "the mask".

So when the dropped `source` is one of these four shape types, the callback
first creates a plain `new MaskLayer()`, binds the shape into
`maskLayer.firstShapeSlot` (a public getter for `_shapeSlots[0]`, the
conventional first-shape binding target — same slot `MaskLayer.autoBindRules`
uses), and uses that `MaskLayer` — not the shape — as the source for
`clip.maskSlot`. Both the shape and the new `MaskLayer` are sent to
`backgroundLayer`; the `MaskLayer` is never inserted into the visible stack.

To create the shape→`firstShapeSlot` binding via the normal
`BindingLayer.create` (which inserts the `BindingLayer` above its consumer in
the *live* stack), the new `MaskLayer` is first inserted above `target`
(`maskLayer.insertAbove(target)`) so it has a stack position to attach above.
Immediately afterwards, both the resulting `BindingLayer` and the `MaskLayer`
are moved to `backgroundLayer` (`BindingLayer` first, then `MaskLayer` — this
order unwinds the temporary two-layer chain cleanly, restoring the original
stack links with neither layer left dangling).

## PointLayer wander mode

`PointLayer` (`src/layers/PointLayer.ts`) has a self-perpetuating "wander"
simulation. Below the coordinate-readout pill, `renderSlots` draws two more
pills: a single-row pill for the main `slot` (Point) binding, then one
consolidated wander pill containing all wander-related controls and their
slot bindings together. `panelBottom` sits below this stack. The standard
per-slot grid from `Layer.renderSlots` is not used here — `PointLayer`
reimplements row rendering itself (`_renderSlotRow`, `_renderSliderRow`),
registering `_slotBounds` (`protected` on `Layer`) so `hitTestSlot`/bind-drop
still work for each row.

**Wander pill layout** (7 fixed-height rows):

```
┌──────────────────────────────────────────────────────────┐
│ ▌ wander ────────────────────────────────────  ○    [⏸]  │  ← row 1
│   mode   [◀] drift [▶]                                    │  ← row 2
│   amount ──────●─────────────────────────────────  0.40  │  ← row 3
│   amount ──────────────────────────────────  unbound     │  ← row 4
│   speed  ───●────────────────────────────────────  0.30  │  ← row 5
│   speed  ──────────────────────────────────  unbound     │  ← row 6
│   mask   ──────────────────────────────────  unbound     │  ← row 7
└──────────────────────────────────────────────────────────┘
```

- **Row 1 — `wanderToggleSlot` (Event) binding + `[⏺]/[⏸]` toggle**. Rising-edge
  detection in `recompute()` flips `_wanderEnabled` while the slot is `Bound`.
  The manual button (`_handleWanderToggle`, `_renderWanderToggleButton`,
  `BTN_SZ = row.height - 6 = 20`) uses the "permanent override" toggle
  convention (see CLAUDE.md) — once touched, the event source is permanently
  bypassed.
- **Row 2 — `[◀] <algorithm> [▶]`** — cycles `WANDER_TYPES = ['drift',
  'brownian', 'orbit', 'wave', 'track']` via `cyclePrev`/`cycleNext`. No slot binding.
  - **drift** — forward motion with the heading perturbed smoothly left/right
    (`_heading += rand(-1,1) * amount * DRIFT_TURN_RATE * dt`).
  - **brownian** — sharp independent random turns each tick
    (`_heading += rand(-1,1) * amount * BROWNIAN_TURN_RATE`, no `dt` scaling
    — drunken-walk character).
  - **orbit** — constant-direction turning, producing circular/spiral paths
    (`_heading += _orbitSpin * (ORBIT_BASE_RATE + amount * ORBIT_AMOUNT_RATE) * dt`).
    `_orbitSpin` (±1, randomised at construction) flips sign on every bounce —
    like a spinning ball reversing spin off a paddle — so the orbit direction
    alternates each time the point hits the mask/canvas edge.
  - **wave** — heading oscillates sinusoidally over time, producing an
    S-curve path (`_wavePhase += WAVE_FREQ * dt; _heading += cos(_wavePhase)
    * amount * WAVE_TURN_RATE * dt`). `amount` scales the turning-rate
    amplitude (how tight the wiggle is), not the phase frequency.
  - **track** — see "PointLayer track wander mode" below.
- **Row 3 — amount slider** (`_renderSliderRow`): randomisation strength
  `[0,1]`, fed into whichever algorithm is selected above. Shows the
  resolved value (manual `_amount`, default 0.4, or the bound
  `amountSlot`'s value), tinted with the Amount accent when `amountSlot` is
  bound. Suspend-on-touch.
- **Row 4 — `amountSlot`** (Amount) binding row (`_renderSlotRow`, standard
  label + drop-target box), directly beneath the amount slider — a normal
  drop target for any `Amount`-producing layer.
- **Row 5 — speed slider** (`_renderSliderRow`), same treatment as row 3.
  Manual slider `[0,1]` maps to `[MIN_SPEED_PX, MAX_SPEED_PX]` px/s
  (20–400); a bound Rate is read directly in Hz and scaled by
  `SPEED_RATE_SCALE` (200) to px/s. The slider bar for a bound Rate is
  normalised against `RATE_DISPLAY_MAX = 8`, matching `RateLayer.MAX_RATE`.
- **Row 6 — `speedSlot`** (Rate) binding row, directly beneath the speed
  slider, same standard drop-target treatment as row 4.
- **Row 7 — `maskSlot`** (Mask) binding row (`_renderSlotRow`, standard
  label + drop-target box, showing the bound source's name like any other
  slot row). When bound, the point is constrained to the mask's opaque
  region; when unbound, it bounces off the canvas edges instead.

**Simulation** (`_wanderTick`, called from `recompute()` when
`_wanderEnabled && !_slot.isActive`): advances `_point` by `speed * dt` along
`_heading` (dt from `performance.now()`, capped at `MAX_DT = 0.1`s), perturbs
`_heading` per the selected algorithm, then checks `_boundaryNormal()` for the
resulting position. If outside the permitted area, velocity is reflected
(`v' = v - 2(v·n)n`) and `_heading` recomputed via `atan2`, retried once more;
if still outside, the point doesn't move this tick.

**Mask added/moved while outside it**: at the start of each tick, if a mask is
bound and the point's *current* position is outside it (`_boundaryNormal`
returns non-null for the current `_point`, before any movement), the point is
relocated via `_nearestInsideMask()` to the closest interior point — heading
and speed are left unchanged, so the bounce logic below may fire immediately
if the relocated position sits right at the mask edge. `_nearestInsideMask`
reads a `SNAP_MAX_RADIUS` (150px) square around the point with one
`getImageData` call and scans it for the nearest alpha ≥ `MASK_THRESHOLD`
pixel; if none is found within that radius, the point is left where it is.

**`_boundaryNormal(p, mask)`** — returns the inward unit normal at `p` if `p`
is outside the permitted area, or `null` if inside:
- **mask bound** — samples alpha at `p` via `getImageData` (1×1 read on the
  mask `OffscreenCanvas`); `null` if alpha ≥ `MASK_THRESHOLD` (0.5). Otherwise
  estimates the normal from a 4-point finite-difference alpha gradient at
  `±EDGE_SAMPLE_EPS` (3px). If the gradient is ~flat (deep outside / degenerate
  mask), falls back to bouncing straight back toward the previous point.
- **no mask** — `null` unless `p` is outside `[0, canvasWidth] × [0,
  canvasHeight]` (`Node.canvasWidth/Height`), in which case the normal points
  back toward the corresponding edge (handles corners by combining both axes).

**Self-perpetuation**: `queueMicrotask(() => forceDirty())` at the end of
`recompute()`, guarded by `_wanderEnabled && !_slot.isActive &&
!this.outsideStack` (checked again inside the microtask).

While wandering, `_region.interactive = false` (the draggable handle is
driven by the simulation, not the pointer) — same as when the main Point
`slot` is bound.

## MaskLayer invert toggle

A second pill, directly below the 4-shape-slot pill (`PILL_GAP = 8px`),
holds a single `_invertSlot` (`ValueType.Event`, label "invert") and a
manual `[⏺/⏸]` toggle button drawn at the right edge of its row
(`_renderInvertToggleButton`, same geometry/colour convention as
PointLayer's `_renderWanderToggleButton`: `BTN_SZ = row.height - 6`,
positioned at `row.x + row.width - BTN_SZ - 3`, coloured with
`EV_ACCENT = '#e0e060'`). `MaskLayer.renderSlots` is overridden to draw both
pills via two `renderSlotGroup` calls.

**`recompute()`** — after compositing the painted layer, shape slots, and
`trackedShape` into `_offscreen` as before, a rising edge on `_invertSlot`
(`getEventTime()` change) flips `_inverted`. If `_inverted` is true, the
composited mask is inverted in place: copy `_offscreen` to a scratch canvas
(`_scratch`, sized alongside the other canvases in `_ensureCanvases`), clear
`_offscreen` and fill it white, then `globalCompositeOperation =
'destination-out'` + `drawImage(_scratch)` punches out the previously
included region — leaving white where the mask was previously transparent
and vice versa.

**`_handleInvertToggle`** — "permanent override" toggle convention (see
CLAUDE.md): if `_invertSlot.state === Bound`, the binding is suspended
(`_invertSlot.suspend()`, never auto-resumed by this button); either way
`_inverted` is flipped. Checked in `hitTestSelf` (before the `hitTestSlot`
early-return that hands slot-row clicks to the slot-click/binding-inspector
logic) and in `handlePointerDown`.

## PointLayer "track" wander mode

The fifth `WANDER_TYPES` entry, selected via the row-2 mode cycler like the
others. Unlike the other four algorithms — which perturb `_heading` and
advance at constant `speed` with edge-bounce — `track` mode (`_trackTick`)
bypasses the heading/velocity model entirely:

- The point exponentially eases toward `Node.pointerCanvas` (the live mouse
  position): `followHz = TRACK_MIN_FOLLOW_HZ + speed01 * (TRACK_MAX_FOLLOW_HZ
  - TRACK_MIN_FOLLOW_HZ)`, `alpha = 1 - exp(-followHz * dt)`, then `_point`
  lerps toward the target by `alpha` each tick — frame-rate independent.
  `TRACK_MIN_FOLLOW_HZ = 2` (speed=0, a visible trailing lag) and
  `TRACK_MAX_FOLLOW_HZ = 150` (speed=1, effectively snaps within a frame) —
  `speed` controls follow lag, not movement style.
- **`amount`** sets the radius (`amount * TRACK_DRIFT_RADIUS`, 100px at
  amount=1) of `_trackDrift`, a 2D offset that random-walks
  (`TRACK_DRIFT_RATE` px/s per axis) and is clamped to that radius each tick.
  `amount = 0` collapses the radius to 0, so the point follows the mouse
  exactly.
- **No mask bound** — `target = mouse + _trackDrift`.
- **Mask bound, mouse inside it** — same as above, but the drifted target is
  clipped back onto the segment `mouse -> drifted` at the mask edge via
  `_lastInsidePointAlongLine`, so drift can pull the target deeper into the
  mask but never push it outside.
- **Mask bound, mouse outside it** — `_point` is already guaranteed inside
  the mask (the existing pre-switch relocation in `_wanderTick` handles a
  mask that was just bound/moved). The target is the last point along the
  line from `_point` to the mouse that is still inside the mask
  (`_lastInsidePointAlongLine`, `TRACK_LINE_STEP = 2px` increments), i.e.
  "walk toward the mouse until you'd leave the mask, stop just before". Drift
  is then applied and clipped the same way as the mouse-inside case.

`_lastInsidePointAlongLine(mask, from, to)` is the shared helper for both the
mouse-outside-mask and drift-clipping cases: marches from `from` (assumed
inside the mask) toward `to`, returning the last in-mask point before the
line would cross outside (or `to` itself if the whole segment stays inside).

## RootLayer.clockSlot and Clock readout dial

`RootLayer` has a third slot, `clockSlot` (`ValueType.Amount`, label
"clock"), **nominally bound** to the `ClockLayer` singleton (see CLAUDE.md)
via `root.setClock(clock)` — a raw `ParameterSlot.bind()` call, not a
`BindingLayer`. There is no binding inspector or remove button for this slot
(`BindingLayer.findForSlot` returns null for it); it exists purely to surface
the singleton's special status and give it a click target.

Clicking this (bound) slot row while Root is selected falls through
`interaction.setSlotClickCallback`'s "Bound slot" branch: `source.isHiddenHelper`
is false and `source.outsideStack` is true, but the source is in neither
`DeletionLayer`'s archive nor `BackgroundLayer` — a final `else` branch
(`source.insertAbove(consumer)`) handles this case generically, inserting the
singleton directly above Root and selecting it. From then on it behaves like
any other layer (movable, deletable/archivable — re-clicking the slot after
archiving falls back to the existing `deletionLayer.removeFromArchive` path).

### Clock readout — dial

`RootLayer.renderPanel` calls `_renderClockReadout(ctx)`, which draws a
clock dial (radius `CLOCK_R = 70`) centred on the canvas, with the elapsed
time printed below it. Since `renderPanel` runs only for the selected/top
layer and only in edit mode, this appears only while Root is selected — a
way to check the singleton's elapsed time without exposing it in the stack.

- **Dial face** — white (`CLOCK_BG`), so it blends with the default Root
  background. Boundary, minute ticks (every 5 minutes), the second hand, its
  trail, and the numeric readout are all light grey (`CLOCK_GREY =
  '128,128,128'`) so they read clearly against that white face (and against
  the default white canvas background generally).
- **Hour sweep** — a filled pie slice from 12 o'clock, growing in discrete
  one-minute steps (`Math.floor(elapsed / 60) % 60` minutes filled in the
  current lap) — i.e. it ticks forward each time the second hand completes a
  minute, not continuously. Coloured gold (`CLOCK_FILL`) for the first lap
  (0–60 min); once elapsed passes an hour it starts a second lap, coloured
  red (`CLOCK_OVERTIME`) — `lap = Math.floor(totalMinutes / 60)`, alternating
  gold/red on `lap % 2`.
- **Second hand** — continuous sweep, one revolution per minute
  (`(elapsed % 60) / 60`), with a 12-step fading trail (60° span,
  decreasing alpha) behind it.
- **Numeric readout** — `hh:mm:ss.cs` below the dial, using the same
  formatting as the ClockLayer thumbnail (`hh` omitted when zero).
