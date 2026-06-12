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

## Known issues / pre-existing tech debt

- `npm run typecheck` reports ~80 `TS2352` cast warnings throughout the codebase
  (e.g. `slot.source as AmountSource`). These are pre-existing and do not affect
  runtime behaviour — Vite transpiles without type-checking.
- `PathLayer` has a private `_dragStartPtr` field that shadows the one in
  `ShapeLayer`, causing a TS2415 error. Pre-existing.
- `MaskLayer.resize()` from the original implementation is gone; canvas size
  changes are handled automatically via `Node.canvasWidth/Height`.
