# PalimpsestII — Claude Code Context

## What this project is

A reactive dataflow canvas application. The mental model is a spreadsheet:
nodes are cells, evaluation functions are formulas, dependency edges are cell
references. Values are spatial and visual (images, masks, paths, colours) as
well as scalar. The layer stack is both the execution order and the primary
UI metaphor.

## Running locally

```
npm install        # first time only
npm run dev        # starts Vite dev server at http://localhost:5173
npm run typecheck  # TypeScript check (many pre-existing TS2352 cast warnings — ignore)
```

The project has **no external runtime dependencies** — only TypeScript and Vite.

## Deploying (GitHub Pages)

GitHub Pages serves the **committed `docs/` folder** on `main`
(`vite.config.ts` sets `outDir: 'docs'`, `base: '/PalimpsestII/'`). There is
**no CI workflow** that rebuilds it — after merging changes that should
appear on the live site, run:

```
npm run build       # regenerates docs/
git add docs
git commit -m "Rebuild docs/ for GitHub Pages"
git push
```

If a feature works locally but "isn't showing up" on the deployed site,
check whether `docs/` is stale before debugging the feature itself
(`git log -1 -- docs` vs `git log -1`).

## Architecture

### Value types (`src/core/types.ts`)

Ten types in the `ValueType` enum:
`Image`, `Mask`, `Colour`, `Amount`, `Point`, `Direction`, `Rate`, `Count`, `Event`, `Collection`

Each has a corresponding `*Source` interface (`AmountSource`, `MaskSource`, etc.).
Layers that produce a type implement the interface; consumers cast `slot.source`
to the interface to read the value. This is structural subtyping — no shared
base interface required.

### Node (`src/core/Node.ts`)

Abstract base. Key statics:
- `Node.scheduleFrame` — set by Evaluator; calling it requests a render frame
- `Node.bindDrag` — shared drag state for the bind-drag overlay
- `Node.canvasWidth / canvasHeight` — updated by Evaluator on construction and resize; use these when sizing full-canvas OffscreenCanvases

Dirty propagation is **push** (marking dirty propagates to dependents immediately).
Evaluation is **pull** (lazy — `evaluate()` depth-first resolves dependencies before recomputing).

### Layer (`src/core/Layer.ts`)

Extends Node. Adds:
- Doubly-linked stack (`layerBelow`, `layerAbove`)
- `renderSelf(ctx)` — layer content, called for every layer in the stack
- `renderPanel(ctx)` — control UI, called **only for the selected layer**
- `renderSlots(ctx)` — parameter drop-target rows, called after renderPanel
- `hitTestSelf(point)` — override to respond to pointer events
- `panelBottom` — y-coordinate of the bottom of the panel strip; slot rows start here

### ParameterSlot (`src/core/ParameterSlot.ts`)

Typed input on a Layer. States: `Unbound | Bound | SuspendedBound`.
- `slot.isActive` — true only when Bound
- `slot.bind(source)` / `slot.unbind()` / `slot.suspend()` / `slot.resume()`
- Slots registered in `this.slots[]` are rendered automatically by `renderSlots`

### Interaction (duck-typed)

Nodes respond to pointer events by implementing any subset of:
```typescript
handlePointerDown(point: Point): boolean  // return true to claim the drag
handlePointerMove(point: Point): void
handlePointerUp(): void
```
`InteractionSystem` calls `hitTestLayer` (selected layer only) or `hitTest` (full
stack) on pointerdown, then delivers move/up to the captured node.

When a tool mode needs to capture the whole canvas (e.g. a paint tool), override
`hitTestSelf` to return `this` for all points while the tool is active.

### Dataflow graph (`src/dataflow/Graph.ts`)

Singleton registry. Call `graph.register(this)` in every Layer constructor.
Provides cycle detection at bind time — `graph.canBind(source, consumer)`.

## Adding a new layer type

1. Create `src/layers/MyLayer.ts`, extend `Layer`
2. Declare `readonly types: ReadonlySet<ValueType>` — what value(s) this layer produces
3. Implement the matching source interface(s) (e.g. `implements AmountSource`)
4. Declare `ParameterSlot` fields, push them onto `this.slots[]` in the constructor
5. Call `graph.register(this)` at the end of the constructor
6. Implement `protected recompute(): void` — reads slot sources, updates internal state
7. Implement `renderSelf(ctx)` for canvas content, `renderPanel(ctx)` for the control strip
8. Override `hitTestSelf` and add `handlePointerDown/Move/Up` if the layer is interactive
9. Add an entry to the `BUTTONS` array in `src/layers/MenuLayer.ts`
10. Export from `src/layers/index.ts`

## Layer panel conventions

Panels are drawn in the layer's `bounds` (a horizontal strip, typically `height: 36`).
Standard elements:
- Background pill: `rgba(0,0,0,0.45)`, `roundRect`
- Accent stripe: 4 px wide on the left, coloured by type
- Type accent colours: Amount `#4a8fe8`, Colour `#e8944a`, Image `#7ecf7e`,
  Mask `#cfcf7e`, Point `#cf7ecf`, Direction `#7ecfcf`, Rate `#e87e7e`
- Slot indicator dots (●/○) drawn right-to-left before the reset button
- Reset button `[↺]` at far right: `x + width - 26, width: 20`

The canvas-space panel below the strip (slot rows) starts at `this.panelBottom`
(default: `50 + bounds.height + 8`) at `x: 300, width: 260`.

**IMPORTANT — canvas-space pill rule:** Any interactive controls that a layer needs
(camera selector, shape handles, colour pickers, etc.) **must** be drawn in a second
pill at `{ x: 300, y: 50, width: 260, height: bounds.height }` inside `renderPanel`,
*not* only in `this.bounds`. The Stack Widget covers roughly `x: 0–295`, so controls
drawn only in `this.bounds` will be hidden behind it. See `ShapeLayer` and `VideoLayer`
for the canonical two-pill `renderPanel` pattern.

Toggle buttons for event slots (freeze/fill-mode/etc.) go in `override renderSlots`
at `PANEL_X + PANEL_W - BTN_SZ - 3` in the corresponding slot row (BTN_SZ = 20).
Store bounds in a `_toggleBounds` field and check it in `hitTestSelf` /
`handlePointerDown`. See `ShapeLayer.renderSlots` for the canonical pattern.

## Key files

