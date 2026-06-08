// PalimpsestII — entry point
import { Evaluator } from '../dataflow/Evaluator.js'
import { graph }     from '../dataflow/Graph.js'
import { AmountLayer } from '../layers/AmountLayer.js'

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
// Demo stack: two AmountLayers stacked vertically
// ------------------------------------------------------------------
const LAYER_W = 240
const LAYER_H = 36

const layerA = new AmountLayer(0.3)
layerA.debugName = 'AmountA'
layerA.bounds = { x: 40, y: 60, width: LAYER_W, height: LAYER_H }

const layerB = new AmountLayer(0.7)
layerB.debugName = 'AmountB'
layerB.bounds = { x: 40, y: 110, width: LAYER_W, height: LAYER_H }

// Wire B above A in the layer stack (layerA sits at the bottom unlinked).
layerB.insertAbove(layerA)

// Tell the evaluator about the top of the stack.
evaluator.setStack(layerB)

// ------------------------------------------------------------------
// Interaction — route pointer events to the layer stack
// ------------------------------------------------------------------
let activeNode: ReturnType<typeof layerB.hitTest> = null

canvas.addEventListener('pointerdown', e => {
  const point = { x: e.offsetX, y: e.offsetY }
  activeNode = layerB.hitTest(point)
  if (activeNode && 'handlePointerDown' in activeNode) {
    (activeNode as any).handlePointerDown(point)
    canvas.setPointerCapture(e.pointerId)
  }
})

canvas.addEventListener('pointermove', e => {
  if (activeNode && 'handlePointerMove' in activeNode) {
    (activeNode as any).handlePointerMove({ x: e.offsetX, y: e.offsetY })
  }
})

canvas.addEventListener('pointerup', e => {
  if (activeNode && 'handlePointerUp' in activeNode) {
    (activeNode as any).handlePointerUp()
  }
  activeNode = null
})

// ------------------------------------------------------------------
// Resize
// ------------------------------------------------------------------
window.addEventListener('resize', () => {
  evaluator.resize(window.innerWidth, window.innerHeight)
})
