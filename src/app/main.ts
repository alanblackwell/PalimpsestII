// PalimpsestII — entry point
import { Evaluator }            from '../dataflow/Evaluator.js'
import { InteractionSystem }    from '../interaction/InteractionSystem.js'
import { AmountLayer }          from '../layers/AmountLayer.js'
import { ColourLayer }          from '../layers/ColourLayer.js'
import { BindingLayer }         from '../layers/BindingLayer.js'
import { RootLayer }            from '../layers/RootLayer.js'
import { PointLayer }           from '../layers/PointLayer.js'
import { ClockLayer }           from '../layers/ClockLayer.js'
import { RateLayer }            from '../layers/RateLayer.js'
import { AnimationPathLayer }   from '../layers/AnimationPathLayer.js'
import { SelectLayer }          from '../layers/SelectLayer.js'
import { CountLayer }           from '../layers/CountLayer.js'

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
//   BindingLayer — AmountA → AmountB
//   ColourC      — colour picker (unbound)
//   PointP       — freely draggable point handle (unbound)
//   Clock        — continuously advancing time source; drives rAF loop
//   RateLayer    — Clock → cycling phase at 1.0 Hz
//   BindingLayer — Clock → RateLayer.timeSlot
//   AnimPath     — elliptical path driven by RateLayer output
//   BindingLayer — RateLayer → AnimPath.positionSlot
//   AmountHi     — source, value=0.8 (SelectLayer slotB)
//   Select       — A/B switch; condSlot=Rate, slotA=AmountA, slotB=AmountHi
//   BindingLayer — Rate   → Select.condSlot
//   BindingLayer — AmountA → Select.slotA
//   BindingLayer — AmountHi → Select.slotB
//   CountLayer   — manual counter (unbound event slot)
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

const rateLayer = new RateLayer(0.5)
rateLayer.debugName = 'Rate'
rateLayer.bounds = { x: X, y: 465, width: W, height: 44 }

const animPath = new AnimationPathLayer()
animPath.debugName = 'AnimPath'
animPath.bounds = { x: X, y: 524, width: W, height: 30 }

const amountHi = new AmountLayer(0.8)
amountHi.debugName = 'AmountHi'
amountHi.bounds = { x: X, y: 570, width: W, height: 36 }

const selectLayer = new SelectLayer()
selectLayer.debugName = 'Select'
selectLayer.bounds = { x: X, y: 620, width: W, height: 36 }

const countLayer = new CountLayer(0)
countLayer.debugName = 'Count'
countLayer.bounds = { x: X, y: 670, width: W, height: 36 }

// Wire the stack bottom → top
layerA.insertAbove(root)
layerB.insertAbove(layerA)
colourLayer.insertAbove(layerB)
pointLayer.insertAbove(colourLayer)
clockLayer.insertAbove(pointLayer)
rateLayer.insertAbove(clockLayer)
animPath.insertAbove(rateLayer)
amountHi.insertAbove(animPath)
selectLayer.insertAbove(amountHi)
countLayer.insertAbove(selectLayer)

// Bindings (each auto-inserts a BindingLayer above the consumer)
BindingLayer.create(layerA,      layerB.slot)              // AmountA  → AmountB
BindingLayer.create(clockLayer,  rateLayer.timeSlot)       // Clock    → Rate.time
BindingLayer.create(rateLayer,   animPath.positionSlot)    // Rate     → AnimPath.pos
BindingLayer.create(rateLayer,   selectLayer.condSlot)     // Rate     → Select.cond
BindingLayer.create(layerA,      selectLayer.slotA)        // AmountA  → Select.A
BindingLayer.create(amountHi,    selectLayer.slotB)        // AmountHi → Select.B

// Tell the evaluator about the top of the stack and drive the clock.
evaluator.setStack(countLayer)
evaluator.setClock(clockLayer)

const interaction = new InteractionSystem(canvas)
interaction.setStack(countLayer)

// ------------------------------------------------------------------
// Resize
// ------------------------------------------------------------------
window.addEventListener('resize', () => {
  evaluator.resize(window.innerWidth, window.innerHeight)
  root.resize(window.innerWidth, window.innerHeight)
})