| Path | Purpose |
|---|---|
| `src/app/main.ts` | Entry point — canvas setup, initial stack, event wiring |
| `src/core/types.ts` | ValueType enum, value types, source interfaces, BoundingBox |
| `src/core/Node.ts` | Base class — dirty, dependents, evaluate, statics |
| `src/core/Layer.ts` | Stack links, rendering, hit testing, slot rendering, `autoBindRules` |
| `src/core/ParameterSlot.ts` | Typed inputs — Bound/Unbound/SuspendedBound |
| `src/dataflow/Evaluator.ts` | rAF loop, render pipeline, resize |
| `src/dataflow/Graph.ts` | Cycle detection, bind validation |
| `src/interaction/InteractionSystem.ts` | Pointer routing, keyboard, bind-drag, pixel-pick selection |
| `src/interaction/LayerStackWidget.ts` | Thumbnail strip, layer selection, reorder |
| `src/interaction/thumbnail.ts` | Shared thumbnail rendering utility (used by widget and DeletionLayer) |
| `src/layers/MaskLayer.ts` | Composite mask: shape slots + freehand paint/erase |
| `src/layers/ShapeLayer.ts` | Abstract shape base — produces Point + Mask |
| `src/layers/CompositeLayer.ts` | Blends two images with optional Mask input |
| `src/layers/TileLayer.ts` | Tile or fit an image's content bbox to cover the canvas |
| `spec/architecture.md` | Detailed architecture specification |

## MaskLayer specifics (added June 2026)

`MaskLayer` combines up to 4 `MaskSource` inputs (shape slots) with a
freehand-painted `OffscreenCanvas`. Final mask = black background ∪ painted
strokes ∪ all bound shape masks, composited with `source-over`.

`ShapeLayer` (and its subclasses `RectLayer`, `EllipseLayer`) now produce both
`ValueType.Point` and `ValueType.Mask`. The mask is a full-canvas white-on-transparent
rasterisation of the filled shape, regenerated in `recompute()` using
`Node.canvasWidth/Height`.

## Pixel-pick layer selection (added June 2026)

Clicking an empty area of the canvas (no hit on the current layer's controls)
triggers a pixel-pick scan: `InteractionSystem._pickLayerAtPixel()` walks the
stack top-to-bottom, renders each non-infrastructure layer to a single shared
`OffscreenCanvas`, reads the alpha of the clicked pixel, and selects the first
layer with alpha > 10. This fires from `_handleDown` whenever the normal
hit-test returns nothing.

## Default binding rules (`autoBindRules`) (added June 2026)

`Layer.autoBindRules()` returns an array of `{ slot, accepts,
sendToBackgroundAfterBind? }` descriptors. `applyDefaultBindings(layer)` in
`main.ts` walks down the stack from the newly-added layer and binds the first
non-infrastructure, non-hidden-helper layer that satisfies each `accepts`
predicate.

Layers currently declaring rules:
- **MaskLayer** — binds first shape slot to nearest `Mask`-producing layer below,
  with `sendToBackgroundAfterBind: true` (see below). `ClipDrawingLayer` inherits
  this rule via `...super.autoBindRules()`.
- **ClipLayer** — binds image slot to nearest `Image`; mask slot to nearest `Mask`;
  both with `sendToBackgroundAfterBind: true`
- **TileLayer** — binds source slot to nearest `Image`, with
  `sendToBackgroundAfterBind: true`
- **AnimPathLayer** — special-cased in `main.ts` (creates Clock/Rate if absent)

To add rules to a new layer, override `autoBindRules()` in the layer class.

### `sendToBackgroundAfterBind` (added June 2026)

A source layer bound straight into a freshly-created layer's slot at creation
time — a shape into a `MaskLayer`'s first shape slot, or an image/mask into a
`ClipLayer`, or an image into a `TileLayer` — is unlikely to be needed for
anything else, but its output is still part of the result (the mask, the
clip's content, the tile's source) so it must keep recomputing.
`applyDefaultBindings` moves that source layer into the `BackgroundLayer`
collection (via `backgroundLayer.add(l)`) instead of leaving it in the main
stack: it keeps recomputing but no longer clutters the stack, and remains
recoverable via `DeletionLayer`'s Background toggle (once `DeletionLayer` is
in the stack — see `pruneDeletionLayerIfEmpty()` below, which keys its
visibility on deletion count alone, not on Background contents).

Hidden helper layers (see below) are unaffected by this — they remain in the
stack, in their fixed position relative to their host, just not rendered or
given a thumbnail.

## DeletionLayer (updated June 2026)

Archived layers are shown as **live thumbnails** (same rendering as
`LayerStackWidget`) so they stay visually distinct and update as their sources
change. Each thumbnail has a small red `×` button at top-right for permanent
purge. On purge, `main.ts` snapshots `layer.dependents`, filters for
`BindingLayer` instances, and calls `bl.remove()` on each — which unbinds the
consumer slot, removes the BindingLayer from the stack, and unregisters it from
the graph. Double-click still restores.

Thumbnail rendering is in `src/interaction/thumbnail.ts` (`drawLayerThumbnail`,
`typeColor`) — import from there when adding a new widget that needs thumbnails.

## Binding replacement and right-click inspector (added June 2026)

**Drag-to-replace**: `Layer.renderSlots` now shows the green "replace binding"
drop-target highlight on already-bound slots when a compatible drag is live
(same appearance as an empty slot). `BindingLayer.create` calls
`BindingLayer.findForSlot(slot)?.remove()` before creating the new binding,
cleanly removing the old BindingLayer from the stack.

**Right-click inspector**: `InteractionSystem` listens for `contextmenu` on
the canvas. If the click lands on a bound slot of the selected layer, it shows
a floating HTML panel with the binding description (`Source ──→ Consumer · slot`),
a toggle button (enable/disable, updates in-place), and a delete button.
Panel closes on outside click. `setRefreshCallback()` lets main.ts provide the
`refreshStack()` hook so delete updates the stack widget.

`_handleDown` now guards with `if (e.button !== 0) return` so right-clicks
don't accidentally trigger pixel-pick layer selection.

`BindingLayer` exposes `get slot()`, `get source()`, and
`static findForSlot(slot)` (scans `graph.nodes`) for use by the inspector.

## MaskLayer UX improvements (added June 2026)

