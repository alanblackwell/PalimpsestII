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

export const MIN_RATE  = 0.001  // Hz — slider full-left
export const MAX_RATE  = 8      // Hz — slider full-right
const ACCENT    = '#e87e7e'  // Rate type colour

// Logarithmic mapping between slider [0,1] and Hz [MIN_RATE, MAX_RATE].
const _logRange = Math.log(MAX_RATE / MIN_RATE)
export function sliderToHz(v: number): number {
  return MIN_RATE * Math.exp(v * _logRange)
}
export function hzToSlider(hz: number): number {
  return Math.log(Math.max(MIN_RATE, Math.min(MAX_RATE, hz)) / MIN_RATE) / _logRange
}

export class RateLayer extends Layer implements AmountSource, RateSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Amount, ValueType.Rate])

  private readonly _timeSlot:   ParameterSlot   // Amount input (time source)
  private readonly _rateSlider: SliderRegion     // Rate control widget

  private _phase:     Amount = 0   // output: cycling [0, 1]
  private _rateHz:    Rate   = 1   // current rate in Hz
  private _timeValue: number = 0   // last time input (for display)
  private _cpBounds: { x: number; y: number; width: number; height: number } | null = null

  private static readonly PAD_X   = 10
  private static readonly PAD_Y   = 8
  private static readonly LABEL_W = 80   // reserved on right for text labels

  constructor(initialRateHz: Rate = 1.0) {
    super()
    this._rateHz     = Math.max(MIN_RATE, Math.min(MAX_RATE, initialRateHz))
    const sliderInit = hzToSlider(this._rateHz)
    this._timeSlot   = new ParameterSlot(ValueType.Amount, this, 'time')
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

  // Set the rate directly (e.g. from a proxy slider on the host layer).
  setRateHz(hz: number): void {
    const clamped = Math.max(MIN_RATE, Math.min(MAX_RATE, hz))
    this._rateSlider.setValue(hzToSlider(clamped))
    this._rateHz = clamped
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { sliderValue: this._rateSlider.value }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.sliderValue === 'number') this._rateSlider.setValue(state.sliderValue)
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    // Rate — from slider (no Rate input slot in this implementation).
    this._rateHz = sliderToHz(this._rateSlider.value)
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
    if (this.bounds.width <= 0 || this.bounds.height <= 0) return
    this._drawPill(ctx, this.bounds)
    const cp = this.canvasBounds
    this._cpBounds = cp
    this._drawPill(ctx, cp)
    // ── Phase arc on main canvas ───────────────────────────
    this._renderPhaseArc(ctx)
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
    const midY  = y + height / 2
    const labelX = x + width - RateLayer.LABEL_W + 4

    // Update slider bounds to this pill's position
    const px = RateLayer.PAD_X
    const py = RateLayer.PAD_Y
    const lw = RateLayer.LABEL_W
    this._rateSlider.bounds = {
      x:      x + px,
      y:      y + py,
      width:  Math.max(0, width  - px * 2 - lw),
      height: Math.max(0, height - py * 2),
    }

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

  private _renderPhaseArc(ctx: Ctx2D): void {
    const cw   = ctx.canvas.width
    const ch   = ctx.canvas.height
    const cx   = (cw + 280) / 2   // centre of main area (right of 280px widget strip)
    const cy   = ch / 2
    const R    = 36                // outer radius
    const r    = 22                // inner radius (ring)

    const sweep = this._phase * Math.PI * 2
    const start = -Math.PI / 2    // 12 o'clock

    ctx.save()

    // Track ring background
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(232,126,126,0.18)'
    ctx.lineWidth   = R - r
    ctx.stroke()

    // Filled arc representing current phase
    if (this._phase > 0) {
      ctx.beginPath()
      ctx.arc(cx, cy, R, start, start + sweep)
      ctx.strokeStyle = `rgba(232,126,126,${this._timeSlot.isActive ? '0.80' : '0.35'})`
      ctx.lineWidth   = R - r
      ctx.stroke()
    }

    // Hz label in centre
    ctx.font         = 'bold 12px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.70)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(this._rateHz.toFixed(1) + ' Hz', cx, cy - 6)

    // Phase value below Hz
    ctx.font      = '10px monospace'
    ctx.fillStyle = this._timeSlot.isActive
      ? 'rgba(232,196,74,0.85)'
      : 'rgba(255,255,255,0.30)'
    ctx.fillText('φ ' + this._phase.toFixed(2), cx, cy + 8)

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
