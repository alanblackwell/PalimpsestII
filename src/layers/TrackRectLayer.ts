import { RectLayer }         from './RectLayer.js'
import { Node }              from '../core/Node.js'
import { ParameterSlot }     from '../core/ParameterSlot.js'
import {
  ValueType,
  type ImageSource,
  type PointSource,
  type Point,
  type Ctx2D,
} from '../core/types.js'
import { MotionTrackerCore } from './MotionTrackerCore.js'
import type { Layer }        from '../core/Layer.js'

// ------------------------------------------------------------
// TrackRectLayer — hue-histogram motion tracker
// ------------------------------------------------------------
//
// Extends RectLayer (inheriting the full interactive rectangle:
// move/scale/rotate handles, mask output, ShapeLayer slots).
// On creation the current video frame is captured through the
// rectangle mask to build a colour model; every subsequent frame
// the centroid of matching pixels is found in a search window
// around the previous position and output as ValueType.Point.
//
// Created via the "Track" convenience button on ClipRectLayer.
// The Capture button (in edit mode below the stroke/fill pill)
// re-samples the current live frame — move the rectangle first,
// then press Capture to reinitialise the colour model.

const SEARCH_RADIUS  = 120     // search window half-size (px) per frame
const FROZEN_OPACITY = 0.55    // opacity of frozen reference frame in edit mode

const CAPTURE_COL = '#cf7ecf'  // Point accent
const CAPTURE_W   = 72
const CAPTURE_H   = 26

export class TrackRectLayer extends RectLayer implements PointSource {
  override readonly types: ReadonlySet<ValueType> =
    new Set([ValueType.Point, ValueType.Mask])

  readonly imageSlot: ParameterSlot

  private readonly _tracker = new MotionTrackerCore()
  private _needsCapture     = true
  private _captureBtnBounds: { x: number; y: number; w: number; h: number } | null = null
  private _thumbCanvas      = new OffscreenCanvas(1, 1)
  private _iterHistory: Point[] = []
  private _iterTime     = 0

  constructor() {
    super(
      Node.canvasWidth  / 2,
      Node.canvasHeight / 2,
      Node.canvasWidth  * 0.35,
      Node.canvasHeight * 0.3,
    )
    this.imageSlot = new ParameterSlot(ValueType.Image, this, 'image')
    this.slots.push(this.imageSlot)

    this.debugName       = 'TrackRect'
    this.displayBaseName = 'Tracker'

    // Suppress ShapeLayer convenience buttons that don't apply here
    this._showAnimateButton = false
    this._showMaskButton    = false
    this._showPointButton   = false
  }

  // ----------------------------------------------------------
  // PointSource
  // ----------------------------------------------------------

  getPoint(): Point { return this._tracker.getPoint() }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected override recompute(): void {
    super.recompute()   // geometry, mask canvas, ShapeLayer slots
    if (!this.imageSlot.isActive) return
    const image = (this.imageSlot.source as ImageSource).getImage()
    if (image === null) return

    if (this._needsCapture) {
      this._tracker.capture(image, this.getMask(), { x: this._cx, y: this._cy })
      this._needsCapture = false
    } else {
      this._iterHistory = this._tracker.track(image, SEARCH_RADIUS)
      this._iterTime    = performance.now()
    }
    this._updateThumb()
  }

  // Compose the thumbnail: full frozen frame (fills the card, matches the
  // brightness of the video thumbnail) with the area outside the tracking
  // rect darkened.  This avoids the "faded small region in a dark field"
  // problem that occurs when only the clipped rect is drawn at canvas scale
  // and then the whole canvas is scaled down to the card size.
  private _updateThumb(): void {
    const frozen = this._tracker.getFrozenFrame()
    if (frozen === null) return
    const fw = frozen.width, fh = frozen.height
    if (this._thumbCanvas.width !== fw || this._thumbCanvas.height !== fh)
      this._thumbCanvas = new OffscreenCanvas(fw, fh)
    const ctx = this._thumbCanvas.getContext('2d')!

    // Background: full frozen frame, darkened outside the tracking region
    ctx.drawImage(frozen, 0, 0)
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, 0, fw, fh)

