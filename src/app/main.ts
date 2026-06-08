// PalimpsestII — entry point
import { Evaluator }    from '../dataflow/Evaluator.js'
import { AmountLayer }  from '../layers/AmountLayer.js'
import { ColourLayer }  from '../layers/ColourLayer.js'
import { BindingLayer } from '../layers/BindingLayer.js'

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
//
//   AmountA  (y=60)   — source, value=0.3
//   AmountB  (y=110)  — consumer; slot bound to AmountA
//   BindingLayer      — auto-positioned above AmountB (y=78)
//   ColourC  (y=170)  — colour picker (unbound)
//
// BindingLayer.create() binds AmountA → AmountB.slot and inserts the
// BindingLayer into the stack, demonstrating the binding visualisation.
// ------------------------------------------------------------------
const X = 40
const W = 260

const layerA = new AmountLayer(0.3)
layerA.debugName = 'AmountA'
layerA.bounds = { x: X, y: 60, width: W, height: 36 }

const layerB = new AmountLayer(0.7)
layerB.debugName = 'AmountB'
layerB.bounds = { x: X, y: 120, width: W, height: 36 }

const colourLayer = new ColourLayer({ r: 1, g: 0.42, b: 0.17, a: 1 })
colourLayer.debugName = 'ColourC'
colourLayer.bounds = { x: X, y: 190, width: W, height: 170 }

// Wire the stack bottom → top
layerB.insertAbove(layerA)
colourLayer.insertAbove(layerB)

// Create a binding: AmountA drives AmountB's slot.
// BindingLayer.create() binds the slot and inserts the BindingLayer
// above AmountB, which correctly places it between layerB and colourLayer.
BindingLayer.create(layerA, layerB.slot)

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
