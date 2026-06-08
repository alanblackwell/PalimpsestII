import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type CollectionValue, type CollectionSource,
  type Amount, type AmountSource,
  type EventValue, type EventSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// CollectionLayer — step-sequencer / value bank
// ------------------------------------------------------------
//
// Stores N Amount values (2 – 8 items) and outputs the currently
// selected item as both Amount and Collection.
//
// Item selection — two independent mechanisms, lowest-priority first:
//
//   stepSlot  (Event)  — each new event pulse advances the step
//                        counter by 1, wrapping mod N.
//
//   indexSlot (Amount) — maps [0, 1) → item 0 .. N-1 (continuous
//                        lookup).  Overrides the step counter when
//                        bound.
//
// Manual editing:
//   Click + drag anywhere in the bar area to set an item's value.
//   Dragging vertically within a bar adjusts its value (top = 1,
//   bottom = 0).
//
// Item count:
//   [−] / [+] buttons change N (min 2, max 8).  Items are added at
//   the end (default value 0.5) or removed from the end.
//
// Visual layout (height ≈ 90 px):
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌  [−] 4 [+]    step 2/4    = 0.73    event ○   idx ○  │
//   │                                                          │
//   │  ████  ████  ████  ████  ← draggable value bars         │
//   │  [0]   [1]  *[2]   [3]   (* = active item)             │
//   └──────────────────────────────────────────────────────────┘
//
// Outputs both Amount (selected value) and Collection (all values).

const ACCENT   = '#a0a4b8'   // neutral — Collection has no specific accent; use muted blue
const MIN_N    = 2
const MAX_N    = 8
const ROW1_H   = 32          // height of the control row
const BAR_PAD  = 6           // horizontal padding around the bar group
const BAR_GAP  = 4           // gap between bars
const BTN      = 20
const BTN_M    = 6