- **Default paint mode**: `_activeTool` initialises to `'paint'` — ready to paint immediately on creation.
- **Brush preview on slider drag**: the brush outline circle is shown at the cursor position while the size slider is being dragged.
- **Pixel-pick suppression**: `readonly blockPixelPick = true` on MaskLayer. `InteractionSystem._handleDown` checks for this flag before running the pixel-pick scan, so transparent canvas areas never accidentally switch focus away from MaskLayer while it is selected.

## OS file drag-and-drop (updated June 2026)

Dropping an image file from the OS onto the canvas always **creates a new `ImageLayer`**. Placement rules (in `main.ts`):

| Context | Result |
|---|---|
| MenuLayer is selected | New layer inserted below MenuLayer |
| Drop lands on an Image-type slot of the current layer, or the current layer has an empty Image slot | New layer inserted below current layer, bound to that slot; current layer stays selected |
| Anything else | New layer inserted above current layer, becomes selected |

The `dragover` handler just sets `dropEffect = 'copy'`; no existing layer state is modified.

## ClipLayer transform handles (added June 2026)

`ClipLayer` now has move / scale / rotate handles (identical geometry and colours to `ImageLayer`) and two new parameter slots:

- **`positionSlot`** (Point) — overrides the manual move handle
- **`scaleSlot`** (Amount) — overrides the manual scale handle

The clipped content (which pixels are included) is fixed by the mask and source image in their original canvas positions. Only the rendered output is transformed: the full-canvas `_offscreen` is drawn with `translate → rotate → scale`, centred on `_position`. Default: canvas centre, scale 1, rotation 0 — identical to the previous behaviour.

## AmountLayer point-coordinate slots (added June 2026)

Two new `ValueType.Point` input slots derive an Amount from a Point's canvas coordinates:

- **x position slot** — `point.x / canvasWidth` → [0, 1] (left→right)
- **y position slot** — `point.y / canvasHeight` → [0, 1] (top→bottom)

If both are active the value is their average. Point slots take precedence over the existing Amount slot; if nothing is active the slider is user-controlled.

**Slider override**: dragging the slider while any slots are active calls `BindingLayer.findForSlot(slot)?.toggle()` on all active slots, suspending them and handing control back to the user at the current value. `SliderRegion` gained a `setOnDragStart(fn)` callback to support this; the guard `if (!this._interactive) return false` in `handlePointerDown` was removed so that the slider is always draggable.

Panel shows three slot indicators right-to-left: **A** (Amount, blue), **x** (Point, purple), **y** (Point, purple).

## Layer.assignDebugName and parameter-slot click-to-create/select (added June 2026)

`Layer.assignDebugName(layer)` (static, in `Layer.ts`) assigns a friendly
`debugName` of the form `"<Type> <n>"` (class name with trailing `Layer`
stripped + a per-type running counter in `Layer._typeCounters`). All layer
creation sites (MenuLayer buttons, OS file drop, AnimPathLayer's auto-created
Clock/Rate, the slot-click factory below) call this instead of setting
`debugName` to a literal, so names stay unique and consistent everywhere.

`renderSlots` in `Layer.ts` now also renders `SlotState.SuspendedBound` rows:
a dashed outline plus a `⏸ <sourceDebugName>` label, distinct from the solid
"bound" and dashed empty-slot styles.

**Click on a parameter-slot row** of the selected layer (`InteractionSystem`
checks this in `_handleDown`, before falling back to pixel-pick, via
`setSlotClickCallback`):
- **Empty slot** — looks up the slot's type in `DEFAULT_VALUE_LAYER` (main.ts),
  constructs the canonical default layer for that type (e.g. `AmountLayer(0.5)`,
  `ColourLayer(...)`, `PointLayer(centre)`), inserts it above the consumer,
  binds it via `BindingLayer.create`, and selects it. `DEFAULT_VALUE_HEIGHT`
  mirrors `MenuLayer.BUTTONS`' height overrides (only Colour needs 170px).
- **Bound slot** — selects the layer feeding it. If that layer is currently
  archived (`layer.outsideStack`), `DeletionLayer.removeFromArchive(layer)`
  removes it from the archive list and it's reinserted above the consumer.

## ColourLayer hue/position slots (added June 2026)

`ColourLayer` gained two extra input slots, active only while the main
Colour slot is unbound:

- **hue slot** (Amount) — drives the hue strip; `amount [0,1] → hue [0,360)`
- **position slot** (Point) — drives the SV cursor; canvas `x → saturation`,
  `y → 1 - value`

`ColourPickerRegion` gained `setHue`/`setSatVal` (driven from the slot
values each `recompute`), and per-zone `hueInteractive`/`svInteractive`
flags. Dragging a zone that's locked by an active slot calls
`setOnHueDragStart`/`setOnSvDragStart`, which suspend that binding via
`BindingLayer.findForSlot(slot)?.toggle()` — same pattern as
`AmountLayer`'s slider-override. Slot indicators **P** (position) and **H**
(hue) are drawn right-to-left in the panel using the ●/◐/○ Bound/Suspended/Unbound
convention.

Also fixed: `renderPanel` on both `ColourLayer` and `AmountLayer` was calling
`_drawPill` twice (once for `this.bounds`, once for the canvas-space panel) —
the duplicate call against `this.bounds` was removed.

## ColourLayer hue/position and image-sample slot rows (added June 2026)

`ColourLayer` derives its colour either from the bound `_slot` (Colour), from
two slots that drive the HSV picker directly (`_hueSlot`: Amount, `_posSlot`:
Point — see "ColourLayer hue/position slots" above), or by sampling pixels
from another image around a point. All six slots
(`_slot, _hueSlot, _posSlot, _sampleEnableSlot, _sampleImageSlot,
_samplePointSlot`) are pushed onto `this.slots[]` in that order and get
standard bind rows from `Layer.renderSlots`, starting at the default
`panelBottom` (directly below the main picker pill) — `panelBottom` is **not**
overridden.

The three sample slots are:

- **`_sampleEnableSlot`** (Event) — rising edge toggles `_sampleEnabled`,
  same rising-edge pattern as `RootLayer.toggleSlot`
- **`_sampleImageSlot`** (Image) — source to sample from
- **`_samplePointSlot`** (Point) — canvas-space location to sample around

