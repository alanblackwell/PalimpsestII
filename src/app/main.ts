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
import { EventLayer }           from '../layers/EventLayer.js'
import { DirectionLayer }       from '../layers/DirectionLayer.js'
import { MathLayer }            from '../layers/MathLayer.js'
import { TextLayer }            from '../layers/TextLayer.js'
import { ImageLayer }           from '../layers/ImageLayer.js'
import { MaskLayer }            from '../layers/MaskLayer.js'
import { CompositeLayer }       from '../layers/CompositeLayer.js'

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
//   EventLayer   — pulse generator; rateSlot=Rate (fires at ~0.5 Hz)
//   BindingLayer — Rate → Event.rateSlot
//   CountLayer   — counts Event pulses; eventSlot=EventLayer
//   BindingLayer — Event → Count.eventSlot
//   DirectionLayer — manual dial (unbound magnitude slot)
//   MathLayer      — a × b; slotA=AmountA (0.3), slotB=AmountHi (0.8)
//   BindingLayer   — AmountA  → Math.slotA
//   BindingLayer   — AmountHi → Math.slotB
//   TextLayer      — "Palimpsest II"; pos=PointP, col=ColourC
//   BindingLayer   — PointP   → Text.positionSlot
//   BindingLayer   — ColourC  → Text.colourSlot
//   ImageLayer     — file picker; pos=PointP, opacity=AmountA
//   BindingLayer   — PointP   → Image.positionSlot
//   BindingLayer   — AmountA  → Image.opacitySlot
//   MaskLayer      — ellipse; pos=PointP, size=AmountHi
//   BindingLayer   — PointP   → Mask.positionSlot
//   BindingLayer   — AmountHi → Mask.sizeSlot
//   ImageLayer2    — second image (blend source)
//   CompositeLayer — normal; base=ImageLayer, blend=ImageLayer2, mask=MaskLayer
//   BindingLayer   — ImageLayer  → Composite.base
//   BindingLayer   — ImageLayer2 → Composite.blend
//   BindingLayer   — MaskLayer   → Composite.mask
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

const eventLayer = new EventLayer()
eventLayer.debugName = 'Event'
eventLayer.bounds = { x: X, y: 670, width: W, height: 36 }

const countLayer = new CountLayer(0)
countLayer.debugName = 'Count'
countLayer.bounds = { x: X, y: 720, width: W, height: 36 }

const directionLayer = new DirectionLayer(Math.PI / 4, 0.7)
directionLayer.debugName = 'Direction'
directionLayer.bounds = { x: X, y: 770, width: W, height: 70 }

const mathLayer = new MathLayer(2)   // 2 = a × b
mathLayer.debugName = 'Math'
mathLayer.bounds = { x: X, y: 854, width: W, height: 36 }

const textLayer = new TextLayer('Palimpsest II')
textLayer.debugName = 'Text'
textLayer.bounds = { x: X, y: 904, width: W, height: 36 }

const imageLayer = new ImageLayer()
imageLayer.debugName = 'Image'
imageLayer.bounds = { x: X, y: 954, width: W, height: 36 }

const maskLayer = new MaskLayer(canvas.width, canvas.height)
maskLayer.debugName = 'Mask'
maskLayer.bounds = { x: X, y: 1004, width: W, height: 36 }

const imageLayer2 = new ImageLayer()
imageLayer2.debugName = 'Image2'
imageLayer2.bounds = { x: X, y: 1054, width: W, height: 36 }

const compositeLayer = new CompositeLayer(canvas.width, canvas.height)
compositeLayer.debugName = 'Composite'
compositeLayer.bounds = { x: X, y: 1104, width: W, height: 36 }

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
eventLayer.insertAbove(selectLayer)
countLayer.insertAbove(eventLayer)
directionLayer.insertAbove(countLayer)
mathLayer.insertAbove(directionLayer)
textLayer.insertAbove(mathLayer)
imageLayer.insertAbove(textLayer)
maskLayer.insertAbove(imageLayer)
imageLayer2.insertAbove(maskLayer)
compositeLayer.insertAbove(imageLayer2)

// Bindings (each auto-inserts a BindingLayer above the consumer)
BindingLayer.create(layerA,      layerB.slot)              // AmountA  → AmountB
BindingLayer.create(clockLayer,  rateLayer.timeSlot)       // Clock    → Rate.time
BindingLayer.create(rateLayer,   animPath.positionSlot)    // Rate     → AnimPath.pos
BindingLayer.create(rateLayer,   selectLayer.condSlot)     // Rate     → Select.cond
BindingLayer.create(layerA,      selectLayer.slotA)        // AmountA  → Select.A
BindingLayer.create(amountHi,    selectLayer.slotB)        // AmountHi → Select.B
BindingLayer.create(rateLayer,   eventLayer.rateSlot)      // Rate     → Event.rate
BindingLayer.create(eventLayer,  countLayer.eventSlot)     // Event    → Count.event
BindingLayer.create(layerA,      mathLayer.slotA)          // AmountA  → Math.a
BindingLayer.create(amountHi,    mathLayer.slotB)          // AmountHi → Math.b
BindingLayer.create(pointLayer,  textLayer.positionSlot)   // PointP   → Text.pos
BindingLayer.create(colourLayer, textLayer.colourSlot)     // ColourC  → Text.col
BindingLayer.create(pointLayer,  imageLayer.positionSlot)  // PointP   → Image.pos
BindingLayer.create(layerA,      imageLayer.opacitySlot)   // AmountA  → Image.opacity
BindingLayer.create(pointLayer,  maskLayer.positionSlot)   // PointP   → Mask.pos
BindingLayer.create(amountHi,    maskLayer.sizeSlot)       // AmountHi → Mask.size
BindingLayer.create(imageLayer,  compositeLayer.baseSlot)  // Image    → Composite.base
BindingLayer.create(imageLayer2, compositeLayer.blendSlot) // Image2   → Composite.blend
BindingLayer.create(maskLayer,   compositeLayer.maskSlot)  // Mask     → Composite.mask

// Tell the evaluator about the top of the stack and drive the clock.
evaluator.setStack(compositeLayer)
evaluator.setClock(clockLayer)

const interaction = new InteractionSystem(canvas)
interaction.setStack(compositeLayer)

// ------------------------------------------------------------------
// Resize
// ------------------------------------------------------------------
window.addEventListener('resize', () => {
  evaluator.resize(window.innerWidth, window.innerHeight)
  root.resize(window.innerWidth, window.innerHeight)
  maskLayer.resize(window.innerWidth, window.innerHeight)
  compositeLayer.resize(window.innerWidth, window.innerHeight)
})
