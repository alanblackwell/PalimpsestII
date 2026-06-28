import { Layer } from '../core/Layer.js'
import { Node }  from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type Amount, type AmountSource,
  type EventValue, type EventSource,
  type ImageSource,
  type PointSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { drawIcon, type IconName } from '../ui/icons.js'

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
//   Collision    — imageASlot and imageBSlot (both Image) are bound.
//                  Fires on the first frame that the two images share
//                  any non-transparent pixels (rising-edge only).
//                  Detection uses a 64×64 downsampled probe canvas:
//                  image A is drawn, then image B is composited with
//                  destination-in (alpha multiplication), and any
//                  surviving pixel signals contact.  The alpha-weighted
//                  centroid of surviving pixels is mapped back to
//                  canvas coordinates and shown as a crosshair/flash.
//
// Output: EventValue — performance.now() timestamp of the most
// recent pulse, or null if never triggered.

const ACCENT               = '#e0e060'
const CALIBRATION_SAMPLES  = 500
const PROXIMITY_TOLERANCE  = 1.05   // fire within 5 % of calibrated minimum
const PROBE_SIZE           = 64     // collision probe canvas dimensions
// Consecutive non-collision frames required before separation is confirmed.
// Guards against the probe briefly missing a thin-sliver overlap as shapes
// pass through each other, which would otherwise spuriously reset _wasColliding
// and trigger a second fire mid-passage.
const SEPARATION_THRESHOLD = 3

// Button geometry
const BTN_M = 6
const BTN   = 24

