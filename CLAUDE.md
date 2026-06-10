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

## Known issues / pre-existing tech debt

- `npm run typecheck` reports ~80 `TS2352` cast warnings throughout the codebase
  (e.g. `slot.source as AmountSource`). These are pre-existing and do not affect
  runtime behaviour — Vite transpiles without type-checking.
- `PathLayer` has a private `_dragStartPtr` field that shadows the one in
  `ShapeLayer`, causing a TS2415 error. Pre-existing.
- `MaskLayer.resize()` from the original implementation is gone; canvas size
  changes are handled automatically via `Node.canvasWidth/Height`.
