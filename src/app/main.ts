// PalimpsestII — entry point
import { Evaluator }         from '../dataflow/Evaluator.js'
import { InteractionSystem } from '../interaction/InteractionSystem.js'
import { Layer }             from '../core/Layer.js'
import { Node }              from '../core/Node.js'
import { ValueType, SlotState } from '../core/types.js'
import { ParameterSlot }     from '../core/ParameterSlot.js'
import { rndColour }         from '../core/colour.js'
import { graph }             from '../dataflow/Graph.js'
import { BindingLayer }      from '../layers/BindingLayer.js'
import { AnimPathLayer }     from '../layers/AnimPathLayer.js'
import { ClockLayer }        from '../layers/ClockLayer.js'
import { ImageLayer }        from '../layers/ImageLayer.js'
import { RateLayer }         from '../layers/RateLayer.js'
import { RootLayer }         from '../layers/RootLayer.js'
import { MenuLayer }         from '../layers/MenuLayer.js'
import { DeletionLayer }     from '../layers/DeletionLayer.js'
import { BackgroundLayer }   from '../layers/BackgroundLayer.js'
import { AmountLayer }       from '../layers/AmountLayer.js'
import { ColourLayer }       from '../layers/ColourLayer.js'
import { PointLayer }        from '../layers/PointLayer.js'
import { DirectionLayer }    from '../layers/DirectionLayer.js'
import { CountLayer }        from '../layers/CountLayer.js'
import { EventLayer }        from '../layers/EventLayer.js'
import { MaskLayer }         from '../layers/MaskLayer.js'
import { CollectionLayer }   from '../layers/CollectionLayer.js'
import { LayerStackWidget }  from '../interaction/LayerStackWidget.js'
import { StartupLayer }      from '../layers/StartupLayer.js'
import { TutorialLayer }     from '../layers/TutorialLayer.js'
import { StrokeLayer }       from '../layers/StrokeLayer.js'
import { ClipLayer }         from '../layers/ClipLayer.js'
import type { ClipShapeLayer } from '../layers/ClipLayer.js'
import { ClipRectLayer }     from '../layers/ClipRectLayer.js'
import { ClipEllipseLayer }  from '../layers/ClipEllipseLayer.js'
import { ClipPathLayer }     from '../layers/ClipPathLayer.js'
import { ClipTextLayer }     from '../layers/ClipTextLayer.js'
import { ClipDrawingLayer }  from '../layers/ClipDrawingLayer.js'
import { RotateLayer }       from '../layers/RotateLayer.js'

// Auto-bind a phase slot to a Rate or Clock layer, creating both (a hidden
// helper RateLayer above `host`, plus a background ClockLayer) if neither
// is found nearby. Shared by AnimPathLayer and RotateLayer.
function ensurePhaseSource(host: Layer, phaseSlot: ParameterSlot): void {
  if (phaseSlot.isActive) return

  let phaseSource: RateLayer | ClockLayer | null = null
  for (let l: Layer | null = host.layerBelow; l !== null; l = l.layerBelow) {
    if (l instanceof RateLayer || l instanceof ClockLayer) { phaseSource = l; break }
  }
  if (phaseSource === null) {
    for (let l: Layer | null = host.layerAbove; l !== null; l = l.layerAbove) {
      if (l instanceof RateLayer || l instanceof ClockLayer) { phaseSource = l; break }
    }
  }

  if (phaseSource === null) {
    // The auto-created Clock is unlikely to need its own controls —
    // send it straight to the Background collection (still ticked by
    // the Evaluator every frame, recoverable via DeletionLayer's toggle)
    // rather than adding it to the visible stack.
    const clock = new ClockLayer()
    Layer.assignDebugName(clock)
    clock.bounds = { ...host.bounds }
    backgroundLayer.add(clock)

    // The Rate layer is created as a hidden helper directly above the
    // host, bound to its phase slot. It stays with the host as it moves,
    // and has no thumbnail in the stack widget unless exposed (by clicking
    // the phase slot it's bound to).
    const rate = new RateLayer(1.0)
    Layer.assignDebugName(rate)
    rate.bounds = { ...host.bounds }
    rate.insertAbove(host)
    rate.isHiddenHelper = true
    rate.helperHost = host
    host.hiddenHelper = rate

    BindingLayer.create(clock, rate.timeSlot)
    phaseSource = rate
  }

  BindingLayer.create(phaseSource, phaseSlot)
}

