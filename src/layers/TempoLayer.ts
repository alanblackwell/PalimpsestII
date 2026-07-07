import { Layer } from '../core/Layer.js'
import { Node }  from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  type Amount, type AmountSource,
  type Rate,   type RateSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { SliderRegion } from '../regions/SliderRegion.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'

// ------------------------------------------------------------
// TempoLayer — converts a time source into a cycling phase
// ------------------------------------------------------------
//
// Inputs:
//   _timeSlot  (Amount) — binds to a ClockLayer or any Amount source.
//                         Represents elapsed time in seconds.
//
//   _rateSlider (embedded SliderRegion) — controls the rate in Hz
//                         when no Rate slot is bound.  Maps slider
//                         value [0, 1] → [MIN_RATE, MAX_RATE] Hz.
//
// Output:
//   Amount — a phase value (t × hz) mod 1, cycling [0, 1].
//   Rate   — the current rate value in Hz.
//             (types satisfies both Amount and Rate, so other layers
//              can bind to this as either.)
//
// Display is in BPM (beats per minute) with conventional metronome
// markings.  Internal computation remains in Hz.

export const MIN_RATE  = 0.001  // Hz — slider full-left  (~0.06 BPM)
export const MAX_RATE  = 8      // Hz — slider full-right (~480 BPM)
const ACCENT    = '#e87e7e'  // Rate type colour

// Logarithmic mapping between slider [0,1] and Hz [MIN_RATE, MAX_RATE].
const _logRange = Math.log(MAX_RATE / MIN_RATE)
export function sliderToHz(v: number): number {
  return MIN_RATE * Math.exp(v * _logRange)
}
export function hzToSlider(hz: number): number {
  return Math.log(Math.max(MIN_RATE, Math.min(MAX_RATE, hz)) / MIN_RATE) / _logRange
}

// BPM ↔ Hz helpers used for display.
export function hzToBpm(hz: number): number { return hz * 60 }
export function bpmToHz(bpm: number): number { return bpm / 60 }

// Conventional Italian metronome markings, keyed by BPM threshold.
export function tempoMarking(hz: number): string {
  const bpm = hz * 60
  if (bpm <  24)  return 'Larghissimo'
  if (bpm <  40)  return 'Largo'
  if (bpm <  60)  return 'Lento'
  if (bpm <  66)  return 'Larghetto'
  if (bpm <  76)  return 'Adagio'
  if (bpm < 108)  return 'Andante'
  if (bpm < 120)  return 'Moderato'
  if (bpm < 156)  return 'Allegro'
  if (bpm < 176)  return 'Vivace'
  if (bpm < 200)  return 'Presto'
  return 'Prestissimo'
}

export class TempoLayer extends Layer implements AmountSource, RateSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Amount, ValueType.Rate])

  private readonly _timeSlot:   ParameterSlot   // Amount input (time source)
  private readonly _rateSlider: SliderRegion     // Rate control widget

  private _phase:     Amount = 0   // output: cycling [0, 1]
  private _rateHz:    Rate   = 1   // current rate in Hz
  private _timeValue: number = 0   // last time input (for display)
  private _cpBounds: { x: number; y: number; width: number; height: number } | null = null

  // Layers whose sliders directly control this Tempo's Hz (tracked externally
  // by those layers; not a ParameterSlot binding).
  private readonly _controllers: Set<Layer> = new Set()

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
    this.debugName = 'TempoLayer'
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

  // Register/unregister a layer whose slider proxies this Tempo's Hz.
  // Called from the controller layer's recompute() when _hiddenRate changes.
  addController(layer: Layer):    void { this._controllers.add(layer)    }
  removeController(layer: Layer): void { this._controllers.delete(layer) }

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
    this._renderPhaseArc(ctx)
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
    const midY   = y + height / 2
    const labelX = x + width - TempoLayer.LABEL_W + 4

    const px = TempoLayer.PAD_X
    const py = TempoLayer.PAD_Y
    const lw = TempoLayer.LABEL_W
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

    ctx.font      = '11px monospace'
    ctx.textAlign = 'left'

    // BPM value (upper label line)
    ctx.fillStyle    = 'rgba(255,255,255,0.80)'
    ctx.textBaseline = 'middle'
    ctx.fillText(Math.round(this._rateHz * 60) + ' BPM', labelX, midY - 7)

    // Metronome marking (lower label line) — lit when time source is active
    ctx.fillStyle = this._timeSlot.isActive
      ? 'rgba(232,196,74,0.90)'
      : 'rgba(255,255,255,0.30)'
    ctx.fillText(tempoMarking(this._rateHz), labelX, midY + 7)

    ctx.restore()
  }

  private _renderPhaseArc(ctx: Ctx2D): void {
    const cw   = ctx.canvas.width
    const ch   = ctx.canvas.height
    const cx   = (cw + 280) / 2
    const cy   = ch / 2
    const R    = 36
    const r    = 22

    const sweep = this._phase * Math.PI * 2
    const start = -Math.PI / 2

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

    // BPM value
    ctx.font         = 'bold 12px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.70)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(Math.round(this._rateHz * 60) + ' BPM', cx, cy - 10)

    // Metronome marking
    ctx.font      = '10px monospace'
    ctx.fillStyle = this._timeSlot.isActive
      ? 'rgba(232,196,74,0.85)'
      : 'rgba(255,255,255,0.30)'
    ctx.fillText(tempoMarking(this._rateHz), cx, cy + 3)

    // Phase value
    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.fillText('φ ' + this._phase.toFixed(2), cx, cy + 16)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Slot rendering — time slot + optional "responds to" pill
  // ----------------------------------------------------------

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const y1 = this.renderSlotGroup(ctx, this.slots, this.panelBottom)

    if (this._controllers.size === 0) return

    const PANEL_X = contentLeft(Node.canvasWidth)
    const PANEL_W = panelWidth(Node.canvasWidth)
    const HEAD_H  = 18
    const ENTRY_H = 18
    const GAP     = 4
    const y0      = y1 + GAP

    const names: string[] = []
    for (const c of this._controllers) names.push(c.debugName ?? '?')

    const totalH = HEAD_H + names.length * ENTRY_H

    ctx.save()
    ctx.textBaseline = 'middle'

    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(PANEL_X, y0, PANEL_W, totalH, 6)
    ctx.fill()

    ctx.font      = '9px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.38)'
    ctx.textAlign = 'left'
    ctx.fillText('responds to', PANEL_X + 8, y0 + HEAD_H / 2)

    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.70)'
    let ey = y0 + HEAD_H
    for (const name of names) {
      ctx.fillText(name, PANEL_X + 14, ey + ENTRY_H / 2)
      ey += ENTRY_H
    }

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
    const px = TempoLayer.PAD_X
    const py = TempoLayer.PAD_Y
    const lw = TempoLayer.LABEL_W
    this._rateSlider.bounds = {
      x:      x + px,
      y:      y + py,
      width:  Math.max(0, width  - px * 2 - lw),
      height: Math.max(0, height - py * 2),
    }
  }
}