`override renderSlots` calls `super.renderSlots(ctx)` (drawing all six
standard rows), then draws an additive accent-bordered group (`SAMPLE_ACCENT`
= Colour accent `#e8944a`) around the three sample-slot rows plus one extra
row below them for a `_sampleRadius` slider (`[2,100]` px, manual only — no
slot binding; `_sampleGroupGeom()`/`_sampleSliderGeom()` compute this
geometry from `this.slots.indexOf(_sampleEnableSlot)` and `panelBottom`). An
enable/disable toggle button (`_sampleToggleBounds`, `_handleSampleToggle()`
— Bound→suspend, SuspendedBound→resume, Unbound→flip `_sampleEnabled`,
identical to `RootLayer._handleToggle`) is overlaid on the
`_sampleEnableSlot` row, coloured with `EV_ACCENT` (`#e0e060`, the Event
accent).

`recompute()`: after computing `_colour` via the existing slot/picker logic,
a rising edge on `_sampleEnableSlot` flips `_sampleEnabled`; if enabled,
`_sampleFromImage()` is called and — if it returns non-null — overrides
`_colour` and sets `_picker.interactive = false`. `_sampleFromImage()` reads
the sample image's pixels (via `getImageData`, `ImageBitmap` first drawn to a
temporary `OffscreenCanvas` as in `TileLayer._contentBbox`), and returns the
alpha-weighted average colour of pixels within `_sampleRadius` of the sample
point, or `null` if either slot is unbound, the image is unavailable, or the
sampled area is fully transparent — in which case the colour computed above
(bound Colour slot, or interactive picker) is used unchanged.

`hitTestSelf`/`handlePointerDown/Move/Up` check the toggle button
(`_sampleToggleBounds`) and slider (`_sliderHit`) before falling back to
`_picker.hitTest(point)`; the picker's own bounds stay confined to the main
pill, so there's no overlap.

## Edit-mode drop shadow and depth fade (fixed June 2026)

In `Evaluator.render()`, the current (selected/top) layer's drop shadow now
uses the legacy `ctx.shadowColor` / `ctx.shadowBlur` / `ctx.shadowOffsetY`
properties instead of `ctx.filter = 'drop-shadow(...)'` — the `filter` form
is not rendered on older Safari.

The progressive fade of layers below the top one is no longer done via
`ctx.globalAlpha` (many layers' `renderSelf` set their own
`ctx.globalAlpha = this._opacity`, clobbering a depth-based value set by the
Evaluator). Instead, after rendering each non-top layer, a full-canvas
`rgba(255,255,255,0.25)` rectangle is composited over everything rendered so
far ("atmospheric haze") — layers further down accumulate more washes and
fade toward white. Both effects only run in edit mode (the loop over
`layers[]` in `render()`), never in display mode.

## Transform handles are panel-only (fixed June 2026)

`ImageLayer` and `ClipLayer` move/scale/rotate handles are now drawn in
`renderPanel` (called only for the selected layer, never in display mode),
not in `renderSelf` (composited for every layer in the stack and in display
mode). `ImageLayer.renderPanel` calls `_renderPanelImpl` then
`_renderHandles`; `ClipLayer.renderPanel` calls `_renderHandles` first, then
its normal panel drawing.

## TileLayer (added June 2026)

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

## FilterLayer (updated June 2026)

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

## VideoLayer (added June 2026)

`src/layers/VideoLayer.ts` captures webcam input and produces `ValueType.Image`.

- Camera enumeration via `navigator.mediaDevices.enumerateDevices()` after a brief
  permission-unlock `getUserMedia` call. ◀ / ▶ nav buttons in the canvas-space pill
  cycle through cameras when more than one is present.
- **Frame loop**: `recompute()` calls `queueMicrotask(() => forceDirty())` while live
  and in the stack. The microtask fires *after* `evaluate()` clears `_dirty`, so the
  next rAF finds the node dirty and captures a fresh frame. Loop self-terminates when
  `_frozen || _stream === null || outsideStack`.
- **Freeze toggle**: `enableSlot` (Event) — rising edge toggles `_frozen`. Manual
  toggle button in the slot row follows the ShapeLayer/VideoLayer pattern
  (`override renderSlots`). Bound → suspend, SuspendedBound → resume, Unbound → flip.
- The hidden `<video>` element must remain in the DOM for Safari to deliver frames
  (positioned at `top: -9999px`).
- Panel follows the two-pill convention: strip pill at `this.bounds`, camera-selector
  pill at `{ x: 300, y: 50, width: 260, height: bounds.height }`.

## RootLayer background controls (added June 2026)

`RootLayer` now has two parameter slots and interactive controls:

- **`toggleSlot`** (Event) — rising edge flips `_transparent`. Default `false` = white
  fill. `true` = checkerboard (signals no fill). Manual toggle button in the slot row.
- **`colourSlot`** (Colour) — when bound, overrides the white fill with the bound colour.
  Unbound = white (`{ r:1, g:1, b:1, a:1 }`).

`renderSelf` uses `Node.canvasWidth/Height` (not `this.bounds`) because `this.bounds`
covers the full canvas rect for the checkerboard — do **not** use `this.bounds` for
panel geometry in RootLayer. Fixed constants `STRIP_X/Y/W/H` and `PANEL_X/Y/W` are
used instead. `panelBottom` is overridden to return `PANEL_Y + STRIP_H + 8 = 94`.

## DeletionLayer — deferred insertion (updated June 2026)

`DeletionLayer` is no longer inserted at startup. It is added to the stack (above
`root`) only when the first deletion occurs, and removed again when its archive is
emptied. Two helpers in `main.ts` manage this:

- `ensureDeletionLayerInStack()` — inserts above `root` if `outsideStack`; called
  before every `deletionLayer.archive()` call.
- `pruneDeletionLayerIfEmpty()` — calls `removeFromStack()` when archive length is 0;
  called in the restore, purge, and slot-restore callbacks.
- `lowestAnchor()` — returns `deletionLayer` when in stack, `root` otherwise; used
  by drag-drop fallback insertion sites.

`deletionLayer.outsideStack` is set to `true` at construction (before any insertion)
so `lowestAnchor()` returns `root` from the start.

## LayerStackWidget — thumbnail visibility (updated June 2026)

`Layer` has a new property `thumbnailOnlyWhenSelected: boolean = false`. When `true`,
`LayerStackWidget._drawCard` skips the entire card (body, shadow, thumbnail, border)
unless the layer is the currently selected layer.

`RootLayer` overrides it to `true` — its white-fill thumbnail is invisible at startup
and reappears only when Root is selected.

