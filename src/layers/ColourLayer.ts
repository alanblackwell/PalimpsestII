import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import { ValueType, type Colour, type ColourSource, type Ctx2D, type Point } from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { ColourPickerRegion, registerPromotionFactory } from '../regions/ColourPickerRegion.js'

// ------------------------------------------------------------
// ColourLayer — a layer that holds and exposes a Colour value
// ------------------------------------------------------------
//
// Two operating modes:
//
//   Unbound  — the HSV picker is fully interactive; the user
//              drags the SV square and hue strip to set the colour.
//
//   Bound    — the colour is driven by a source layer (the slot);
//              the picker displays the incoming value read-only.
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

  private readonly _slot:   ParameterSlot
  private readonly _picker: ColourPickerRegion
  private _colour: Colour

  private static readonly PAD_X    = 10
  private static readonly PAD_Y    = 8
  private static readonly LABEL_H  = 18  // space reserved at bottom for hex label

  constructor(initial: Colour = { r: 1, g: 0.42, b: 0.17, a: 1 }) {
    super()
    this._colour = { ...initial }
    this._slot   = new ParameterSlot(ValueType.Colour, this)
    this._picker = new ColourPickerRegion(this, initial)
    this.slots.push(this._slot)
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
      this._colour = { ...this._picker.colour }
      this._picker.displayColour = this._colour
    }
    this._syncPickerBounds()
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width <= 0 || this.bounds.height <= 0) return
    this._drawPill(ctx, this.bounds)
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
