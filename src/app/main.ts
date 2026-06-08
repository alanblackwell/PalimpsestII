// PalimpsestII — entry point
import { Evaluator }         from '../dataflow/Evaluator.js'
import { InteractionSystem } from '../interaction/InteractionSystem.js'
import { AmountLayer }       from '../layers/AmountLayer.js'
import { ColourLayer }       from '../layers/ColourLayer.js'
import { BindingLayer }      from '../layers/BindingLayer.js'
import { RootLayer }         from '../layers/RootLayer.js'
import { PointLayer }        from '../layers/PointLayer.js'
import { ClockLayer }        from '../layers/ClockLayer.js'
import { RateLayer }         from '../layers/RateLayer.js'

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
// Demo stack (bottom → top):
//
//   RootLayer    — checkerboard background, full canvas
//   AmountA      — source, value=0.3
//   AmountB      — consumer; slot bound to AmountA
//   BindingLayer — auto-inserted by BindingLayer.create
//   ColourC      — colour picker (unbound)
//   PointP       — freely draggable point handle (unbound)
//   Clock        — continuously advancing time source; drives rAF loop
//   RateLayer    — Clock → cycling phase at 1.0 Hz (draggable rate)
//   BindingLayer — auto-inserted: Clock → RateLayer.timeSlot
// ------------------------------------------------------------------
const X = 40
const W = 260

const root = new RootLayer(canvas.width, canvas.height)

const layerA = new AmountLayer(0.3)
layerA.debugName = 'AmountA'
layerA.bounds = { x: X, y: 60, width: W, height: 36 }

const layerB = new AmountLayer(0.7)
layerB.debugName = 'AmountB'
layerB.bounds = { x: X, y: 120, width: W, height: 36 }

const colourLayer = new ColourLayer({ r: 1, g: 0.42, b: 0.17, a: 1 })
colourLayer.debugName = 'ColourC'
colourLayer.bounds = { x: X, y: 190, width: W, height: 170 }

const pointLayer = new PointLayer({ x: 500, y: 250 })
pointLayer.debugName = 'PointP'
pointLayer.bounds = { x: X, y: 375, width: W, height: 30 }

const clockLayer = new ClockLayer()
clockLayer.debugName = 'Clock'
clockLayer.bounds = { x: X, y: 420, width: W, height: 30 }

const rateLayer = new RateLayer(1.0)
rateLayer.debugName = 'Rate'
rateLayer.bounds = { x: X, y: 465, width: W, height: 44 }

// Wire the stack bottom → top
layerA.insertAbove(root)
layerB.insertAbove(layerA)
colourLayer.insertAbove(layerB)
pointLayer.insertAbove(colourLayer)
clockLayer.insertAbove(pointLayer)
rateLayer.insertAbove(clockLayer)

// Bindings
BindingLayer.create(layerA, layerB.slot)          // AmountA → AmountB
BindingLayer.create(clockLayer, rateLayer.timeSlot) // Clock → RateLayer.time

// Tell the evaluator about the top of the stack and drive the clock.
evaluator.setStack(rateLayer)
evaluator.setClock(clockLayer)

const interaction = new InteractionSystem(canvas)
interaction.setStack(rateLayer)

// ------------------------------------------------------------------
// Resize
// ------------------------------------------------------------------
window.addEventListener('resize', () => {
  evaluator.resize(window.innerWidth, window.innerHeight)
  root.resize(window.innerWidth, window.innerHeight)
})
