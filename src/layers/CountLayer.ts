import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type Count, type CountSource,
  type EventSource, type EventValue,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// CountLayer — a non-negative integer counter
// ------------------------------------------------------------
//
// Two operating modes:
//
//   Manual   — [−] and [+] buttons increment/decrement the count.
//              Count never goes below 0.
//
//   Driven   — an EventSource is bound to the event slot.  Each
//              new event pulse (EventValue timestamp changes)
//              increments the counter by 1.  Manual buttons still
//              work on top.
//
// A [↺] reset button always zeros the counter.
//
// Visual layout:
//
//   ┌──────────────────────────────────────────────────────┐
//   │ ▌  [−]   42   [+]                              [↺]  │
//   └──────────────────────────────────────────────────────┘
//
// Height should be 36 px (same as AmountLayer).

const ACCENT = '#a0a0a0'   // Count type colour

// Button geometry
const BTN   = 22   // button size in px
const BTN_M = 6    // margin from right edge
const BTN_G = 6    // gap between buttons

export class CountLayer extends Layer implements CountSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Count])

  // Optional EventSource input — increments counter on each new pulse.
  private readonly _eventSlot: ParameterSlot

  private _count: Count = 0

  // Last seen event timestamp — used to detect new pulses.
  private _lastEventTime: EventValue = null

  constructor(initial: Count = 0) {
    super()
    this._count    = Math.max(0, Math.floor(initial))
    this._eventSlot = new ParameterSlot(ValueType.Event, this)
    this.slots.push(this._eventSlot)
    this.debugName = 'CountLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // CountSource
  // ----------------------------------------------------------

  getCount(): Count { return this._count }

  // ----------------------------------------------------------
  // Slot accessor
  // ----------------------------------------------------------

  get eventSlot(): ParameterSlot { return this._eventSlot }

  // ----------------------------------------------------------
  // Controls
  // ----------------------------------------------------------

  increment(): void {
    this._count++
    this.markDirty()
  }

  decrement(): void {
    if (this._count > 0) this._count--
    this.markDirty()
  }

  reset(): void {
    this._count         = 0
    this._lastEventTime = null
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this._eventSlot.isActive) {
      const src = this._eventSlot.source as EventSource
      const t   = src.getEventTime()
      // New, non-null timestamp that differs from what we last saw → pulse.
      if (t !== null && t !== this._lastEventTime) {
        this._count++
        this._lastEventTime = t
      }
    }
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._decrBtnBounds(), point)) {
      this.decrement()
      return true
    }
    if (boundingBoxContains(this._incrBtnBounds(), point)) {
      this.increment()
      return true
    }
    if (boundingBoxContains(this._resetBtnBounds(), point)) {
      this.reset()
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

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.bounds
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

    // [−] button
    const decrB = this._decrBtnBounds()
    this._drawBtn(ctx, decrB, '−',
      this._count > 0 ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.18)')

    // Count value — centred between the two stepper buttons
    const incrB  = this._incrBtnBounds()
    const valCx  = (decrB.x + decrB.width + incrB.x) / 2
    ctx.font         = '13px monospace'
    ctx.fillStyle    = this._eventSlot.isActive
      ? 'rgba(160,160,160,0.95)'
      : 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(this._count), valCx, midY)

    // [+] button
    this._drawBtn(ctx, incrB, '+', 'rgba(255,255,255,0.75)')

    // [↺] reset button
    this._drawBtn(ctx, this._resetBtnBounds(), '↺', 'rgba(255,255,255,0.45)')

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

    ctx.font         = '14px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }

  // Layout: [−] at left after accent stripe; [+] immediately after; [↺] at right edge.
  private _decrBtnBounds() {
    const { x, y, height } = this.bounds
    const s = BTN
    return { x: x + 10, y: y + (height - s) / 2, width: s, height: s }
  }

  private _incrBtnBounds() {
    const db = this._decrBtnBounds()
    return { x: db.x + BTN + BTN_G, y: db.y, width: BTN, height: BTN }
  }

  private _resetBtnBounds() {
    const { x, y, width, height } = this.bounds
    const s = BTN
    return { x: x + width - BTN_M - s, y: y + (height - s) / 2, width: s, height: s }
  }
}