// All per-type setup that runs after a new layer is inserted into the stack.
// Called from both the MenuLayer onAdded callback and wireTutorialLayer so
// that every creation path (menu, tutorial buttons) gets identical behaviour.
function postInsertLayer(newLayer: Layer): void {
  if (newLayer instanceof CollectionLayer) {
    newLayer.setEjectCallback(() => refreshStack())
  }
  if (newLayer instanceof TutorialLayer) {
    wireTutorialLayer(newLayer)
  }
  if (newLayer instanceof ClipLayer) {
    wireClipLayer(newLayer)
  }
  applyDefaultBindings(newLayer)

  if (newLayer instanceof AnimPathLayer) {
    // Auto-bind shape slot to the first samplePerimeter-capable layer below.
    if (!newLayer.shapeSlot.isActive) {
      let l: Layer | null = newLayer.layerBelow
      while (l !== null) {
        if (!l.isInfrastructure && 'samplePerimeter' in l) {
          BindingLayer.create(l, newLayer.shapeSlot)
          break
        }
        l = l.layerBelow
      }
    }

    // Auto-bind phase slot to a Rate or Clock layer, creating both if needed.
    ensurePhaseSource(newLayer, newLayer.phaseSlot)
  }

  if (newLayer instanceof RotateLayer) {
    // Same phase auto-binding as AnimPathLayer.
    ensurePhaseSource(newLayer, newLayer.phaseSlot)
  }

  if (newLayer instanceof ClipRectLayer || newLayer instanceof ClipEllipseLayer || newLayer instanceof ClipPathLayer || newLayer instanceof ClipDrawingLayer) {
    // The hidden helper is a plain MaskLayer directly below the Clip layer,
    // with no handles of its own — its content tracks the Clip layer's own
    // shape mask (setMaskTracker) and is bound to maskSlot so it can be
    // exposed by clicking that (bound) slot.
    const maskHelper = new MaskLayer()
    Layer.assignDebugName(maskHelper)
    maskHelper.bounds = { ...newLayer.bounds }
    maskHelper.insertBelow(newLayer)
    maskHelper.isHiddenHelper = true
    maskHelper.helperHost = newLayer
    newLayer.hiddenHelper = maskHelper
    newLayer.helperBelow = true
    newLayer.setMaskTracker(maskHelper)

    BindingLayer.create(maskHelper, newLayer.maskSlot)
  }

  if (newLayer instanceof ClipTextLayer) {
    // Same hidden-helper pattern as the other Clip<Shape> layers, but bound
    // to clipMaskSlot — TextLayer's own (pre-existing) maskSlot is a
    // different feature (flows the glyphs inside a bound mask shape).
    const maskHelper = new MaskLayer()
    Layer.assignDebugName(maskHelper)
    maskHelper.bounds = { ...newLayer.bounds }
    maskHelper.insertBelow(newLayer)
    maskHelper.isHiddenHelper = true
    maskHelper.helperHost = newLayer
    newLayer.hiddenHelper = maskHelper
    newLayer.helperBelow = true
    newLayer.setMaskTracker(maskHelper)

    BindingLayer.create(maskHelper, newLayer.clipMaskSlot)
  }
}

