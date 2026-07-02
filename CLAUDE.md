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
- `Node.pointerCanvas: Point | null` — live mouse position in canvas coordinates,
  maintained by `InteractionSystem` (set on pointermove/pointerdown, cleared on
  pointerleave). Lets any layer's `recompute()`/simulation read "where is the
  mouse right now" without prop plumbing.
- `Node.geometricMode: boolean` — global toggle between **geometric mode** (plain
  canvas primitives, graph-paper background, shapes forced to stroke) and **artistic
  mode** (torn-paper fills, brush strokes, Lichtenstein halftone). Toggled by the
  palette/shapes icon button in `MenuLayer`. Gate artistic rendering on
  `!Node.geometricMode`; gate geometric fallbacks on `Node.geometricMode`.
  Distinct from the per-shape `_filled` flag (filled vs. stroke boundary of an
  individual shape), which uses the local variable name `strokeMode` in
  `ShapeLayer` / `TraceLayer` render code.

Dirty propagation is **push** (marking dirty propagates to dependents immediately).
Evaluation is **pull** (lazy — `evaluate()` depth-first resolves dependencies before recomputing).

### Layer (`src/core/Layer.ts`)

Extends Node. Adds:
- Doubly-linked stack (`layerBelow`, `layerAbove`), plus `insertAbove(target)` /
  `insertBelow(target)` for inserting at a specific stack position
- `renderSelf(ctx)` — layer content, called for every layer in the stack
- `renderPanel(ctx)` — control UI, called **only for the selected layer**
- `renderSlots(ctx)` — parameter drop-target rows, called after renderPanel
- `renderOverlay(ctx)` — canvas-space handles/dials/paths, drawn **after** the
  StackWidget and without any clip, so they appear on top of thumbnails
- `hitTestSelf(point)` — override to respond to pointer events
- `panelBottom` — y-coordinate of the bottom of the panel strip; slot rows start here
- `thumbnailOnlyWhenSelected: boolean` — hides the layer's `LayerStackWidget` card
  unless it's the selected layer (used by `RootLayer`)
- `isHiddenHelper` / `helperHost` / `hiddenHelper` / `helperBelow` — see
  "Hidden helper layers" below