## Strip pill suppression (added June 2026)

Strip pills (drawn at `this.bounds`, in the widget column to the left of
`contentLeft(canvasWidth)`) are suppressed when the StackWidget is visible. In
`Evaluator.render()`, `renderPanel` is wrapped in a `save() / clip(rect(ww, 0, …)) /
restore()` when the widget is visible, where `ww = contentLeft(width)`. This covers
the full extent of strip pills while leaving canvas-space pills and slot rows
(`x ≥ contentLeft(width)`) completely unaffected.

Pressing **h** hides the widget, removes the clip, and makes strip pills visible —
useful for development and inspection.

## LayerStackWidget — responsive width (added June 2026)

`src/interaction/layout.ts` is the single source of truth for the widget/content
boundary:
- `stackWidgetWidth(canvasWidth)` — `canvas.width * 0.20`, clamped to
  `[WIDGET_MIN=120, WIDGET_MAX=280]`.
- `contentLeft(canvasWidth)` — `stackWidgetWidth(canvasWidth) + WIDGET_MARGIN(20)`,
  the left edge of the canvas-space panel area (replaces the old fixed `x = 300`).

`LayerStackWidget._widgetW()` calls `stackWidgetWidth`. `_cardW()` is
`_widgetW() - CARD_X(16) - CARD_MARGIN(20)`. All draw/hit-test code (`_cardH`,
`_drawCard`, `inBounds`, `handlePointerMove`'s bind-drag threshold, the
current-label strip, the drop indicator) calls these instead of fixed
`WIDGET_W`/`CARD_W` constants.

At the original ~1400px-wide desktop canvas this is unchanged (280px widget,
`contentLeft` = 300 — same as the old fixed values). On a phone-width canvas the
widget shrinks toward the 120px floor and `contentLeft` shrinks with it.

**Note:** the canvas-space pill convention for individual layers (`x: 300, width:
260` in many `renderPanel` implementations) still uses the literal `300`, not
`contentLeft()`. Only `LayerStackWidget`, `Evaluator`, and `MenuLayer` have been
made responsive so far — per-layer panels are a larger follow-up if full phone
support is needed.

## MenuLayer — responsive button grid (added June 2026)

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

## Startup flow (added June 2026)

At launch the stack is `root → startupLayer` — no MenuLayer. `StartupLayer`
(`src/layers/StartupLayer.ts`) renders two 140×140 dark rounded-rect buttons
centred in the visible canvas area (x ≥ 300, right of the StackWidget):

- **"Menu"** (left) — removes StartupLayer, inserts MenuLayer above root,
  calls `refreshStack(menuLayer)`.
- **"Tutorial"** (right) — removes StartupLayer, inserts MenuLayer above root,
  then inserts a new TutorialLayer above MenuLayer, calls `refreshStack(tl)`.

`blockPixelPick = true` on StartupLayer prevents accidental layer selection
when clicking the white background area between or around the buttons.

`refreshStack` was changed to walk up from `root` rather than `menuLayer`
so it finds the correct stack top even when MenuLayer is not yet present.

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

### `postInsertLayer` (main.ts)

All per-type setup that runs after a new layer is inserted — AnimPath auto-binding,
CollectionLayer eject callback, TutorialLayer wiring, `applyDefaultBindings` — lives here.
Both the MenuLayer `onAdded` callback and `wireTutorialLayer` call it, so every creation
path gets identical behaviour. The caller is responsible for calling `refreshStack` afterwards
(selecting `menuLayer` or `tl` as appropriate).

Current pages:
1. **Welcome** — layer stack navigation (Up/Down/Delete/drag), then Ellipse/Rect/Text buttons.
2. **Images and Video** — Image (file load + OS drag-and-drop), Video (camera), with Image/Video buttons.
3. **Values and Binding** — parameter slots, bind-drag gesture, click-to-create shortcut, with Colour/Amount/Point buttons.
4. **Masks and Animation Paths** — masking shapes, AnimPath auto-wiring of shape + Clock/Rate, with Mask/AnimPath buttons.

StartupLayer is **not** listed in the MenuLayer button grid — it is only
ever shown at launch and is destroyed when a mode is chosen.

## StrokeLayer (added June 2026)

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

## TextLayer transform handles (added June 2026)

`TextLayer` now has move / scale / rotate handles, drawn in `renderPanel` (panel-only,
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

## Direction rotationSlot — manual rotate handles (added June 2026)

`ImageLayer`, `ClipLayer`, `TextLayer`, and `StrokeLayer` each have a manual
rotate handle (`_rotation`, in radians) and now also have a `rotationSlot`
(`ValueType.Direction`), pushed onto `this.slots[]`. This follows the same
slider-override pattern as `AmountLayer`'s `_suspendActiveSlots()`:

- **`recompute()`** — when `rotationSlot.isActive`, `_rotation` is overwritten
  from `(rotationSlot.source as DirectionSource).getDirection().angle`
  (magnitude is unused). For `StrokeLayer` this sets the *base* `_rotation`,
  which then flows through the existing `_computedRotation` rubber-banding
  (start/end Point slots) exactly as a manual drag would.
- **Rotate handle drag start** — if `rotationSlot.state === SlotState.Bound`,
  `BindingLayer.findForSlot(this.rotationSlot)?.toggle()` suspends the binding
  before the drag begins, handing manual control back to the user at the
  current angle. `StrokeLayer` calls this alongside its existing
  `_suspendEndpointSlots()`.
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
- **H_ROTATE drag start** — suspends `rotationSlot` via
  `BindingLayer.findForSlot(...)?.toggle()`, same as the other layers.
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

## Known issues / pre-existing tech debt

- `npm run typecheck` reports ~80 `TS2352` cast warnings throughout the codebase
  (e.g. `slot.source as AmountSource`). These are pre-existing and do not affect
  runtime behaviour — Vite transpiles without type-checking.
- `PathLayer` has a private `_dragStartPtr` field that shadows the one in
  `ShapeLayer`, causing a TS2415 error. Pre-existing.
- `MaskLayer.resize()` from the original implementation is gone; canvas size
  changes are handled automatically via `Node.canvasWidth/Height`.

## Hidden helper layers (added June 2026)

A **hidden helper** is a normal stack member — it is evaluated every frame
via `renderStack` in stack order — but is invisible: no thumbnail in
`LayerStackWidget`, and `renderSelf`/panel/haze are skipped in the Evaluator's
edit-mode loop. Three `Layer` fields support this:

- **`isHiddenHelper`** — set on the helper itself.
- **`helperHost`** — set on the helper, points back to the layer it helps.
- **`hiddenHelper`** — set on the host, points to its helper.

`LayerStackWidget.setStack` excludes `isHiddenHelper` layers from `_layers`
(no thumbnail, never selectable). `Layer.renderStack` and the Evaluator's
edit-mode loop call `.evaluate()` on hidden helpers but skip `renderSelf`.
`LayerStackWidget._reorderLiveStack` (shared by `moveUp`/`moveDown`/drag-drop)
re-inserts `layer.hiddenHelper` directly above `layer` after every reorder, so
the pair always travels together.

**First application**: when `postInsertLayer` (`main.ts`) auto-creates a
`RateLayer` for a new `AnimPathLayer`'s `phaseSlot` (no existing Rate/Clock
found), the `RateLayer` is inserted directly **above** the AnimPath as a
hidden helper (`rate.isHiddenHelper = true`, linked via `helperHost`/
`hiddenHelper`) and bound to `phaseSlot`. The `ClockLayer` it derives its time
from is sent straight to `backgroundLayer` (`backgroundLayer.add(clock)`,
never inserted into the stack) — same "unlikely to need its own controls"
reasoning as `sendToBackgroundAfterBind`. `refreshStack` (`main.ts`) falls
back to scanning `backgroundLayer.items` for a `ClockLayer` when none is
found in the stack, so `evaluator.setClock()` still picks it up and
`tick()`/continuous rendering work as normal.

