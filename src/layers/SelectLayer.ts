import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  type Amount,    type AmountSource,
  type Colour,    type ColourSource,
  type Point,     type PointSource,
  type Direction, type DirectionSource,
  type Rate,      type RateSource,
  type Count,     type CountSource,
  type EventValue, type EventSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// SelectLayer — a polymorphic A/B switch
// ------------------------------------------------------------
//
// From the architecture spec §3:
//   "A Select node: given a boolean condition and two inputs of
//    the same type T, it outputs a value of type T. The output
//    type is determined when the inputs are bound."
//
// Slots:
//   condSlot  (Amount)  condition — ≥ 0.5 → select A, < 0.5 → B.
//                       Unbound default is 0 (→ B).
//   slotA     (null)    polymorphic value input A.
//   slotB     (null)    polymorphic value input B.
//
// Output type is inferred from the bound value sources at runtime.
// The backing `types` set is updated in recompute() and exposed via
// a getter so downstream layers always see the current output type.
//
// All typed source interfaces are implemented; each guards itself
// to return a sensible default if the SelectLayer's value type
// does not match what the caller expects.
//
// Visual:
//
//   ┌────────────────────────────────────────────────────┐
//   │ ●  [A] [B]  c:0.73                    output val  │
//   └────────────────────────────────────────────────────┘
//
// Selected branch is filled with accent colour; unselected is dim.

// ------------------------------------------------------------------
// Primary type selection
// ------------------------------------------------------------------

// When a source satisfies multiple ValueTypes, pick the most
// semantically specific one for SelectLayer's output type.
const TYPE_PRIORITY: ValueType[] = [
  ValueType.Image,
  ValueType.Mask,
  ValueType.Colour,
  ValueType.Point,
  ValueType.Direction,
  ValueType.Amount,
  ValueType.Rate,
  ValueType.Count,
  ValueType.Event,
]

