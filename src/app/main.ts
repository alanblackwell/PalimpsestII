// PalimpsestII — entry point
import { Evaluator }   from '../dataflow/Evaluator.js'
import { AmountLayer } from '../layers/AmountLayer.js'
import { ColourLayer } from '../layers/ColourLayer.js'

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
// Demo stack
// ------------------------------------------------------------------
const X = 40
const W = 260

const layerA = new AmountLayer(0.3)
layerA.debugName = 'AmountA'
layerA.bounds = { x: X, y: 60, width: W, height: 36 }

const layerB = new AmountLayer(0.7)
layerB.debugName = 'AmountB'
layerB.bounds = { x: X, y: 110, width: W, height: 36 }

const colourLayer = new ColourLayer({ r: 1, g: 0.42, b: 0.17, a: 1 })
colourLayer.debugName = 'ColourC'
colourLayer.bounds = { x: X, y: 165, width: W, height: 170 }

// Wire the stack bottom → top: layerA → layerB → colourLayer
layerB.insertAbove(layerA)
colourLayer.insertAbove(layerB)

// Tell the evaluator about the top of the stack.
evaluator.setStack(colourLayer)

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