// Wire a ClipLayer's bottom-row "replace with specialised Clip<Shape>"
// buttons. Pressing one creates the chosen layer at this ClipLayer's stack
// position, carries over the image binding (if any) and redirects any
// consumers of this ClipLayer's image output to the new layer, then either
// archives the old ClipLayer (recoverable via DeletionLayer, same as Delete)
// or — if it had no other bindings/manual transform worth keeping — purges
// it permanently.
function wireClipLayer(clipLayer: ClipLayer): void {
  clipLayer.setOnReplace((factory: () => ClipShapeLayer) => {
    const below = clipLayer.layerBelow
    if (below === null) return

    const newLayer = factory()
    Layer.assignDebugName(newLayer)
    newLayer.bounds = { ...clipLayer.bounds }

    // Carry over the image binding, if any.
    const imgBinding = BindingLayer.findForSlot(clipLayer.imageSlot)
    const imgSource  = imgBinding?.source ?? null
    imgBinding?.remove()

    // Redirect any layers consuming this ClipLayer's image output.
    const outBindings = [...clipLayer.dependents].filter(
      (d): d is BindingLayer => d instanceof BindingLayer,
    )

    newLayer.insertAbove(below)

    if (imgSource !== null) {
      BindingLayer.create(imgSource, newLayer.imageSlot)
    }
    for (const bl of outBindings) {
      BindingLayer.create(newLayer, bl.slot)
    }

    if (clipLayer.hasRestorableState()) {
      ensureDeletionLayerInStack()
      deletionLayer.archive(clipLayer)
    } else {
      clipLayer.removeFromStack()
      graph.unregister(clipLayer)
    }

    postInsertLayer(newLayer)
    refreshStack(newLayer)
  })
}

function wireTutorialLayer(tl: TutorialLayer): void {
  tl.setOnAdded((newLayer) => {
    Layer.assignDebugName(newLayer)
    newLayer.bounds = { x: X, y: 24, width: W, height: 36 }
    const below = tl.layerBelow
    if (below !== null) newLayer.insertAbove(below)
    postInsertLayer(newLayer)
    refreshStack(tl)   // keep TutorialLayer selected, like MenuLayer keeps itself selected
  })
}

// ------------------------------------------------------------------
// Canonical default layer for each value type — used when the user
// clicks an empty parameter slot.
// ------------------------------------------------------------------
const DEFAULT_VALUE_LAYER: Partial<Record<ValueType, (w: number, h: number) => Layer>> = {
  [ValueType.Amount]:    ()     => new AmountLayer(0.5),
  [ValueType.Colour]:    ()     => new ColourLayer(rndColour()),
  [ValueType.Point]:     (w, h) => new PointLayer({ x: w / 2, y: h / 2 }),
  [ValueType.Direction]: ()     => new DirectionLayer(0, 1),
  [ValueType.Rate]:      ()     => new RateLayer(1.0),
  [ValueType.Count]:     ()     => new CountLayer(0),
  [ValueType.Event]:     ()     => new EventLayer(),
  [ValueType.Image]:     ()     => new ImageLayer(),
  [ValueType.Mask]:      ()     => new MaskLayer(),
  [ValueType.Collection]:()     => new CollectionLayer(),
}

// Panel-height override for the canonical layer of a given type
// (mirrors MenuLayer.BUTTONS — only ColourLayer needs extra height).
const DEFAULT_VALUE_HEIGHT: Partial<Record<ValueType, number>> = {
  [ValueType.Colour]: 170,
}

// ------------------------------------------------------------------
// Canvas setup
// ------------------------------------------------------------------
const app = document.getElementById('app')!
const canvas = document.createElement('canvas')
canvas.width  = window.innerWidth
canvas.height = window.innerHeight
app.appendChild(canvas)

// ------------------------------------------------------------------
// Evaluator (drives the render loop)
// ------------------------------------------------------------------
const evaluator = new Evaluator(canvas)

// ------------------------------------------------------------------
// Initial stack: Root → MenuLayer  (DeletionLayer added on first deletion)
// ------------------------------------------------------------------
// X/W size every layer's "strip pill" (debug panel, this.bounds) — it's
// normally hidden under the LayerStackWidget. X + W must stay comfortably
// below WIDGET_MIN (120, see interaction/layout.ts) so it stays hidden even
// at the narrowest widget width, with margin for label text overflow.
const X = 8
const W = 100

const root = new RootLayer(canvas.width, canvas.height)

const deletionLayer = new DeletionLayer()
deletionLayer.bounds      = { x: X, y: 24, width: W, height: 36 }
deletionLayer.outsideStack = true   // not inserted until first deletion

