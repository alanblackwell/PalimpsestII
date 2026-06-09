import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  type Amount, type AmountSource,
  type Rate,   type RateSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { SliderRegion } from '../regions/SliderRegion.js'

// ------------------------------------------------------------
// RateLayer — converts a time source into a cycling phase
// ------------------------------------------------------------
//
// Inputs:
//   _timeSlot  (Amount) — binds to a ClockLayer or any Amount source.
//                         Represents elapsed time in seconds.
//
//   _rateSlider (embedded SliderRegion) — controls the rate in Hz
//                         when no Rate slot is bound.  Maps slider
//                         value [0, 1] → [0, MAX_RATE] Hz.
//
// Output:
//   Amount — a phase value (t × hz) mod 1, cycling [0, 1].
//   Rate   — the current rate value in Hz.
//             (types satisfies both Amount and Rate, so other layers
//              can bind to this as either.)
//
// Visual:
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ [========== rate slider ==========]   1.0 Hz            │
//   │                                       φ 0.42            │
//   └──────────────────────────────────────────────────────────┘
//
// Height should be ~44 px to accommodate two label lines.

const MAX_RATE  = 8     // Hz — slider full-right
const ACCENT    = '#e87e7e'  // Rate type colour

export class RateLayer extends Layer implements AmountSource, RateSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Amount, ValueType.Rate])

  private readonly _timeSlot:   ParameterSlot   // Amount input (time source)
  private readonly _rateSlider: SliderRegion     // Rate control widget

  private _phase:     Amount = 0   // output: cycling [0, 1]
  private _rateHz:    Rate   = 1   // current rate in Hz
  private _timeValue: number = 0   // last time input (for display)

  private static readonly PAD_X   = 10
  private static readonly PAD_Y   = 8
  private static readonly LABEL_W = 80   // reserved on right for text labels

  constructor(initialRateHz: Rate = 1.0) {
    super()
    this._rateHz     = Math.max(0, Math.min(MAX_RATE, initialRateHz))
    const sliderInit = this._rateHz / MAX_RATE
    this._timeSlot   = new ParameterSlot(ValueType.Amount, this)
    this._rateSlider = new SliderRegion(this, sliderInit)
    this.slots.push(this._timeSlot)
    this.debugName = 'RateLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // AmountSource + RateSource
  // ----------------------------------------------------------

  getAmount(): Amount { return this._phase  }
  getRate():   Rate   { return this._rateHz }

  // ----------------------------------------------------------
  // Slot accessor (for BindingLayer.create)
  // ----------------------------------------------------------

  get timeSlot(): ParameterSlot { return this._timeSlot }

  // ----------------------------------------------------------
  // Called by the embedded SliderRegion when the user drags.
  // ----------------------------------------------------------

  setValue(v: Amount): void {
    this._rateHz = v * MAX_RATE
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    // Rate — from slider (no Rate input slot in this implementation).
    this._rateHz = this._rateSlider.value * MAX_RATE
    this._rateSlider.interactive  = true
    this._rateSlider.displayValue = this._rateSlider.value

    // Time — from bound source, or zero if unbound.
    if (this._timeSlot.isActive) {
      this._timeValue = (this._timeSlot.source as AmountSource).getAmount()
    } else {
      this._timeValue = 0
    }

    // Phase — wrap into [0, 1).
    this._phase = this._rateHz > 0
      ? (this._timeValue * this._rateHz) % 1
      : 0

    this._syncSliderBounds()
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.bounds
    if (width <= 0 || height <= 0) return

    const midY  = y + height / 2
    const labelX = x + width - RateLayer.LABEL_W + 4

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe (Rate colour)
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // Rate slider widget
    this._rateSlider.renderSelf(ctx)

    ctx.font = '11px monospace'
    ctx.textAlign    = 'left'

    // Rate in Hz (upper label line)
    ctx.fillStyle    = 'rgba(255,255,255,0.80)'
    ctx.textBaseline = 'middle'
    ctx.fillText(this._rateHz.toFixed(1) + ' Hz', labelX, midY - 7)

    // Phase output (lower label line) — lit when time source is active
    ctx.fillStyle = this._timeSlot.isActive
      ? 'rgba(232,196,74,0.90)'   // warm gold = time is flowing
      : 'rgba(255,255,255,0.30)'  // dim = no time source bound
    ctx.fillText('φ ' + this._phase.toFixed(2), labelX, midY + 7)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point) {
    return this._rateSlider.hitTest(point)
  }

  // ----------------------------------------------------------
  // Private
  // ----------------------------------------------------------

  private _syncSliderBounds(): void {
    const { x, y, width, height } = this.bounds
    const px = RateLayer.PAD_X
    const py = RateLayer.PAD_Y
    const lw = RateLayer.LABEL_W
    this._rateSlider.bounds = {
      x:      x + px,
      y:      y + py,
      width:  Math.max(0, width  - px * 2 - lw),
      height: Math.max(0, height - py * 2),
    }
  }
}
