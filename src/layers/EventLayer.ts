import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type Amount, type AmountSource,
  type EventValue, type EventSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// EventLayer — discrete event source (pulse generator)
// ------------------------------------------------------------
//
// Two operating modes:
//
//   Manual   — a [▶ FIRE] button triggers a pulse on click.
//
//   Driven   — an AmountSource (typically a RateLayer phase) is
//              bound to rateSlot.  The layer fires automatically
//              each time the phase wraps around (value drops by
//              more than 0.5 relative to the previous sample —
//              robust zero-crossing detection).  Manual trigger
//              still works on top.
//
// Output:
//   EventValue — performance.now() timestamp of the most recent
//                pulse, or null if never triggered.  Downstream
//                CountLayers detect changes to this value.
//
// A [↺] clear button resets the event time to null.
//
// Visual layout:
//
//   ┌──────────────────────────────────────────────────────┐
//   │ ▌  [▶ FIRE]     last: 2.3 s ago              [↺]   │
//   └──────────────────────────────────────────────────────┘
//
// The last-trigger label pulses bright yellow immediately after
// a fire and fades back to dim over ~1 second.
// Height should be 36 px.

const ACCENT = '#e0e060'   // Event type colour

// Button geometry
const BTN_M = 6    // margin from right edge
const BTN   = 20   // reset button size

export class EventLayer extends Layer implements EventSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Event])

  // Optional AmountSource slot — phase wraps auto-fire.
  private readonly _rateSlot: ParameterSlot

  private _eventTime: EventValue = null   // ms timestamp of last pulse
  private _prevPhase: number     = 0      // for wrap detection

  constructor() {
    super()
    this._rateSlot  = new ParameterSlot(ValueType.Amount, this)
    this.slots.push(this._rateSlot)
    this.debugName = 'EventLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // EventSource
  // ----------------------------------------------------------

  getEventTime(): EventValue { return this._eventTime }

  // ----------------------------------------------------------
  // Slot accessor
  // ----------------------------------------------------------

  get rateSlot(): ParameterSlot { return this._rateSlot }

  // ----------------------------------------------------------
  // Controls
  // ----------------------------------------------------------

  fire(): void {
    this._eventTime = performance.now()
    this.markDirty()
  }

  clearEvent(): void {
    this._eventTime = null
    this._prevPhase = 0
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this._rateSlot.isActive) {
      const phase = (this._rateSlot.source as AmountSource).getAmount() as Amount
      // Wrap detected: new phase is substantially less than previous.
      if (phase < this._prevPhase - 0.5) {
        this._eventTime = performance.now()
      }
      this._prevPhase = phase
    }
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._fireBtnBounds(), point)) {
      this.fire()
      return true
    }
    if (boundingBoxContains(this._clearBtnBounds(), point)) {
      this.clearEvent()
      return true
    }
    return false
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    return boundingBoxContains(this.bounds, point) ? this : null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    const { x, y, width, height } = this.bounds
    if (width <= 0 || height <= 0) return

    const midY = y + height / 2
    const now  = performance.now()

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

    // [▶ FIRE] button
    const fb = this._fireBtnBounds()
    ctx.fillStyle = 'rgba(224,224,96,0.15)'
    ctx.beginPath()
    ctx.roundRect(fb.x, fb.y, fb.width, fb.height, 4)
    ctx.fill()
    ctx.font         = 'bold 11px monospace'
    ctx.fillStyle    = ACCENT
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('▶ FIRE', fb.x + fb.width / 2, fb.y + fb.height / 2)

    // Last-trigger label — fades from bright to dim over 1 s
    const clearB = this._clearBtnBounds()
    const labelX = fb.x + fb.width + 10
    const labelR = clearB.x - 8
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'

    if (this._eventTime === null) {
      ctx.fillStyle = 'rgba(255,255,255,0.22)'
      ctx.fillText('last: —', labelX, midY)
    } else {
      const age    = (now - this._eventTime) / 1000   // seconds since last pulse
      const bright = Math.max(0, 1 - age)             // fades to 0 over 1 s
      const baseA  = 0.45
      const alpha  = baseA + bright * 0.50
      // Blend from yellow to white as it fades
      const r = Math.round(255)
      const g = Math.round(255)
      const b = Math.round(bright * 96)
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(2)})`
      const ageSec  = age < 100 ? age.toFixed(1) + ' s ago' : '—'
      // Right-align within label zone to keep layout stable
      ctx.textAlign = 'right'
      ctx.fillText('last: ' + ageSec, labelR, midY)
    }

    // [↺] clear button
    this._drawBtn(ctx, clearB, '↺', 'rgba(255,255,255,0.40)')

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _drawBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    colour: string,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
    ctx.font         = '13px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }

  private _clearBtnBounds() {
    const { x, y, width, height } = this.bounds
    const s = BTN
    return { x: x + width - BTN_M - s, y: y + (height - s) / 2, width: s, height: s }
  }

  private _fireBtnBounds() {
    const { x, y, height } = this.bounds
    const fw = 58   // wide enough for "▶ FIRE"
    const fh = 22
    return { x: x + 10, y: y + (height - fh) / 2, width: fw, height: fh }
  }
}