// Background collection — never part of the layer stack; the Evaluator
// evaluates it directly every frame so its items keep recomputing while
// off-canvas. Browsed via DeletionLayer's toggle.
const backgroundLayer = new BackgroundLayer()
evaluator.setBackground(backgroundLayer)
deletionLayer.setBackgroundLayer(backgroundLayer)

// ------------------------------------------------------------------
// Widget, interaction, helpers
// ------------------------------------------------------------------
const widget = new LayerStackWidget(canvas)
widget.setVisible(false)   // hidden at startup; revealed when a mode is chosen
evaluator.setLayerStackWidget(widget)

const interaction = new InteractionSystem(canvas)
interaction.setLayerStackWidget(widget)
interaction.setSpaceAction(() => evaluator.toggleDisplayMode())

// Apply any auto-bind rules declared by a newly-added layer.
// Each rule names a slot and a predicate; we walk down the stack and bind
// the first non-infrastructure layer that satisfies the predicate.
function applyDefaultBindings(newLayer: Layer): void {
  for (const { slot, accepts, sendToBackgroundAfterBind } of newLayer.autoBindRules()) {
    if (slot.isActive) continue
    for (let l: Layer | null = newLayer.layerBelow; l !== null; l = l.layerBelow) {
      if (!l.isInfrastructure && !l.isHiddenHelper && accepts(l)) {
        BindingLayer.create(l, slot)
        if (sendToBackgroundAfterBind) {
          backgroundLayer.add(l)
        }
        break
      }
    }
  }
}

// Helper: refresh evaluator + widget + interaction after stack mutations.
const refreshStack = (selectLayer?: Layer) => {
  let top: Layer = root
  while (top.layerAbove !== null) top = top.layerAbove

  // Wire the first ClockLayer found — in the stack, or (failing that) in
  // the Background collection, where auto-created Clocks live — to the
  // evaluator so the render loop runs continuously while a clock is present.
  let clock: ClockLayer | null = null
  for (let l: Layer | null = top; l !== null; l = l.layerBelow) {
    if (l instanceof ClockLayer) { clock = l; break }
  }
  if (clock === null) {
    for (const item of backgroundLayer.items) {
      if (item instanceof ClockLayer) { clock = item; break }
    }
  }
  evaluator.setClock(clock)

  evaluator.setStack(top)
  widget.setStack(top)
  interaction.setStack(top)
  if (selectLayer !== undefined) widget.selected = selectLayer
}

// The lowest layer above which new user layers should be inserted.
// When DeletionLayer is in the stack it is that anchor; otherwise root is.
function lowestAnchor(): Layer { return deletionLayer.outsideStack ? root : deletionLayer }

// Ensure DeletionLayer is in the stack (inserted just above root).
// Called before any archive() so it is always visible after a deletion.
function ensureDeletionLayerInStack(): void {
  if (deletionLayer.outsideStack) {
    deletionLayer.insertAbove(root)
  }
}

// Remove DeletionLayer from the stack when the archive is empty — visibility
// tracks deletion count only, regardless of what the Background collection
// holds (those items keep recomputing via Evaluator.setBackground either
// way). A future deletion will re-add it via ensureDeletionLayerInStack().
function pruneDeletionLayerIfEmpty(): void {
  if (deletionLayer.archivedLayers.length === 0 &&
      !deletionLayer.outsideStack) {
    deletionLayer.removeFromStack()
  }
}

// MenuLayer sits at the very top.
const menuLayer = new MenuLayer(canvas.width, canvas.height, (newLayer) => {
  postInsertLayer(newLayer)
  refreshStack(menuLayer)
})
menuLayer.debugName = 'Menu'
menuLayer.bounds    = { x: X, y: 24, width: W, height: 36 }
// menuLayer is NOT inserted at startup — StartupLayer handles that.

// DeletionLayer restore: put the layer just above DeletionLayer, then refresh.
// Prune DeletionLayer itself if the archive is now empty.
deletionLayer.setRestoreCallback((layer) => {
  layer.insertAbove(deletionLayer)
  pruneDeletionLayerIfEmpty()
  refreshStack(layer)
})

