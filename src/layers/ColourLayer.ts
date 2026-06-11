import { Layer } from '../core/Layer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  type Colour, type ColourSource,
  type AmountSource, type PointSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { ColourPickerRegion, registerPromotionFactory } from '../regions/ColourPickerRegion.js'
import { BindingLayer } from './BindingLayer.js'

// ------------------------------------------------------------
// ColourLayer — a layer that holds and exposes a Colour value
// ------------------------------------------------------------
//
// Operating modes:
//
//   Unbound  — the HSV picker is fully interactive; the user
//              drags the SV square and hue strip to set the colour.
//
//   Bound    — the colour is driven by a source layer (the slot);
//              the picker displays the incoming value read-only.
//
// Two further input slots provide independent control over part of
// the picker, and only apply when the Colour slot above is unbound:
//
//   hue slot (Amount) — drives the hue strip; amount [0, 1] -> [0, 360)
//   position slot (Point) — drives the SV cursor; canvas coordinates
//                            map onto the SV square (x -> saturation,
//                            y -> value, inverted)
//
// Dragging the hue strip or SV square while the corresponding slot
// is active suspends that binding, returning control to the user.
//
// Visual layout (within bounds):
//
//   ┌───────────────────────────────────┐
//   │ ╔═══════════════════════════════╗ │
//   │ ║  SV square (main area)        ║ │
//   │ ╚═══════════════════════════════╝ │
//   │ ████████████ hue strip ██████████ │
//   │ #ff6a2b                           │ ← hex label
//   └───────────────────────────────────┘

registerPromotionFactory((initial: Colour) => new ColourLayer(initial))

export class ColourLayer extends Layer implements ColourSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Colour])

  private readonly _slot:    ParameterSlot   // Colour input
  private readonly _hueSlot: ParameterSlot   // Amount → hue
  private readonly _posSlot: ParameterSlot   // Point  → SV position

  private readonly _picker: ColourPickerRegion
  private _colour: Colour

  private static readonly PAD_X    = 10
  private static readonly PAD_Y    = 8
  private static readonly LABEL_H  = 18  // space reserved at bottom for hex label

  constructor(initial: Colour = { r: 1, g: 0.42, b: 0.17, a: 1 }) {
    super()
    this._colour  = { ...initial }
    this._slot    = new ParameterSlot(ValueType.Colour, this)
    this._hueSlot = new ParameterSlot(ValueType.Amount, this, 'hue')
    this._posSlot = new ParameterSlot(ValueType.Point,  this, 'position')
    this._picker  = new ColourPickerRegion(this, initial)
    this.slots.push(this._slot, this._hueSlot, this._posSlot)
    this._picker.setOnHueDragStart(() => this._suspendSlot(this._hueSlot))
    this._picker.setOnSvDragStart(() => this._suspendSlot(this._posSlot))
    this.debugName = 'ColourLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ColourSource
  // ----------------------------------------------------------

  getColour(): Colour { return { ...this._colour } }

  // ----------------------------------------------------------
  // Value
  // ----------------------------------------------------------

  // Called by the embedded picker when the user drags.
  setColour(c: Colour): void {
    this._colour = { ...c }
    this.markDirty()
  }

  get slot(): ParameterSlot { return this._slot }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this._slot.isActive) {
      const src = this._slot.source as ColourSource
      this._colour = src.getColour()
      this._picker.setDisplayColour(this._colour)
      this._picker.interactive = false
    } else {
      this._picker.interactive = true

      const hueActive = this._hueSlot.isActive
      const posActive = this._posSlot.isActive

      if (hueActive) {
        const amt = (this._hueSlot.source as AmountSource).getAmount()
        this._picker.setHue(amt * 360)
      }
      if (posActive) {
        const pt  = (this._posSlot.source as PointSource).getPoint()
        const sat = pt.x / Node.canvasWidth
        const val = 1 - pt.y / Node.canvasHeight
        this._picker.setSatVal(sat, val)
      }

      this._picker.hueInteractive = !hueActive
      this._picker.svInteractive  = !posActive

      this._colour = { ...this._picker.colour }
      this._picker.displayColour = this._colour
    }
    this._syncPickerBounds()
  }

  // Suspend an active binding so the picker can take over that zone.
  private _suspendSlot(slot: ParameterSlot): void {
    if (slot.isActive) BindingLayer.findForSlot(slot)?.toggle()
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width <= 0 || this.bounds.height <= 0) return
    this._drawPill(ctx, { x: 300, y: 50, width: 260, height: this.bounds.height })
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b

    // Update picker bounds to this pill's position
    const px = ColourLayer.PAD_X
    const py = ColourLayer.PAD_Y
    const lh = ColourLayer.LABEL_H
    this._picker.bounds = {
      x:      x + px,
      y:      y + py,
      width:  Math.max(0, width  - px * 2),
      height: Math.max(0, height - py * 2 - lh),
    }

    const r = Math.min(height / 2, 10)
    ctx.save()

    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.50)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, r)
    ctx.fill()

    // Picker widget
    this._picker.renderSelf(ctx)

    // Hex label at the bottom
    const c = this._colour
    const hex = '#' +
      byteHex(c.r) +
      byteHex(c.g) +
      byteHex(c.b)
    const labelY = y + height - ColourLayer.LABEL_H / 2 - 2

    // Colour swatch dot next to label
    const dotR  = 5
    const dotX  = x + ColourLayer.PAD_X + dotR
    const dotY  = labelY
    ctx.fillStyle = `rgb(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)})`
    ctx.beginPath()
    ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth   = 1
    ctx.stroke()

    ctx.font         = '11px monospace'
    ctx.fillStyle    = this._slot.isActive ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.80)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(hex, dotX + dotR + 6, labelY)

    // Slot indicators — right to left: position, hue
    const indicators = [
      { slot: this._posSlot, label: 'P', colour: '#cf7ecf' },
      { slot: this._hueSlot, label: 'H', colour: '#4a8fe8' },
    ]
    let dx = x + width - ColourLayer.PAD_X
    ctx.font = '9px monospace'
    for (const { slot, label, colour } of indicators) {
      const state = slot.state
      let dot: string, dotColour: string, labelColour: string
      if (state === SlotState.Bound) {
        dot = '●'; dotColour = colour; labelColour = 'rgba(255,255,255,0.55)'
      } else if (state === SlotState.SuspendedBound) {
        dot = '◐'; dotColour = colour + '88'; labelColour = 'rgba(255,255,255,0.40)'
      } else {
        dot = '○'; dotColour = 'rgba(255,255,255,0.22)'; labelColour = 'rgba(255,255,255,0.28)'
      }
      ctx.fillStyle    = dotColour
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(dot, dx, labelY)
      dx -= 11
      ctx.fillStyle = labelColour
      ctx.fillText(label, dx, labelY)
      dx -= ctx.measureText(label).width + 5
    }

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point) {
    return this._picker.hitTest(point)
  }

  // ----------------------------------------------------------
  // Private
  // ----------------------------------------------------------

  private _syncPickerBounds(): void {
    const { x, y, width, height } = this.bounds
    const px = ColourLayer.PAD_X
    const py = ColourLayer.PAD_Y
    const lh = ColourLayer.LABEL_H
    this._picker.bounds = {
      x:      x + px,
      y:      y + py,
      width:  Math.max(0, width  - px * 2),
      height: Math.max(0, height - py * 2 - lh),
    }
  }
}

function byteHex(v: number): string {
  return Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0')
}