export class EventLayer extends Layer implements EventSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Event])

  private readonly _rateSlot:     ParameterSlot
  private readonly _animPathSlot: ParameterSlot
  private readonly _targetSlot:   ParameterSlot
  private readonly _imageASlot:   ParameterSlot
  private readonly _imageBSlot:   ParameterSlot

  // Collision probe canvas — allocated once, reused every frame
  private readonly _probe:    OffscreenCanvas
  private readonly _probeCtx: OffscreenCanvasRenderingContext2D

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

  // ── Collision detection state ───────────────────────────
  private _wasColliding:      boolean      = false
  private _separationFrames:  number       = 0     // consecutive non-collision frames
  private _contactPoint:      Point | null = null  // current-frame collision centroid
  private _lastContactPoint:  Point | null = null  // snapshot at last event fire

  constructor() {
    super()
    this._rateSlot     = new ParameterSlot(ValueType.Amount, this, 'rate')
    this._animPathSlot = new ParameterSlot(ValueType.Point,  this, 'anim path')
    this._targetSlot   = new ParameterSlot(ValueType.Point,  this, 'target')
    this._imageASlot   = new ParameterSlot(ValueType.Image,  this, 'image A', true)
    this._imageBSlot   = new ParameterSlot(ValueType.Image,  this, 'image B', true)
    this.slots.push(
      this._rateSlot, this._animPathSlot, this._targetSlot,
      this._imageASlot, this._imageBSlot,
    )

    this._probe    = new OffscreenCanvas(PROBE_SIZE, PROBE_SIZE)
    this._probeCtx = this._probe.getContext('2d')!

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
  get imageASlot():   ParameterSlot { return this._imageASlot }
  get imageBSlot():   ParameterSlot { return this._imageBSlot }

  // ----------------------------------------------------------
  // Controls
  // ----------------------------------------------------------

  fire(): void {
    this._eventTime = performance.now()
    this.markDirty()
  }

  clearEvent(): void {
    this._eventTime        = null
    this._prevPhase        = 0
    this._threshold        = null
    this._prevDist         = null
    this._prevAnimPhase    = null
    this._firedThisCycle   = false
    this._wasColliding     = false
    this._separationFrames = 0
    this._contactPoint     = null
    this._lastContactPoint = null
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

    // ── Mode 3: collision detection ────────────────────────
    if (this._imageASlot.isActive && this._imageBSlot.isActive) {
      const imgA = (this._imageASlot.source as ImageSource).getImage()
      const imgB = (this._imageBSlot.source as ImageSource).getImage()
      const colliding = (imgA !== null && imgB !== null)
        ? this._checkCollision(imgA, imgB)
        : false
      if (colliding) {
        this._separationFrames = 0
        if (!this._wasColliding) {
          this._eventTime        = performance.now()
          this._lastContactPoint = this._contactPoint
            ? { x: this._contactPoint.x, y: this._contactPoint.y }
            : null
          this._wasColliding = true
        }
      } else {
        // Only declare separation after SEPARATION_THRESHOLD consecutive
        // non-collision frames, absorbing brief probe misses on thin overlaps.
        if (this._wasColliding) {
          this._separationFrames++
          if (this._separationFrames >= SEPARATION_THRESHOLD) {
            this._wasColliding     = false
            this._separationFrames = 0
          }
        }
      }
    } else {
      this._wasColliding     = false
      this._separationFrames = 0
      this._contactPoint     = null
    }
  }

  // Downscale both images to a 64×64 probe canvas, multiply their alphas
  // via destination-in, then find the alpha-weighted centroid of any surviving
  // pixels.  O(PROBE_SIZE²) pixel scan with no early exit so the centroid
  // covers the full contact area rather than just the first hit.
  private _checkCollision(
    imgA: ImageBitmap | OffscreenCanvas,
    imgB: ImageBitmap | OffscreenCanvas,
  ): boolean {
    const P   = PROBE_SIZE
    const ctx = this._probeCtx

    ctx.clearRect(0, 0, P, P)
    ctx.drawImage(imgA as CanvasImageSource, 0, 0, P, P)
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(imgB as CanvasImageSource, 0, 0, P, P)
    ctx.globalCompositeOperation = 'source-over'

    const data = ctx.getImageData(0, 0, P, P).data

    let totalAlpha = 0, sumX = 0, sumY = 0
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3]!
      if (a > 0) {
        const pIdx  = i >> 2
        const px    = pIdx % P
        const py    = (pIdx / P) | 0
        totalAlpha += a
        sumX       += px * a
        sumY       += py * a
      }
    }

    if (totalAlpha === 0) {
      this._contactPoint = null
      return false
    }

    // Map probe centroid to canvas coordinates (add 0.5 for pixel centre)
    const cw = Node.canvasWidth
    const ch = Node.canvasHeight
    this._contactPoint = {
      x: ((sumX / totalAlpha) + 0.5) / P * cw,
      y: ((sumY / totalAlpha) + 0.5) / P * ch,
    }
    return true
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
    // ── Proximity mode ──────────────────────────────────────
    if (this._animPathSlot.isActive && this._targetSlot.isActive) {
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

    // ── Collision mode: crosshair at contact ────────────────
    if (this._imageASlot.isActive && this._imageBSlot.isActive) {
      // Show current contact while colliding, else fade from last known point
      const pt = this._contactPoint ?? this._lastContactPoint
      if (pt) {
        const now    = performance.now()
        const age    = this._eventTime !== null ? (now - this._eventTime) / 1000 : Infinity
        const bright = Math.max(0, 1 - age)
        const alpha  = this._wasColliding ? 0.70 : (0.25 + bright * 0.45)

        ctx.save()
        ctx.strokeStyle = `rgba(224,224,96,${alpha.toFixed(2)})`
        ctx.lineWidth   = 1.5
        const r = 7
        ctx.beginPath(); ctx.moveTo(pt.x - r, pt.y); ctx.lineTo(pt.x + r, pt.y); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(pt.x, pt.y - r); ctx.lineTo(pt.x, pt.y + r); ctx.stroke()
        ctx.restore()
      }
    }
  }

  // ----------------------------------------------------------
  // Rendering — panel UI (selected layer only)
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width <= 0 || this.bounds.height <= 0) return
    this._drawPill(ctx, this.bounds)
    const cp = this.canvasBounds
    this._cpBounds = cp
    this._drawPill(ctx, cp)

    const proximityActive = this._animPathSlot.isActive && this._targetSlot.isActive
    const collisionActive = this._imageASlot.isActive && this._imageBSlot.isActive

    if (proximityActive) {
      this._renderFireFlash(ctx)
    } else if (collisionActive && this._lastContactPoint !== null) {
      this._renderContactFlash(ctx, this._lastContactPoint)
    } else {
      this._renderBlob(ctx)
    }
  }

  // Fire flash — blooms from the proximity target point.
  private _renderFireFlash(ctx: Ctx2D): void {
    const now    = performance.now()
    const age    = this._eventTime !== null ? (now - this._eventTime) / 1000 : Infinity
    const bright = Math.max(0, 1 - age)
    if (bright <= 0) return

    const tgt    = (this._targetSlot.source as PointSource).getPoint()
    const base   = this._threshold ?? 16
    const flashR = base * (0.6 + bright * 0.6)

    ctx.save()
    ctx.beginPath()
    ctx.arc(tgt.x, tgt.y, flashR, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(224,224,96,${(bright * 0.40).toFixed(2)})`
    ctx.fill()
    ctx.restore()
  }

  // Contact flash — blooms from the collision centroid.
  private _renderContactFlash(ctx: Ctx2D, pt: Point): void {
    const now    = performance.now()
    const age    = this._eventTime !== null ? (now - this._eventTime) / 1000 : Infinity
    const bright = Math.max(0, 1 - age)
    if (bright <= 0) return

    const flashR = 16 * (0.6 + bright * 0.6)

    ctx.save()
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, flashR, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(224,224,96,${(bright * 0.40).toFixed(2)})`
    ctx.fill()
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
  // Rendering — slot rows (two pills: event triggers + collision)
  // ----------------------------------------------------------

  override renderSlots(ctx: Ctx2D): void {
    if (this.slots.length === 0) return
    this._slotBounds.clear()
    const y1 = this.renderSlotGroup(
      ctx,
      [this._rateSlot, this._animPathSlot, this._targetSlot],
      this.panelBottom,
    )
    this.renderSlotGroup(ctx, [this._imageASlot, this._imageBSlot], y1 + 8)
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
    ctx.fillStyle    = ACCENT
    drawIcon(ctx, 'lightning', fb.x + fb.width / 2, fb.y + fb.height / 2, fb.height - 6)

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

    // Mode status label (left of timestamp)
    if (this._animPathSlot.isActive && this._targetSlot.isActive) {
      const status = this._threshold !== null
        ? `⊙ ${Math.round(this._threshold)} px`
        : '⊙ calibrating…'
      ctx.fillStyle = 'rgba(224,224,96,0.55)'
      ctx.font      = '10px monospace'
      ctx.textAlign = 'left'
      ctx.fillText(status, labelX, midY)
    } else if (this._imageASlot.isActive && this._imageBSlot.isActive) {
      ctx.fillStyle = this._wasColliding
        ? 'rgba(224,224,96,0.90)'
        : 'rgba(224,224,96,0.40)'
      ctx.font      = '10px monospace'
      ctx.textAlign = 'left'
      ctx.fillText(this._wasColliding ? '⊕ contact' : '⊕', labelX, midY)
    }

    this._drawBtn(ctx, clearB, 'arrow-counter-clockwise', 'rgba(255,255,255,0.40)')

    ctx.restore()
  }

  private _drawBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    icon: IconName,
    colour: string,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
    ctx.fillStyle = colour
    drawIcon(ctx, icon, b.x + b.width / 2, b.y + b.height / 2, Math.min(b.width, b.height) - 8)
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