    // Foreground: frozen frame at full brightness inside the tracking rect
    const hw = (this._width * this._scale) / 2
    const hh = (this._height * this._scale) / 2
    ctx.save()
    ctx.translate(this._cx, this._cy)
    ctx.rotate(this._angle)
    ctx.beginPath()
    ctx.rect(-hw, -hh, hw * 2, hh * 2)
    ctx.clip()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(frozen, 0, 0)
    ctx.restore()
  }

  // Called by the thumbnail system (duck-typed) to get a custom thumbnail
  // instead of the default Mask or Point rendering.
  getThumbnailImage(): OffscreenCanvas | null {
    return this._tracker.hasCapture ? this._thumbCanvas : null
  }

  // Re-sample the current frame on the next recompute.
  // Called by main.ts immediately after creation, and by the Capture button.
  triggerCapture(): void { this._needsCapture = true }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  override renderSelf(_ctx: Ctx2D): void {
    // Point layer — no canvas content drawn.
    // The tracked-point crosshair is shown in renderOverlay when selected.
  }

  override renderPanel(ctx: Ctx2D): void {
    // Draw the frozen reference frame behind the shape handles so the user can
    // see what was captured and reposition the rectangle for a re-capture.
    this._tracker.renderFrozenFrame(ctx, FROZEN_OPACITY)
    super.renderPanel(ctx)
  }

  override renderOverlay(ctx: Ctx2D): void {
    super.renderOverlay(ctx)   // shape handles + snap guides
    this._renderIterations(ctx)
    this._tracker.renderTrackedPoint(ctx)
    this._renderCaptureBtn(ctx)
  }

  private _renderIterations(ctx: Ctx2D): void {
    if (this._iterHistory.length === 0) return
    const FADE_MS = 700
    const alpha = Math.max(0, 1 - (performance.now() - this._iterTime) / FADE_MS)
    if (alpha <= 0) return

    ctx.save()
    ctx.strokeStyle = CAPTURE_COL
    ctx.lineWidth   = 1
    ctx.shadowColor = 'rgba(0,0,0,0.5)'
    ctx.shadowBlur  = 2
    for (const pt of this._iterHistory) {
      ctx.globalAlpha = alpha * 0.65
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
  }

  private _renderCaptureBtn(ctx: Ctx2D): void {
    // Place the Capture button just below the stroke/fill pill.
    const pb = this._strokePillBounds()
    const x  = pb.x
    const y  = pb.y + pb.height + 8
    this._captureBtnBounds = { x, y, w: CAPTURE_W, h: CAPTURE_H }

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(x, y, CAPTURE_W, CAPTURE_H, 5)
    ctx.fill()

    ctx.fillStyle = CAPTURE_COL + 'cc'
    ctx.beginPath()
    ctx.roundRect(x, y, 3, CAPTURE_H, [5, 0, 0, 5])
    ctx.fill()

    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, CAPTURE_W, CAPTURE_H)
    ctx.clip()
    ctx.fillStyle    = 'rgba(255,255,255,0.85)'
    ctx.font         = '10px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Capture', x + 8, y + CAPTURE_H / 2)
    ctx.restore()

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point): this | null {
    const b = this._captureBtnBounds
    if (b && point.x >= b.x && point.x <= b.x + b.w &&
             point.y >= b.y && point.y <= b.y + b.h) return this
    return super.hitTestSelf(point)
  }

  override handlePointerDown(point: Point): boolean {
    const b = this._captureBtnBounds
    if (b && point.x >= b.x && point.x <= b.x + b.w &&
             point.y >= b.y && point.y <= b.y + b.h) {
      this.triggerCapture()
      Node.scheduleFrame?.()
      return true
    }
    return super.handlePointerDown(point)
  }

  // ----------------------------------------------------------
  // Auto-bind: find the nearest Image source below on creation
  // ----------------------------------------------------------

  override autoBindRules() {
    return [
      { slot: this.imageSlot, accepts: (l: Layer) => l.types.has(ValueType.Image) },
    ]
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { ...super.serializeState(), tracker: this._tracker.serializeState() }
  }

  override deserializeState(state: Record<string, unknown>): void {
    super.deserializeState(state)
    if (state.tracker && typeof state.tracker === 'object') {
      this._tracker.deserializeState(state.tracker as Record<string, unknown>)
      // Resume from stored histogram + last point; skip capture if we have one
      this._needsCapture = !this._tracker.hasCapture
    }
  }
}
