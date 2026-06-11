// PalimpsestII — entry point
import { Evaluator }         from '../dataflow/Evaluator.js'
import { InteractionSystem } from '../interaction/InteractionSystem.js'
import { Layer }             from '../core/Layer.js'
import { ValueType, SlotState } from '../core/types.js'
import { ParameterSlot }     from '../core/ParameterSlot.js'
import { BindingLayer }      from '../layers/BindingLayer.js'
import { AnimPathLayer }     from '../layers/AnimPathLayer.js'
import { ClockLayer }        from '../layers/ClockLayer.js'
import { ImageLayer }        from '../layers/ImageLayer.js'
import { RateLayer }         from '../layers/RateLayer.js'
import { RootLayer }         from '../layers/RootLayer.js'
import { MenuLayer }         from '../layers/MenuLayer.js'
import { DeletionLayer }     from '../layers/DeletionLayer.js'
import { AmountLayer }       from '../layers/AmountLayer.js'
import { ColourLayer }       from '../layers/ColourLayer.js'
import { PointLayer }        from '../layers/PointLayer.js'
import { DirectionLayer }    from '../layers/DirectionLayer.js'
import { CountLayer }        from '../layers/CountLayer.js'
import { EventLayer }        from '../layers/EventLayer.js'
import { MaskLayer }         from '../layers/MaskLayer.js'
import { CollectionLayer }   from '../layers/CollectionLayer.js'
import { LayerStackWidget }  from '../interaction/LayerStackWidget.js'

// ------------------------------------------------------------------
// Canonical default layer for each value type — used when the user
// clicks an empty parameter slot.
// ------------------------------------------------------------------
const DEFAULT_VALUE_LAYER: Partial<Record<ValueType, (w: number, h: number) => Layer>> = {
  [ValueType.Amount]:    ()     => new AmountLayer(0.5),
  [ValueType.Colour]:    ()     => new ColourLayer({ r: 1, g: 0.42, b: 0.17, a: 1 }),
  [ValueType.Point]:     (w, h) => new PointLayer({ x: w / 2, y: h / 2 }),
  [ValueType.Direction]: ()     => new DirectionLayer(0, 0.7),
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
// Initial stack: Root → DeletionLayer → MenuLayer
// ------------------------------------------------------------------
const X = 40
const W = 260

const root = new RootLayer(canvas.width, canvas.height)

const deletionLayer = new DeletionLayer()
deletionLayer.bounds = { x: X, y: 24, width: W, height: 36 }
deletionLayer.insertAbove(root)

// ------------------------------------------------------------------
// Widget, interaction, helpers
// ------------------------------------------------------------------
const widget = new LayerStackWidget(canvas)
evaluator.setLayerStackWidget(widget)

const interaction = new InteractionSystem(canvas)
interaction.setLayerStackWidget(widget)
interaction.setSpaceAction(() => evaluator.toggleDisplayMode())

// Apply any auto-bind rules declared by a newly-added layer.
// Each rule names a slot and a predicate; we walk down the stack and bind
// the first non-infrastructure layer that satisfies the predicate.
function applyDefaultBindings(newLayer: Layer): void {
  for (const { slot, accepts, removeAfterBind } of newLayer.autoBindRules()) {
    if (slot.isActive) continue
    for (let l: Layer | null = newLayer.layerBelow; l !== null; l = l.layerBelow) {
      if (!l.isInfrastructure && accepts(l)) {
        BindingLayer.create(l, slot)
        if (removeAfterBind) deletionLayer.archive(l)
        break
      }
    }
  }
}

// Helper: refresh evaluator + widget + interaction after stack mutations.
const refreshStack = (selectLayer?: Layer) => {
  let top: Layer = menuLayer
  while (top.layerAbove !== null) top = top.layerAbove

  // Wire the first ClockLayer found in the stack to the evaluator so the
  // render loop runs continuously while a clock is present.
  let clock: ClockLayer | null = null
  for (let l: Layer | null = top; l !== null; l = l.layerBelow) {
    if (l instanceof ClockLayer) { clock = l; break }
  }
  evaluator.setClock(clock)

  evaluator.setStack(top)
  widget.setStack(top)
  interaction.setStack(top)
  if (selectLayer !== undefined) widget.selected = selectLayer
}

// MenuLayer sits at the very top.
const menuLayer = new MenuLayer(canvas.width, canvas.height, (newLayer) => {
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
    if (!newLayer.phaseSlot.isActive) {
      // Search the whole stack for the first Rate or Clock layer.
      let phaseSource: RateLayer | ClockLayer | null = null
      for (let l: Layer | null = newLayer.layerBelow; l !== null; l = l.layerBelow) {
        if (l instanceof RateLayer || l instanceof ClockLayer) { phaseSource = l; break }
      }
      if (phaseSource === null) {
        for (let l: Layer | null = newLayer.layerAbove; l !== null; l = l.layerAbove) {
          if (l instanceof RateLayer || l instanceof ClockLayer) { phaseSource = l; break }
        }
      }

      // If neither exists, create Clock → Rate and use Rate as the phase source.
      if (phaseSource === null) {
        const below = newLayer.layerBelow
        const clock = new ClockLayer()
        Layer.assignDebugName(clock)
        clock.bounds = { ...newLayer.bounds }
        if (below !== null) clock.insertAbove(below)

        const rate = new RateLayer(1.0)
        Layer.assignDebugName(rate)
        rate.bounds = { ...newLayer.bounds }
        rate.insertAbove(clock)

        BindingLayer.create(clock, rate.timeSlot)
        phaseSource = rate
      }

      BindingLayer.create(phaseSource, newLayer.phaseSlot)
    }
  }
  refreshStack(menuLayer)
})
menuLayer.debugName = 'Menu'
menuLayer.bounds    = { x: X, y: 24, width: W, height: 36 }
menuLayer.insertAbove(deletionLayer)