function primaryType(types: ReadonlySet<ValueType>): ValueType | null {
  for (const t of TYPE_PRIORITY) {
    if (types.has(t)) return t
  }
  return null
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ACCENT = '#4acfe8'  // teal — neutral, signals "polymorphic"

// ------------------------------------------------------------------
// SelectLayer
// ------------------------------------------------------------------

export class SelectLayer extends Layer
  implements AmountSource, ColourSource, PointSource,
             DirectionSource, RateSource, CountSource, EventSource {

  // Output types are set dynamically in recompute().
  private readonly _outputTypes = new Set<ValueType>()
  get types(): ReadonlySet<ValueType> { return this._outputTypes }

  // Slots — condSlot is Amount; value slots are polymorphic (null type).
  readonly condSlot: ParameterSlot
  readonly slotA:    ParameterSlot
  readonly slotB:    ParameterSlot

  // Cached recompute results.
  private _condValue:  number         = 0
  private _useA:       boolean        = false
  private _valueType:  ValueType | null = null
  private _activeNode: import('../core/Node.js').Node | null = null
  private _cpBounds: { x: number; y: number; width: number; height: number } | null = null

  constructor() {
    super()
    this.condSlot = new ParameterSlot(ValueType.Amount, this)
    this.slotA    = new ParameterSlot(null, this)   // polymorphic
    this.slotB    = new ParameterSlot(null, this)   // polymorphic
    this.slots.push(this.condSlot, this.slotA, this.slotB)
    this.debugName = 'Select'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // Typed source interfaces — delegate to the active source
  // ----------------------------------------------------------

  getAmount(): Amount {
    return this._valueType === ValueType.Amount
      ? ((this._activeNode as AmountSource | null)?.getAmount() ?? 0)
      : 0
  }

  getColour(): Colour {
    return this._valueType === ValueType.Colour
      ? ((this._activeNode as ColourSource | null)?.getColour() ?? { r: 0, g: 0, b: 0, a: 1 })
      : { r: 0, g: 0, b: 0, a: 1 }
  }

  getPoint(): Point {
    return this._valueType === ValueType.Point
      ? ((this._activeNode as PointSource | null)?.getPoint() ?? { x: 0, y: 0 })
      : { x: 0, y: 0 }
  }

  getDirection(): Direction {
    return this._valueType === ValueType.Direction
      ? ((this._activeNode as DirectionSource | null)?.getDirection() ?? { angle: 0, magnitude: 0 })
      : { angle: 0, magnitude: 0 }
  }

  getRate(): Rate {
    return this._valueType === ValueType.Rate
      ? ((this._activeNode as RateSource | null)?.getRate() ?? 0)
      : 0
  }

  getCount(): Count {
    return this._valueType === ValueType.Count
      ? ((this._activeNode as CountSource | null)?.getCount() ?? 0)
      : 0
  }

  getEventTime(): EventValue {
    return this._valueType === ValueType.Event
      ? ((this._activeNode as EventSource | null)?.getEventTime() ?? null)
      : null
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    // Condition
    this._condValue = this.condSlot.isActive
      ? (this.condSlot.source as AmountSource).getAmount()
      : 0
    this._useA = this._condValue >= 0.5

    // Active source — the selected slot's source (or null if unbound)
    const sel = this._useA ? this.slotA : this.slotB
    this._activeNode = sel.isActive ? sel.source : null

    // Output type — inferred from whichever value slot is currently bound
    const typeSrc = this.slotA.isActive ? this.slotA.source
                  : this.slotB.isActive ? this.slotB.source
                  : null
    this._valueType = typeSrc ? primaryType(typeSrc.types) : null

    this._outputTypes.clear()
    if (this._valueType !== null) this._outputTypes.add(this._valueType)
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.canvasBounds
    if (width <= 0 || height <= 0) return

    const midY = y + height / 2

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // A / B selector blocks
    const btnW = 22
    const btnH = 22
    const btnY = midY - btnH / 2
    const btnAx = x + 12
    const btnBx = btnAx + btnW + 4

    this._drawSelector(ctx, btnAx, btnY, btnW, btnH, 'A', this._useA,
      this.slotA.isActive)
    this._drawSelector(ctx, btnBx, btnY, btnW, btnH, 'B', !this._useA,
      this.slotB.isActive)

    // Condition value
    const condStr = this.condSlot.isActive
      ? 'c:' + this._condValue.toFixed(2)
      : 'c:—'
    ctx.font         = '11px monospace'
    ctx.fillStyle    = this.condSlot.isActive ? 'rgba(255,255,255,0.70)' : 'rgba(255,255,255,0.28)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(condStr, btnBx + btnW + 8, midY)

    // Output value (right side)
    this._renderOutput(ctx, x + width - 8, midY)

    ctx.restore()

    // Canvas panel overlay
    const cp = { x: 300, y: 50, width: 260, height }
    this._cpBounds = cp
    this._renderCanvasOverlay(ctx)
  }

  private _renderCanvasOverlay(ctx: Ctx2D): void {
    const cp = this._cpBounds
    if (!cp) return
    const { x, y, width, height } = cp
    const midY = y + height / 2

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // Large A or B label showing selected branch
    const branchLabel = this._useA ? 'A' : 'B'
    ctx.font      = 'bold 20px monospace'
    ctx.fillStyle = ACCENT
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(branchLabel, x + 14, midY)

    // Condition value
    const condStr = this.condSlot.isActive
      ? 'c:' + this._condValue.toFixed(2)
      : 'c:—'
    ctx.font      = '11px monospace'
    ctx.fillStyle = this.condSlot.isActive ? 'rgba(255,255,255,0.70)' : 'rgba(255,255,255,0.28)'
    ctx.textAlign = 'left'
    ctx.fillText(condStr, x + 44, midY)

    // Output value (right side)
    this._renderOutput(ctx, x + width - 8, midY)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Private
  // ----------------------------------------------------------

  private _drawSelector(
    ctx: Ctx2D,
    bx: number, by: number, bw: number, bh: number,
    label: string,
    selected: boolean,
    bound: boolean,
  ): void {
    // Fill: selected+bound = accent, selected+unbound = dim accent, not selected = near-transparent
    ctx.fillStyle = selected
      ? (bound ? ACCENT : 'rgba(74,207,232,0.30)')
      : 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(bx, by, bw, bh, 4)
    ctx.fill()

    ctx.font         = 'bold 12px monospace'
    ctx.fillStyle    = selected
      ? (bound ? '#000000' : 'rgba(74,207,232,0.70)')
      : 'rgba(255,255,255,0.28)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, bx + bw / 2, by + bh / 2)
  }

  private _renderOutput(ctx: Ctx2D, rx: number, midY: number): void {
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'right'
    ctx.textBaseline = 'middle'

    if (this._valueType === null || this._activeNode === null) {
      ctx.fillStyle = 'rgba(255,255,255,0.18)'
      ctx.fillText('—', rx, midY)
      return
    }

    ctx.fillStyle = 'rgba(255,255,255,0.78)'

    switch (this._valueType) {
      case ValueType.Amount:
        ctx.fillText(this.getAmount().toFixed(2), rx, midY)
        break
      case ValueType.Rate:
        ctx.fillText(this.getRate().toFixed(1) + ' Hz', rx, midY)
        break
      case ValueType.Count:
        ctx.fillText(String(this.getCount()), rx, midY)
        break
      case ValueType.Point: {
        const p = this.getPoint()
        ctx.fillText(`(${Math.round(p.x)}, ${Math.round(p.y)})`, rx, midY)
        break
      }
      case ValueType.Colour: {
        const c   = this.getColour()
        const sw  = 18
        const sh  = 14
        const css = `rgb(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)})`
        ctx.fillStyle = css
        ctx.beginPath()
        ctx.roundRect(rx - sw, midY - sh / 2, sw, sh, 3)
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.20)'
        ctx.lineWidth   = 1
        ctx.stroke()
        break
      }
      default:
        ctx.fillText(String(this._valueType), rx, midY)
    }
  }
}
