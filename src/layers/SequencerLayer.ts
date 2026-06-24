import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type Amount,     type AmountSource,
  type Point,      type PointSource,
  type EventValue, type EventSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// SequencerLayer — 2-D point step sequencer
// ------------------------------------------------------------
//
// Stores N points in normalised [0, 1] × [0, 1] space and steps
// through them, outputting the current or interpolated position
// as a Point (scaled to canvas coordinates) and the normalised
// playhead position as an Amount.
//
// Playback — two independent mechanisms:
//
//   rateSlot  (Amount) — maps [0, 1) → continuous fractional index
//                        across all N points.  Supports linear and
//                        smooth interpolation between steps.
//                        Takes priority over eventSlot when bound.
//
//   eventSlot (Event)  — each new pulse advances the step counter
//                        by 1, wrapping mod N.  No interpolation.
//
// Interpolation mode — cycled with [◀] / [▶]:
//
//   step   — snaps to the nearest keyframe (no blending).
//   linear — straight-line interpolation between adjacent keyframes.
//   smooth — smoothstep (ease-in/out) interpolation.
//
// Manual editing:
//   Drag dots in the preview area to reposition keyframes.
//   [−] / [+] remove or add keyframes (min 2, max 8).
//   New keyframes default to the centre of the preview area.
//
// Outputs:
//   Point  — current position in canvas-pixel coordinates.
//   Amount — playhead position [0, 1] (suitable for feedback).
//
// Visual layout (height ≈ 128 px):
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌  [−] 4 [+]   [◀] linear [▶]              rate ○  ev ○│
//   │ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │
//   │  ┌──────────────────────────────────────────────────┐   │
//   │  │  ●0 ——— •1        draggable dots; active = ●     │   │
//   │  │          \        lines = interp path             │   │
//   │  │           •2                                      │   │
//   │  │    •3 ——— (end = back to •0 when looping)        │   │
//   │  └──────────────────────────────────────────────────┘   │
//   └──────────────────────────────────────────────────────────┘
//
// Call resize(w, h) when the canvas dimensions change.

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ACCENT  = '#e87070'   // salmon/coral — sequencer/playback
const MIN_N   = 2
const MAX_N   = 8
const ROW1_H  = 32
const PRV_PAD = 8
const PRV_H   = 80
const BTN     = 20
const BTN_M   = 6
const DOT_R   = 5

type InterpMode = 'step' | 'linear' | 'smooth'
const INTERP_MODES: InterpMode[] = ['step', 'linear', 'smooth']
const LABEL_W = 52
const NAV_W   = 18
const NAV_H   = 22

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function smoothstep(t: number): number { return t * t * (3 - 2 * t) }

// ------------------------------------------------------------------
// SequencerLayer
// ------------------------------------------------------------------