// DeletionLayer restore: put the layer just above DeletionLayer, then refresh.
deletionLayer.setRestoreCallback((layer) => {
  layer.insertAbove(deletionLayer)
  refreshStack(layer)
})

// Delete key: archive the currently selected layer into DeletionLayer.
interaction.setDeleteAction(() => {
  const layer = widget.selected
  if (layer === null || layer === deletionLayer || layer === root || layer === menuLayer) return
  let below: Layer | null = layer.layerBelow
  while (below !== null && below.isInfrastructure) below = below.layerBelow
  const nextSel = below ?? deletionLayer
  deletionLayer.archive(layer)
  refreshStack(nextSel)
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
//                    the Deleted archive (above the consumer) if needed.
interaction.setSlotClickCallback((consumer, slot) => {
  if (slot.state === SlotState.Unbound) {
    if (slot.type === null) return
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
  if (source.outsideStack) {
    if (deletionLayer.removeFromArchive(source)) {
      source.insertAbove(consumer)
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
  refreshStack()
})

evaluator.setStack(menuLayer)
widget.setStack(menuLayer)
interaction.setStack(menuLayer)

// ------------------------------------------------------------------
// Drag-and-drop image loading — always creates a new ImageLayer
// ------------------------------------------------------------------
//
// Placement rules:
//   • MenuLayer selected  → new layer inserted below MenuLayer
//   • Drop on Image slot  → new layer inserted below current layer,
//                           bound to that slot; current layer stays selected
//   • Otherwise           → new layer inserted above current layer,
//                           new layer becomes selected

canvas.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
})

canvas.addEventListener('drop', (e) => {
  e.preventDefault()
  const file = e.dataTransfer?.files[0]
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
    newLayer.insertAbove(below ?? deletionLayer)
  } else if (selected !== null) {
    const slot = selected.hitTestSlot(dropPoint)
    if (slot !== null && slot.type === ValueType.Image) {
      // Dropped onto an Image-type slot — insert below selected, then bind.
      targetSlot = slot
      newLayer.insertAbove(selected.layerBelow ?? deletionLayer)
    } else {
      // Default: insert above current layer.
      newLayer.insertAbove(selected)
    }
  } else {
    newLayer.insertAbove(deletionLayer)
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