export class CollectionLayer extends Layer
  implements AmountSource, CollectionSource {

  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Amount, ValueType.Collection])

  private readonly _indexSlot: ParameterSlot
  private readonly _stepSlot:  ParameterSlot

  private _values:        number[] = [0.20, 0.50, 0.80, 0.40]
  private _stepIndex:     number   = 0
  private _activeIndex:   number   = 0
  private _lastEventTime: EventValue = null

  // Drag state for bar editing
  private _dragBarIndex: number = -1

  constructor(initial: readonly number[] = [0.20, 0.50, 0.80, 0.40]) {
    super()
    this._values    = [...initial]
    this._indexSlot = new ParameterSlot(ValueType.Amount, this)
    this._stepSlot  = new ParameterSlot(ValueType.Event,  this)
    this.slots.push(this._indexSlot, this._stepSlot)
    this.debugName = 'CollectionLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // AmountSource + CollectionSource
  // ----------------------------------------------------------

  getAmount():     Amount          { return this._values[this._activeIndex] ?? 0 }
  getCollection(): CollectionValue { return this._values }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get indexSlot(): ParameterSlot { return this._indexSlot }
  get stepSlot():  ParameterSlot { return this._stepSlot  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    const n = this._values.length

    // Step advance on new event pulse
    if (this._stepSlot.isActive) {
      const t = (this._stepSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastEventTime) {
        this._stepIndex     = (this._stepIndex + 1) % n
        this._lastEventTime = t
      }
    }

    // Index slot overrides step counter
    if (this._indexSlot.isActive) {
      const amt = (this._indexSlot.source as AmountSource).getAmount() as Amount
      this._activeIndex = Math.min(n - 1, Math.floor(amt * n))
    } else {
      this._activeIndex = this._stepIndex % n
    }
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    // Control row buttons
    if (boundingBoxContains(this._decrBtnBounds(), point)) {
      if (this._values.length > MIN_N) {
        this._values.pop()
        this._stepIndex  = this._stepIndex % this._values.length
        this._activeIndex = Math.min(this._activeIndex, this._values.length - 1)
        this.markDirty()
      }
      return true
    }
    if (boundingBoxContains(this._incrBtnBounds(), point)) {
      if (this._values.length < MAX_N) {
        this._values.push(0.5)
        this.markDirty()
      }
      return true
    }

    // Bar area — find which bar was clicked
    const idx = this._barIndexAt(point)
    if (idx >= 0) {
      this._dragBarIndex = idx
      this._setBarValue(idx, point)
      return true
    }

    return false
  }

  handlePointerMove(point: Point): void {
    if (this._dragBarIndex >= 0) {
      this._setBarValue(this._dragBarIndex, point)
    }
  }

  handlePointerUp(): void {
    this._dragBarIndex = -1
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

    this._renderControlRow(ctx)
    this._renderBars(ctx)

    ctx.restore()
  }

  // ── Control row ─────────────────────────────────────────────

  private _renderControlRow(ctx: Ctx2D): void {
    const { x, y, width } = this.bounds
    const midY = y + ROW1_H / 2
    const n    = this._values.length

    // [−] count [+]
    const db = this._decrBtnBounds()
    const ib = this._incrBtnBounds()
    this._drawBtn(ctx, db, '−', n > MIN_N ? 'rgba(255,255,255,0.70)' : 'rgba(255,255,255,0.20)')
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.85)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(n), (db.x + db.width + ib.x) / 2, midY)
    this._drawBtn(ctx, ib, '+', n < MAX_N ? 'rgba(255,255,255,0.70)' : 'rgba(255,255,255,0.20)')

    // Step indicator
    const stepStr = `step ${this._activeIndex + 1}/${n}`
    ctx.font      = '10px monospace'
    ctx.fillStyle = this._stepSlot.isActive
      ? 'rgba(160,164,184,0.90)' : 'rgba(255,255,255,0.45)'
    ctx.textAlign    = 'left'
    ctx.fillText(stepStr, ib.x + BTN + 10, midY)

    // Output value
    const outStr = '= ' + this.getAmount().toFixed(2)
    ctx.fillStyle    = 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'center'
    ctx.fillText(outStr, x + width / 2, midY)

    // Slot indicators (right side)
    const slots = [
      { slot: this._stepSlot,  label: 'step' },
      { slot: this._indexSlot, label: 'idx'  },
    ]
    let dx = x + width - BTN_M
    ctx.font = '9px monospace'
    for (let i = slots.length - 1; i >= 0; i--) {
      const { slot, label } = slots[i]
      const active = slot.isActive
      ctx.fillStyle    = active ? ACCENT : 'rgba(255,255,255,0.22)'
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(active ? '●' : '○', dx, midY)
      dx -= 12
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText(label, dx, midY)
      dx -= ctx.measureText(label).width + 6
    }
  }

  // ── Value bars ───────────────────────────────────────────────

  private _renderBars(ctx: Ctx2D): void {
    const { x, y, width, height } = this.bounds
    const n       = this._values.length
    const barArea = this._barAreaBounds()
    const bw      = (barArea.width - (n - 1) * BAR_GAP) / n

    for (let i = 0; i < n; i++) {
      const bx       = barArea.x + i * (bw + BAR_GAP)
      const by       = barArea.y
      const bh       = barArea.height
      const v        = this._values[i]
      const active   = i === this._activeIndex
      const fillH    = Math.max(2, v * bh)

      // Bar track background
      ctx.fillStyle = 'rgba(255,255,255,0.07)'
      ctx.beginPath()
      ctx.roundRect(bx, by, bw, bh, 3)
      ctx.fill()

      // Value fill
      ctx.fillStyle = active
        ? ACCENT
        : 'rgba(255,255,255,0.35)'
      ctx.beginPath()
      ctx.roundRect(bx, by + bh - fillH, bw, fillH, 3)
      ctx.fill()

      // Active highlight border
      if (active) {
        ctx.strokeStyle = 'rgba(160,164,184,0.70)'
        ctx.lineWidth   = 1
        ctx.beginPath()
        ctx.roundRect(bx, by, bw, bh, 3)
        ctx.stroke()
      }

      // Index label
      ctx.font         = '9px monospace'
      ctx.fillStyle    = active
        ? 'rgba(255,255,255,0.90)' : 'rgba(255,255,255,0.30)'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillText(String(i), bx + bw / 2, by + bh + 10)
    }

    // Separator line between control row and bars
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(x + 8, y + ROW1_H)
    ctx.lineTo(x + width - 8, y + ROW1_H)
    ctx.stroke()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _barAreaBounds() {
    const { x, y, width, height } = this.bounds
    return {
      x:      x + BAR_PAD,
      y:      y + ROW1_H + 6,
      width:  width - BAR_PAD * 2,
      height: height - ROW1_H - 6 - 14,  // 14 = space for index labels
    }
  }

  private _barIndexAt(point: Point): number {
    const ba = this._barAreaBounds()
    if (!boundingBoxContains(ba, point)) return -1
    const n  = this._values.length
    const bw = (ba.width - (n - 1) * BAR_GAP) / n
    const rel = point.x - ba.x
    const idx = Math.floor(rel / (bw + BAR_GAP))
    return idx >= 0 && idx < n ? idx : -1
  }

  private _setBarValue(idx: number, point: Point): void {
    const ba = this._barAreaBounds()
    const t  = 1 - Math.max(0, Math.min(1, (point.y - ba.y) / ba.height))
    this._values[idx] = t
    this.markDirty()
  }

  private _decrBtnBounds() {
    const { x, y } = this.bounds
    return { x: x + 8, y: y + (ROW1_H - BTN) / 2, width: BTN, height: BTN }
  }

  private _incrBtnBounds() {
    const db = this._decrBtnBounds()
    return { x: db.x + BTN + 18, y: db.y, width: BTN, height: BTN }
  }

  private _drawBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    colour: string,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
    ctx.font         = '14px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }
}
