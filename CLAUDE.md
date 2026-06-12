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

`Layer.autoBindRules()` returns an array of `{ slot, accepts, removeAfterBind? }`
descriptors. `applyDefaultBindings(layer)` in `main.ts` walks down the stack
from the newly-added layer and binds the first non-infrastructure layer that
satisfies each `accepts` predicate.

Layers currently declaring rules:
- **MaskLayer** — binds first shape slot to nearest `Mask`-producing layer below
- **ClipLayer** — binds image slot to nearest `Image`; mask slot to nearest `Mask`;
  both with `removeAfterBind: true` (sources are archived after binding)
- **AnimPathLayer** — special-cased in `main.ts` (creates Clock/Rate if absent)

To add rules to a new layer, override `autoBindRules()` in the layer class.

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
| Drop lands on an Image-type slot of the current layer | New layer inserted below current layer, bound to that slot; current layer stays selected |
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
`removeAfterBind: true`.

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

## Known issues / pre-existing tech debt

- `npm run typecheck` reports ~80 `TS2352` cast warnings throughout the codebase
  (e.g. `slot.source as AmountSource`). These are pre-existing and do not affect
  runtime behaviour — Vite transpiles without type-checking.
- `PathLayer` has a private `_dragStartPtr` field that shadows the one in
  `ShapeLayer`, causing a TS2415 error. Pre-existing.
- `MaskLayer.resize()` from the original implementation is gone; canvas size
  changes are handled automatically via `Node.canvasWidth/Height`.
