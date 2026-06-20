import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  type Amount, type AmountSource,
  type PointSource,
  type Ctx2D, type Point, type Direction,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { SliderRegion, registerPromotionFactory } from '../regions/SliderRegion.js'
import { BindingLayer } from './BindingLayer.js'

// ------------------------------------------------------------
// AmountLayer — a layer that holds and exposes an Amount value
// ------------------------------------------------------------
//
// Three input slots (any combination may be active):
//
//   _slot  (Amount) — driven by any AmountSource
//   _xSlot (Point)  — x coordinate of the point mapped to [0, 1] (left→right)
//   _ySlot (Point)  — y coordinate of the point mapped to [0, 1] (top→bottom)
//
// If any point slots are active, their proportions are averaged.
// If only the amount slot is active, that value is used.
// If no slots are active, the slider is user-controlled.
//
// Dragging the slider while slots are active suspends all active
// bindings, returning control to the user at the current value.

// Register the promotion factory immediately so that any SliderRegion
// created before a full AmountLayer can still call promoteToLayer().
registerPromotionFactory((initial: Amount) => new AmountLayer(initial))

export class AmountLayer extends Layer implements AmountSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Amount])

  private readonly _slot:  ParameterSlot   // Amount input
  private readonly _xSlot: ParameterSlot   // Point → x proportion
  private readonly _ySlot: ParameterSlot   // Point → y proportion

  private readonly _slider: SliderRegion

  private _value: Amount

  private static readonly PAD_X       = 10
  private static readonly PAD_Y       = 6
  private static readonly LABEL_WIDTH = 112  // value label + 3 slot indicators

  constructor(initial: Amount = 0.5) {
    super()
    this._value  = initial
    this._slot   = new ParameterSlot(ValueType.Amount, this)
    this._xSlot  = new ParameterSlot(ValueType.Point,  this, 'x position')
    this._ySlot  = new ParameterSlot(ValueType.Point,  this, 'y position')
    this._slider = new SliderRegion(this, initial)
    this.slots.push(this._slot, this._xSlot, this._ySlot)
    this._slider.setOnDragStart(() => this._suspendActiveSlots())
    this.debugName = 'AmountLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // AmountSource
  // ----------------------------------------------------------

  getAmount(): Amount { return this._value }

  // ----------------------------------------------------------
  // Value
  // ----------------------------------------------------------

  setValue(v: Amount): void {
    this._value = v
    this.markDirty()
  }

  protected override receiveValue(type: ValueType | null, val: Point | number | Direction): void {
    if (type !== ValueType.Amount || typeof val !== 'number') return
    this._suspendActiveSlots()
    this._value = val as Amount
    this.markDirty()
  }

  get slot(): ParameterSlot { return this._slot }

  // Seed a newly-created layer (via slot-click-to-create) with the value
  // currently shown by the slider, so the binding starts as a no-op.
  override getSlotDefault(slot: ParameterSlot): Point | number | null {
    if (slot === this._slot) return this._value
    return null
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    const xActive = this._xSlot.isActive
    const yActive = this._ySlot.isActive

    if (xActive || yActive) {
      // Derive value from active point slot(s), averaged.
      const W = Node.canvasWidth
      const H = Node.canvasHeight
      let sum = 0, count = 0
      if (xActive) {
        const pt = (this._xSlot.source as PointSource).getPoint()
        sum += Math.max(0, Math.min(1, pt.x / W))
        count++
      }
      if (yActive) {
        const pt = (this._ySlot.source as PointSource).getPoint()
        sum += Math.max(0, Math.min(1, pt.y / H))
        count++
      }
      this._value = sum / count as Amount
      this._slider.displayValue = this._value
      this._slider.interactive  = false
    } else if (this._slot.isActive) {
      const src = this._slot.source as AmountSource
      this._value = src.getAmount()
      this._slider.displayValue = this._value
      this._slider.interactive  = false
    } else {
      this._slider.interactive  = true
      this._slider.displayValue = this._value
    }
    this._syncSliderBounds()
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { value: this._value }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.value === 'number') this._value = state.value
  }

  private _syncSliderBounds(): void {
    const { x, y, width, height } = this.bounds
    const px = AmountLayer.PAD_X
    const py = AmountLayer.PAD_Y
    this._slider.bounds = {
      x:      x + px,
      y:      y + py,
      width:  Math.max(0, width  - px * 2 - AmountLayer.LABEL_WIDTH),
      height: Math.max(0, height - py * 2),
    }
  }

  // Suspend all active input bindings so the slider can take over.
  private _suspendActiveSlots(): void {
    for (const slot of [this._slot, this._xSlot, this._ySlot]) {
      if (slot.isActive) {
        BindingLayer.findForSlot(slot)?.toggle()
      }
    }
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width <= 0 || this.bounds.height <= 0) return
    this._drawPill(ctx, this.canvasBounds)
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
    const px  = AmountLayer.PAD_X
    const py  = AmountLayer.PAD_Y
    const midY = y + height / 2

    // Update slider bounds for this pill.
    this._slider.bounds = {
      x:      x + px,
      y:      y + py,
      width:  Math.max(0, width  - px * 2 - AmountLayer.LABEL_WIDTH),
      height: Math.max(0, height - py * 2),
    }

    const r = Math.min(height / 2, 8)
    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, r)
    ctx.fill()

    // Slider
    this._slider.renderSelf(ctx)

    // Slot indicators — right to left: y, x, amt
    const slots = [
      { slot: this._slot,  label: 'A', colour: '#4a8fe8' },
      { slot: this._xSlot, label: 'x', colour: '#cf7ecf' },
      { slot: this._ySlot, label: 'y', colour: '#cf7ecf' },
    ]
    let dx = x + width - 6
    ctx.font = '9px monospace'
    for (let i = slots.length - 1; i >= 0; i--) {
      const { slot, label, colour } = slots[i]!
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
      ctx.fillText(dot, dx, midY)
      dx -= 11
      ctx.fillStyle = labelColour
      ctx.fillText(label, dx, midY)
      dx -= ctx.measureText(label).width + 5
    }

    // Numeric label to the left of indicators
    const label = this._value.toFixed(2)
    ctx.font         = '11px monospace'
    const anyActive  = this._slot.isActive || this._xSlot.isActive || this._ySlot.isActive
    ctx.fillStyle    = anyActive ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.80)'
    ctx.textAlign    = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, dx - 2, midY)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point) {
    return this._slider.hitTest(point)
  }
}