**Exposure**: clicking the AnimPath's `phaseSlot` row (a bound slot) in
`interaction.setSlotClickCallback` checks `source.isHiddenHelper` first — if
set, it clears `isHiddenHelper` and breaks the `helperHost`/`hiddenHelper`
link on both sides *before* `refreshStack(source)`. The RateLayer then gets a
thumbnail at its current position (directly above the AnimPath) and is
selected; it no longer moves with the AnimPath on subsequent reorders. This
exposure logic is generic — it fires for *any* hidden helper bound to a
clicked slot, not just RateLayer.

**Below-host helpers**: `helperBelow: boolean` (on the host) tells
`_reorderLiveStack` to keep the helper directly *below* the host
(`helper.insertBelow(layer)`) instead of above. `Layer.insertBelow(target)`
is the mirror of `insertAbove`. See `ClipRectLayer` below for the first
below-host application.

## ClipRectLayer (added June 2026)

`src/layers/ClipRectLayer.ts` is the first of a planned "Clip&lt;Shape&gt;"
family. Unlike a typical hidden-helper consumer, `ClipRectLayer extends
RectLayer` directly — it has its own geometry and handles (inherited
unchanged from `ShapeLayer`/`RectLayer`), and renders the clipped image
instead of a filled rectangle.

- **Slots**: adds `imageSlot` (Image) and `maskSlot` (Mask) to the slots
  inherited from `ShapeLayer` (position/colour/opacity/phase/fillMode/
  rotation) — "same controls as a Rectangle layer", plus these two.
- **`recompute()`** — calls `super.recompute()` (updates geometry and
  `this._maskCanvas` via `ShapeLayer`), then composites `imageSlot`'s image
  through `this.getMask()` (its own rectangle silhouette) with
  source-over + destination-in, into `_offscreen`. `renderSelf` draws
  `_offscreen`; `getImage()` returns it.
- **`maskSlot` is not read by `recompute()`** — it exists purely so the slot
  row can be bound to the hidden mask-tracker helper below (see next), so
  that helper is exposable via the standard "click a bound slot whose source
  is a hidden helper" gesture.
- **Hidden helper**: `postInsertLayer` (`main.ts`) creates a plain
  `MaskLayer`, inserts it directly **below** the new `ClipRectLayer`
  (`maskHelper.insertBelow(newLayer)`), sets `isHiddenHelper`/`helperHost` on
  the helper and `hiddenHelper`/`helperBelow = true` on the host, calls
  `newLayer.setMaskTracker(maskHelper)`, and binds the helper to `maskSlot`
  via `BindingLayer.create`. The helper has no handles of its own — it's a
  normal `MaskLayer` (paint tools only).
- **`setMaskTracker`/`trackedShape`**: `MaskLayer.trackedShape` (added on
  `MaskLayer`) is unioned into its mask every `recompute()`, in addition to
  its painted layer and bound shape slots. `ClipRectLayer.markDirty()` is
  overridden to also call `this._maskTracker?.markDirty()`, so the helper's
  mask is re-derived from `this.getMask()` whenever the rectangle's geometry
  changes (one-frame lag, from the helper evaluating before its host in
  stack order). This link is independent of `isHiddenHelper`/`helperHost`,
  so it **persists even after the helper is exposed** — exposing it reveals
  a plain, paintable mask that keeps tracking ClipRect's handles.
- **Auto-bind**: `autoBindRules()` binds `imageSlot` to the nearest
  `Image`-producing layer below (the hidden helper is excluded from this
  search — see the `!l.isHiddenHelper` check in `applyDefaultBindings`).

`ClipEllipseLayer` (`src/layers/ClipEllipseLayer.ts`) and `ClipPathLayer`
(`src/layers/ClipPathLayer.ts`) follow the identical pattern, extending
`EllipseLayer` and `PathLayer` respectively — same `imageSlot`/`maskSlot`,
`setMaskTracker`/`trackedShape`/`markDirty` override, hidden plain-`MaskLayer`
helper wiring in `postInsertLayer`, and `autoBindRules()`. `ClipPathLayer`'s
`recompute()` calls `super.recompute()` which is `PathLayer`'s override
(applies `rotationSlot` to `_points`, then chains to `ShapeLayer.recompute()`)
— `getMask()`/`getImage()` are inherited unchanged from `ShapeLayer`, so the
clip-compositing step is identical to `ClipRectLayer`'s. `ClipPathLayer`'s
constructor passes `undefined` for `points` (uses `PathLayer`'s
`defaultPoints(cx, cy)` hexagon).

## TextLayer as a MaskSource (added June 2026)

`TextLayer` now declares `ValueType.Mask` in `types` and `implements
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

## TextLayer as an ImageSource (added June 2026)

`TextLayer` now also declares `ValueType.Image` in `types` and `implements
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

