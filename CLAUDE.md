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

Eleven types in the `ValueType` enum:
`Image`, `Mask`, `Colour`, `Amount`, `Point`, `Direction`, `Rate`, `Count`, `Event`, `Collection`, `Audio`

Each has a corresponding `*Source` interface (`AmountSource`, `MaskSource`, etc.).
Layers that produce a type implement the interface; consumers cast `slot.source`
to the interface to read the value. This is structural subtyping — no shared
base interface required.

`Audio` is deliberately a thin handle rather than an interpreted signal:
`AudioValue = AnalyserNode | null`, and `AudioSource.getAudio()` just returns
the raw Web Audio node (same shape as `MaskValue`/`MaskSource` exposing an
`OffscreenCanvas`). Consumers pull samples from it themselves every frame
(`getByteTimeDomainData`/`getByteFrequencyData`) and do their own analysis —
see `VideoLayer`'s audio tap and `EventLayer`/`TempoLayer`'s audio modes
below. Three separate `Partial<Record<ValueType, string>>` maps duplicate the
per-type accent colour/label (`Layer.ts`'s `SLOT_TC`, `BindingLayer.ts`'s
`TYPE_COLOUR`, `ParameterSlot.ts`'s `_defaultLabel`) — there is no single
source of truth, so a new `ValueType` needs an entry added to all three.

### Node (`src/core/Node.ts`)

Abstract base. Key statics:
- `Node.scheduleFrame` — set by Evaluator; calling it requests a render frame
- `Node.bindDrag` — shared drag state for the bind-drag overlay
- `Node.canvasWidth / canvasHeight` — updated by Evaluator on construction and resize; use these when sizing full-canvas OffscreenCanvases
- `Node.pointerCanvas: Point | null` — live mouse position in canvas coordinates,
  maintained by `InteractionSystem` (set on pointermove/pointerdown, cleared on
  pointerleave). Lets any layer's `recompute()`/simulation read "where is the
  mouse right now" without prop plumbing.
- `Node.shiftKey: boolean` — live Shift-key state, maintained by
  `InteractionSystem` (keydown/keyup on `Shift`, plus a `window.blur` fallback
  so it can't get stuck `true` after an alt-tab). Lets any layer implement the
  standard "hold Shift to constrain a drag to horizontal/vertical" convention
  by reading it inside `handlePointerMove` — no changes to the
  `handlePointerDown/Move/Up` signatures needed. Used by `MaskLayer`'s brush
  stroke (`_moveConstrained`), which also adds a polyline-style pivot: moving
  substantially perpendicular to the current constrained line (more than a
  brush-scaled threshold) plants a corner and continues as a new segment
  locked to the perpendicular axis, rather than jumping/re-snapping through
  the original anchor.
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
  Event `#e0e060`, Count `#a0a0a0`, Collection `#a0a4b8`, Audio `#a87ee8`
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

### ArrowLeft/Right — AmountLayer keyboard nudge

`AmountLayer.adjustValue(dir: 1 | -1)` nudges the slider by `ARROW_STEP`
(0.02), suspending any active slot first (same suspend-on-touch convention
as dragging the slider). Wired from `LayerStackWidget.handleKey` — checked
*after* the existing `handlePageNavKey` claim (e.g. `TutorialLayer`'s page
nav) so an established ArrowLeft/Right binding still wins — via
`_findAmountTarget(displayMode)`:
- If the currently selected layer **is** the `AmountLayer`, that's always
  the target, in either mode.
- Otherwise, only in **display mode** (no other layer to explicitly select
  there), it searches down the stack from the selection
  (`layerBelow`, skipping `isInfrastructure`/`isHiddenHelper`) for the first
  `AmountLayer` and nudges that instead.
- In edit mode, no downward search — arrow keys are left free for whatever
  other layer is currently selected (handle-nudging, etc.) unless that
  layer itself is the `AmountLayer`.

`InteractionSystem` passes `displayMode` into `handleKey` for exactly this;
ArrowLeft/Right otherwise needs no edit-mode switch first, same reasoning
as plain ArrowUp/ArrowDown (layer navigation) already documented at that
call site.

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

### Feedback slots — permitting a well-defined cycle

`ParameterSlot`'s 4th constructor arg (`feedback: boolean`, default `false`)
marks a slot whose binding is allowed to close a cycle in the dependency
graph. Two effects, both in `Node.ts`/`Graph.ts`:

- `Node.evaluate()` skips feedback slots in its eager "pull dependencies
  first" walk (`if (slot.isActive && !slot.feedback) slot.source!.evaluate()`),
  so the consumer reads whatever value the source last computed (on its own
  schedule elsewhere in the tree — stack position or `BackgroundLayer`) rather
  than forcing a fresh, potentially re-entrant evaluation. This is what
  prevents infinite recursion in `evaluate()` once a cycle exists.
- `Graph.bind()` skips the reachability/cycle check entirely for feedback
  slots (self-binding is still always rejected). This matters because the
  check only ever looks at *existing* regular edges — marking a slot
  `feedback` doesn't help if the other edges in the loop were bound first and
  already make the source reachable, so the exemption has to apply at bind
  time, not just to future BFS walks past an edge that's already there.
- `Node.forceDirty()` (used by self-perpetuating layers, see below) forces
  only `this`; propagation to dependents goes through the guarded
  `markDirty()` (`if (this._dirty) return`), not another `forceDirty()` — so
  a cyclic dependent graph can't recurse forever there either.

**Gotcha — don't "fix" a passive read by forcing it, when *both* sides of
the edge read each other.** `MaskLayer.clipRegionSlot` and the host's
`maskSlot`/`clipMaskSlot` (see `Clip<Shape>` layer family below) are
*mutually* feedback — both sides read the other's value passively
(`slot.source.getMask()`, never `slot.source!.evaluate()`) for real,
value-affecting output, not just to dodge a structural bind-time cycle. Two
tempting "fixes" both break this, for related but distinct reasons:

- **Forcing one side's read** (`slot.source!.evaluate()` before reading)
  reintroduces exactly the infinite recursion `feedback` exists to prevent,
  *if* the slot on the other end of the same two-node pair is an ordinary
  (non-feedback) slot — `Node.evaluate()`'s eager pull runs over every
  active non-feedback slot unconditionally, regardless of whether
  `recompute()` reads it, so a forced pull on one side can re-enter the
  other's `evaluate()` while it's still mid-`recompute()` (`_dirty` not
  yet cleared) → recomputes again → forces again → stack overflow. (This
  really happened here — worth internalizing why: whenever a manual
  `source!.evaluate()` pull is added for one feedback edge, every *other*
  binding between the same two nodes must also be feedback, or the eager
  pull reopens the recursion regardless of which edge you reasoned was
  safe.)
- Even granting both slots are feedback so the forced pull *terminates*
  safely, it's still wrong for a **true mutual dependency**: the forced side
  ends up recomputing *while the node it just forced is still mid-`recompute()`*,
  reading that node's output *before* it's finished being written this
  frame (e.g. `MaskLayer.recompute()` clears its canvas, draws paint/shape
  slots, *then* would force-pull the host — if the host's own `recompute()`
  reads the helper's mask back at that exact moment, it gets a
  half-composited canvas, missing content the helper hasn't drawn yet).
  This corrupted live-drag preview accuracy specifically (moving the shape
  didn't track correctly) even though it didn't crash.

The correct fix for a true mutual/one-directional-per-frame dependency,
matching the framework's own feedback-slot philosophy: leave **both** reads
fully passive (each just reads `slot.source.getMask()`, no forced
`evaluate()` anywhere), and accept up to ~1 frame of lag on each side — self-
correcting continuously via the ordinary dirty propagation each side already
registers on the other (both slots being feedback), imperceptible during a
live interaction. The one gap this leaves is a **brand-new pair where
neither side has ever evaluated** — passive reads alone would settle
permanently on a blank/wrong result with nothing left to mark either side
dirty again. Solve *that* narrow case once, explicitly, at the moment the
pair is created — see `settleMaskTrackerPair` (`MaskLayer.ts`) below — not
by forcing evaluation from inside `recompute()` at all.

Canonical use: `FlashLayer.triggerSlot` (Event, feedback) lets a flash's own
implied repetition tempo (see next section) drive a repeating `EventLayer`
that retriggers the same flash — `Flash → TempoLayer.rateSlot → TempoLayer
(phase) → EventLayer.rateSlot → EventLayer (event) → Flash.triggerSlot`. The
flash's *output* (`getRate()`) only depends on its `lengthSlot`, never on
whether it's currently flashing, so the loop is value-safe; the feedback flag
just gives it a well-defined one-frame delay instead of infinite recursion.
`EventLayer`'s `imageASlot`/`imageBSlot` are the original feedback-slot
precedent (collision detection feeding back into the images being watched).

### Rate → phase adapter (`tryBindRateIntoPhase`) and `adapterCompatible`

`AnimPathLayer.phaseSlot` and `RotateLayer.phaseSlot` are `Amount`-typed
(a cycling `[0,1)` phase, not a raw Hz value) but every new instance already
gets an auto-created hidden `TempoLayer` bound there (`createHiddenRate` /
`ensurePhaseSource` in `main.ts`) — so a `Rate`-only source (e.g.
`FlashLayer`, via its tempo-from-length output) can't bind to `phaseSlot`
directly, but there's almost always a `TempoLayer` already sitting there to
redirect into.

- `TempoLayer` has a `rateSlot` (`Rate`) that overrides its internal Hz
  slider when bound (suspend-on-touch, like any other manual/slot pair).
- `interaction.setBoundCallback` in `main.ts` calls
  `tryBindRateIntoPhase(source, slot)` before the normal
  `BindingLayer.create`: if the drop target is a `phaseSlot` and the source
  produces `Rate` but not `Amount`, it finds (or creates via
  `createHiddenRate`) the hidden `TempoLayer` driving that phase and binds
  the source into *its* `rateSlot` instead of `phaseSlot` itself.
- `Layer.adapterCompatible(slot, sourceTypes)` (default `false`, overridden
  by `AnimPathLayer`/`RotateLayer`) is the display-side counterpart:
  `renderSlotGroup` (and `AnimPathLayer`'s bespoke phase-row rendering, which
  doesn't go through `renderSlotGroup`) checks it to highlight an
  otherwise-incompatible drop target **amber** (`"drop to convert"`) instead
  of green, so the adapter path is visible during drag rather than just
  silently rejecting the drop. Keep the two conditions in sync when adding a
  new adapter case.

### `AnimPathLayer` — `phaseOffsetSlot` (scrub / live phase shift)

A second `Amount` slot, `phaseOffsetSlot` (label `'phase'`, rendered as its
own `SliderSlot` pill — Pill 3 of 4 — below the rate+phase pill and above
the run-mode/clockwise pill), distinct from the rate-driving `phaseSlot`
described above. Semantics: `0` = path start, `1` = path end.

- **Binding a fresh source auto-stops `runModeSlot`.** `_offsetSlotPrevState`
  tracks the slot's previous `SlotState` each `recompute()`; only the
  transition `Unbound -> Bound` (a genuinely new bind, not a pause-button
  resume from `SuspendedBound`) sets `_running = false`. This is what lets
  the bound amount alone scrub the point from start to end without the rate
  cycle fighting it, per the same "first bind" convention used elsewhere
  (e.g. `TransformLayer`'s reflect auto-enable), generalized here from
  `isActive` to explicit `SlotState` transitions specifically so that
  suspending/resuming the same binding later (via the `SliderSlot`'s pause
  button, or a manual drag's suspend-on-touch) doesn't re-trigger it.
- **`_effectiveT()`** (the perimeter-sample parameter) branches on both
  `_running` and `phaseOffsetSlot.isActive`: while stopped *and* bound, it
  returns the offset directly, bypassing `_phase` entirely — "the amount
  binding simply controls the position." In every other case (running, or
  stopped-but-unbound) the offset is just added into the ordinary
  `_phase + _phaseOffset` sum before wrapping — "the rate is applied with
  this phase offset." Gating the bypass on `isActive` (not just `!_running`)
  matters: without it, pausing via the ordinary run-mode checkbox on a
  layer that has never touched this feature would snap the point to the
  default `_offsetValue = 0` (path start) instead of freezing in place,
  breaking pre-existing pause behaviour for every other `AnimPathLayer`.
- The manual slider value (`_offsetValue`) always live-updates the point
  regardless of run state or binding — suspend-on-touch via `setPhaseOffset`
  — satisfying "phase can be modified locally while the animation still
  runs" for both the bound and unbound cases.
- `phaseOffsetSlot` is pushed onto `this.slots[]` *after* `cwSlot` (not
  interleaved with the original four), so old saves' positional slot
  restore still binds their first four slots correctly; the new slot is
  simply unbound on an old save, matching the "clean break, no migration"
  precedent documented under "Known issues" below.

### `Clip<Shape>` layer family

`ClipRectLayer`, `ClipEllipseLayer`, `ClipPathLayer`, `ClipTextLayer`, and
`ClipDrawingLayer` extend `RectLayer`/`EllipseLayer`/`PathLayer`/`TextLayer`/
`MaskLayer` directly (geometry and handles unchanged) and add an `imageSlot`
(Image) plus a mask-tracker slot (`maskSlot`, or `clipMaskSlot` on
`ClipTextLayer` since `TextLayer` already has its own `maskSlot`).
`recompute()` calls `super.recompute()`, then composites `imageSlot`'s image
through a mask via `source-over` + `destination-in` into an offscreen canvas
that `renderSelf`/`getImage()` use. The mask is `maskSlot.source.getMask()`
(the mask-tracker helper's fuller composited mask — own shape ∪ any extra
paint/shapes the user added while it was exposed) when that slot is bound to
a `MaskLayer`, falling back to `this.getMask()` (the bare shape outline) —
read via the slot's `.source`, not `hiddenHelper`/`helperHost`, since those
are cleared the moment the helper is exposed (see "Exposure" under "Hidden
helper layers" above) while the `maskSlot` binding itself persists for the
helper's whole lifetime. Deliberately a **passive** read — no forced
`evaluate()` on the helper — since the helper's own `clipRegionSlot` read of
*this* layer's mask (below) is equally passive; forcing either side would
race the other's still-in-progress `recompute()` within the same frame (see
"Feedback slots"'s "don't force a mutual read" gotcha above). A passive read
is at most about one frame stale and self-corrects via the normal per-frame
stack evaluation and dirty propagation. `ClipDrawingLayer` needs none of
this — its own `getMask()` (inherited from `MaskLayer`) already *is* the
composited mask, so it's used unconditionally, same as before.

`ClipDrawingLayer` extends `MaskLayer`, whose `renderSlots` only renders its
own private shape slots and invert slot (not the full `this.slots[]` array).
`ClipDrawingLayer` therefore overrides `renderSlots`: calls `super.renderSlots`,
scans `_slotBounds.values()` to find the bottom of the last rendered row, then
calls `renderSlotGroup` once more to append a third pill for `imageSlot` and
`maskSlot`. Any future `MaskLayer` subclass that adds slots to `this.slots[]`
must do the same — the base `renderSlots` will not pick them up automatically.

`postInsertLayer` (`main.ts`) inserts a plain hidden `MaskLayer` directly
**below** the new layer (`helperBelow = true`) and links it two ways: the
host's own `maskSlot`/`clipMaskSlot` is bound *to* the helper (a normal
`BindingLayer.create` — this is what makes the row clickable via the
hidden-helper exposure gesture above, and per the compositing paragraph
above, `recompute()` also reads its `.source` directly, passively, to fetch
the helper's mask), and the helper's `clipRegionSlot` — a dedicated
`Mask`-typed feedback slot on `MaskLayer` (`this._clipRegionSlot`) — is
bound to the host (`maskHelper.clipRegionSlot.bind(newLayer)`, a raw
`ParameterSlot.bind()`, no `BindingLayer` card, same nominal-binding
convention as `RootLayer.clockSlot`). `MaskLayer.recompute()` unions
`clipRegionSlot`'s source mask in exactly like one more shape slot — a
passive read, same as the host's own read of the helper (see "Feedback
slots — permitting a well-defined cycle" above, including its "don't force a
mutual read" gotcha — this pairing is the concrete example it walks
through).

Both `clipRegionSlot` *and* `maskSlot`/`clipMaskSlot` are `feedback: true` —
not just `clipRegionSlot`. The two bindings run in opposite directions
between the same two nodes, which would be a two-node cycle for an ordinary
slot; `clipRegionSlot` being feedback is what gets the bind itself past
`Graph.bind()`'s cycle check, and `maskSlot`/`clipMaskSlot` being feedback
too is what keeps `Node.evaluate()`'s eager pull from creating an incidental
extra edge between the same two nodes (its value is never read either way,
so nothing about its own semantics changes). Dirty propagation is
unaffected by either slot's feedback flag — `markDirty()`/`forceDirty()`
walk `_feedbackDependents` exactly like `_dependents`, so each side still
redraws whenever the other changes (host moves → helper redraws; helper is
painted on → host re-clips), settling within about a frame since neither
read is forced. `settleMaskTrackerPair(host, helper)` (`MaskLayer.ts`) is
called once, right after the `clipRegionSlot.bind()` — both at creation
(`postInsertLayer`) and on load (`Persistence.ts`/`CollectionExport.ts`'s
phase 6) — to bootstrap a brand-new pair past the one case passive reads
alone can't recover from: neither side has ever evaluated, so both would
otherwise settle permanently on a blank/wrong read. Because `clipRegionSlot`
is a real, visible slot, exposing the helper (clicking the host's bound
`maskSlot` row) shows the tracked host as an ordinary `Bound → <HostName>`
row in the shape-slot pill — labelled "clip region" — rather than an
invisible side-channel; the row only renders while bound
(`MaskLayer.renderSlots`), so a plain
user-created `MaskLayer` never shows it. `autoBindRules()` binds `imageSlot`
to the nearest `Image` below (excluding hidden helpers).

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
  above the consumer, binds it, and selects it. **Exception**: an empty
  `Audio`-typed slot (`EventLayer`/`TempoLayer`'s `audioSlot` — the only
  consumers of this type) isn't in `DEFAULT_VALUE_LAYER` at all; it's a
  dedicated special case in `setSlotClickCallback` that creates a
  `VideoLayer` and inserts it **below** the consumer instead of above —
  the video's own image output isn't the point of this binding, only its
  audio tap, so there's no reason for it to sit over whatever the user is
  already looking at. Runs the new layer through `postInsertLayer` (Track
  button/inspector wiring) like any other `VideoLayer` creation path before
  selecting it, so the source-picker (File/Camera/Screen) is immediately
  in view.
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

**Dropping onto the Startup screen**: if `widget.selected instanceof StartupLayer`
when any of these drops (image/video, text, or JSON) lands, `promoteStartupToMenu()`
runs first — same effect as pressing StartupLayer's "Menu" button
(`widget.setVisible(true)`, `startupLayer.removeFromStack()`,
`menuLayer.insertAbove(deletionLayer)`) — before the normal placement rule
applies with `selected` now `menuLayer`. This is necessary because
`StartupLayer` has no slots and isn't `MenuLayer`, so without it a drop would
silently insert the new layer above the still-present StartupLayer instead of
replacing the startup screen.

**JSON drop — full session vs. collection export**: a `.json` drop is
distinguished by parsed shape, not extension/MIME. Checked in order: (1) a
full session save (has `version`/`stack`/`canvas`/`clock`, no `kind` field) —
loaded via `applyLoadedSession()`, identical to pressing MenuLayer's Load
button (teardown + full stack reconstruction, see "Persistence" below); (2)
a collection export (`kind === 'palimpsest-collection'`) — existing
`deserializeCollection` handling, placed via the same MenuLayer-selected /
current-layer / lowest-anchor rules as an image/video drop.

### `postInsertLayer` (main.ts)

All per-type setup that runs after a new layer is inserted — auto-binding
(`applyDefaultBindings`), hidden-helper wiring, AnimPath Clock/Rate creation,
CollectionLayer eject/delete callbacks, TutorialLayer wiring, etc. — lives in
`postInsertLayer(newLayer)`. Every creation path (MenuLayer's `onAdded`,
`wireTutorialLayer`, OS file drop, the mask-drop clipping shortcut) calls it,
so layers behave identically regardless of how they were created. The caller
is responsible for calling `refreshStack` afterwards.

**Exception**: the `'c'` key handler (`interaction.setCollectionAction`) —
the primary way users create a `CollectionLayer` — constructs it inline and
does **not** call `postInsertLayer`; it wires `setEjectCallback`/
`setDeleteCallback` by hand instead. Any future per-CollectionLayer wiring
added to `postInsertLayer` must also be added here, or it will silently
never run for freshly-created collections (only for ones restored from a
save file, which do go through the `applyLoadedSession` scan loop). This
already caused one bug: a callback wired only in `postInsertLayer` looked
correct but was a no-op for every collection actually created via `'c'`.

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

**Global pause ('p' key)** — `interaction.setPauseClockAction` (wired once,
`main.ts`, near the other global key actions) toggles `clock.togglePause()`
and, on the same keypress, also pauses every currently-`instanceof
VideoLayer` node found via `graph.nodes` (`VideoLayer.pauseForGlobalPause()`
— file-source playback only; camera/screen are live capture, not a
play/pause timeline) and freezes the shared `audioRhythm` singleton
(`audioRhythm.setPaused(true)`, see "Audio-onset detection..." below) — one
key freezes everything time-based at once, for testing convenience. Resuming
only resumes the `VideoLayer`s this same action paused (tracked in a
`Set<VideoLayer>` closure in `main.ts`), so a video the user had already
paused manually beforehand stays paused.

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
| `src/interaction/MarshallingPanel.ts` | Floating DOM panel for prepared performance content — see "Content marshalling panel" below |
| `src/layers/MaskLayer.ts` | Composite mask: shape + collection slots + freehand paint/erase |
| `src/layers/ShapeLayer.ts` | Abstract shape base — produces Point + Mask |
| `src/layers/CompositeLayer.ts` | Blends two images with optional Mask input |
| `src/layers/TileLayer.ts` | Tile an image's content bbox across the canvas, or fit (contain) it within the canvas |
| `src/layers/BackgroundLayer.ts` | Off-stack collection for layers that must keep recomputing |
| `src/layers/ClockLayer.ts` | Singleton time source, `outsideStack` but ticked every frame |
| `src/layers/FilterGL.ts` | Shared WebGL pipeline singleton for `FilterLayer` |
| `src/layers/MotionBlurLayer.ts` | Temporal image accumulation / motion trails |
| `src/audio/OnsetDetector.ts` | Crude time-domain onset DSP (pure, not a singleton itself) |
| `src/audio/AudioRhythm.ts` | Shared "one master audio rhythm" singleton — filter, detector, beat-tracking |
| `src/audio/AudioScopeWidget.ts` | Shared live-scope tuning UI, used by both EventLayer and TempoLayer |
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
  `CollectionLayer._layers`) need their own id-resolution step in
  `serialize()`/`deserialize()` — see the `itemIds` handling for the
  existing pattern. A *raw-bound* feedback slot like `MaskLayer.clipRegionSlot`
  (see `Clip<Shape>` above) is a middle case: it's excluded from the generic
  per-slot serialize/replay (mirroring `root.clockSlot`'s exclusion — see
  `serialize()`'s `clipRegionSlot`/`clockSlot` checks) and instead re-derived
  from `hiddenHelperId` in its own phase (`deserialize()`'s phase 6).
- After any such change, run `npm run typecheck` (baseline is the
  pre-existing ~451-line warning count — new errors should be 0) and do a
  manual save → reload → load round-trip of a stack using the new/changed
  layer.

### Collection save/load (`src/persistence/CollectionExport.ts`)

A `CollectionLayer` can be saved/loaded as its own standalone `.json` file,
independent of the rest of the session — Save/Load buttons live in the
`CollectionLayer`'s own header pill (`setSaveLoadCallbacks`), not the main
menu. `CollectionSaveFile` is a much smaller sibling of `SaveFile` — reuses
`LayerRecord`/`SlotRecord` unchanged (`{version, kind:
'palimpsest-collection', rootId, layers}`, no stack/background/archive/
clock/audioRhythm) — built by `serializeCollection()`/`deserializeCollection()`,
which share `encodeState`/`decodeState`/`resolveSource`
with `Persistence.ts` (exported from there for this reuse) rather than
duplicating them. Its own phase 6 (`clipRegionSlot` re-derivation) and the
`clipRegionSlot` serialize-exclusion duplicate `Persistence.ts`'s logic
line-for-line rather than sharing it — any future fix to the mask-tracker
restore logic must be mirrored in both files.

**What gets exported**: the collection itself, its ingested `items`, and —
via the same `visit()`/`refId()` lazy-closure-growth pattern
`Persistence.serialize()` already uses for slot sources not otherwise
reachable — every layer any of those transitively depend on through a
`ParameterSlot` binding or a `hiddenHelper` pointer (e.g. a `Clip<Shape>`
item's mask-tracker). No separate "dependencies" list is needed in the
format; it falls out of the same per-record `slots`/`itemIds`/
`hiddenHelperId` fields every `LayerRecord` already carries.

**On load**, `deserializeCollection()` walks the ownership closure (root →
its own `itemIds`, recursively through nested collections → each owned
layer's `hiddenHelper`, recursively) to split the result into `itemLayers`
(top-level items, handed back for the caller to `restoreItems()` into
whichever `CollectionLayer` actually keeps them) and `backgroundLayers`
(everything else — layers that only exist because something needed them as
a slot source or a required mask-tracker helper). The caller always parks
`backgroundLayers` in the global `BackgroundLayer` — kept evaluating every
frame, never rendered, no stack-widget thumbnail. This **is** "reloaded as
a hidden layer": no separate hidden-layer concept was added to
`CollectionLayer` itself.

Every layer `deserializeCollection()` instantiates — root, items, and
background dependencies alike — gets a **fresh** `debugName` via
`Layer.assignDebugName()` (the same incrementing-counter mechanism a
newly-created layer gets), never the persisted one: a collection file was
built from a live session, so its saved names are almost always identical
to some already-live layer's name, which reads as confusing duplication
rather than useful identity. `debugName` has no functional effect anywhere
in the codebase (purely a display label, plus a brush-texture hash seed in
`StrokeLayer`/`PathLayer`/`RectLayer`/`EllipseLayer`), so this is safe.

The freshly-instantiated root `CollectionLayer` is never auto-wired with
its own items inside `deserializeCollection()` — the caller decides:
- **OS file-drop onto the canvas** creates a brand-new `CollectionLayer`
  (placed via the same `selected`-relative rules as an image/video OS
  drop — see "OS file drag-and-drop" above) and keeps this root, restoring
  its `indexSlot` binding (but not its name, per above).
- **Load button on an existing `CollectionLayer`** merges (appends) the
  file's items into that target instead — the throwaway root is discarded,
  and `discardImportedCollectionRoot()` (`main.ts`) must sever any
  `BindingLayer` touching its own slots and `graph.unregister()` it, or
  both leak (same concern `Persistence.teardownSession` handles for a full
  session reload, scoped down to one throwaway layer here).

**`wireLoadedLayer` (`main.ts`)**: every per-type post-restore wiring call
(convenience buttons, `onInspectorRequest` hooks, etc.) that used to be
duplicated between `applyLoadedSession`'s main-stack and archive scans was
extracted into this one function so it can also be applied to freshly
loaded/merged collection items — it recurses into `CollectionLayer.items`,
which the original two scans never did (a real pre-existing gap: a
`CollectionLayer`'s ingested items, restored via an ordinary full-session
load, never got this wiring at all).

**Known gap surfaced by this feature, not fixed by it**:
`CollectionLayer.ingest()`/`eject()` call `Layer.removeFromStack()`
directly and never follow `hiddenHelper` — unlike
`LayerStackWidget._reorderLiveStack()`, which explicitly re-homes a helper
alongside its host on every main-stack reorder. Ingesting a `Clip<Shape>`
layer into a collection today leaves its mask-tracker helper behind in the
main stack (it keeps working — pull-evaluation only cares about reachability
via the `clipRegionSlot` binding, not stack membership — but is a
bookkeeping/visual orphan). `serializeCollection()`'s closure walk still
finds such helpers correctly via `hiddenHelper` regardless of where they
live.

### `MotionBlurLayer`

Temporal accumulation layer that maintains a persistent cache canvas. On each
update tick (gated by the `delay` slider, log-scaled), it fades the cache by
`fade` and composites the current `imageSlot` input over it. Slots:
- `imageSlot` (Image) — source; auto-bound at creation, source sent to Background
- `fadeSlot` (Amount) — `0` = full accumulation (old frames never cleared);
  `1` = instant clear (only latest frame visible). Slider suspends on touch.
- `delaySlot` (Amount) — `0` = update every frame; `1` = frozen; log-scaled
  so `0.5` ≈ every 10 frames. Slider suspends on touch.

### `LineLayer` — produces `Image`, `Mask`, `Direction`, and `Point`

`LineLayer` renders into a private `_canvas: OffscreenCanvas` and declares
`ValueType.Image` / `ValueType.Mask`. A second `_maskCanvas` is maintained in
parallel: rendered in opaque white with the same geometry (stroke width,
arrowheads), so the mask covers exactly the visible line pixels rather than a
filled interior. A **Mask** convenience button is wired via `wireLineMaskButton`
in `postInsertLayer`.

`LineLayer` also `implements PointSource` and declares `ValueType.Point`, with
`getPoint()` returning the line's midpoint and `samplePerimeter(t)` linearly
interpolating between the rendered start/end (`t=0` → start, `t=1` → end) —
same duck-typed contract (`'samplePerimeter' in l`) that `ShapeLayer`/
`StrokeLayer` use, so `LineLayer` is a valid `AnimPathLayer.shapeSlot` source
with no changes needed to `AnimPathLayer` itself. An **Animate** convenience
button (third slot in the existing Point/Mask row — `_lineBtnRect`/
`_renderLineConvBtn`, extended from a 2-button to a 3-button layout matching
`ShapeLayer._convBtnRect`'s order/geometry convention) is wired via
`wireAnimatableShape` in `postInsertLayer`/`wireLoadedLayer` — the same
function `ShapeLayer`/`PathLayer` use, its parameter type just widened to
`ShapeLayer | LineLayer` since the body has no shape-specific logic.

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

### `StrokeLayer` — chaining multiple strokes into one curve

`chainSlot` (Point-typed, pushed onto `this.slots[]` alongside `startSlot`/
`endSlot`) binds another `StrokeLayer`, splicing its points onto this one's
for rendering/sampling so a whole chain draws as a single continuous curve.
It's typed `Point` purely so drag-drop highlighting/rendering reuse the
ordinary slot machinery (`SLOT_TC`, `renderSlotGroup`) — actual binding is
restricted to `StrokeLayer` sources by a guard in `main.ts`'s
`setBoundCallback`, since nothing in the `ValueType` system can express
"must be this concrete class."

- **`PathLayer._renderPoints(): Point[]`** (new protected hook, default
  `return this._points`) — everywhere that used to read `this._points` for
  *rendering* (`drawShape`, and `StrokeLayer`'s own `_rebuildArcSamples`,
  which drives `samplePerimeter`/the artistic brush canvas via
  `_arcSamples`) now calls this instead. `StrokeLayer` overrides it:
  `chainSlot.isActive ? [...this._points, ...(chainSlot.source as
  StrokeLayer)._renderPoints().slice(1)] : this._points` — recursive, so a
  multi-link chain fully flattens. The chained stroke's own first point is
  always dropped (same "pop the duplicate" convention `_checkClosure`
  already uses for auto-closing a loop), so the join has one shared node —
  this stroke's own last point — rather than two coincident ones; dragging
  that last point reshapes the join with no extra bookkeeping needed.
  **Editing stays scoped to `_points`** — control-point handles, curve-click
  insertion (`_curveHit`), and drag hit-testing are untouched by this hook,
  so a chain link is only ever edited on the layer that actually owns it
  (see chained handles below).
- **Creation** — `createChainedStroke(consumer)` (`main.ts`) makes a new
  `StrokeLayer`, seeds colour/opacity/scale/stroke width/spline radius via
  `applyStateSnapshot(consumer.getStateSnapshot())`, `insertAbove(consumer)`,
  binds it into `consumer.chainSlot`, then re-binds any of those same style
  slots that were *actively* bound on the consumer onto the new layer too
  (so both segments keep tracking a shared source, not just its value at
  creation time) — then runs it through `postInsertLayer` and returns it. A
  fresh `StrokeLayer` already starts in draw mode with no points, so the
  caller can begin drawing immediately. Two entry points, both routed
  through this helper and both guarded to never replace an already-bound
  `chainSlot` (an existing chain is left in place; the gesture is a no-op if
  one exists):
  - **Slot click** — `setSlotClickCallback`'s `StrokeLayer` branch.
  - **Click-through** — `InteractionSystem`'s "true empty-area miss"
    handling (the existing pattern that lets a click reach through to an
    *empty* `StrokeLayer` below the current selection and start drawing on
    it) now also fires when the currently **selected** layer is itself a
    non-empty `StrokeLayer` (its own hit-test already had first refusal at
    the point — handles/curve/pills — so a miss there means genuinely empty
    space), and when the scan-below case lands on a non-empty stroke
    instead of an empty one — both chain from it via
    `setChainStrokeCallback` rather than leaving the click a no-op.
- **Chained handles** — `StrokeLayer.renderOverlay` also calls
  `_renderChainedHandles`, drawing every layer in `_chainedLayers()`'s own
  control points (skipping each layer's index 0 — the point
  `_renderPoints()` always drops, so it has no visible position) in
  `CHAIN_HANDLE_COL` (`#e84a8f`, distinct from the amber `ACCENT` used for
  this stroke's own handles) to flag that dragging one edits a *different*
  layer. `hitTestSelf`/`handlePointerDown` try this stroke's own elements
  first via `super`, then fall back to `_nearestChainPoint`; a hit drags via
  `PathLayer.setPointAt(idx, p)` (new public method) called on the *owning*
  layer, not `this` — dirty propagation needs no special-casing, since the
  existing `chainSlot` dependency edges (source → consumer) already cascade
  through every intermediate link up to whichever layer is selected.
  Grabbing a chain layer's pinned last point suspends its own `endSlot`
  binding first, same convention `_onControlPointDragStart` uses for this
  stroke's own endpoint. `handleContextMenu` follows the same own-first,
  chain-fallback order, deleting via the new `PathLayer.removePointAt(idx)`
  (`_minPoints`-guarded; `handleContextMenu` itself is now a thin wrapper
  around it) on the owning layer.
- **Resolving a click on chained curve content** — a chained layer's
  segment of the curve is only ever *rendered* by the head layer (via
  `_renderPoints`); the chained layer itself still exists as an ordinary
  stack member (or in Background/Deleted) and — when on-stack — usually
  renders its own copy independently too, so ordinary top-down pixel-pick
  (`_pickLayerAtPixel`) naturally finds it directly (it's inserted *above*
  its predecessor, so it wins z-order) with no extra code. The gap is a
  chained layer that's been sent to Background or archived: nothing else is
  rendering that pixel, so pixel-pick can only find the head. `StrokeLayer.
  chainSegmentOwnerAt(point)` (public) resolves this generically — samples
  every layer in `[this, ...this._chainedLayers()]`'s own un-merged curve
  independently (reusing this stroke's own `_radius`, matching how the
  merged curve is actually rendered — an individual chain layer's radius
  isn't separately honoured there) and returns whichever comes closest,
  sidestepping any attempt to map an index back through the `_renderPoints`
  splice. `InteractionSystem.setResolveChainClickCallback` calls this from
  `_handleEmptyAreaClick` whenever pixel-pick lands on a `StrokeLayer`;
  `main.ts`'s implementation checks `owner.outsideStack` and, if so, does
  the same "remove from wherever it's parked, `insertAbove` the click
  target, `forceDirty()` to restart any self-perpetuating loop, refresh"
  restoration already used for hidden-helper exposure just below it in the
  same file — landing it directly above the layer that was actually
  clicked, per the same "restore where a chain link would naturally sit"
  convention `createChainedStroke` uses.

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

### `TextLayer` — canvas-relative font size cap

The size slider/stepper's upper bound is `maxTextSize()` — `2 × max(Node.canvasWidth,
Node.canvasHeight)` — not a fixed px constant, so a single word (or single
character) can be scaled up to fill the whole screen regardless of canvas/device
size. `MIN_SIZE` (12) stays fixed. All five places that previously read the old
fixed `MAX_SIZE` (the Amount-slot `[0,1]` mapping in both directions, the
mask-fit binary-search bound, and the scale-handle drag clamp) now call
`maxTextSize()`. The `−`/`+` size-stepper buttons (`adjustSize(dir: 1 | -1)`)
step by ~10% of the current size (floor 4px) rather than a fixed 4px — a fixed
step would take hundreds of clicks to cross the now much wider range; the
scale-drag handle (`renderOverlay`) remains the fastest way to reach the top
of the range.

### Slot label convention

All `ParameterSlot` constructors should use a descriptive label string (third
argument), not the default `'amount'`. Slots updated this session: TextLayer
`scaleSlot` → `'scale'`; DirectionLayer `_magnitudeSlot` → `'magnitude'`;
CompositeLayer `_opacitySlot` → `'opacity'`; AnimationPathLayer `_posSlot` →
`'position'`; RateLayer `_timeSlot` → `'time'`; SequencerLayer `_rateSlot` →
`'rate'`; MathLayer `_slotA` → `'a'`, `_slotB` → `'b'`.

### `VideoLayer` — file audio, pause control, camera-only pill cleanup

File-sourced video now plays with audio by default. Previously `_video.muted`
was hardcoded `true` for every source type; `recompute()` now sets
`_video.muted`/`_video.volume` every frame from a new `volumeSlot` (Amount) +
`_volumeWidget` (`SliderSlot`, the same combined slider/binding widget class
`opacitySlot` uses) — draggable manually or bindable to any `Amount` source,
suspend-on-touch like every other slot/manual pair, rendered in its own pill
below the opacity pill. Muted is forced `true` whenever `sourceType !==
'file'` (camera/screen streams are always captured with `audio: false`) or
volume is 0, computed unconditionally each `recompute()` so switching source
types can't leave a stale unmuted element behind.

The `enableSlot` row — labelled `'enable toggle'` — is now labelled
`'pause'`, and its button icon shows the *action* a click performs (▶ while
paused, ⏸ while playing) rather than the previous pause/record pairing.

The lower source-controls pill's fit/mirror buttons, and its filename/
dimensions/status readout plus small load-file button, are now camera/
screen-only — none of it applies to file playback (a loaded file's framing
and orientation are properties of the media itself, not something to
fit/fill or mirror against the canvas; reloading a different file is done
via the big **File** button in the source-selector row above, which already
reopens the file picker when file is already the active source).
`_drawFileControls` was deleted as dead code once its content was removed
for file mode. The file-playback scrub/control bar at the bottom of the
viewport now starts at `contentLeft(cw)` instead of a fixed left margin, so
it's no longer hidden under the `LayerStackWidget` strip.

`VideoLayer` also `implements AudioSource` (`types` includes `ValueType.Audio`
alongside `Image` — the same multi-type-source pattern `LineLayer` uses for
Image+Mask). `getAudio()` lazily builds an `AudioContext` →
`MediaElementAudioSourceNode(this._video)` → `AnalyserNode` (small
`fftSize = 1024` for low-latency time-domain reads) → `destination` chain the
first time a consumer calls it, and caches it forever —
`createMediaElementSource` can only be called once per `<video>` element ever,
and `_video` persists across camera/screen/file source switches, so this is
safe regardless of when the first consumer binds. No source-type gating: when
not playing file audio the signal is simply near-silent, which consumers
already have to tolerate.

### `VideoLayer` file-source persistence — relink via File System Access

Video bytes are never embedded in saved session JSON (unlike `ImageLayer`,
which embeds its bitmap as a base64 PNG data URL — see "Persistence"
below) — only `filename`/transform/playback metadata. Historically this
meant a reloaded file-sourced `VideoLayer` just rendered blank forever,
since the browser can't regain access to the original `File`/blob without
the user re-picking it and nothing prompted for that.

`_openFilePicker()` (the panel's File button, and — since `sourceType`
stays `'file'` after reload — also the entry point for manually relinking a
missing one) now tries the File System Access API first
(`window.showOpenFilePicker`, typed via the ambient declarations in
`src/types/file-system-access.d.ts` since TypeScript's bundled `dom` lib
doesn't cover this Chromium-only extension) and falls back to the original
`<input type=file>` flow when unsupported
(`VideoFileHandleStore.fileSystemAccessSupported`). A successful pick's
`FileSystemFileHandle` is stored in `src/persistence/VideoFileHandleStore.ts`
— its own small IndexedDB (separate DB from `MobileStore`'s save gallery, so
their `onupgradeneeded`/version bumps never interact) — keyed by a
`_fileHandleId` (`crypto.randomUUID()`, minted on first capture and
persisted in `serializeState`/`deserializeState`). This is a **new** stable
per-layer id, not reused from anything existing: `Node.creationIndex` is a
runtime-only counter that resets every page load, and `LayerRecord.id`
(`Persistence.ts`) is a positional index recomputed fresh on every save —
neither survives a save/load round trip.

`Persistence.deserialize()`'s per-record state-restore loop calls
`await layer.tryAutoRelink()` right after `layer.deserializeState(decoded)`
for any `VideoLayer` (kept as an explicit `instanceof` branch there rather
than folded into `VideoLayer.deserializeState` itself, since that method's
contract with the rest of the persistence layer is synchronous and shared
by every layer type). `tryAutoRelink()` looks up the stored handle and
checks `handle.queryPermission?.({mode:'read'})` — which never itself
prompts the user, so this is always safe to run unconditionally on load —
and silently reconnects (`handle.getFile()` → `loadFile(file, handle)`) if
already granted. When that's not possible (handle missing, permission would
need an interactive `requestPermission` prompt that has no user gesture to
attach to here, or — for a drag-and-dropped file, or an older save — no
handle was ever captured in the first place), the layer instead sets
`_needsRelink = true`: the File big-button's label swaps to `'Relink'`
(`VideoLayer.ts`'s big-button spec loop), and since `_renderControlBar`
otherwise draws nothing at all once `_objectUrl === null`, it now also
draws a one-line "Missing: ‹filename› — click File to relink" bar in the
normal scrub-bar's position — `_missingBarB`, wired into `hitTestSelf`/
`handlePointerDown` alongside the other bar/button bounds, so a click
anywhere on that readout (not just the small File button) also opens the
picker.

Purging a `VideoLayer` from the Deletion archive
(`deletionLayer.setPurgeCallback` in `main.ts`) also deletes its
`VideoFileHandleStore` entry when `fileHandleId !== null`, so the handle
store doesn't grow unboundedly as videos are picked and later discarded.

**Deliberately out of scope**: drag-and-dropped video files never capture a
handle (`DataTransferItem.getAsFileSystemHandle()` isn't typed in the
bundled `dom` lib either, and is Chromium-only) — they stay filename-only,
same as before this feature, and still get the manual Relink prompt on
reload rather than erroring. `ImageLayer` has no equivalent reconnect
problem to solve, since its content is already fully embedded in the save.

### Audio-onset detection and beat induction — stage-performance sync

Three-file split: `src/audio/OnsetDetector.ts` (pure DSP), `src/audio/
AudioRhythm.ts` (shared analysis singleton), `src/audio/AudioScopeWidget.ts`
(shared tuning UI). `EventLayer`'s audio-onset trigger mode and `TempoLayer`'s
audio-driven beat induction each bind a `VideoLayer` (or any future
`AudioSource`) via their own `Audio`-typed `audioSlot`, but **there is only
one master audio rhythm at a time** — filtering, onset detection, and beat
tracking are shared global state, not per-layer copies that could drift out
of sync tuning-wise. Whichever layer's `audioSlot` is active feeds the
shared singleton each `recompute()`; tuning dragged on either layer's scope
applies to both immediately.

**`OnsetDetector`** — plain (non-`Node`) DSP, time-domain only (no FFT — a
windowed analysis would delay a one-off transient; frequency selectivity is
the caller's job, via a `BiquadFilterNode` upstream — see `AudioRhythm`
below). Each `sample()` call reduces `getByteTimeDomainData` to a single
envelope scalar (mean absolute deviation from silence, `[0, 1]`) and fires
`onset` on the below→above rising edge of `levelThreshold`, gated by a short
refractory period — edge-triggering (not "level is currently above") is
what stops a sustained loud passage from retriggering every time the
refractory window expires. `history` (1000 samples, `HISTORY_LEN`, public,
~16 s at one `sample()` call per rendered frame — long enough to see
several cycles of a slow beat) and parallel `historyTimesMs` (wall-clock
capture time per sample, for placing something timestamp-based like a
predicted-beat grid onto the tick-indexed axis by interpolation) are a
render-only ring buffer. `onsetAges` returns the age (ticks since firing) of
every still-visible onset, oldest first, so a caller can mark each one on a
scrolling trace rather than only the latest. `normCenter`/`normScale` are a
slow EMA (not a windowed min/max, which would make a display scale jump
every time a peak entered or left the visible window) of the envelope's
centre and mean absolute deviation, for auto-normalising a live trace.

**`AudioRhythm`** (`export const audioRhythm = new AudioRhythm()`) — a bare
module-level singleton, same weight as `FilterGL`'s shared WebGL pipeline
(no `Node`/`Layer`/`Clock`, no graph registration, no per-frame ticking of
its own — purely input-driven by whichever caller supplies a live
`AnalyserNode`). Owns: `filterFreq`/`filterQ` (tunable `BiquadFilterNode`
params — full-band amplitude alone was dominated by whichever instrument is
loudest, e.g. vocals drowning out a kick drum, so isolating a band is what
makes onset detection usable for beat-driven triggers), the one shared
`OnsetDetector` instance, and beat-induction state (`periodMs`, private
wall-clock `_phaseAnchorMs`/`_lastBeatOnsetMs`/`_tapTimes`). `update(raw
Analyser, nowMs)` lazily builds/rebuilds a band-pass tap downstream of
whatever raw `AnalyserNode` it's given (`raw -> BiquadFilterNode('bandpass')
-> its own AnalyserNode` — an `AnalyserNode`'s output fanning out further,
not a change to `VideoLayer`, keeping "`VideoLayer` only exposes the tap,
DSP happens at the consumer"), runs the detector on the filtered signal, and
on a fire updates the beat-induction prior via `_registerBeatOnset` — a
crude drift-tolerant PLL: rejects intervals outside `[0.5×, 1.5×]` of the
current period estimate (defense in depth — in practice the refractory
below already keeps this from tripping once a period exists), otherwise
blends the period toward the freshly measured interval at `AUDIO_DRIFT_RATE`
(0.1) — or the much slower `AUDIO_DRIFT_RATE_CONFIDENT` (0.02) once
`tap()` has set `_periodConfident`, so a tapped tempo stays sticky against
live audio evidence — and nudges `_phaseAnchorMs` by a damped fraction of
the phase error at a fixed rate regardless of confidence (audio timing is
more precise than a human tap, so phase keeps correcting freely either
way; only *period* drift slows down post-tap) — never a hard reset either
way. `update()` also keeps `onset.refractoryMs` in sync with the current
period estimate every call — `max(BASE_REFRACTORY_MS, periodMs ×
REFRACTORY_FRACTION)` (0.6) — so once a period is known (especially a
tapped one), anything arriving sooner than ~60% of a beat cycle later
structurally can't register as a separate onset at all: this is what
rejects an echo/reverb tail immediately following a real hit, filtered
before it ever reaches interval estimation rather than merely down-weighted
afterward. `currentPhase(nowMs)`/`currentRateHz()`
derive from `periodMs`/`_phaseAnchorMs` directly in wall-clock ms
throughout (deliberately **not** anchored to any one `TempoLayer`'s own
`_timeSlot`/`_timeValue` the way a single-layer implementation naturally
would be — onset-interval measurement was already wall-clock-based via
`performance.now()`, and decoupling the phase anchor from any one
consumer's time source is what sharing this prediction across multiple
layers requires). One real behaviour change from a single-layer design:
this means `AudioRhythm` pausing is independent of the singleton
`ClockLayer`'s own pause state — nothing here freezes just because
`ClockLayer` does. `paused`/`setPaused(p)` is `AudioRhythm`'s own explicit
freeze: `update()` becomes a no-op (history/onset markers hold their last
state) and `displayNowMs` holds the moment pausing started (rather than
live `performance.now()`), so `AudioScopeWidget`'s predicted-beat overlay
(which reads wall-clock time every render) freezes in place too instead of
continuing to drift while the trace itself is frozen. The global 'p' key
(see `ClockLayer` singleton above) calls `audioRhythm.setPaused(true)`
alongside pausing `ClockLayer` and video playback, but nothing requires
that pairing — a future caller could pause just the audio analysis.
`tap(nowMs)` (re)seeds `periodMs`/`_phaseAnchorMs` — the standard "tap
tempo" convention from music software, called by both `EventLayer` and
`TempoLayer`'s TAP buttons (below). A gap of more than `MIN_TAP_INTERVAL_
GAP_MS` (12 s, covers down to 6 BPM — must comfortably exceed the slowest
realistic tap-to-tap spacing, or every tap in a genuine slow sequence looks
like the start of a new one and `periodMs` never updates at all; e.g.
tapping the downbeat of a slow bar rather than every beat, where "tempo"
means bar-rate) starts a fresh run, free to jump straight to a new tempo
(the very first interval of a
run is taken raw, unblended, precisely because it shouldn't be weighed
against an unrelated prior); later taps within the same run blend at
`TAP_DRIFT_RATE` (0.4 — higher than audio's, since a deliberate tap is
higher-quality evidence and should converge in a few taps, not drift
glacially) rather than recomputing a flat median from scratch each time
(which used to make every tap jitter independently instead of firming up).
`tapMarkerTimesMs` (public, render-only, capped at `MAX_TAP_MARKERS = 32`)
records every `tap()` call's wall-clock time regardless of what it did or
didn't do to `periodMs` — `AudioScopeWidget` draws a red (`#ff3b3b`) line
per entry, a diagnostic independent of the period/predicted-beat machinery
for confirming the TAP button is actually registering clicks at all.

**`AudioScopeWidget`** — the part of the tuning UI that's identical
wherever it's shown and reads/writes `audioRhythm` directly: the
band-centre-frequency + selectivity row (log-mapped 40 Hz – 2 kHz, full-width
drag track rather than a small circular handle, since its range needs a
wider grab target — see below for the Q whiskers), the scope box (waveform
+ onset markers + predicted-beat grid), and the level drag handle. **Not**
included: the `audioSlot`
binding row and pill header, which stay layer-specific (each layer still
decides which `VideoLayer` feeds the shared analysis) — callers draw a
header (label + TAP/gate buttons) then render the `audioSlot` row via the
ordinary shared `Layer.renderSlotGroup(ctx, [audioSlot], rowY, false)` (the
`drawBackdrop = false` form — the caller's already painted one continuous
pill backdrop behind header + slot row + scope, exactly `TraceLayer`'s
`_renderColourPill` pattern) and then call `render(ctx, x, y, width)` for
the frequency/scope/handles portion, which returns the total height
consumed (`AudioScopeWidget.HEIGHT` gives this up front, for sizing the
pill backdrop before calling `render`). `EventLayer` and `TempoLayer`'s
audio pills are now deliberately identical in structure this way — header,
`audioSlot` row, scope, all one pill — see both below. Each host layer
constructs its **own** `AudioScopeWidget` instance — the widget holds only
this-instance drag/UI state (`_scopeBounds`, `_levelHandlePos`, `_qLeftPos`,
`_qRightPos`, `_freqRowBounds`, `_scopeDrag`), never analysis state — so `EventLayer`'s
and `TempoLayer`'s scopes can be dragged independently while staying
visually and numerically in sync (both mutate the same `audioRhythm`).
Waveform trace and onset markers are positioned horizontally via
`_ageToX` — age (ticks since capture) scaled against `OnsetDetector.
HISTORY_LEN` (the buffer's fixed *capacity*, not its current `length`) — so
newest is always pinned to the scope's right edge and the time axis never
rescales as the buffer fills from empty (indexing directly by array
position instead made the apparent time scale visibly stretch while
filling). Vertically, the waveform trace and the level-threshold line are
positioned through `_envToY`/`_yToEnv` (inverse, used when dragging the
level handle), mapping an envelope value to scope-y via `OnsetDetector`'s
`normCenter`/`normScale` — running average sits at `MEAN_Y_FRAC` (0.2, i.e.
20%) up from the bottom, **not** centred: every onset of interest is a rise
*above* the mean, so most of the height (80%) is headroom above it and
little is spent below. Both directions still share one constant
deviations-per-pixel rate (`NORM_HEADROOM` total), so this is a pure
re-anchoring of the same linear scale, not a different slope each way —
the trace stays visible and the threshold line stays visually aligned with
where it actually crosses the trace regardless of loudness (the absolute
`levelThreshold` value used for detection is unaffected — only its
*displayed* position is normalised). `AudioRhythm`'s `onset` is constructed
with `levelThreshold = 0.05`, chosen so the handle starts at roughly 50% up
this axis given `OnsetDetector`'s initial (pre-adaptation) EMA seed values
— a reasonable starting drag position before real audio has streamed in
and shifted the live centre/scale to something track-specific. The level
drag handle sits at the scope's horizontal mid-point (not the right edge)
— purely a grab-target placement choice, `handlePointerMove`'s `'level'`
case only ever reads `point.y`, so it behaves identically wherever it's
drawn.

The frequency row is one integrated band-centre + selectivity control
rather than a plain slider: a vertical centre-line thumb marks
`filterFreq` (drag anywhere on the row's background to retune it, same
full-width track as before), flanked by two horizontal **whiskers**
showing `filterQ` — narrow whiskers read as high Q (tight, selective
band), wide whiskers as low Q (broad band). Each whisker end is
independently draggable and both drive the same symmetric Q value. Whisker
half-width is derived from Q via a half-bandwidth-in-octaves
approximation (`_qToWhiskerPx`/`_whiskerPxToQ`, `0.5 / Q`, clamped to
`[Q_HALF_OCTAVE_MIN, Q_HALF_OCTAVE_MAX]`) — deliberately not exact biquad
magnitude-response math, just enough to be monotonic and visually distinct
across the Q range; since `_freqToX` is affine in `log(f)`, a fixed octave
width is a fixed pixel width regardless of where the band centre currently
sits, so both whiskers are always equal length. This replaced an earlier
design (a single diagonal guide line + handle in the scope's corner,
controlling Q alone, disconnected from the frequency row) that worked but
read as unrelated to frequency and was easy to mistake for a leftover
rise-time onset heuristic — it wasn't; it wasn't even doing anything with
onset detection at all, just Q.

The scope **always** draws a yellow
(`#ffe000`) vertical line per entry in `onsetAges` — every detected onset
gets its own persistent marker that travels leftward with the waveform and
only disappears once it ages out (not replaced by the next onset) — and,
whenever `audioRhythm.periodMs !== null`, a cyan (`#4ae0e0`) predicted-beat
grid: vertical lines at each beat position `AudioRhythm` currently predicts,
computed by walking backward from `currentPhase(nowMs) * periodMs` in
`periodMs` steps and converting each to an x via the average ms-per-tick
across `historyTimesMs` (good enough for a visual overlay without tracking
exact per-tick timestamps). No on/off option for the predicted-beat
overlay — it's useful comparison context on both layers (why `TempoLayer`
duplicates the scope at all — tuning from either layer, plus this
comparison view — and what makes `EventLayer`'s tempo gate below legible),
so showing it unconditionally keeps the widget's API simple.

**`EventLayer`** (mode 4 of its four independent trigger modes): calls
`audioRhythm.update(analyser, nowMs)` each `recompute()`, and on a fire,
optionally gates it through `audioRhythm.passesTempoGate(nowMs)` — when
`audioRhythm.tempoGate` (small toggle button in the "audio onset" pill
header, plain boolean, not tied to a `ParameterSlot`) is on and a tempo
estimate has locked in, an onset is only accepted if it's within
`TEMPO_GATE_TOLERANCE` (0.15, a fixed constant in `AudioRhythm.ts`) of a
beat. **The gate is shared `AudioRhythm` state, not per-layer** — both the
toggle and the tolerance moved out of `EventLayer` entirely. This matters
beyond code-sharing: the gate is applied *inside*
`AudioRhythm._registerBeatOnset()`, before an accepted onset is blended
into `periodMs`/`_phaseAnchorMs`, not only as a downstream check on
whether to fire. Gating only the fire decision (the original design) did
nothing to protect the estimate itself — by the time `EventLayer` could
check it, the onset had already unconditionally corrupted `periodMs` for
busy/syncopated material (ghost notes, hi-hats between the main hits).
Gating at the source protects the shared estimate for both `EventLayer`
and `TempoLayer` at once, since both funnel through this same `update()` →
`_registerBeatOnset` path — `EventLayer`'s own `passesTempoGate` check
downstream is now largely a reconfirmation rather than the actual
protection. The pill header also has a **TAP** button (plain text glyph —
no tap/metronome icon exists in `src/ui/icons.ts`), next to the gate
toggle: calls `audioRhythm.tap(performance.now())`. Useful even though
`EventLayer` doesn't display a tempo: for rhythmic material, manually
seeding the inter-onset-interval estimate is what makes the tempo gate
above accurate, without needing a `TempoLayer` in the stack at all.

**Tap-tempo without any audio bound**: `EventLayer`'s mode-1b internal
timer (its own manual rate slider, used when `rateSlot` isn't bound) can
now be driven by TAP alone, with no `audioSlot` ever bound. A `tapDriving`
condition in `recompute()` (`!rateSlot.isActive && !_tapSuspended &&
audioRhythm.tapMarkerTimesMs.length > 0`) — true from the very first TAP
press, before a period estimate even exists — calls
`audioRhythm.tickSilent(nowMs)` (skipped if mode 4 already has a live
analyser feeding history that frame) so the scope's tap markers and
predicted-beat grid render/animate purely off tapped timestamps, and once
`periodMs` is set (second tap onward) pushes `hzToSlider(audioRhythm.
currentRateHz())` into both `_rateSlider.setValue()` *and* `this.
setValue()` — the same pair of calls a real drag's `_applyPointer` makes,
so the tap-driven update is indistinguishable from the user having dragged
the slider. `_tapSuspended` (cleared by `_tap()`, set by the slider's
`setOnDragStart`) is the suspend-on-touch escape hatch: grabbing the
slider directly hands control back to manual, same convention as a
suspended `ParameterSlot` binding, generalized here to a non-slot shared
estimate. `OnsetDetector.sampleSilent(nowMs)`/`AudioRhythm.tickSilent(nowMs)`
advance the shared history ring buffer and tick counter from the wall
clock alone (flatlined at the running mean, no onset detection run) —
exactly what a live `update()` does for timing purposes, minus the actual
signal.

Level threshold/filter freq/Q/tempo gate are **not** serialized
per-`EventLayer` instance (see `AudioRhythm` persistence below) —
`serializeState` only keeps `running`/`rateSliderValue`.

**Convenience creation**: clicking `EventLayer`'s or `TempoLayer`'s empty
`audioSlot` creates a `VideoLayer` and binds it — see the `Audio`-typed
exception in "assignDebugName and slot click-to-create/select" above
(inserted below the consumer, not above, and immediately selected so the
user can pick a source file right away).

**`TempoLayer`**: audio branch calls the same `audioRhythm.update(...)` and
reads `periodMs`/`currentRateHz()` to drive `_rateHz`, at lowest priority —
an explicitly-bound `_rateSlot` (`Rate`) still wins outright, unchanged from
before this feature. Phase: when the audio slot is active and locked,
`_phase = audioRhythm.currentPhase(nowMs)` directly, bypassing the
`_timeValue`-based formula entirely for that case; every other case
(rate-slot-bound, manual slider) keeps the original `wrap01(_timeValue *
_rateHz)` formula unchanged. Below the audio-slot branch, a third
`recompute()` case — tap-tempo with no audio bound anywhere — mirrors it:
when `!_rateSlot.isActive && !_audioSlot.isActive && !_tapSuspended &&
audioRhythm.tapMarkerTimesMs.length > 0`, it calls
`audioRhythm.tickSilent(nowMs)` and drives `_rateHz`/the slider from
`audioRhythm.currentRateHz()` exactly like the live-audio branch, so TAP
alone (no `VideoLayer` ever bound) is enough to set this layer's tempo;
`_rateSlider.interactive` is false while this is driving, same as the
audio-slot case, and a manual drag (`setOnDragStart`) sets `_tapSuspended`
to hand control back — cleared again by the next `tap()`. `renderSlots`
pulls `audioSlot` out of the main `timeSlot`/`rateSlot` group and renders
it in its own `_renderAudioPill` pill (own `AudioScopeWidget` instance,
`this._scope`) below — **structured identically to `EventLayer`'s
audio-onset pill**: header + `audioSlot` row + scope, one continuous
backdrop — so tuning `audioRhythm` looks and works the same from either
layer. This now includes the same tempo-gate toggle button `EventLayer`
has (same position left of TAP, same style, both read/write the single
shared `audioRhythm.tempoGate`) — it belongs here too since the gate
protects the shared estimate itself (see `EventLayer` above), not just a
per-layer firing decision. Wired through the same `hitTestSelf`/
`handlePointerDown`/`handlePointerMove`/`handlePointerUp` delegation
pattern as `EventLayer`. Its own **TAP** button sits in the pill header
(same position/style as `EventLayer`'s); `tap()` suspends `_rateSlot` if
bound (same suspend-on-touch convention the rate slider already uses),
clears `_tapSuspended`, then calls `audioRhythm.tap(performance.now())` —
deliberately does **not** suspend `_audioSlot`: tap reseeds the shared
prior, it doesn't disable the ongoing audio tracking that keeps refining
it afterward. Dragging the rate slider directly, by contrast, suspends
`_rateSlot`, `_audioSlot`, and tap-driving all at once — a full manual
takeover.

**Persistence**: `AudioRhythm`'s tunables (`filterFreq`, `filterQ`, `onset.
levelThreshold`, `tempoGate`) are saved/restored as a flat top-level
`SaveFile.audioRhythm` field in `src/persistence/Persistence.ts` — unlike `ClockLayer`
(which threads through `PersistenceContext` and a dedicated restore phase
since it's referenced structurally by id), `audioRhythm` is a plain
importable singleton with no cross-references to other layers, so it's just
a few lines in `serialize()`/`deserialize()` reading/writing the module
directly. Beat/phase-tracking state is **not** persisted — live state that
re-locks quickly once audio is playing again, the same "recomputed from
slot sources, don't persist" case as any other derived field.

### `FilterLayer` — `gradient-map` filter

The `gradient-map` filter has a bidirectional control: `t = 0.5` is
pass-through (no effect); `t < 0.5` blends towards a chrome palette (cool
gunmetal → cold steel → silver → icy white); `t > 0.5` blends towards a neon
palette (deep purple → hot pink → neon lime → electric yellow). Both the CPU
fallback (`FilterLayer.ts`) and the WebGL path (`FilterGL.ts`) use identical
palettes and blend logic.

### `WarpLayer` — GPU warp (`WarpGL.ts`)

`WarpLayer.recompute()` prefers a WebGL path (`warpGL.apply(...)`, `src/layers/
WarpGL.ts`) over the original CPU implementation (`WarpLayer._applyWarp`, kept
as the fallback when `warpGL.supported` is `false`). Unlike `FilterGL`'s
multi-pass ping-pong pipeline, this is a single shader pass: the inverse-distance-
weighted displacement sum *and* the inverse-mapped source sample both happen
per-fragment, so the CPU path's two CPU-specific tricks — a quarter-resolution
displacement map (`DISP_SCALE`) and a hand-rolled bilinear resample loop — are
unnecessary on the GPU. `LINEAR` texture filtering plus `CLAMP_TO_EDGE`
wrapping (set once on the source texture) give bilinear sampling and edge-clamping
for free.

Control pairs (`{init, curr}`, from bound handles + shape-perimeter samples +
zero-displacement boundary anchors) are passed as a plain `vec4[64]` uniform
array rather than a data texture — simpler, and sized well above WarpLayer's
actual worst case (5 handles + 16 shape samples + 32 boundary anchors = 53).
`WARP_MAX_PAIRS = 64` in `WarpGL.ts` is a hard cap: `apply()` silently drops
any pairs beyond it. The fragment shader loops over a constant bound
(`WARP_MAX_PAIRS`) with a runtime `break` at `uCount`, the same
constant-loop-bound-plus-dynamic-exit idiom `FilterGL.ts`'s `blur_h`/`blur_v`
shaders already use for their runtime-variable radius.

### `PointLayer` — per-axis `xSlot`/`ySlot` override

`PointLayer` no longer has a `Point`-typed input slot for being driven by
another `PointSource` (removed — a "relay/tap" binding turned out to have no
real use case, since anything that already produces a combined `Point` can
just be bound directly wherever the point is consumed). It still implements
`PointSource` and remains freely usable as an output for other layers to
bind to — only the ability to be driven *by* another Point source was
removed.

In its place: `xSlot`/`ySlot` (`Amount`, `[0,1]` scaled to
`Node.canvasWidth`/`canvasHeight`), for driving each axis from an
independent scalar source (e.g. two unrelated LFOs) rather than requiring
one upstream layer that already produces a full `Point`. Position priority,
highest first (each stage wins outright over what's below it, mirroring the
shape-slot check already in `recompute()`): (1) `xSlot`/`ySlot` per-axis
override — either or both may be bound independently; (2) wander-mode
simulation; (3) free drag. An axis pinned by a bound `xSlot`/`ySlot` ignores
drag input for that axis only (`setPoint()` only writes the unbound axis/axes),
so a partially-bound handle (e.g. x bound, y free) can still be dragged along
its free axis without the bound axis visibly fighting the drag before the
next `recompute()` pins it back anyway. Rendered as a two-row pill (x, y)
directly below `canvasBounds`, above the shape-reference and wander pills —
unchanged in every other respect (shape-reference mode, wander sim,
mask-tracking, etc. — see the file's own header comment for the full
picture).

### `CollectionLayer` — row/column grid layout, viewport-aware reflow, eject-all

The thumbnail grid (`_gridBounds()`) supports two layout modes via a
per-instance `_layout: 'row' | 'column'` field, toggled by a header button
(persisted in `serializeState`/`deserializeState`):
- **row** (default) — fills a row left-to-right before wrapping to a new
  row below; grid grows downward as items are added.
- **column** — the transpose: fills a column top-to-bottom before wrapping
  to a new column to the right; grid grows rightward instead.

Either way, array index 0 — the earliest-ingested item, i.e. originally
**topmost** in the main stack, since the `'c'` key ingests top-down (see
`postInsertLayer`/`interaction.setCollectionAction` in `main.ts`) — sits at
the grid's top-left in both layouts, and stays there as later items are
added around it (no more "newest ingested jumps to the front" reversal).
**Composite render order in `recompute()` is the *reverse* of this array
order** (index 0 drawn *last*): this is what keeps index 0 frontmost in the
actual pixel output, matching where it was in the original stack, even
though it's *first* in ingestion/array/grid-reading order. Don't "fix" one
side without the other — the grid position and the z-order are
deliberately opposite ends of the same array for exactly this reason. See
the `items` getter's doc comment for the full reasoning, and `_cellOrigin`/
`_computeDropIdx`/`_commitReorder` for how drag-reorder and the insertion
line stay layout-aware.

**Thumbnail size floor**: `MIN_TW === MAX_TW === 120` (and the derived
`MIN_TH`/`MAX_TH`, both 90) — thumbnails render at a fixed size regardless
of item count; once a row/column can't fit another item at that size,
`_gridBounds()` adds another row/column instead of shrinking the
thumbnail. (Previously `MIN_TW` was 60, which meant thumbnails visibly
shrank right at the wrap boundary — the point where the row/column was
almost, but not quite, full.)

**Viewport-aware reflow (desktop only)**: `_gridBounds()` and the
`canvasBounds` override source their width/height from `_layoutWidth()`/
`_layoutHeight()`, not `Node.canvasWidth`/`Node.canvasHeight` directly.
`Node.canvasWidth`/`Height` are deliberately **grow-only** (see
`Evaluator.setViewport`) so mobile's address-bar-driven viewport changes
don't constantly reflow content — but that has no benefit on desktop, and
actively breaks reflow there: after a desktop window is enlarged and then
shrunk again, `canvasWidth`/`Height` stay stuck at the larger size, so a
naive `canvasWidth`-based grid would keep sizing itself for a window that
no longer exists. `_layoutWidth()`/`_layoutHeight()` return
`Node.viewportWidth`/`Node.viewportHeight` (which track the actual current
window exactly, both growing and shrinking) on desktop, falling back to
the old `canvasWidth`/`canvasHeight`-based behaviour when
`Node.isMobileDevice`. `canvasBounds` is overridden (not just
`_gridBounds()`) so the header pill reflows in sync with the grid instead
of drifting apart — the header, index-slot row (`panelBottom`), and grid's
`leftX` are all anchored off the *same* `canvasBounds`. Deliberately left
alone: the `cw`/`ch` used for `drawLayerThumbnail`'s render-resolution
params and the composite/mask `OffscreenCanvas` sizing in `recompute()` —
those need the true full canvas size to render correctly, not the
viewport.

**Index-slot row is pinned above the grid, not below it**: `panelBottom` is
a fixed position right after the header pill
(`canvasBounds.y + canvasBounds.height + 8`), *not* derived from the
grid's own height the way most layers' `panelBottom` overrides work. This
matters specifically because the grid's height varies a lot as items are
added (especially in column layout), and a `panelBottom` tied to grid
height would make the index-binding row migrate toward the bottom of the
viewport as the collection grows. `_gridBounds()` positions the grid
*below* this same fixed row in turn (`panelBottom + INDEX_PILL_H + 8`).

**Eject-all** (`ejectAll()`) restores every ingested item back to the main
stack at once, directly above the collection, preserving order — reusing
`eject()`'s single-item `insertAbove(this)` mechanics in ascending array
order, which naturally re-stacks the whole run in its original top-to-
bottom order (each subsequent `insertAbove(this)` call lands directly
above the collection, displacing the previous insert one further up).
Fires `setEjectAllCallback(fn: (topmost) => void)` once, after every item
is back on the stack, with the restored topmost layer — `main.ts` archives
the (now-empty) collection via `deletionLayer.archive(...)` (same
non-destructive convention as the plain Delete key) and selects `topmost`.
Wired at all three real CollectionLayer creation/rewiring sites
(`postInsertLayer`, the `'c'` key handler, `wireLoadedLayer`) — any *new*
per-instance CollectionLayer callback needs the same treatment at all
three, or it'll silently work for menu-created collections and silently
not work for ones created via the `'c'` key or loaded from a save (this has
bitten this feature twice already — see "Bugfix" below).

**Bugfix found while wiring eject-all**: the slot-click "create a default
value for an empty slot" paths — both the generic
`DEFAULT_VALUE_LAYER[ValueType.Collection]` factory and
`consumer.wantsCollectionForSlot(slot)` (MaskLayer's `collectionSlot`
convenience) — never called `postInsertLayer`, so a `CollectionLayer`
created that way had **no** Save/Load/Delete/EjectAll callbacks wired at
all (silently inert buttons, not a crash). Both now call
`postInsertLayer(newLayer)`.

**Header pill is now a big-button row**, not a thin label+status-text
strip — see the Big-button mobile touch-target pass below.

## Big-button mobile touch-target pass (wound down)

Ongoing multi-session effort to replace small/cramped panel buttons with
larger ones sized for touch, started from VideoLayer/CaptureLayer's
big-button source-selector rows. Convention: local `LG_SZ`/`LG_GAP`/
`LG_MARGIN`-style constants per layer (target ~48–72px squares; shrink to a
floor on narrow panels rather than wrapping when there are few buttons,
wrap to a grid when there are more — see each layer for its choice), with
`canvasBounds`/`panelBottom` overridden to compute the panel height
dynamically instead of relying on `this.bounds.height`. Old thin
identity/status strips (small type glyph + text preview + slot-state dots)
are being removed outright where they carry no interactive controls, not
just resized.

**Done**: VideoLayer (source picker — camera/screen/file, one big button
per camera on mobile), CaptureLayer (shutter/mode/save/share), TextLayer
(edit/size row only — align row deliberately left small, not very
touch-critical for this layer), MaskLayer (removed the debug status strip;
paint/erase tool buttons enlarged to a two-row layout — see below), ImageLayer
(File/Paste/Camera acquire row, replaced by a live camera preview with a red
shutter + flip-camera control once Camera is tapped), NoiseLayer
(style-picker thumbnails replacing the type-cycle/seed-stepper row; each
button shows a live-generated-but-static preview of that style),
CountLayer/"Index" (−/+/reset), TileLayer (Tile/Fit buttons with live mode
previews; margin converted from a −/+ stepper to a bindable Amount slot +
slider, matching opacity), CollectionLayer (eject-all/layout-toggle/Save/Load
row, replacing the thin "Collect" label + "N layers" status-text strip —
same `LG_SZ=52`/wrap-to-grid choice as CaptureLayer's 4-button row, since the
status text wasn't adding anything the grid of thumbnails below doesn't
already show).

MaskLayer's tools panel is now two rows: row 1 is a 4-button grid of
touch-sized paint/erase/clear/undo buttons (`TOOL_SZ`-style constants),
wrapping into extra rows on narrow panels rather than shrinking — same
tradeoff as CaptureLayer's mode/shutter/save/share row, not CountLayer's
shrink-to-floor. Row 2 holds brush presets (three round-shape size swatches
plus a square-brush and a slanted-line/calligraphy-brush swatch — `BrushShape
= 'round' | 'square' | 'line'`, `_applyBrush`'s stamp function switches on
it) and the brush-size slider, which flexes to fill the remaining row width.
Clear now snapshots undo state before wiping (same as a brush stroke), so
`[↺]` undoes a clear, not just the last stroke; `[↺]` falls back to a full
reset (clear + unbind all shape slots) once there's nothing left to undo.

**Deliberately skipped** — the point of this pass was mobile usability, and
none of these are worth the effort on that basis:
- SequencerLayer — its `[−] value [+]` stepper (20×20) has the same small
  shape CountLayer had before this pass, but the layer isn't in
  `MenuLayer`'s button list and hasn't been since before this effort started
  (`MenuLayer.ts` even has a comment calling it low-utility) — it's only
  reachable by loading an old saved session that already contains one, so a
  touch-target fix has no live audience. Still registered in
  `LAYER_CLASSES` so old saves keep loading.
- BindingMapLayer — 24×24 toggle/delete pairs, repeated per row in a
  node-diagram. The diagram-editing interaction itself isn't practically
  usable on a phone screen regardless of button size, so resizing the
  buttons wouldn't move the needle.
- ClockLayer — play/pause + reset, already reasonably spaced with only 2
  buttons; no real problem to fix.

## Status/readout pill removal pass (done)

Many layers drew a narrow, read-only "status" pill above the value-binding
controls (shape dimensions, rotation angle, current coordinates, etc.) that
restated information the user was already controlling elsewhere and didn't
help operate the layer. All 13 candidates have been reviewed; full per-item
notes and reasoning: `spec/status-pill-candidates.md`.

Removed: ShapeLayer (Rect/Ellipse), PathLayer, AnimPathLayer,
AnimationPathLayer, DirectionLayer, PointLayer, TransformLayer, TraceLayer
(status text only — the DETECT button and pill background stayed). Kept
after review: DeletionLayer, ClockLayer, ColourLayer (hex readout stays,
slot-indicator dots removed), TempoLayer (relocated and simplified rather
than removed). Skipped as dead code: RotateLayer (unreachable — no menu
button constructs one anymore).

## Live-performance hotspot indicator (in progress)

Infrastructure so a performer using Palimpsest live on stage can notice, at
a glance, when a layer (or a binding chain feeding it) is dominating
per-frame recompute cost — without stopping to read numbers. Full design
rationale, revision history, and next steps: `spec/live-performance-hotspots.md`.

Constraints driving the design: no animation/pulsing (Palimpsest follows
the live-coding convention that the audience sees the same screen as the
performer, so signals are static, not motion); two-stage design — a
fixed-position "notice" signal (the top strip) separate from an in-place
"locate" signal (card/thumbnail glow). The two signals use **different**
metrics: card/thumbnail glow stays rank-relative (`hotspotWorst` in
`src/interaction/hotspot.ts` — which layer's `evalCostMs` dominates a
group's total, as a `[0,1]` share rescaled so an even split maps to `0`),
while the strip is an **absolute**, FPS-anchored quantity per explicit
request. Shared constants/math/glow-rendering live in `hotspot.ts` (not
`LayerStackWidget.ts` alone) because `DeletionLayer` needs the identical
machinery for the Background collection — see below.

**Shipped**: `Node.evalCostMs` — an EMA of each node's own `recompute()`
self-time, timed in `Node.evaluate()` around the `recompute()` call only
(dependencies are evaluated earlier in the same method, so their cost is
already excluded without extra bookkeeping).

The top strip (`_drawCurrentLabel`) is a level-meter **load bar**: plain
grey background, with a bar of colour `HOTSPOT_RGB` growing from the left
edge as `_hotspotBarFraction()` rises. That fraction sums `evalCostMs`
across every `_hotspotCandidates()` layer (total, not worst-single-layer —
what costs frame rate is the sum of every dirty layer's recompute() that
frame, spread across one layer or several) and maps it linearly from `0`
at `HOTSPOT_BAR_START_MS` (≈33ms, a 30fps floor) to `1` at
`HOTSPOT_BAR_JERKY_MS` (100ms, a 10fps ceiling — "video looks very jerky
around here," calibrated directly to that request). Went through two
earlier revisions, both found by live testing: v1 was a binary threshold
(on/off snap, too subtle to notice); v2 was a continuous grey→red *hue*
gradient driven by the same rank-relative share the card glow uses — an
improvement, but still imprecise to read, and rank-relative share doesn't
actually answer "is this costing me frame rate" (several moderately
expensive layers with no single dominant one could read as fine while
genuinely hurting FPS). v3 (current) is the fixed-hue bar above.

`_drawCard` casts a matching static halo around whichever card
`_hotspotState()` currently names as worst — the "locate" half — using the
*same technique* as the card's own drop shadow immediately above it in the
code: a `fillRect` with `shadowColor`/`shadowBlur` set and `shadowOffset`
zero, `ctx.restore()`'d before the thumbnail is drawn over it, so only the
shadow's outward gaussian bleed is ever visible (true soft falloff, inner
edge flush with the card, same as the drop shadow). Drawn *after* the drop
shadow so it composites on top, and — since it's cast from the card's own
bounds as an ordinary part of `_drawCard`, not a final overlay — whichever
card is stacked above this one in the same `render()` loop naturally paints
over the glow's bleed for the region it occupies, same as it already does
for the drop shadow. Colour is fixed at `HOTSPOT_RGB` — the same constant
the strip's bar now uses, so the two signals read as visually related —
and `_hotspotLoad` drives only opacity, not hue, on the same "brightness
reads more clearly than colour" feedback that shaped the strip's v3.
Visibility is gated on `_hotspotBarFrac > 0` (the strip's threshold), not
`_hotspotLoad > 0` (rank-relative share) — the glow only appears once the
strip's bar has actually started rising, so a "worst" layer with
negligible absolute cost (e.g. two trivial layers on an otherwise-empty
canvas) no longer lights up despite being nowhere near hurting frame rate.
Both quantities are cached once per `render()` call, so gating on one and
driving intensity from the other is free. (Card glow was itself revised
twice before this: v1 was a `strokeRect` at the card's exact edge,
invisible because this stack is an overlapping card fan — see `_hitTest`'s
own comment — where only the current/topmost cards show their full body;
v2 moved to a final-overlay pass to force full visibility, which fixed
that but made the glow ignore the stack's own occlusion order entirely.)

`_hotspotCandidates()` excludes permanent chrome layers (`Layer.hotspotExempt`,
overridden on `RootLayer`, `MenuLayer`, `DeletionLayer`) from both the bar's
sum and the glow's ratio — without this, `RootLayer`/`MenuLayer`'s
structurally near-zero recompute cost made any single real content layer
read as ~100% of the stack's cost immediately, a measurement artifact
rather than a genuine hotspot.

**Background collection is folded in, not forgotten.** `Layer.backgroundCostMs`
(`src/core/Layer.ts`, default `0`) is a generic hook for a layer that
maintains its own off-stack collection with an ongoing cost of its own;
`DeletionLayer` overrides it to sum `evalCostMs` across the Background
collection's items (self-perpetuating — see "Self-perpetuating recompute"
above — so this is real, ongoing cost, not a one-off). Two consequences:
(1) `LayerStackWidget._hotspotBarFraction()` adds every on-stack layer's
`backgroundCostMs` into the strip's total before converting to a fraction,
so sending an expensive layer to Background to declutter the stack no
longer makes the strip go quiet — the cost didn't go away, it just left
the visible stack. (2) `_drawCard`'s hotspot block gained a second trigger
alongside the on-stack one: `DeletionLayer`'s own card glows once
`hotspotBarFraction(layer.backgroundCostMs)` clears the same threshold, and
— once you've opened it, on the Background tab — `DeletionLayer._drawGrid`
casts the identical glow (via the shared `drawHotspotGlow`, `radius = 6` to
match its rounded cards) onto whichever specific item is worst *within*
the collection. Deliberately scoped to the Background collection only, not
`DeletionLayer`'s own archive (which also keeps evaluating its contents) —
scoped to what was actually asked for; the archive is a documented,
not-yet-built follow-up using the exact same `hotspot.ts` machinery.

**`BindingMapLayer` source-vs-consumer glow** — its diagram pill (one
source thumbnail, one per bound consumer) glows whichever single node
`hotspotWorst([source, ...consumers])` names as worst, via the same shared
`drawHotspotGlow`. Unlike every other hotspot glow, **no absolute-cost
threshold gate** — this diagram is opened deliberately to inspect one
source's bindings, not glanced at ambiently, so any non-zero cost
difference is surfaced immediately (`hotspotWorst` already stays quiet
when everything in the diagram costs nothing). This required generalizing
`hotspot.ts`'s `sumEvalCost`/`hotspotWorst` from `Layer` to `Node`
(`evalCostMs` lives on `Node`, and `ParameterSlot.owner` — a
`BindingMapLayer` consumer — is typed `Node`, not `Layer`);
`LayerStackWidget._hotspotState()` casts back to `Layer` at its one
call site rather than threading `Node` through its own fields for no
benefit there.

**`CollectionLayer` per-item glow** — same "which item inside is worst"
question as `DeletionLayer`'s Background tab, applied to
`CollectionLayer._drawGrid`'s own thumbnail grid, gated the same way
(`hotspotBarFraction(sumEvalCost(this._layers)) > 0`). No
`backgroundCostMs`-equivalent hook needed here: `CollectionLayer` is an
ordinary on-stack layer whose `recompute()` calls `layer.evaluate()` on
its ingested items *synchronously inside* the timed call, so its own
`evalCostMs` already includes every item's cost and its stack card already
glows via the existing on-stack path — only the "locate the specific item"
half was missing.

**Not started**: click-to-jump from the strip/glow to select the offender;
folding `DeletionLayer`'s archive (not just Background) into
`backgroundCostMs`.

## Debug names (layer labels)

`debugName` is the friendly label shown in the stack-widget top strip
(`LayerStackWidget._drawCurrentLabel`), the thumbnail card/collection grid
(`interaction/thumbnail.ts`), and the binding inspector — normally assigned
once at creation via `Layer.assignDebugName` ("`<Type> N`", a session-wide
counter, see "Adding a new layer type" above) and never touched again.
Three features layer on top of that baseline:

**`TextLayer` content-derived naming** — `TextLayer.debugName` is instead
re-derived from its own text every `recompute()` via the private
`_syncDebugName()`: whitespace/newlines collapsed to single spaces, trimmed,
then truncated to the first 10 characters + `…` if longer (falling back to
`'TextLayer'` for empty content). This lets multiple text layers be told
apart at a glance in the stack widget instead of all reading "TextLayer".
`deserializeState` also calls `_syncDebugName()` directly (rather than
waiting for the first post-load `recompute()`) so a freshly loaded
`TextLayer`'s name is correct immediately, before anything (e.g. the
collision check below) might read it.

**Load-time debugName collision check** (`main.ts`) — `deserializeCollection`
already gives every instantiated layer a fresh, session-unique "Type N" name
via `assignDebugName` (see "Collection save/load" above), which structurally
can't collide with anything already live. `TextLayer`'s content-derived name
is the one exception — two text layers with the same (or same-first-10-char)
content collide no matter when either was created. `resolveDebugNameCollisions
(newLayers)` is the general-purpose safety net for this: run once per
load/merge batch (both `handleLoadCollection` — the Load button merging a
file into an existing `CollectionLayer` — and the OS-drop `.json`
collection-load path), it groups every layer currently in the graph (old and
new) by base name (`debugNameBase`, strips a trailing `" (x)"` suffix), and
for any group containing at least one newly loaded layer, assigns the next
free letter suffix to every still-plain-named member — preferring an
already-live layer for `" (a)"` since `graph.nodes` (a `Set`, so insertion
order) puts it before anything just loaded; the second colliding layer gets
`" (b)"`, and so on. A layer that already carries a valid suffix (from an
earlier collision) keeps it. Recurses into nested `CollectionLayer.items`
(`flattenLayersForNameCheck`), matching `wireLoadedLayer`'s own recursion —
a collision inside a nested collection is just as confusing as one at the
top level.

Setting the suffix has to go through `setLayerDebugName`'s
`instanceof TextLayer` branch rather than a plain `debugName +=`: a
`TextLayer`'s name is overwritten wholesale by `_syncDebugName()` next
frame, so the suffix wouldn't survive a direct append. `TextLayer` exposes
`setDebugNameSuffix(suffix)` for this, which stores it in `_debugNameSuffix`
and folds it into every future `_syncDebugName()` call; every other layer
type's `debugName` is a one-time assignment, so setting it directly is
permanent.

**In-place rename (authoring feature)** — for naming layers in a
particularly complex stack, clicking the top-left name label itself (the
strip `_drawCurrentLabel` draws, anywhere left of the `?` help button) turns
it into an editable field (`LayerStackWidget._editingLabel` /
`_labelEditText` / `_labelCursorPos`), seeded with the selected layer's
current `debugName`. Typing edits it in place (Backspace/Delete/arrow
keys/Home/End all work, drawn with a caret via `ctx.measureText`); **Enter or
Tab commits**, **Escape cancels**. A click anywhere else — inside the widget
strip (handled in `LayerStackWidget.handlePointerDown`) or out on the canvas
content (handled in `InteractionSystem._handleDown`, gated on
`!_inWidgetStrip(e.clientX)`) — also commits first, same "blur commits"
behaviour as an ordinary HTML text input, via the shared public
`commitLabelEdit()`.

Duck-typed like `TextLayer`'s own in-place text editing (see
`isTextEditActive`/`handleTextEditKey` under "Interaction" above), but at
the *widget* level rather than per-layer: `LayerStackWidget.isLabelEditActive()`
/ `handleLabelEditKey(e)` are checked by `InteractionSystem._handleKey`
**before** every other branch, including the per-layer text-edit check and
every global hotkey (space, delete, `m`, `h`, ...) — while the field is
open, every keydown is consumed and `e.preventDefault()`'d, so typing a
letter that happens to also be a shortcut never fires it. Committing calls
`layer.debugName = name` directly for most layer types; for a `TextLayer`
specifically it calls `setManualDebugName(name)` instead, which makes
`_syncDebugName()` prefer the author's chosen name over the content-derived
one outright (still with `_debugNameSuffix` applied on top) — a deliberate
identifier the user picked for navigating a complex stack shouldn't get
silently overwritten by the next keystroke in that layer's own text. There
is currently no way to revert a `TextLayer` back to automatic content-derived
naming once a manual name is set.

## Content marshalling panel (performance-prep)

`src/interaction/MarshallingPanel.ts` — a small floating DOM panel holding a
one-time snapshot of an OS folder's images/video/JSON files, so a performer
running Palimpsest full-screen (which hides the OS desktop and any file
manager) can still drag prepared content onto the canvas. Populated in
advance of a show; not a live/synced view of the folder.

**Trigger**: MenuLayer's existing Load button, not a new button. Clicking
Load toggles a small in-place choice — the Load/Save slots in the Control
column's bottom row temporarily swap to "Session"/"Folder" (`MenuLayer.
_loadChoiceOpen`, substituted into `_drawGrid`'s `resolved` columns just
before rendering, so this reuses the ordinary button grid/hit-test machinery
with no new layout code). "Session" behaves exactly like the old Load
button; "Folder" calls `handleLoadFolderDesktop()` (`main.ts`), which opens
an `<input type="file" webkitdirectory multiple>` picker (typed via the
ambient `src/types/file-input-directory.d.ts`, since `webkitdirectory`/
`webkitRelativePath` aren't in TypeScript's bundled `dom` lib) and feeds the
resulting `File[]` into `marshallingPanel.load(folderName, files)`. Desktop
only — `isMobile ? null : handleLoadFolderDesktop` passed into
`setSaveLoadCallbacks`'s third argument; on mobile the choice never appears
and Load behaves exactly as before this feature. No File System Access API
and no live re-sync with the folder — deliberately a one-time snapshot,
matching "content prepared in advance of the performance."

**Why a DOM overlay, not a Layer or canvas widget**: researched three
existing non-Layer UI patterns (`LayerStackWidget`'s own overlay canvas,
`AudioScopeWidget`'s host-supplied-position delegation, and
`InteractionSystem`'s right-click binding-inspector panel) before choosing
to follow the binding-inspector's approach — a plain `document.
createElement('div')` appended to `document.body`, entirely outside the
`Evaluator` render loop and `InteractionSystem`'s pointer pipeline. The
deciding factor: a real HTML `draggable="true"` element's `dragstart`
handler can attach an actual `File` object to the native browser drag
(`DataTransfer.items.add(file)` — Chromium), so dragging a panel item over
the canvas fires the **exact same** `dragover`/`drop` listeners already
wired in `main.ts` for OS file drops, with zero duplicated placement logic:
the image/video slot-binding rules, the `LayerStackWidget` ghost-card
insert-position mechanic, the `.json` shape-dispatch between
`applyLoadedSession`/`deserializeCollection`, and the `StartupLayer`
promotion guard all apply unchanged. The panel's own header is its own drag
handle (plain `pointerdown`/`pointermove`/`pointerup` on `_header`,
independent of `InteractionSystem`) for repositioning it anywhere on
screen — this is what "floating panel" means here, not a canvas overlay.

**Cross-browser drag fallback (Safari)**: confirmed live that WebKit does
not support injecting a JS-constructed `File` into a page-initiated drag via
`items.add()` — `dataTransfer.types` comes back empty on both `dragover` and
`dragend` there, even though the same code works in Chromium. Every panel
drag therefore *also* carries a plain string id via `setData`/`getData` on a
custom MIME type, `MARSHALLING_DRAG_MIME` (`'application/x-palimpsest-
marshalled-item'`) — ordinary same-page custom-type drag data, which every
browser supports reliably. `main.ts`'s canvas `dragover` handler now accepts
either `'Files'` or this custom type in `dataTransfer.types` (calling
`preventDefault()`/setting `dropEffect` for both, but only running the
Files-specific ghost-card mechanic — `isImageOrVideoDrag`, etc. — when real
Files are present); its `drop` handler resolves the dropped `File` as
`files?.[0] ?? marshallingPanel.getFileForDrag(dragId)`, falling back to a
lookup on the panel's own item list when `dataTransfer.files` came back
empty. `getFileForDrag` is a non-destructive lookup — removal is still
driven solely by each item's own `dragend` handler checking `dropEffect !==
'none'` (`main.ts`'s `dragover` sets `dropEffect = 'copy'` for both
channels), so item removal behaves identically regardless of which channel
actually delivered the file. If a future browser/Chromium regression
reintroduces the same failure mode, this is the mechanism to check first —
verify with a synthetic `DragEvent`/`DataTransfer` test (construct a real
`DataTransfer`, call `setData`/`items.add` from a script, dispatch
`dragstart`/`dragover`/`drop` on the actual elements) rather than assuming
from reading the code, since the browser's behavior here is what's actually
in question, not the JS logic.

**Visual design** (arrived at through several rounds of "make it more
unobtrusive" — it's meant to sit on stage without drawing audience
attention): single column of small (28×28px) square thumbnails — each one
just the image/video frame/JSON glyph with a 2-letter monogram
(`_monogramOf`, first two raw characters of the filename, uppercased —
deliberately *not* letters-only, so a performer's own numbering scheme like
`1_intro.mp4`/`2_build.mp4` stays visible as "1_"/"2_") centred on top via a
white fill + 4-directional black `text-shadow` outline (plain CSS, not
`-webkit-text-stroke`, so it renders identically everywhere and stays
legible regardless of the thumbnail's own brightness/colour). No visible
folder-name heading — the header strip is just a close button + drag
handle; the folder name is preserved only as a native hover tooltip
(`_root.title`). The whole panel is `opacity: 0.5`. Capped at
`VISIBLE_ITEMS = 4` rows (`_body`'s `max-height`, computed from
`THUMB_SIZE`/`ITEM_GAP`) with a hover-only scrollbar beyond that — the
scrollbar is real CSS injected once globally via `ensureScrollbarStyle()`
(pseudo-elements aren't reachable from inline styles), transparent
track/thumb by default and only revealing a thin 3px thumb via `.
palimpsest-marshalling-root:hover .palimpsest-marshalling-body::-webkit-
scrollbar-thumb`. **Gotcha hit while building this**: capping `_body`'s
`max-height` alone did nothing — flex children shrink to fit by default, so
all items were being squashed to fit within 4 rows' worth of height instead
of actually overflowing; each item needs `flex-shrink: 0` to hold its true
size and force genuine overflow/scroll.

**Removed on use**: dragging an item onto the canvas and having the drop
accepted (`dropEffect !== 'none'` at `dragend`) removes it from the panel.
Loading a second folder replaces the panel's contents outright (one panel
at a time). Nothing here is persisted in `Persistence.ts` — deliberately
ephemeral, re-loaded fresh each session, consistent with the one-time-
snapshot design and with browsers not allowing silent re-access to
previously-picked files anyway.

## Known issues / pre-existing tech debt

- `npm run typecheck` reports ~80 `TS2352` cast warnings throughout the codebase
  (e.g. `slot.source as AmountSource`). These are pre-existing and do not affect
  runtime behaviour — Vite transpiles without type-checking.
- `PathLayer` has a private `_dragStartPtr` field that shadows the one in
  `ShapeLayer`, causing a TS2415 error. Pre-existing.
- `MaskLayer.resize()` from the original implementation is gone; canvas size
  changes are handled automatically via `Node.canvasWidth/Height`.
- `MaskLayer` was changed from 4 fixed shape slots to one `shapeSlot` + one
  `collectionSlot` (conventionally bound to a `CollectionLayer`, whose own
  `getMask()` unions any number of ingested shapes — see `CollectionLayer.ts`).
  `Persistence.ts` restores slot bindings positionally
  (`record.slots[i]` ↔ `layer.slotList[i]`), so loading a session saved
  before this change will silently drop a MaskLayer's 2nd–4th shape binding
  and/or its invert-slot binding (the shape slot and painted/erased content
  are unaffected). No migration was written for this — accepted as a clean
  break. Clip&lt;Shape&gt; mask-tracker helpers are unaffected regardless, since
  `clipRegionSlot` is always excluded from that positional array and
  restored separately by id.