export class SequencerLayer extends Layer implements PointSource, AmountSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Point, ValueType.Amount])

  private readonly _rateSlot:  ParameterSlot
  private readonly _eventSlot: ParameterSlot

  // Keyframes in normalised [0, 1] space
  private _points: Array<{ x: number; y: number }> = [
    { x: 0.30, y: 0.30 },
    { x: 0.70, y: 0.30 },
    { x: 0.70, y: 0.70 },
    { x: 0.30, y: 0.70 },
  ]

  private _interpIndex:   number     = 1          // default: linear
  private _stepIndex:     number     = 0
  private _lastEventTime: EventValue = null

  // Resolved outputs
  private _outPoint:  Point  = { x: 0, y: 0 }
  private _outAmount: Amount = 0

  // Canvas dimensions for coordinate scaling
  private _canvasW: number
  private _canvasH: number

  // Drag state for dot editing
  private _dragIdx: number = -1
  private _cpBounds: { x: number; y: number; width: number; height: number } | null = null

  constructor(canvasWidth = 1920, canvasHeight = 1080) {
    super()
    this._canvasW   = canvasWidth
    this._canvasH   = canvasHeight
    this._rateSlot  = new ParameterSlot(ValueType.Amount, this)
    this._eventSlot = new ParameterSlot(ValueType.Event,  this)
    this.slots.push(this._rateSlot, this._eventSlot)
    this.displayBaseName = 'Sequence'
    this.debugName = 'Sequence'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // Sources
  // ----------------------------------------------------------

  getPoint():  Point  { return this._outPoint  }
  getAmount(): Amount { return this._outAmount }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get rateSlot():  ParameterSlot { return this._rateSlot  }
  get eventSlot(): ParameterSlot { return this._eventSlot }

  // ----------------------------------------------------------
  // Resize
  // ----------------------------------------------------------

  resize(w: number, h: number): void {
    this._canvasW = w
    this._canvasH = h
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Interpolation cycling
  // ----------------------------------------------------------

  cycleNext(): void {
    this._interpIndex = (this._interpIndex + 1) % INTERP_MODES.length
    this.markDirty()
  }

  cyclePrev(): void {
    this._interpIndex = (this._interpIndex - 1 + INTERP_MODES.length) % INTERP_MODES.length
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      points:        this._points,
      interpIndex:   this._interpIndex,
      stepIndex:     this._stepIndex,
      lastEventTime: this._lastEventTime,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (Array.isArray(state.points)) this._points = state.points as Array<{ x: number; y: number }>
    if (typeof state.interpIndex === 'number') this._interpIndex = state.interpIndex
    if (typeof state.stepIndex === 'number')   this._stepIndex   = state.stepIndex
    if (typeof state.lastEventTime === 'number' || state.lastEventTime === null) {
      this._lastEventTime = state.lastEventTime as EventValue
    }
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    const n    = this._points.length
    const mode = INTERP_MODES[this._interpIndex]!

    // Advance step counter on new event pulse (lower priority than rateSlot)
    if (this._eventSlot.isActive) {
      const t = (this._eventSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastEventTime) {
        this._stepIndex     = (this._stepIndex + 1) % n
        this._lastEventTime = t
      }
    }

    if (this._rateSlot.isActive) {
      // Continuous fractional index driven by rate
      const rate = (this._rateSlot.source as AmountSource).getAmount() as Amount
      const fi   = rate * n

      if (mode === 'step') {
        const i         = Math.min(n - 1, Math.floor(fi))
        this._outPoint  = this._scalePoint(this._points[i] ?? this._points[0]!)
        this._outAmount = i / Math.max(1, n - 1)
      } else {
        const i0     = Math.floor(fi) % n
        const i1     = (i0 + 1) % n
        const t      = fi - Math.floor(fi)
        const p0     = this._points[i0]!
        const p1     = this._points[i1]!
        const blend  = mode === 'smooth' ? smoothstep(t) : t
        this._outPoint = this._scalePoint({
          x: p0.x + (p1.x - p0.x) * blend,
          y: p0.y + (p1.y - p0.y) * blend,
        })
        this._outAmount = (i0 + t) / n
      }
    } else {
      // Event / manual step
      const idx       = this._stepIndex % n
      this._outPoint  = this._scalePoint(this._points[idx] ?? this._points[0]!)
      this._outAmount = idx / Math.max(1, n - 1)
    }
  }

  private _scalePoint(p: { x: number; y: number }): Point {
    return { x: p.x * this._canvasW, y: p.y * this._canvasH }
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    const b = this._cpBounds ?? this.bounds
    if (boundingBoxContains(this._decrBtnBounds(b), point)) {
      if (this._points.length > MIN_N) {
        this._points.pop()
        this._stepIndex = this._stepIndex % this._points.length
        this.markDirty()
      }
      return true
    }
    if (boundingBoxContains(this._incrBtnBounds(b), point)) {
      if (this._points.length < MAX_N) {
        this._points.push({ x: 0.5, y: 0.5 })
        this.markDirty()
      }
      return true
    }
    if (boundingBoxContains(this._prevBtnBounds(b), point)) { this.cyclePrev(); return true }
    if (boundingBoxContains(this._labelBounds(b),   point)) { this.cycleNext(); return true }
    if (boundingBoxContains(this._nextBtnBounds(b), point)) { this.cycleNext(); return true }

    const pv = this._previewBounds(b)
    if (boundingBoxContains(pv, point)) {
      const idx = this._dotIndexAt(point, pv)
      if (idx >= 0) {
        this._dragIdx = idx
        this._setDotFromPoint(idx, point, pv)
      }
      return true
    }

    return false
  }

  handlePointerMove(point: Point): void {
    if (this._dragIdx >= 0) {
      const b = this._cpBounds ?? this.bounds
      this._setDotFromPoint(this._dragIdx, point, this._previewBounds(b))
    }
  }

  handlePointerUp(): void {
    this._dragIdx = -1
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    return (this._cpBounds && boundingBoxContains(this._cpBounds, point))
      ? this : null
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
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.50)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    this._renderControlRow(ctx, b)
    this._renderPreview(ctx, b)

    ctx.restore()
  }

  // ── Control row ─────────────────────────────────────────────

  private _renderControlRow(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width } = b
    const midY = y + ROW1_H / 2
    const n    = this._points.length

    // [−] count [+]
    const db = this._decrBtnBounds(b)
    const ib = this._incrBtnBounds(b)
    this._drawBtn(ctx, db, '−', n > MIN_N ? 'rgba(255,255,255,0.70)' : 'rgba(255,255,255,0.20)')
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.85)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(n), (db.x + db.width + ib.x) / 2, midY)
    this._drawBtn(ctx, ib, '+', n < MAX_N ? 'rgba(255,255,255,0.70)' : 'rgba(255,255,255,0.20)')

    // [◀] interp [▶]
    this._drawNavBtn(ctx, this._prevBtnBounds(b), '◀', midY)
    const lb = this._labelBounds(b)
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(lb.x, lb.y, lb.width, lb.height, 3)
    ctx.fill()
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(INTERP_MODES[this._interpIndex]!, lb.x + lb.width / 2, midY)
    this._drawNavBtn(ctx, this._nextBtnBounds(b), '▶', midY)

    // Slot indicators (right side)
    const slots = [
      { slot: this._rateSlot,  label: 'rate' },
      { slot: this._eventSlot, label: 'ev'   },
    ]
    let dx = x + width - BTN_M
    ctx.font = '9px monospace'
    for (let i = slots.length - 1; i >= 0; i--) {
      const entry = slots[i]; if (!entry) continue
      const { slot, label } = entry
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

  // ── Preview ──────────────────────────────────────────────────

  private _renderPreview(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width } = b
    const pv   = this._previewBounds(b)
    const n    = this._points.length
    const mode = INTERP_MODES[this._interpIndex]!

    // Separator line
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(x + 8,         y + ROW1_H)
    ctx.lineTo(x + width - 8, y + ROW1_H)
    ctx.stroke()

    // Preview background
    ctx.fillStyle = 'rgba(255,255,255,0.04)'
    ctx.beginPath()
    ctx.roundRect(pv.x, pv.y, pv.width, pv.height, 4)
    ctx.fill()

    // Interpolation path (looping)
    if (mode !== 'step' && n > 1) {
      ctx.strokeStyle = `${ACCENT}66`   // ACCENT at ~40% opacity
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      for (let i = 0; i <= n; i++) {
        const pt = this._points[i % n]!
        const px = pv.x + pt.x * pv.width
        const py = pv.y + pt.y * pv.height
        if (i === 0) ctx.moveTo(px, py)
        else         ctx.lineTo(px, py)
      }
      ctx.stroke()
    }

    // Active step for event-driven (or drag)
    const activeIdx = this._rateSlot.isActive
      ? -1
      : this._stepIndex % n

    // Interpolated playhead marker (rate-driven, non-step mode)
    if (this._rateSlot.isActive && mode !== 'step') {
      const nx = this._outPoint.x / this._canvasW
      const ny = this._outPoint.y / this._canvasH
      ctx.fillStyle = 'rgba(255,255,255,0.75)'
      ctx.beginPath()
      ctx.arc(pv.x + nx * pv.width, pv.y + ny * pv.height, 3, 0, Math.PI * 2)
      ctx.fill()
    }

    // Keyframe dots
    for (let i = 0; i < n; i++) {
      const pt     = this._points[i]!
      const px     = pv.x + pt.x * pv.width
      const py     = pv.y + pt.y * pv.height
      const active = i === activeIdx || i === this._dragIdx
      const r      = active ? DOT_R : DOT_R - 1

      ctx.fillStyle = active ? ACCENT : 'rgba(255,255,255,0.45)'
      ctx.beginPath()
      ctx.arc(px, py, r, 0, Math.PI * 2)
      ctx.fill()

      // Index label below dot
      ctx.font         = '8px monospace'
      ctx.fillStyle    = active ? 'rgba(255,255,255,0.90)' : 'rgba(255,255,255,0.30)'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(String(i), px, py + r + 2)
    }
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _dotIndexAt(
    point: Point,
    pv: { x: number; y: number; width: number; height: number },
  ): number {
    const threshold = (DOT_R + 6) * (DOT_R + 6)
    let best = -1, bestDist = threshold
    for (let i = 0; i < this._points.length; i++) {
      const pt = this._points[i]!
      const px = pv.x + pt.x * pv.width
      const py = pv.y + pt.y * pv.height
      const d  = (point.x - px) ** 2 + (point.y - py) ** 2
      if (d < bestDist) { bestDist = d; best = i }
    }
    return best
  }

  private _setDotFromPoint(
    idx: number,
    point: Point,
    pv: { x: number; y: number; width: number; height: number },
  ): void {
    this._points[idx] = {
      x: Math.max(0, Math.min(1, (point.x - pv.x) / pv.width)),
      y: Math.max(0, Math.min(1, (point.y - pv.y) / pv.height)),
    }
    this.markDirty()
  }

  // Geometry

  private _decrBtnBounds(b?: { x: number; y: number; width: number; height: number }) {
    const { x, y } = b ?? this.bounds
    return { x: x + 8, y: y + (ROW1_H - BTN) / 2, width: BTN, height: BTN }
  }

  private _incrBtnBounds(b?: { x: number; y: number; width: number; height: number }) {
    const db = this._decrBtnBounds(b)
    return { x: db.x + BTN + 18, y: db.y, width: BTN, height: BTN }
  }

  private _prevBtnBounds(b?: { x: number; y: number; width: number; height: number }) {
    const ib = this._incrBtnBounds(b)
    return { x: ib.x + BTN + 10, y: ib.y, width: NAV_W, height: NAV_H }
  }

  private _labelBounds(b?: { x: number; y: number; width: number; height: number }) {
    const pb = this._prevBtnBounds(b)
    return { x: pb.x + NAV_W + 4, y: pb.y, width: LABEL_W, height: NAV_H }
  }

  private _nextBtnBounds(b?: { x: number; y: number; width: number; height: number }) {
    const lb = this._labelBounds(b)
    return { x: lb.x + LABEL_W + 4, y: lb.y, width: NAV_W, height: NAV_H }
  }

  private _previewBounds(b?: { x: number; y: number; width: number; height: number }) {
    const { x, y, width, height } = b ?? this.bounds
    return {
      x:      x + PRV_PAD,
      y:      y + ROW1_H + PRV_PAD,
      width:  width - PRV_PAD * 2,
      height: height - ROW1_H - PRV_PAD * 2,
    }
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

  private _drawNavBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    midY: number,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 3)
    ctx.fill()
    ctx.font         = '9px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.55)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, midY)
  }
}