## ClipTextLayer (added June 2026)

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
other Clip\<Shape\> layers call `maskSlot` is therefore named **`clipMaskSlot`**
on `ClipTextLayer` to avoid colliding with it. `postInsertLayer` (`main.ts`)
has a separate `if (newLayer instanceof ClipTextLayer)` block (after the
shared `ClipRectLayer | ClipEllipseLayer | ClipPathLayer` block) that is
otherwise identical — plain hidden `MaskLayer` helper, `setMaskTracker`,
`BindingLayer.create(maskHelper, newLayer.clipMaskSlot)`.

## ClipDrawingLayer (added June 2026)

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
  Clip\<X\> layers.

## BackgroundLayer and the DeletionLayer toggle (added June 2026)

`src/layers/BackgroundLayer.ts` is a second "collection" alongside
`DeletionLayer`'s archive — a place for layers that must keep recomputing
(so downstream bindings stay live) but are never rendered on the main
canvas.

- **Not a stack member.** Unlike `DeletionLayer`, `BackgroundLayer` is never
  inserted into the layer stack — in edit mode, `Evaluator.render()` only
  evaluates layers from the current `renderTop` down to `root`, so a layer
  positioned above the selection would sometimes be skipped. Instead
  `Evaluator.setBackground(node)` stores it and `frame()` calls
  `this._background?.evaluate()` directly every frame, the same way `_clock`
  is ticked.
- **Self-perpetuating.** `recompute()` calls `.evaluate()` on each item in
  `_items`, then — while `_items.length > 0` — does
  `queueMicrotask(() => this.forceDirty())`, the same pattern `VideoLayer`
  uses for its frame loop. This keeps `BackgroundLayer` (and therefore its
  items) recomputing every frame even with no Clock and no dependents.
- **API**: `add(layer)` (removes from stack, pushes onto `_items`),
  `removeItem(layer)` (splices without re-inserting), `get items()`.

**DeletionLayer toggle** — `DeletionLayer.setBackgroundLayer(bg)` links the
two. A toggle button (`_toggleBounds`, top-right of the grid header, only
drawn when a `BackgroundLayer` is linked) flips `_showBackground` and swaps
the entire grid — header hint, thumbnails, trash buttons, double-click
restore — between `_archived` and `bg.items` via `_activeItems()` /
`_removeFromActive()`. Restore and purge use the same `_onRestore`/`_onPurge`
callbacks for both lists.

**`'b'` key** (`InteractionSystem.setBackgroundAction`) moves the selected
layer into `backgroundLayer`. Unlike the Delete-key archive flow, it does
**not** call `ensureDeletionLayerInStack()` — sending a layer to Background
must not by itself make `DeletionLayer` appear (see below). The layer to
select afterwards is `below ?? lowestAnchor()`.

`pruneDeletionLayerIfEmpty()` only checks `deletionLayer.archivedLayers` —
`DeletionLayer`'s presence in the stack (and thus its Background toggle)
tracks deletion count alone, regardless of what `backgroundLayer.items`
holds. Items in `BackgroundLayer` keep recomputing via
`Evaluator.setBackground()` either way; they're just not browsable via the
toggle while the archive is empty.

## NoiseLayer slider panel (updated June 2026)

`NoiseLayer`'s panel (`src/layers/NoiseLayer.ts`) now has one slider per row
for **scale**, **speed**, **warp**, and **drift** — FilterLayer-style (label +
track + thumb + value text + ●/○ bind indicator), replacing the previous
`[−]/[+]`/`[‹]/[›]` steppers. The panel grew from 2 rows (78px) to 5 rows
(161px): row 1 is unchanged (type cycler, seed, `time`/`pos` indicators); rows
2-5 are the new sliders. `MenuLayer`'s `BUTTONS` entry for `'Noise'` was
updated to `height: 161` to match.

- **scale** — a new manual fallback `_scale` (`[0,1]`, default ≈0.16) is
  introduced; previously frequency was a fixed `DEFAULT_FREQ` when
  `scaleSlot` was unbound. The slider maps `[0,1] → frequency [MIN_FREQ,
  MAX_FREQ]` (same mapping as the bound case) and displays the resolved
  frequency.
- **speed** / **warp** — sliders directly on `_speed`/`_detail` (`[0,1]`),
  displaying the value to 2 decimals.
- **drift** — slider `[0,1] ↔ angle [0, 2π)`, displaying degrees.

Dragging any slider while its slot is bound suspends that binding via
`BindingLayer.findForSlot(slot)?.toggle()` on first touch — the same
suspend-on-touch convention used elsewhere (`AmountLayer`, `FilterLayer`).
Slider fill colour is the Amount accent `#4a8fe8` (scale/speed/warp) or
Direction accent `#7ecfcf` (drift) when the slot is active, otherwise the
noise accent `#b8a050`. `NoiseLayer` gained `handlePointerMove`/
`handlePointerUp` (previously not implemented) to track slider drags via
`_sliderDrag`.

## CollectionLayer index slot (added June 2026)

`CollectionLayer` gained a `Count`-typed `indexSlot` (label "index"). When
bound and active (`indexSlot.isActive`), `recompute()` renders only
`_layers[selectedIndex()]` into `_compositeCanvas` instead of compositing all
ingested layers — so both `renderSelf` and `getImage()` (the `ImageSource`
output) become that single item.

`selectedIndex()` reads the bound `CountSource`'s count and wraps it modulo
`_layers.length` (`((raw % n) + n) % n`), so indices run 0..N-1 regardless of
the bound count's range or sign.

The header pill shows `#i of N layers` instead of `N layers` while indexed,
and the selected thumbnail in the grid gets a thicker `#a0a0a0` (Count accent)
border. `panelBottom` is now overridden to sit below the thumbnail grid
(previously the default `50 + bounds.height + 8` coincided with the grid's
top edge, so the new slot row would have overlapped it).

## FillLayer (renamed from GradientLayer, June 2026)

`src/layers/FillLayer.ts` (formerly `GradientLayer.ts`) is a procedural
fill/gradient `ImageSource`. The mode cycler (`[◀] <type> [▶]`) now has three
entries — `'fill' | 'linear' | 'radial'` — with `'fill'` as the default
(conic mode was removed):

- **fill** — the whole canvas is filled with `colourASlot`'s colour (and its
  own alpha). `colourBSlot`/`positionSlot`/`directionSlot` are ignored.
