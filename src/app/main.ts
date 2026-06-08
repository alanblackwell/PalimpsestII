// PalimpsestII — entry point
import { Evaluator }         from '../dataflow/Evaluator.js'
import { InteractionSystem } from '../interaction/InteractionSystem.js'
import { AmountLayer }       from '../layers/AmountLayer.js'
import { ColourLayer }       from '../layers/ColourLayer.js'
import { BindingLayer }      from '../layers/BindingLayer.js'
import { RootLayer }         from '../layers/RootLayer.js'

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
//   RootLayer  — checkerboard background, full canvas
//   AmountA    — source, value=0.3
//   AmountB    — consumer; slot bound to AmountA
//   BindingLayer (auto-inserted by BindingLayer.create)
//   ColourC    — colour picker (unbound)
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

// Wire the stack bottom → top
layerA.insertAbove(root)
layerB.insertAbove(layerA)
colourLayer.insertAbove(layerB)

// Create a binding: AmountA → AmountB.slot.
// The BindingLayer is auto-inserted between layerB and colourLayer.
BindingLayer.create(layerA, layerB.slot)

// Tell the evaluator and interaction system about the top of the stack.
evaluator.setStack(colourLayer)

const interaction = new InteractionSystem(canvas)
interaction.setStack(colourLayer)

// ------------------------------------------------------------------
// Resize
// ------------------------------------------------------------------
window.addEventListener('resize', () => {
  evaluator.resize(window.innerWidth, window.innerHeight)
  root.resize(window.innerWidth, window.innerHeight)
})
