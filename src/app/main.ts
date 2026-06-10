// PalimpsestII — entry point
import { Evaluator }         from '../dataflow/Evaluator.js'
import { InteractionSystem } from '../interaction/InteractionSystem.js'
import { Layer }             from '../core/Layer.js'
import { BindingLayer }      from '../layers/BindingLayer.js'
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
  evaluator.setStack(top)
  widget.setStack(top)
  interaction.setStack(top)
  if (selectLayer !== undefined) widget.selected = selectLayer
}

// MenuLayer sits at the very top.
const menuLayer = new MenuLayer(canvas.width, canvas.height, (_newLayer) => {
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