// Delete key: archive the currently selected layer into DeletionLayer.
interaction.setDeleteAction(() => {
  const layer = widget.selected
  if (layer === null || layer === deletionLayer || layer === root || layer === menuLayer) return
  let below: Layer | null = layer.layerBelow
  while (below !== null && below.isInfrastructure) below = below.layerBelow
  // If this is the bottom-most layer (nothing but Root below it), focus
  // moves up to the layer above rather than down to Root/DeletionLayer.
  if (below === root) below = null
  const above = layer.layerAbove
  ensureDeletionLayerInStack()
  const nextSel = below ?? above ?? deletionLayer
  deletionLayer.archive(layer)
  refreshStack(nextSel)
})

// 'b' key: move the selected layer into the Background collection — it
// keeps recomputing every frame (so downstream bindings stay live) but is
// removed from the main stack and never rendered. Browsed via DeletionLayer's
// toggle; restore/purge use the same callbacks as the Deleted archive.
interaction.setBackgroundAction(() => {
  const layer = widget.selected
  if (layer === null || layer === deletionLayer || layer === root ||
      layer === menuLayer || layer === backgroundLayer) return
  let below: Layer | null = layer.layerBelow
  while (below !== null && below.isInfrastructure) below = below.layerBelow
  // If this is the bottom-most layer (nothing but Root below it), focus
  // moves up to the layer above rather than down to Root.
  if (below === root) below = null
  const above = layer.layerAbove
  const nextSel = below ?? above ?? lowestAnchor()
  backgroundLayer.add(layer)
  refreshStack(nextSel)
})

// 'm' key: bring the Menu layer to immediately above the current layer and
// select it, so new layers can be added in context next to the current work.
interaction.setMenuFocusAction(() => {
  const layer = widget.selected
  if (layer === null || layer === menuLayer) return
  menuLayer.removeFromStack()
  const target = (layer.hiddenHelper !== null && !layer.helperBelow) ? layer.hiddenHelper : layer
  menuLayer.insertAbove(target)
  refreshStack(menuLayer)
})

// 'c' key — collect the layer below into a CollectionLayer.
//
// First press: create a Collection above the selected layer, ingest the
//              selected layer into it, and select the Collection.
//
// Subsequent presses: selected layer IS already a CollectionLayer — ingest
//                     the next non-infrastructure layer below it.
interaction.setCollectionAction(() => {
  const selected = widget.selected
  if (selected === null || selected === menuLayer || selected === deletionLayer || selected === root) return

  if (selected instanceof CollectionLayer) {
    // Find the next ingestable layer below the collection.
    let below: Layer | null = selected.layerBelow
    while (below !== null && below.isInfrastructure) below = below.layerBelow
    if (below === null || below === deletionLayer || below === root) return
    selected.ingest(below)
    refreshStack(selected)
  } else {
    // Create a new Collection, position it where the selected layer is.
    const collection = new CollectionLayer()
    Layer.assignDebugName(collection)
    collection.bounds = { x: X, y: 24, width: W, height: 36 }
    collection.setEjectCallback(() => refreshStack())
    // Insert above the selected layer so it takes its stack position,
    // then ingest the selected layer (removes it from the stack).
    collection.insertAbove(selected)
    collection.ingest(selected)
    refreshStack(collection)
  }
})

interaction.setBoundCallback((source, slot) => {
  BindingLayer.create(source, slot)
  refreshStack()
})

