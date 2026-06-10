import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type Amount, type AmountSource,
  type EventValue, type EventSource,
  type PointSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// EventLayer — discrete event source (pulse generator)
// ------------------------------------------------------------
//
// Three independent triggering modes (all active simultaneously
// when their slots are bound):
//
//   Manual       — [▶ FIRE] button triggers a pulse on click.
//
//   Rate-driven  — an AmountSource (typically a RateLayer phase)
//                  is bound to rateSlot.  Fires each time the
//                  phase wraps around (robust zero-crossing).
//
//   Proximity    — animPathSlot (Point / AnimPath) and targetSlot
//                  (Point) are both bound.  Fires once per cycle
//                  when the AnimPath makes its closest approach to
//                  the target point.
//
//                  Calibration: on first bind (and whenever a full
//                  cycle passes without a trigger, indicating the
//                  path or target has moved), the layer samples the
//                  full path at CALIBRATION_SAMPLES evenly-spaced
//                  phases to find the global minimum distance.  A
//                  5 % tolerance band on that minimum prevents
//                  frame-rate quantisation from causing misses.
//
//                  Cycle detection: the AnimPath exposes its current
//                  phase; a drop of > 0.5 from one frame to the next
//                  signals a wrap.
//
// Output: EventValue — performance.now() timestamp of the most
// recent pulse, or null if never triggered.
//
// Visual:
//
//   ┌──────────────────────────────────────────────────────┐
//   │ ▌  [▶ FIRE]     last: 2.3 s ago              [↺]   │
//   └──────────────────────────────────────────────────────┘
//
//   When proximity mode is active, renderSelf draws a crosshair
//   at the target point, a dashed circle at the threshold radius,
//   and a flash that blooms from the target on each trigger.

const ACCENT               = '#e0e060'
const CALIBRATION_SAMPLES  = 500
const PROXIMITY_TOLERANCE  = 1.05   // fire within 5 % of calibrated minimum

// Button geometry
const BTN_M = 6
const BTN   = 20

