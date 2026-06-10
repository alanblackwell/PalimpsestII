// PalimpsestII — entry point
import { Evaluator }         from '../dataflow/Evaluator.js'
import { InteractionSystem } from '../interaction/InteractionSystem.js'
import { Layer }             from '../core/Layer.js'
import { BindingLayer }      from '../layers/BindingLayer.js'
import { AnimPathLayer }     from '../layers/AnimPathLayer.js'
import { ClockLayer }        from '../layers/ClockLayer.js'
import { RateLayer }         from '../layers/RateLayer.js'
import { RootLayer }         from '../layers/RootLayer.js'
import { MenuLayer }         from '../layers/MenuLayer.js'
import { DeletionLayer }     from '../layers/DeletionLayer.js'
import { LayerStackWidget }  from '../interaction/LayerStackWidget.js'

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
        clock.debugName = 'Clock'
        clock.bounds = { ...newLayer.bounds }
        if (below !== null) clock.insertAbove(below)

        const rate = new RateLayer(1.0)
        rate.debugName = 'Rate'
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

evaluator.setStack(menuLayer)
widget.setStack(menuLayer)
interaction.setStack(menuLayer)

// ------------------------------------------------------------------
// Resize
// ------------------------------------------------------------------
window.addEventListener('resize', () => {
  evaluator.resize(window.innerWidth, window.innerHeight)
  root.resize(window.innerWidth, window.innerHeight)
})