`renderSlots(ctx)` is just:
```ts
renderSlots(ctx: Ctx2D): void {
  if (this.slots.length === 0) return
  this._slotBounds.clear()
  this.renderSlotGroup(ctx, this.slots, this.panelBottom)
}
```
`protected renderSlotGroup(ctx, slots, y): number` draws one backdrop pill of
standard binding rows (label + drop-target box, Bound/SuspendedBound/Unbound/
compat states) for the given `slots`, registers each row in `_slotBounds`
(`protected`), and returns the pill's bottom y. Override `renderSlots`,
call `_slotBounds.clear()` once, then call `renderSlotGroup` once per pill to
stack more than one group of slot rows (e.g. `MaskLayer`'s shape-slot pill +
invert-toggle pill, or `PointLayer`'s reimplemented per-row layout).

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
7. Implement `renderSelf(ctx)` for canvas content, `renderPanel(ctx)` for the control strip,
   and `renderOverlay(ctx)` for canvas-space drag handles (see "renderOverlay" below)
8. Override `hitTestSelf` and add `handlePointerDown/Move/Up` if the layer is interactive
9. Add an entry to the `BUTTONS` array in `src/layers/MenuLayer.ts`. Set
   `selectAfterCreate: true` for any image-processing layer that uses
   `sendToBackgroundAfterBind` for its image input — when the source is sent
   to Background, the user must land on the new processor layer rather than
   the now-invisible source. All of Filter, Blend, Warp, Trail, Tile, Move,
   Rotate, Flash, Clip, and Choose follow this rule.
10. Export from `src/layers/index.ts`
11. Optional: override `autoBindRules()` to auto-bind slots on creation (see
    "Default binding rules" below)
12. Optional: add a branch to `postInsertLayer` in `main.ts` if the new layer
    needs extra creation-time wiring (hidden-helper masks, auto-bound
    Clock/Rate, eject callbacks, etc.)
13. Add an entry to the `LAYER_CLASSES` registry in
    `src/persistence/Persistence.ts` (factory function for save/load), and
    override `serializeState`/`deserializeState` for any manual fields that
    must survive a save — see "Persistence (save/load)" below.

## Layer panel conventions

Panels are drawn in the layer's `bounds` (a horizontal strip, typically `height: 36`).
Standard elements:
- Background pill: `rgba(0,0,0,0.45)`, `roundRect`
- Accent stripe: 4 px wide on the left, coloured by type
- Type accent colours: Amount `#4a8fe8`, Colour `#e8944a`, Image `#7ecf7e`,
  Mask `#cfcf7e`, Point `#cf7ecf`, Direction `#7ecfcf`, Rate `#e87e7e`,
  Event `#e0e060`, Count `#a0a0a0`
- Slot indicator dots (●/◐/○ for Bound/SuspendedBound/Unbound) drawn
  right-to-left before the reset button
- Reset button `[↺]` at far right: `x + width - 26, width: 20`

The canvas-space panel below the strip (slot rows) starts at `this.panelBottom`
(default: `50 + bounds.height + 8`) at `x: 300, width: 260`.

**IMPORTANT — canvas-space pill rule:** Fixed control pills (camera selector,
colour pickers, readout labels, etc.) **must** be drawn in a second pill at
`{ x: 300, y: 50, width: 260, height: bounds.height }` inside `renderPanel`,
*not* only in `this.bounds`. The Stack Widget covers roughly `x: 0–295`, so
controls drawn only in `this.bounds` will be hidden behind it. See `ShapeLayer`
and `VideoLayer` for the canonical two-pill `renderPanel` pattern.

**Drag handles** (move/scale/rotate circles, control-point dots, dials, splines)
go in `renderOverlay` instead — see "renderOverlay — canvas-space handles" below.

Toggle buttons for event slots (freeze/fill-mode/invert/etc.) go in `override
renderSlots` at `PANEL_X + PANEL_W - BTN_SZ - 3` in the corresponding slot row
(`BTN_SZ = row.height - 6`). Store bounds in a `_toggleBounds` field and check
it in `hitTestSelf` / `handlePointerDown`. See `ShapeLayer.renderSlots` for the
canonical pattern, and "Event-slot toggle buttons" below for the two button
behaviours.

**Strip pills vs. canvas-space**: strip pills (drawn at `this.bounds`, in the
widget column to the left of `contentLeft(canvasWidth)`) are clipped out by
`Evaluator.render()` whenever the StackWidget is visible, so they don't need
to worry about overlapping it — only canvas-space pills (`x ≥ contentLeft`)
are guaranteed visible. Press **h** to hide the widget (and the clip) for
development/inspection.

`src/interaction/layout.ts` is the source of truth for the widget/content
boundary: `stackWidgetWidth(canvasWidth)` (20% of canvas width, clamped to
`[120, 280]`) and `contentLeft(canvasWidth)` (`stackWidgetWidth + 20`). At the
original ~1400px desktop canvas this works out to the historical fixed values
(280px widget, `contentLeft` = 300). Only `LayerStackWidget`, `Evaluator`, and
`MenuLayer` use these helpers so far — most per-layer panels still hardcode
`x: 300, width: 260`, which is a known gap for full phone support.

## Conventions and recurring patterns

### Default binding rules (`autoBindRules`)

`Layer.autoBindRules()` returns `{ slot, accepts, sendToBackgroundAfterBind?
}[]`. `applyDefaultBindings(layer)` (`main.ts`) walks down the stack from a
newly-created layer and binds the first non-infrastructure, non-hidden-helper
layer that satisfies each `accepts` predicate. Override `autoBindRules()` to
add rules for a new layer type (call `...super.autoBindRules()` first if the
base class already declares some).

When `sendToBackgroundAfterBind` is set, the layer that was just auto-bound is
moved into `BackgroundLayer` (`backgroundLayer.add(l)`) instead of staying in
the stack: it keeps recomputing (so the binding stays live) but no longer
clutters the stack, and is recoverable via `DeletionLayer`'s Background
toggle. Hidden helper layers are unaffected — they stay in their fixed stack
position relative to their host regardless.

### Suspend-on-touch slot override

Many manual controls (sliders, colour pickers, transform handles) double as
the fallback for a `ParameterSlot`. Dragging the control while its slot is
`Bound` calls `BindingLayer.findForSlot(slot)?.toggle()` on first touch,
suspending the binding and handing control to the user at the current value.
This is the standard pattern for `AmountLayer`'s slider, `ColourLayer`'s
hue/SV picker, `NoiseLayer`/`FillLayer`/`PointLayer`'s sliders, and every
`rotationSlot`/transform-handle drag.

### Snap-and-refine handles (`AngleSnapper` / `ValueSnapper`)

`src/interaction/AngleSnapper.ts` provides two reusable helpers:

- **`AngleSnapper(snaps, threshold, dwellMs)`** — wraps-around angular values. Used for rotation handles.
- **`ValueSnapper(snaps, threshold, dwellMs)`** — linear 1-D values. Used for ShapeLayer's square/circle snap.

Both follow a four-phase cycle per drag:
1. **snap** — within `threshold` of a snap position → output held at that value; dwell timer starts.
2. **dwell** — pointer stays in the snap zone for `dwellMs` → a progress arc sweeps around the handle.
3. **refine** — dwell completes → input passes through freely; snap is disengaged until the next drag.
4. **free** — outside all zones → raw value; timer resets on re-entry.

**Visual convention**: while snapping the handle turns `'#7ecfcf'` (Direction accent / `ROT_SNAP_COL`)
and a clockwise arc sweeps around it. Call `snapper.reset()` on drag start so every drag begins fresh
in snap mode.

**Dwell timer pattern**: start a `setInterval(..., 16)` on first snap entry; feed the current snapped
value back into `update()` each tick to advance the arc while the pointer is still. Clear the timer
and zero `_snapSnapped`/`_snapProgress` in `handlePointerUp` via a dedicated `_clearXxxDwellTimer()`
method.

**Rotation snap** — `AngleSnapper` on the `○ rotate` handle of `ImageLayer`, `TextLayer`,
`StrokeLayer`, `TransformLayer`, and `ShapeLayer` (all subclasses via `_applySnapAngle`), plus
`DirectionLayer`'s dial and rotate handle. Eight snap positions every 45°, 15° threshold, 700 ms dwell.

**Square / circle snap** — `ValueSnapper([0], 20, 700)` on all eight resize handles of
`RectLayer` / `EllipseLayer` (via `ShapeLayer`). Operates on the difference `width − height`; fires
when the two dimensions are within 20 px of equal. When snapped: edge handles fix the changing
dimension to the other; corner handles snap both to their average (preserving the anchor-opposite-edge
invariant by recomputing `shiftX`/`shiftY` from the snapped sizes before the centre-shift step).

### Event-slot toggle buttons

Two conventions for a manual button beside an `Event`-typed slot that flips
an internal boolean on rising edge:
- **Standard** (`RootLayer.toggleSlot`, `VideoLayer.enableSlot`,
  `ColourLayer`'s sample toggle): `Bound` → suspend; `SuspendedBound` →
  resume; `Unbound` → flip. The button can hand control back and forth with
  the bound source.
- **Permanent override** (`MaskLayer`'s invert toggle, `PointLayer`'s wander
  toggle): `Bound` → suspend *and* flip; `SuspendedBound`/`Unbound` → flip
  only. Never auto-resumes — once touched, the event source is permanently
  bypassed and the button behaves as a plain on/off switch.

### Self-perpetuating recompute

A layer that needs to keep recomputing every frame without a `Clock`
dependency calls `queueMicrotask(() => this.forceDirty())` at the end of
`recompute()`, guarded by a liveness condition (e.g. `!this.outsideStack`).
The microtask fires after `evaluate()` clears `_dirty`, so the next rAF finds
the node dirty again. Used by `VideoLayer`'s camera frame loop,
`BackgroundLayer`, and `PointLayer`'s wander simulation.

### Hidden helper layers

A **hidden helper** is a normal stack member — evaluated every frame in stack
order — but invisible: no `LayerStackWidget` thumbnail, and
`renderSelf`/panel/haze are skipped in the Evaluator's edit-mode loop.

- `isHiddenHelper` (set on the helper) / `helperHost` (helper → host) /
  `hiddenHelper` (host → helper) / `helperBelow` (host: keep the helper
  directly *below* it instead of above).
- `LayerStackWidget._reorderLiveStack` (shared by `moveUp`/`moveDown`/drag-drop)
  re-inserts `host.hiddenHelper` directly above/below `host` after every
  reorder, so the pair always travels together.
- **Exposure**: clicking a bound slot whose source `isHiddenHelper` clears the
  helper flags on both sides and gives the source a normal thumbnail/position
  before `refreshStack`. This is generic — it fires for *any* hidden helper
  bound to a clicked slot.
- Examples: the auto-created `RateLayer` for a new `AnimPathLayer`'s
  `phaseSlot` (its source `ClockLayer` goes straight to `BackgroundLayer`,
  never into the stack); the mask-tracker `MaskLayer` below each
  `Clip<Shape>` layer (next section).

### `Clip<Shape>` layer family

`ClipRectLayer`, `ClipEllipseLayer`, `ClipPathLayer`, `ClipTextLayer`, and
`ClipDrawingLayer` extend `RectLayer`/`EllipseLayer`/`PathLayer`/`TextLayer`/
`MaskLayer` directly (geometry and handles unchanged) and add an `imageSlot`
(Image) plus a mask-tracker slot (`maskSlot`, or `clipMaskSlot` on
`ClipTextLayer` since `TextLayer` already has its own `maskSlot`).
`recompute()` calls `super.recompute()`, then composites `imageSlot`'s image
through `this.getMask()` via `source-over` + `destination-in` into an
offscreen canvas that `renderSelf`/`getImage()` use.

`ClipDrawingLayer` extends `MaskLayer`, whose `renderSlots` only renders its
own private shape slots and invert slot (not the full `this.slots[]` array).
`ClipDrawingLayer` therefore overrides `renderSlots`: calls `super.renderSlots`,
scans `_slotBounds.values()` to find the bottom of the last rendered row, then
calls `renderSlotGroup` once more to append a third pill for `imageSlot` and
`maskSlot`. Any future `MaskLayer` subclass that adds slots to `this.slots[]`
must do the same — the base `renderSlots` will not pick them up automatically.

`postInsertLayer` (`main.ts`) inserts a plain hidden `MaskLayer` directly
**below** the new layer (`helperBelow = true`), links it via
`setMaskTracker`/`trackedShape` (unioned into the host's mask every
`recompute`, kept in sync via a `markDirty` override that also calls
`_maskTracker?.markDirty()`), and binds it to the mask-tracker slot — later
exposable via the hidden-helper click gesture above. `autoBindRules()` binds
`imageSlot` to the nearest `Image` below (excluding hidden helpers).

### renderOverlay — canvas-space handles

`Layer.renderOverlay(ctx)` is called after `renderSlots` and after the
StackWidget renders, with **no clip rect**. This makes handles visible anywhere
on the canvas, including over the StackWidget thumbnail strip. Clicks on
handles in the widget-strip area are intercepted by `InteractionSystem` before
the widget sees them.

Layers that use `renderOverlay`: `ImageLayer`, `ClipLayer`, `TextLayer`,
`StrokeLayer`, `VideoLayer`, `MediaLayer`, `TransformLayer`, `ShapeLayer`
(and its subclasses `PathLayer`), `LineLayer`, `PointLayer`, `DirectionLayer`,
`AnimationPathLayer`, `TraceLayer`, `SelectLayer`.

**Rule**: any canvas-space handle, dial, spline, or interactive overlay goes in
`renderOverlay`; the panel-pill background (fixed at `canvasBounds`) stays in
`renderPanel`. Never draw drag handles in `renderPanel` — they would be clipped
to the content area when the StackWidget is visible.

`ImageLayer`, `ClipLayer`, `TextLayer`, and `StrokeLayer` have move/scale/rotate
handles — never in `renderSelf`, which is composited for every layer and in
display mode. All four, plus the `ShapeLayer` family (`RectLayer`/`EllipseLayer`/
`PathLayer`, via their `H_ROTATE` handle), also have a `rotationSlot`
(Direction): when active it overwrites `_rotation`/`_angle` each `recompute()`;
dragging the rotate handle while the slot is `Bound` suspends it first
(suspend-on-touch); the handle dims when the slot is active.

### Right-click binding inspector / drag-to-replace

Dragging a compatible source onto an already-bound slot shows the same green
"replace binding" highlight as an empty slot; `BindingLayer.create` removes
the old `BindingLayer` first. Right-click on a bound slot of the selected
layer opens a floating HTML panel (binding description, enable/disable
toggle, delete) via `InteractionSystem`'s `contextmenu` handler —
`setRefreshCallback()` wires `refreshStack()` so deletes update the stack
widget. `_handleDown` guards `if (e.button !== 0) return` so right-clicks
don't also trigger pixel-pick. `BindingLayer` exposes `get slot()`, `get
source()`, and `static findForSlot(slot)` (scans `graph.nodes`).

### `assignDebugName` and slot click-to-create/select

`Layer.assignDebugName(layer)` (static) assigns a friendly `"<Type> <n>"`
debug name (class name with trailing `Layer` stripped + a per-type running
counter) — call this at every layer-creation site so names stay unique.

Clicking a parameter-slot row of the selected layer (checked in
`InteractionSystem._handleDown` via `setSlotClickCallback`, before
pixel-pick):
- **Empty slot** — looks up the slot's type in `DEFAULT_VALUE_LAYER`
  (`main.ts`), constructs the canonical default layer for that type (e.g.
  `AmountLayer(0.5)`, `ColourLayer(...)`, `PointLayer(centre)`), inserts it
  above the consumer, binds it, and selects it.
- **Bound slot** — selects the layer feeding it, restoring it from
  `DeletionLayer`'s archive first if it's currently archived.

### Pixel-pick layer selection

Clicking an empty area of the canvas (no hit on the current layer's controls)
triggers `InteractionSystem._pickLayerAtPixel()`: it walks the stack
top-to-bottom, renders each non-infrastructure layer to a single shared
`OffscreenCanvas`, reads the alpha of the clicked pixel, and selects the first
layer with alpha > 10. Set `readonly blockPixelPick = true` on a layer to
suppress this while it's selected — used by paint/draw tools (`MaskLayer`,
`StrokeLayer`) and full-canvas modal layers (`StartupLayer`, `TutorialLayer`).

### OS file drag-and-drop

Dropping an image file from the OS onto the canvas always **creates a new
`ImageLayer`**. Placement rules (in `main.ts`):

| Context | Result |
|---|---|
| MenuLayer is selected | New layer inserted below MenuLayer |
| Drop lands on an Image-type slot of the current layer, or the current layer has an empty Image slot | New layer inserted below current layer, bound to that slot; current layer stays selected |
| Anything else | New layer inserted above current layer, becomes selected |

The `dragover` handler just sets `dropEffect = 'copy'`; no existing layer state is modified.

### `postInsertLayer` (main.ts)

All per-type setup that runs after a new layer is inserted — auto-binding
(`applyDefaultBindings`), hidden-helper wiring, AnimPath Clock/Rate creation,
CollectionLayer eject callbacks, TutorialLayer wiring, etc. — lives in
`postInsertLayer(newLayer)`. Every creation path (MenuLayer's `onAdded`,
`wireTutorialLayer`, OS file drop, the mask-drop clipping shortcut) calls it,
so layers behave identically regardless of how they were created. The caller
is responsible for calling `refreshStack` afterwards.

## Infrastructure layers

These exist exactly once (or are deferred until needed) and sit outside the
normal "user adds a layer from the menu" flow.

### `ClockLayer` singleton

One instance, created in `main.ts` at startup: `clock.outsideStack = true`,
`root.setClock(clock)`, `evaluator.setClock(clock)` (`_continuous` is
permanently `true` from startup). Ticked every frame by `Evaluator.frame()`
regardless of stack membership; registered in the `Graph` via its
constructor. Not user-creatable (no Menu button) — it's the only `ClockLayer`
that should ever exist.

`RootLayer.clockSlot` (Amount) is a *nominal* binding to the singleton (a raw
`ParameterSlot.bind()`, not a `BindingLayer` — no inspector/remove button).
Clicking that slot row inserts the singleton above Root and selects it.
`RootLayer.renderPanel` draws a clock-dial readout while Root is selected.
Every new `RateLayer`'s `timeSlot` is auto-bound to this singleton via
`bindRateClock()` (in `postInsertLayer`, the slot-click default-value path,
and `ensurePhaseSource`'s hidden-helper Rate).

### `DeletionLayer`

Not inserted into the stack at startup. `ensureDeletionLayerInStack()` adds it
(above `root`) before the first archive; `pruneDeletionLayerIfEmpty()` removes
it again once the archive is empty (checked after restore/purge/slot-restore).
`lowestAnchor()` returns it when present, else `root` — used as the fallback
insertion point for drag-drop.

Archived layers render as **live thumbnails** (same rendering as
`LayerStackWidget`, via `src/interaction/thumbnail.ts`), each with a red `×`
purge button. Purge snapshots `layer.dependents`, finds any `BindingLayer`
consumers, and calls `bl.remove()` on each. Double-click restores.

`setBackgroundLayer(bg)` links a `BackgroundLayer` (below) — a toggle button
swaps the entire grid (header, thumbnails, restore/purge) between the archive
and `bg.items`. Pressing **b** (`InteractionSystem.setBackgroundAction`) sends
the selected layer to `BackgroundLayer` directly and does **not** call
`ensureDeletionLayerInStack()` — sending something to Background must not by
itself make `DeletionLayer` appear. `pruneDeletionLayerIfEmpty()` only checks
the archive length, independent of `BackgroundLayer`'s contents.

### `BackgroundLayer`

Off-stack collection (`src/layers/BackgroundLayer.ts`) for layers that must
keep recomputing — so downstream bindings stay live — but are never rendered.
Never inserted into the stack; `Evaluator.setBackground(node)` evaluates it
directly every frame (same as `_clock`). Self-perpetuating (see above): while
`_items.length > 0`, `recompute()` evaluates each item then
`queueMicrotask(() => this.forceDirty())`. API: `add(layer)` (removes from
stack, pushes), `removeItem(layer)`, `get items()`.

Populated by `sendToBackgroundAfterBind`, the **b** key, and the
mask-drop-on-image clipping shortcut (dragging a Mask-producing layer's card
from the `LayerStackWidget` onto a selected `ImageLayer`/`FillLayer`/
`NoiseLayer`/`VideoLayer` wraps it in a `ClipLayer` and sends both the target
and the mask source to `BackgroundLayer`).

## Key files

| Path | Purpose |
|---|---|
| `src/app/main.ts` | Entry point — canvas setup, initial stack, event wiring, `postInsertLayer`, `applyDefaultBindings` |
| `src/core/types.ts` | ValueType enum, value types, source interfaces, BoundingBox |
| `src/core/Node.ts` | Base class — dirty, dependents, evaluate, statics |
| `src/core/Layer.ts` | Stack links, rendering, hit testing, slot rendering, `autoBindRules` |
| `src/core/ParameterSlot.ts` | Typed inputs — Bound/Unbound/SuspendedBound |
| `src/dataflow/Evaluator.ts` | rAF loop, render pipeline, resize, background/clock ticking |
| `src/dataflow/Graph.ts` | Cycle detection, bind validation |
| `src/interaction/InteractionSystem.ts` | Pointer routing, keyboard, bind-drag, pixel-pick selection |
| `src/interaction/LayerStackWidget.ts` | Thumbnail strip, layer selection, reorder |
| `src/interaction/thumbnail.ts` | Shared thumbnail rendering utility (used by widget and DeletionLayer) |
| `src/interaction/layout.ts` | `contentLeft`/`stackWidgetWidth` — widget/content boundary |
| `src/interaction/AngleSnapper.ts` | `AngleSnapper` and `ValueSnapper` — reusable snap-and-refine helpers for handles |
| `src/layers/MaskLayer.ts` | Composite mask: shape slots + freehand paint/erase |
| `src/layers/ShapeLayer.ts` | Abstract shape base — produces Point + Mask |
| `src/layers/CompositeLayer.ts` | Blends two images with optional Mask input |
| `src/layers/TileLayer.ts` | Tile or fit an image's content bbox to cover the canvas |
| `src/layers/BackgroundLayer.ts` | Off-stack collection for layers that must keep recomputing |
| `src/layers/ClockLayer.ts` | Singleton time source, `outsideStack` but ticked every frame |
| `src/layers/FilterGL.ts` | Shared WebGL pipeline singleton for `FilterLayer` |
| `src/layers/MotionBlurLayer.ts` | Temporal image accumulation / motion trails |
| `src/persistence/Persistence.ts` | Save/load — `LAYER_CLASSES` registry, serialize/deserialize |
| `spec/architecture.md` | Detailed architecture specification |
| `spec/feature-log.md` | Per-feature implementation notes (historical reference) |

## Persistence (save/load)

`src/persistence/Persistence.ts` serializes the whole session (main stack,
hidden helpers, `BackgroundLayer` items, `DeletionLayer` archive,
`CollectionLayer` ingested items, and every `ParameterSlot` binding) to a
single JSON document, and reconstructs it on load via the `LAYER_CLASSES`
registry.

**Any change that adds, renames, or removes a layer class, or adds/changes a
manually-set field that isn't fully derived from slot inputs in
`recompute()`, must be reflected here too**:

- New layer class → add it to `LAYER_CLASSES` (factory function).
- New manual field (slider value, mode flag, geometry, painted raster, etc.)
  → add it to that layer's `serializeState()`/`deserializeState()` (override
  `Node.serializeState`/`deserializeState` — defaults are no-ops). Only
  manual/fallback state needs persisting; fields fully recomputed from slot
  sources every frame don't.
- New cross-references that aren't plain `ParameterSlot` bindings (like
  `CollectionLayer._layers` or mask-tracker links) need their own id-resolution
  step in `serialize()`/`deserialize()` — see the `itemIds` /
  `setMaskTracker` handling for the existing patterns.
- After any such change, run `npm run typecheck` (baseline is the
  pre-existing ~451-line warning count — new errors should be 0) and do a
  manual save → reload → load round-trip of a stack using the new/changed
  layer.

### `MotionBlurLayer`

Temporal accumulation layer that maintains a persistent cache canvas. On each
update tick (gated by the `delay` slider, log-scaled), it fades the cache by
`fade` and composites the current `imageSlot` input over it. Slots:
- `imageSlot` (Image) — source; auto-bound at creation, source sent to Background
- `fadeSlot` (Amount) — `0` = full accumulation (old frames never cleared);
  `1` = instant clear (only latest frame visible). Slider suspends on touch.
- `delaySlot` (Amount) — `0` = update every frame; `1` = frozen; log-scaled
  so `0.5` ≈ every 10 frames. Slider suspends on touch.

### `LineLayer` — produces `Image` and `Mask`

`LineLayer` renders into a private `_canvas: OffscreenCanvas` and declares
`ValueType.Image` / `ValueType.Mask`. A second `_maskCanvas` is maintained in
parallel: rendered in opaque white with the same geometry (stroke width,
arrowheads), so the mask covers exactly the visible line pixels rather than a
filled interior. A **Mask** convenience button is wired via `wireLineMaskButton`
in `postInsertLayer`.

### `TransformLayer` — reflect (mirror)

A **reflect** toggle pill sits below the opacity pill. The `↔` button mirrors the transformed
output through a reflection axis (left-right flip by default). An optional `reflectSlot`
(Direction) sets the axis angle: `dirAngle = 0` → `axisAngle = π/2` → left-right flip; any
other direction rotates the axis accordingly. When the slot is first bound, reflect is
auto-enabled; pressing `↔` while the slot is bound suspends the binding.

### `MaskLayer` / `ClipDrawingLayer` — paint-mode slot interaction

In idle mode (`_activeTool === null`), `MaskLayer.hitTestSelf` returns `null`
for any click on a slot row, deferring it to the slot-click / binding-inspector
logic in `InteractionSystem`. In paint or erase mode, this deferral is skipped:
`hitTestSelf` returns `this`, and `handlePointerDown` starts a brush stroke.
This lets the user paint anywhere on the canvas — including over the slot-row
pills — without needing to switch off the tool first.

Right-click on a slot row still opens the binding inspector in all modes,
because `InteractionSystem._onContext` calls `selected.hitTestSlot()` directly
and never goes through `hitTestSelf`. `ClipDrawingLayer` inherits this
behaviour from `MaskLayer`.

### `StrokeLayer` — open Catmull-Rom spline

`StrokeLayer extends PathLayer` as a **non-closed** (`_closedPath = false`) spline.
Key differences from `PathLayer`:

- **Freehand drawing**: pointer-down/move collects raw points; pointer-up applies
  Ramer-Douglas-Peucker simplification (ε=8px) to produce sparse Catmull-Rom
  control points, then exits draw mode.
- **Control-point editing**: after the first draw, handles work exactly like
  `PathLayer` (drag to move, click curve to insert, right-click to remove).
- **startSlot / endSlot** (Point) — pin the first/last control point to a
  `PointLayer` source.
- **Arc-length `samplePerimeter`** — builds a 200-sample lookup table so
  `AnimPath` travels at uniform speed along the open stroke.
- **Auto-closure**: when endpoints come within `CLOSE_THRESHOLD = 20px`, the
  duplicate endpoint is popped and `setOnClose` callback fires. `postInsertLayer`
  wires this to archive the `StrokeLayer` and insert a plain `PathLayer` carrying
  the same visual state via `applyStateSnapshot`.
- **Mask is stroke region** — overrides `_maskFilled()` to return `false`, so the
  ShapeLayer mask canvas is rendered in stroke mode (round cap/join, stroke width)
  matching the visible stroke.
- **Mask / Animate convenience buttons** — inherited from ShapeLayer via PathLayer.
  `blockPixelPick = true` while in draw mode.

`PathLayer` was extended to support StrokeLayer and future open-spline subclasses:
- `protected _closedPath = true` — set to `false` by StrokeLayer.
- `export function samplePathOpen(points, t, r)` — open-spline variant of `samplePath` with phantom-clamping at boundaries.
- `protected get _minPoints(): number` — PathLayer returns 3; StrokeLayer overrides to 2.
- `protected _onHandleDragStart(): void {}` — hook called before any canvas-space handle drag; StrokeLayer overrides to suspend `startSlot`/`endSlot`.
- `applyStateSnapshot(snap)` — copies visual state (colour, opacity, scale, radius, strokeWidth, filled) from a `StrokeStateSnapshot`; used during StrokeLayer → PathLayer conversion.

### `ShapeLayer` — `_maskFilled()` hook

`protected _maskFilled(): boolean { return true }` controls whether
`_updateOffscreens()` renders the mask canvas in fill mode (default) or stroke
mode. `StrokeLayer` overrides to `false` so the mask matches the visible stroke
band rather than the filled interior. Override this in any future ShapeLayer
subclass that renders as a stroke rather than a filled shape.

### Mask convenience buttons — TextLayer and LineLayer

`TextLayer` and `LineLayer` have **Mask** convenience buttons (same visual style
as `ShapeLayer`'s, using `Mask` accent `#cfcf7e`). Because they don't extend
`ShapeLayer`, the button is implemented inline in each layer:
- Fields: `_addMaskDone`, `_onAddMask`, `setOnAddMask(fn)`
- Rendering: `_renderMaskBtn(ctx)` called from `renderOverlay` — draws only when
  `_onAddMask !== null` and `!_addMaskDone`
- Hit testing / pointer handling added to `hitTestSelf` / `handlePointerDown`
- `addMaskDone` persisted in `serializeState`/`deserializeState`

Wiring: `wireTextMaskButton` / `wireLineMaskButton` in `main.ts`, called from
`postInsertLayer` and the `applyLoadedSession` scan loop (same pattern as
`wireMaskButton` for `ShapeLayer`).

### Slot label convention

All `ParameterSlot` constructors should use a descriptive label string (third
argument), not the default `'amount'`. Slots updated this session: TextLayer
`scaleSlot` → `'scale'`; DirectionLayer `_magnitudeSlot` → `'magnitude'`;
CompositeLayer `_opacitySlot` → `'opacity'`; AnimationPathLayer `_posSlot` →
`'position'`; RateLayer `_timeSlot` → `'time'`; SequencerLayer `_rateSlot` →
`'rate'`; MathLayer `_slotA` → `'a'`, `_slotB` → `'b'`.

### `FilterLayer` — `gradient-map` filter

The `gradient-map` filter has a bidirectional control: `t = 0.5` is
pass-through (no effect); `t < 0.5` blends towards a chrome palette (cool
gunmetal → cold steel → silver → icy white); `t > 0.5` blends towards a neon
palette (deep purple → hot pink → neon lime → electric yellow). Both the CPU
fallback (`FilterLayer.ts`) and the WebGL path (`FilterGL.ts`) use identical
palettes and blend logic.

## Known issues / pre-existing tech debt

- `npm run typecheck` reports ~80 `TS2352` cast warnings throughout the codebase
  (e.g. `slot.source as AmountSource`). These are pre-existing and do not affect
  runtime behaviour — Vite transpiles without type-checking.
- `PathLayer` has a private `_dragStartPtr` field that shadows the one in
  `ShapeLayer`, causing a TS2415 error. Pre-existing.
- `MaskLayer.resize()` from the original implementation is gone; canvas size
  changes are handled automatically via `Node.canvasWidth/Height`.