// Click on a parameter-slot row:
//   • Empty slot  — create a new layer of the slot's canonical default
//                    type, insert it above the consumer, bind it, and
//                    select it.
//   • Bound slot  — select the layer that feeds it, restoring it from
//                    the Deleted archive (above the consumer) or the
//                    Background collection (below the consumer) if needed.
interaction.setSlotClickCallback((consumer, slot) => {
  if (slot.state === SlotState.Unbound) {
    if (slot.type === null) return

    // StrokeLayer start/end slots: initialise the new PointLayer at the
    // actual stroke endpoint so the binding is a no-op by default.
    if (consumer instanceof StrokeLayer && slot.type === ValueType.Point) {
      const pos = slot === consumer.startSlot
        ? consumer.getStrokeStart()
        : slot === consumer.endSlot
          ? consumer.getStrokeEnd()
          : null
      if (pos !== null) {
        const newLayer = new PointLayer(pos)
        Layer.assignDebugName(newLayer)
        newLayer.bounds = { x: X, y: 24, width: W, height: 36 }
        newLayer.insertAbove(consumer)
        BindingLayer.create(newLayer, slot)
        refreshStack(newLayer)
        return
      }
    }

    // DirectionLayer position/handle slots: initialise the new PointLayer
    // at the dial's current centre / control-handle position so the
    // binding is a no-op by default.
    if (consumer instanceof DirectionLayer && slot.type === ValueType.Point) {
      const pos = slot === consumer.positionSlot
        ? consumer.getDialPosition()
        : slot === consumer.handleSlot
          ? consumer.getHandlePosition()
          : null
      if (pos !== null) {
        const newLayer = new PointLayer(pos)
        Layer.assignDebugName(newLayer)
        newLayer.bounds = { x: X, y: 24, width: W, height: 36 }
        newLayer.insertAbove(consumer)
        BindingLayer.create(newLayer, slot)
        refreshStack(newLayer)
        return
      }
    }

    const factory = DEFAULT_VALUE_LAYER[slot.type]
    if (factory === undefined) return

    const newLayer = factory(canvas.width, canvas.height)
    Layer.assignDebugName(newLayer)
    newLayer.bounds = { x: X, y: 24, width: W, height: DEFAULT_VALUE_HEIGHT[slot.type] ?? 36 }
    newLayer.insertAbove(consumer)
    BindingLayer.create(newLayer, slot)
    refreshStack(newLayer)
    return
  }

  const source = slot.source
  if (!(source instanceof Layer)) return

  // Clicking the slot a hidden helper is bound to exposes it: it becomes
  // a normal layer with a thumbnail at its current stack position, and
  // permanently stops moving together with its host.
  if (source.isHiddenHelper) {
    if (source.helperHost !== null) source.helperHost.hiddenHelper = null
    source.helperHost = null
    source.isHiddenHelper = false
  }

  if (source.outsideStack) {
    if (deletionLayer.removeFromArchive(source)) {
      source.insertAbove(consumer)
      pruneDeletionLayerIfEmpty()
    } else if (backgroundLayer.removeItem(source)) {
      source.insertBelow(consumer)
    }
  }
  refreshStack(source)
})

interaction.setRefreshCallback(() => refreshStack())

// Permanently remove a layer from the archive and clear any bindings that
// still source from it.  We snapshot dependents before iterating because
// each BindingLayer.remove() call modifies the set in-place.
deletionLayer.setPurgeCallback((layer) => {
  const bls = [...layer.dependents].filter(d => d instanceof BindingLayer)
  for (const bl of bls) (bl as BindingLayer).remove()
  pruneDeletionLayerIfEmpty()
  refreshStack()
})

// ------------------------------------------------------------------
// Startup layer — shown instead of MenuLayer at launch.
// ------------------------------------------------------------------

const startupLayer = new StartupLayer(
  // "Menu" button: show widget, insert MenuLayer, remove startup, refresh.
  () => {
    widget.setVisible(true)
    startupLayer.removeFromStack()
    menuLayer.insertAbove(root)
    refreshStack(menuLayer)
  },
  // "Tutorial" button: show widget, insert MenuLayer + TutorialLayer, refresh.
  () => {
    widget.setVisible(true)
    startupLayer.removeFromStack()
    menuLayer.insertAbove(root)
    const tl = new TutorialLayer()
    Layer.assignDebugName(tl)
    tl.bounds = { x: X, y: 24, width: W, height: 36 }
    wireTutorialLayer(tl)
    tl.insertAbove(menuLayer)
    refreshStack(tl)
  },
)
startupLayer.bounds = { x: X, y: 24, width: W, height: 36 }
startupLayer.insertAbove(root)

refreshStack(startupLayer)