export class EventLayer extends Layer implements EventSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Event])

  private readonly _rateSlot:     ParameterSlot
  private readonly _animPathSlot: ParameterSlot
  private readonly _targetSlot:   ParameterSlot

  private _eventTime: EventValue = null
  private _prevPhase: number     = 0
  private _cpBounds: { x: number; y: number; width: number; height: number } | null = null

  // ── Proximity detection state ───────────────────────────
  private _threshold:      number | null = null   // calibrated minimum distance
  private _prevDist:       number | null = null   // distance last frame
  private _prevAnimPhase:  number | null = null   // AnimPath phase last frame
  private _firedThisCycle: boolean = false
  // Track sources to detect binding changes
  private _prevAnimSrc: unknown = null
  private _prevTgtSrc:  unknown = null

  constructor() {
    super()
    this._rateSlot     = new ParameterSlot(ValueType.Amount, this, 'rate')
    this._animPathSlot = new ParameterSlot(ValueType.Point,  this, 'anim path')
    this._targetSlot   = new ParameterSlot(ValueType.Point,  this, 'target')
    this.slots.push(this._rateSlot, this._animPathSlot, this._targetSlot)
    this.debugName = 'EventLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // EventSource
  // ----------------------------------------------------------

  getEventTime(): EventValue { return this._eventTime }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get rateSlot():     ParameterSlot { return this._rateSlot }
  get animPathSlot(): ParameterSlot { return this._animPathSlot }
  get targetSlot():   ParameterSlot { return this._targetSlot }

  // ----------------------------------------------------------
  // Controls
  // ----------------------------------------------------------

  fire(): void {
    this._eventTime = performance.now()
    this.markDirty()
  }

  clearEvent(): void {
    this._eventTime  = null
    this._prevPhase  = 0
    this._threshold  = null
    this._prevDist   = null
    this._prevAnimPhase = null
    this._firedThisCycle = false
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    // ── Mode 1: rate wrap detection ────────────────────────
    if (this._rateSlot.isActive) {
      const phase = (this._rateSlot.source as AmountSource).getAmount() as Amount
      if (phase < this._prevPhase - 0.5) this._eventTime = performance.now()
      this._prevPhase = phase
    }

    // ── Mode 2: proximity detection ────────────────────────
    if (this._animPathSlot.isActive && this._targetSlot.isActive) {
      const animSrc = this._animPathSlot.source!
      const tgtSrc  = this._targetSlot.source!

      // Reset on binding change
      if (animSrc !== this._prevAnimSrc || tgtSrc !== this._prevTgtSrc) {
        this._threshold      = null
        this._prevDist       = null
        this._prevAnimPhase  = null
        this._firedThisCycle = false
      }
      this._prevAnimSrc = animSrc
      this._prevTgtSrc  = tgtSrc

      const animRec  = animSrc as Record<string, unknown>
      const tgtPtSrc = tgtSrc  as PointSource

      // Calibrate immediately via samplePerimeter if threshold is unknown.
      if (this._threshold === null) this._calibrate(animRec, tgtPtSrc)

      // Current distance.
      const pos  = (animRec as unknown as PointSource).getPoint()
      const tgt  = tgtPtSrc.getPoint()
      const dist = Math.hypot(pos.x - tgt.x, pos.y - tgt.y)

      // Detect local minimum (distance was decreasing, now increasing).
      // Fire if this minimum is within the tolerance band of the threshold.
      if (this._prevDist !== null
          && !this._firedThisCycle
          && dist > this._prevDist
          && this._threshold !== null
          && this._prevDist <= this._threshold * PROXIMITY_TOLERANCE) {
        this._eventTime      = performance.now()
        this._firedThisCycle = true
      }

      // Cycle detection via AnimPath.phase.
      const animPhase = animRec['phase'] as number | undefined
      if (typeof animPhase === 'number') {
        if (this._prevAnimPhase !== null && animPhase < this._prevAnimPhase - 0.5) {
          // Phase wrapped — new cycle started.
          if (!this._firedThisCycle) {
            // Missed a trigger: path or target has changed.  Recalibrate.
            this._threshold = null
            this._calibrate(animRec, tgtPtSrc)
          }
          this._firedThisCycle = false
        }
        this._prevAnimPhase = animPhase
      }

      this._prevDist = dist
    }
  }

  // Sample the full path to find the global minimum distance to the target.
  private _calibrate(
    animSrc: Record<string, unknown>,
    tgtSrc:  PointSource,
  ): void {
    if (typeof animSrc['samplePerimeter'] !== 'function') return
    const tgt = tgtSrc.getPoint()
    let minDist = Infinity
    for (let i = 0; i < CALIBRATION_SAMPLES; i++) {
      const pt = (animSrc['samplePerimeter'] as (t: number) => Point)(i / CALIBRATION_SAMPLES)
      const d  = Math.hypot(pt.x - tgt.x, pt.y - tgt.y)
      if (d < minDist) minDist = d
    }
    this._threshold = minDist
  }

  // ----------------------------------------------------------
  // Rendering — canvas content (always visible)
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    if (!this._animPathSlot.isActive || !this._targetSlot.isActive) return

    const tgt = (this._targetSlot.source as PointSource).getPoint()
    const pos = (this._animPathSlot.source as unknown as PointSource).getPoint()
    const now = performance.now()
    const age    = this._eventTime !== null ? (now - this._eventTime) / 1000 : Infinity
    const bright = Math.max(0, 1 - age)

    ctx.save()

    // Dashed line from AnimPath position to target.
    ctx.strokeStyle = 'rgba(224,224,96,0.20)'
    ctx.lineWidth   = 1
    ctx.setLineDash([3, 4])
    ctx.beginPath(); ctx.moveTo(pos.x, pos.y); ctx.lineTo(tgt.x, tgt.y); ctx.stroke()
    ctx.setLineDash([])

    // Threshold ring — the closest-approach boundary.
    if (this._threshold !== null && this._threshold > 0) {
      ctx.beginPath()
      ctx.arc(tgt.x, tgt.y, this._threshold, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(224,224,96,0.28)'
      ctx.lineWidth   = 1
      ctx.setLineDash([4, 4])
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Fire flash — blooms from the target point.
    if (bright > 0) {
      const base   = this._threshold ?? 16
      const flashR = base * (0.6 + bright * 0.6)
      ctx.beginPath()
      ctx.arc(tgt.x, tgt.y, flashR, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(224,224,96,${(bright * 0.40).toFixed(2)})`
      ctx.fill()
    }

    // Target crosshair.
    const r = 7
    ctx.strokeStyle = bright > 0
      ? `rgba(224,224,96,${(0.45 + bright * 0.45).toFixed(2)})`
      : 'rgba(224,224,96,0.45)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(tgt.x - r, tgt.y); ctx.lineTo(tgt.x + r, tgt.y); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(tgt.x, tgt.y - r); ctx.lineTo(tgt.x, tgt.y + r); ctx.stroke()

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Rendering — panel UI (selected layer only)
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width <= 0 || this.bounds.height <= 0) return
    this._drawPill(ctx, this.bounds)
    const cp = { x: 300, y: 50, width: 260, height: this.bounds.height }
    this._cpBounds = cp
    this._drawPill(ctx, cp)
    if (!this._animPathSlot.isActive || !this._targetSlot.isActive) {
      this._renderBlob(ctx)
    }
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
    const midY = y + height / 2
    const now  = performance.now()

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    const fb = this._fireBtnBounds(b)
    ctx.fillStyle = 'rgba(224,224,96,0.15)'
    ctx.beginPath()
    ctx.roundRect(fb.x, fb.y, fb.width, fb.height, 4)
    ctx.fill()
    ctx.font         = 'bold 11px monospace'
    ctx.fillStyle    = ACCENT
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('▶ FIRE', fb.x + fb.width / 2, fb.y + fb.height / 2)

    const clearB = this._clearBtnBounds(b)
    const labelX = fb.x + fb.width + 10
    const labelR = clearB.x - 8
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'

    if (this._eventTime === null) {
      ctx.fillStyle = 'rgba(255,255,255,0.22)'
      ctx.fillText('last: —', labelX, midY)
    } else {
      const age    = (now - this._eventTime) / 1000
      const bright = Math.max(0, 1 - age)
      const alpha  = 0.45 + bright * 0.50
      const bv     = Math.round(bright * 96)
      ctx.fillStyle = `rgba(255,255,${bv},${alpha.toFixed(2)})`
      const ageSec  = age < 100 ? age.toFixed(1) + ' s ago' : '—'
      ctx.textAlign = 'right'
      ctx.fillText('last: ' + ageSec, labelR, midY)
    }

    // Proximity mode: show threshold in the label area.
    if (this._animPathSlot.isActive && this._targetSlot.isActive) {
      const status = this._threshold !== null
        ? `⊙ ${Math.round(this._threshold)} px`
        : '⊙ calibrating…'
      ctx.fillStyle = 'rgba(224,224,96,0.55)'
      ctx.font      = '10px monospace'
      ctx.textAlign = 'left'
      ctx.fillText(status, labelX, midY)
    }

    this._drawBtn(ctx, clearB, '↺', 'rgba(255,255,255,0.40)')

    ctx.restore()
  }

  private _renderBlob(ctx: Ctx2D): void {
    const cw  = ctx.canvas.width
    const ch  = ctx.canvas.height
    const bx  = (cw + 280) / 2
    const by  = ch / 2
    const now = performance.now()

    const age    = this._eventTime !== null ? (now - this._eventTime) / 1000 : Infinity
    const bright = Math.max(0, 1 - age)

    const restR = 10
    ctx.save()
    ctx.beginPath()
    ctx.arc(bx, by, restR, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(224,224,96,0.15)'
    ctx.fill()

    if (bright > 0) {
      const flashR = restR + bright * 22
      ctx.beginPath()
      ctx.arc(bx, by, flashR, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(224,224,96,${(bright * 0.7).toFixed(2)})`
      ctx.fill()
    }

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    const b = this._cpBounds ?? this.bounds
    if (boundingBoxContains(this._fireBtnBounds(b), point)) {
      this.fire()
      return true
    }
    if (boundingBoxContains(this._clearBtnBounds(b), point)) {
      this.clearEvent()
      return true
    }
    return false
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    return (this._cpBounds && boundingBoxContains(this._cpBounds, point))
      ? this : null
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

  private _clearBtnBounds(b?: { x: number; y: number; width: number; height: number }) {
    const { x, y, width, height } = b ?? this.bounds
    return { x: x + width - BTN_M - BTN, y: y + (height - BTN) / 2, width: BTN, height: BTN }
  }

  private _fireBtnBounds(b?: { x: number; y: number; width: number; height: number }) {
    const { x, y, height } = b ?? this.bounds
    const fw = 58, fh = 22
    return { x: x + 10, y: y + (height - fh) / 2, width: fw, height: fh }
  }
}