- **linear** / **radial** — unchanged geometry (linear spans the canvas
  diagonal at `directionSlot.angle`, centred on `positionSlot`; radial is
  concentric circles with radius `direction.magnitude × diagonal`). Stop
  colours now come from `_resolveStops()`:
  - both colour slots active → use them as-is (previous behaviour)
  - only one active → that colour at its own stop, fading to **fully
    transparent** (`a: 0`) at the other stop, instead of mixing in the
    unbound side's black/white default
  - neither active → falls back to `DEFAULT_COL_A` (black) /
    `DEFAULT_COL_B` (white)

**New `opacitySlot`** (`ValueType.Amount`, label "opacity") — overall
multiplier applied via `ctx.globalAlpha` in `_draw()`. Manual fallback
`_opacity` (default 1) with the same suspend-on-touch slider pattern as
`AmountLayer`/`NoiseLayer` (`BindingLayer.findForSlot(slot)?.toggle()` on
first touch). Rendered in its own pill directly below the main controls pill
(`_opacityPillBounds()`, `OPACITY_H = 36`), FilterLayer/NoiseLayer-style
track+thumb slider with a ●/○ bind indicator. `panelBottom` is overridden to
sit below this second pill.

### Auto-binding colours at creation time (added June 2026)

`postInsertLayer` (`main.ts`) has a `FillLayer` branch that searches down the
stack from the new layer for up to two `Colour`-producing layers: the first
found is bound to `colourASlot`, the second (if any) to `colourBSlot`. Mode
stays `'fill'` (the default), so `colourBSlot` is inert until the user
switches to a gradient mode — this is purely "wire up nearby colours in case
they're wanted later".

The colour-A/B swatches in the main pill now show fully transparent
(`TRANSPARENT = { r:0, g:0, b:0, a:0 }`) when their slot is unbound, instead
of the black/white `DEFAULT_COL_A`/`DEFAULT_COL_B` fallback used for the
actual fill/gradient rendering — so an unbound slot reads as "empty" rather
than implying a specific colour is in effect.

### Swap-colours button (added June 2026)

A `⇄` button (`_swapBtnBounds()`, `SWAP_W = 18`) sits between the two
colour swatches in the main pill. `_swapColours()` swaps the
`colourASlot`/`colourBSlot` bindings using the same find/remove/create
pattern as `CompositeLayer._swapLeftRight()` — any combination of
bound/unbound is handled. `_colourASlot`/`_colourBSlot` are now labelled
`'colour a'`/`'colour b'` (previously the default Colour-type label) so
their auto-generated slot rows in `renderSlots` read clearly now that there
are two of them.

## Mask-drop-on-image clipping shortcut (added June 2026)

Dragging a Mask-producing layer's card out of the `LayerStackWidget` and
dropping it onto a selected `ImageLayer`, `FillLayer`, `NoiseLayer`, or
`VideoLayer` (the set returned by `isClippableImageLayer()` in
`ClipLayer.ts`) wraps that layer in a `ClipLayer`:

- A new `ClipLayer` takes the target layer's stack position
  (`clip.bounds = {...target.bounds}`).
- `clip.imageSlot` is bound to the target layer, `clip.maskSlot` to the
  dropped mask layer (both via `BindingLayer.create`).
- Both the target layer and the dropped mask layer are moved to
  `backgroundLayer` — they keep recomputing (so the Clip's bindings stay
  live) but no longer clutter the stack, and remain recoverable via
  `DeletionLayer`'s Background toggle.
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
`maskLayer.firstShapeSlot` (a new public getter for `_shapeSlots[0]`, the
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

## PointLayer wander mode (added June 2026)

`PointLayer` (`src/layers/PointLayer.ts`) gained a self-perpetuating "wander"
simulation. Below the coordinate-readout pill, `renderSlots` draws two more
pills: a single-row pill for the main `slot` (Point) binding, then one
consolidated wander pill containing all wander-related controls and their
slot bindings together. `panelBottom` sits below this stack. The standard
per-slot grid from `Layer.renderSlots` is not used here — `PointLayer`
reimplements row rendering itself (`_renderSlotRow`, `_renderSliderRow`),
registering `_slotBounds` (now `protected` on `Layer`, was `private`) so
`hitTestSlot`/bind-drop still work for each row.

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
  detection in `recompute()` flips `_wanderEnabled` (same pattern as
  `RootLayer.toggleSlot`/`VideoLayer.enableSlot`), but only while the slot
  is `Bound` (`isActive`). The manual button (`_handleWanderToggle`,
  `_renderWanderToggleButton`), drawn at the right edge of this row
  (`_toggleBounds`, `BTN_SZ = row.height - 6 = 20`), departs from the usual
  Bound→suspend / SuspendedBound→resume / Unbound→flip convention: operating
  it manually hands *permanent* control to the user — `Bound` suspends the
  binding and flips `_wanderEnabled`; `SuspendedBound` and `Unbound` just
  flip `_wanderEnabled`. The button never resumes a suspended binding (that
  is the binding-inspector's enable toggle), so once the user has touched it
  the event source is permanently bypassed and the button behaves as a plain
  on/off switch.
- **Row 2 — `[◀] <algorithm> [▶]`** — cycles `WANDER_TYPES = ['drift',
  'brownian', 'orbit', 'wave']` via `cyclePrev`/`cycleNext`. No slot binding.
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
- **Row 3 — amount slider** (`_renderSliderRow`): randomisation strength
  `[0,1]`, fed into whichever algorithm is selected above. Shows the
  resolved value (manual `_amount`, default 0.4, or the bound
  `amountSlot`'s value), tinted with the Amount accent when `amountSlot` is
  bound. Dragging the slider suspends a bound `amountSlot` via
  `BindingLayer.findForSlot(slot)?.toggle()` (suspend-on-touch, as in
  `AmountLayer`/`NoiseLayer`/`FillLayer`).
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

**Self-perpetuation**: identical to `VideoLayer`'s frame loop —
`queueMicrotask(() => forceDirty())` at the end of `recompute()`, guarded by
`_wanderEnabled && !_slot.isActive && !this.outsideStack` (checked again
inside the microtask in case state changed before it runs).

While wandering, `_region.interactive = false` (the draggable handle is
driven by the simulation, not the pointer) — same as when the main Point
`slot` is bound.