// ------------------------------------------------------------------
// Drag-and-drop image loading — always creates a new ImageLayer
// ------------------------------------------------------------------
//
// Placement rules:
//   • Dragged over the LayerStackWidget → a placeholder card opens a gap
//     at the pointer position and follows it, exactly like reordering an
//     existing layer's thumbnail; dropping inserts the new ImageLayer at
//     that position in the stack and selects it.
//   • MenuLayer selected      → new layer inserted below MenuLayer
//   • Drop on Image slot, or
//     current layer has an
//     empty Image slot        → new layer inserted below current layer,
//                                bound to that slot; current layer stays selected
//   • Otherwise                → new layer inserted above current layer,
//                                new layer becomes selected

// Placeholder ImageLayer for a drag currently hovering the stack widget —
// not yet linked into the live stack (outsideStack) until the drop commits.
let fileDragGhost: ImageLayer | null = null

canvas.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'

  const pt = { x: e.offsetX, y: e.offsetY }

  if (widget.inBounds(pt)) {
    if (Node.fileDragActive) {
      Node.fileDragActive = false
      Node.scheduleFrame?.()
    }
    if (fileDragGhost === null) {
      fileDragGhost = new ImageLayer()
      Layer.assignDebugName(fileDragGhost)
      fileDragGhost.bounds = { ...menuLayer.bounds }
      widget.beginExternalDrag(fileDragGhost, pt)
    } else {
      widget.updateExternalDrag(pt)
    }
    return
  }

  if (fileDragGhost !== null) {
    widget.cancelExternalDrag()
    graph.unregister(fileDragGhost)
    fileDragGhost = null
  }

  if (!Node.fileDragActive) {
    Node.fileDragActive = true
    Node.scheduleFrame?.()
  }
})

canvas.addEventListener('dragleave', () => {
  if (fileDragGhost !== null) {
    widget.cancelExternalDrag()
    graph.unregister(fileDragGhost)
    fileDragGhost = null
  }
  if (Node.fileDragActive) {
    Node.fileDragActive = false
    Node.scheduleFrame?.()
  }
})

canvas.addEventListener('drop', (e) => {
  e.preventDefault()
  Node.fileDragActive = false

  const file = e.dataTransfer?.files[0]

  if (fileDragGhost !== null) {
    const ghost = fileDragGhost
    fileDragGhost = null
    if (file) {
      widget.commitExternalDrag()
      ghost.loadFile(file)
      refreshStack(ghost)
    } else {
      widget.cancelExternalDrag()
      graph.unregister(ghost)
    }
    return
  }

  if (!file) return

  const dropPoint  = { x: e.offsetX, y: e.offsetY }
  const selected   = widget.selected

  const newLayer = new ImageLayer()
  Layer.assignDebugName(newLayer)
  newLayer.bounds    = { ...menuLayer.bounds }

  let targetSlot: ParameterSlot | null = null

  if (selected instanceof MenuLayer) {
    // Place below MenuLayer.
    const below = menuLayer.layerBelow
    newLayer.insertAbove(below ?? lowestAnchor())
  } else if (selected !== null) {
    const hitSlot = selected.hitTestSlot(dropPoint)
    const slot = (hitSlot !== null && hitSlot.type === ValueType.Image)
      ? hitSlot
      : selected.findEmptySlot(ValueType.Image)

    if (slot !== null) {
      // Dropped onto an Image-type slot, or the current layer has an empty
      // image slot — insert below selected, then bind.
      targetSlot = slot
      newLayer.insertAbove(selected.layerBelow ?? lowestAnchor())
    } else {
      // Default: insert above current layer.
      newLayer.insertAbove(selected)
    }
  } else {
    newLayer.insertAbove(lowestAnchor())
  }

  newLayer.loadFile(file)

  if (targetSlot !== null) {
    BindingLayer.create(newLayer, targetSlot)
  }

  refreshStack(targetSlot !== null ? selected! : newLayer)
})

// ------------------------------------------------------------------
// Resize
// ------------------------------------------------------------------
window.addEventListener('resize', () => {
  evaluator.resize(window.innerWidth, window.innerHeight)
  root.resize(window.innerWidth, window.innerHeight)
})
