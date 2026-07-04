import { EllipseLayer }      from './EllipseLayer.js'
import { Node }               from '../core/Node.js'
import { ParameterSlot }      from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  type ImageSource, type EventSource,
  type PointSource, type Point, type Ctx2D,
} from '../core/types.js'
import { MotionTrackerCore }  from './MotionTrackerCore.js'
import type { Layer }         from '../core/Layer.js'
import {
  TRK_COL, TRK_W, TRK_BTN_H, TRK_OUTLINE_COL,
  PLAY_BTN_W, PLAY_BTN_GAP, renderPlayPauseBtn,
  renderTrackRepBtn, trackRepBtnLayout,
  drawSliderTrack, smoothValueFromPointer,
} from './trackConvBtn.js'

type BBox = { x: number; y: number; width: number; height: number }

const SEARCH_RADIUS  = 120
const FROZEN_OPACITY = 0.55
const CAPTURE_COL    = TRK_COL
const CAPTURE_W      = 72
const CAPTURE_H      = 26
const SMOOTH_MAX     = 100
const SM_LABEL_W     = 78
const SM_VALUE_W     = 38
const SM_SLOT_H      = 30

// Replacement button defs for TrackEllipseLayer: [Rect][Path][Draw]
const REP_DEFS = [
  { w: TRK_W.rect,  label: 'Rect'  },
  { w: TRK_W.path,  label: 'Path'  },
  { w: TRK_W.draw,  label: 'Draw'  },
] as const

export class TrackEllipseLayer extends EllipseLayer implements PointSource {
  override readonly types: ReadonlySet<ValueType> =
    new Set([ValueType.Point, ValueType.Mask])

  readonly trackingSlot: ParameterSlot
  readonly imageSlot:   ParameterSlot

  private readonly _tracker      = new MotionTrackerCore()
  private _slotsBottom           = 0
  private _needsCapture          = true
  private _trackingEnabled       = true
  private _lastTrackEventTime: number | null = null
  private _captureBtnBounds: BBox | null = null
  private _playBtnBounds: BBox | null    = null
  private _smoothDrag                    = false
  private _thumbCanvas       = new OffscreenCanvas(1, 1)
  private _iterHistory: Point[] = []
  private _iterTime          = 0
  private _smoothWindow      = 1
  private _pointBuf: Point[] = []
  private _smoothedPoint: Point = { x: 0, y: 0 }

  // Replace-button callbacks (set by main.ts via wireTrackLayer)
  private _repRectBounds: BBox | null = null
  private _repPathBounds: BBox | null = null
  private _repDrawBounds: BBox | null = null
  private _onReplaceRect: (() => void) | null = null
  private _onReplacePath: (() => void) | null = null
  private _onReplaceDraw: (() => void) | null = null

  setOnReplaceRect(fn: () => void): void { this._onReplaceRect = fn }
  setOnReplacePath(fn: () => void): void { this._onReplacePath = fn }
  setOnReplaceDraw(fn: () => void): void { this._onReplaceDraw = fn }

  constructor() {
    super(
      Node.canvasWidth  / 2,
      Node.canvasHeight / 2,
      Node.canvasWidth  * 0.35,
      Node.canvasHeight * 0.3,
    )
    this.slots.length = 0   // discard inherited ShapeLayer slot rows
    this.trackingSlot = new ParameterSlot(ValueType.Event, this, 'tracking')
    this.imageSlot    = new ParameterSlot(ValueType.Image, this, 'image')
    this.slots.push(this.trackingSlot, this.imageSlot)
    this.debugName       = 'TrackEllipse'
    this.displayBaseName = 'Tracker'
    this._showAnimateButton = false
    this._showMaskButton    = false
    this._showPointButton   = false
  }

  // ── PointSource ────────────────────────────────────────────────────────

  getPoint(): Point { return { ...this._smoothedPoint } }

  // ── Node ───────────────────────────────────────────────────────────────

  protected override recompute(): void {
    super.recompute()

    if (this.trackingSlot.isActive) {
      const t = (this.trackingSlot.source as EventSource).getEventTime()
      if (t !== this._lastTrackEventTime) {
        this._lastTrackEventTime = t
        this._trackingEnabled    = !this._trackingEnabled
      }
    }

    if (!this.imageSlot.isActive) return
    const image = (this.imageSlot.source as ImageSource).getImage()
    if (image === null) return

    if (this._needsCapture) {
      this._tracker.capture(image, this.getMask(), { x: this._cx, y: this._cy })
      this._needsCapture    = false
      this._pointBuf        = []
      this._smoothedPoint   = { x: this._cx, y: this._cy }
      this._trackingEnabled = true
    } else if (this._trackingEnabled) {
      this._iterHistory = this._tracker.track(image, SEARCH_RADIUS)
      this._iterTime    = performance.now()
      const raw = this._tracker.getPoint()
      this._pointBuf.push({ ...raw })
      if (this._pointBuf.length > this._smoothWindow)
        this._pointBuf.splice(0, this._pointBuf.length - this._smoothWindow)
      const n = this._pointBuf.length
      this._smoothedPoint = {
        x: this._pointBuf.reduce((s, p) => s + p.x, 0) / n,
        y: this._pointBuf.reduce((s, p) => s + p.y, 0) / n,
      }
    }
    this._updateThumb()
  }

  triggerCapture(): void { this._needsCapture = true }

  private _updateThumb(): void {
    const frozen = this._tracker.getFrozenFrame()
    if (frozen === null) return
    const fw = frozen.width, fh = frozen.height
    if (this._thumbCanvas.width !== fw || this._thumbCanvas.height !== fh)
      this._thumbCanvas = new OffscreenCanvas(fw, fh)
    const ctx = this._thumbCanvas.getContext('2d')!

    ctx.drawImage(frozen, 0, 0)
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, 0, fw, fh)

    const hw = (this._width * this._scale) / 2
    const hh = (this._height * this._scale) / 2
    ctx.save()
    ctx.translate(this._cx, this._cy)
    ctx.rotate(this._angle)
    ctx.beginPath()
    ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2)
    ctx.clip()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(frozen, 0, 0)
    ctx.restore()
  }

  getThumbnailImage(): OffscreenCanvas | null {
    return this._tracker.hasCapture ? this._thumbCanvas : null
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  override renderSlots(ctx: Ctx2D): void {
    super.renderSlots(ctx)
    let bottom = this.panelBottom
    for (const b of this._slotBounds.values()) bottom = Math.max(bottom, b.y + b.height)
    this._slotsBottom = bottom
  }

  protected override _drawStrokePill(_ctx: Ctx2D): void {}
  protected override _strokeSliderHit(_p: Point): boolean { return false }
  protected override _scaleSliderHit(_p: Point): boolean { return false }

  override renderSelf(_ctx: Ctx2D): void { /* composite output is blank — outline is an edit-mode overlay */ }

  override renderPanel(ctx: Ctx2D): void {
    this._tracker.renderFrozenFrame(ctx, FROZEN_OPACITY)
    super.renderPanel(ctx)
  }

  override renderOverlay(ctx: Ctx2D): void {
    this._renderOutline(ctx)
    super.renderOverlay(ctx)
    this._renderIterations(ctx)
    this._tracker.renderTrackedPoint(ctx, this._smoothedPoint)
    this._renderCaptureBtn(ctx)
    this._renderPlayBtn(ctx)
    this._drawSmoothSlider(ctx)
    this._renderReplaceBtns(ctx)
  }

  private _renderPlayBtn(ctx: Ctx2D): void {
    const x = this.canvasBounds.x + CAPTURE_W + PLAY_BTN_GAP
    const y = this._slotsBottom + 8
    this._playBtnBounds = { x, y, width: PLAY_BTN_W, height: CAPTURE_H }
    renderPlayPauseBtn(ctx, x, y, CAPTURE_H, this._trackingEnabled)
  }

  private _renderOutline(ctx: Ctx2D): void {
    const hw = (this._width * this._scale) / 2
    const hh = (this._height * this._scale) / 2
    ctx.save()
    ctx.globalAlpha = 0.85
    ctx.translate(this._cx, this._cy)
    ctx.rotate(this._angle)
    ctx.strokeStyle = TRK_OUTLINE_COL
    ctx.lineWidth   = 2.5
    ctx.beginPath()
    ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  private _renderIterations(ctx: Ctx2D): void {
    if (this._iterHistory.length === 0) return
    const alpha = Math.max(0, 1 - (performance.now() - this._iterTime) / 700)
    if (alpha <= 0) return
    ctx.save()
    ctx.strokeStyle = CAPTURE_COL; ctx.lineWidth = 1
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 2
    for (const pt of this._iterHistory) {
      ctx.globalAlpha = alpha * 0.65
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2); ctx.stroke()
    }
    ctx.restore()
  }

  private _renderCaptureBtn(ctx: Ctx2D): void {
    const x = this.canvasBounds.x, y = this._slotsBottom + 8
    this._captureBtnBounds = { x, y, width: CAPTURE_W, height: CAPTURE_H }
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath(); ctx.roundRect(x, y, CAPTURE_W, CAPTURE_H, 5); ctx.fill()
    ctx.fillStyle = CAPTURE_COL + 'cc'
    ctx.beginPath(); ctx.roundRect(x, y, 3, CAPTURE_H, [5, 0, 0, 5]); ctx.fill()
    ctx.save()
    ctx.beginPath(); ctx.rect(x, y, CAPTURE_W, CAPTURE_H); ctx.clip()
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = '10px monospace'
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText('Capture', x + 8, y + CAPTURE_H / 2)
    ctx.restore(); ctx.restore()
  }

  private _smoothRowBounds(): BBox {
    const cb = this.canvasBounds
    return { x: cb.x, y: this._slotsBottom + 8 + CAPTURE_H + 8, width: cb.width, height: SM_SLOT_H }
  }

  private _smoothSliderGeom() {
    const b = this._smoothRowBounds()
    const midY = b.y + b.height / 2
    const labelX = b.x + 12, indX = b.x + b.width - 8
    const valueRight = indX - 14
    const sld0 = labelX + SM_LABEL_W, sldR = valueRight - SM_VALUE_W - 6
    return { b, midY, labelX, sld0, sldR, valueRight }
  }

  private _drawSmoothSlider(ctx: Ctx2D): void {
    const g = this._smoothSliderGeom()
    const { x, y, width, height } = g.b
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath(); ctx.roundRect(x, y, width, height, 6); ctx.fill()
    ctx.font = '10px monospace'; ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(255,255,255,0.62)'; ctx.textAlign = 'left'
    ctx.fillText('smooth', g.labelX, g.midY)
    drawSliderTrack(ctx, g.midY, g.sld0, g.sldR, (this._smoothWindow - 1) / (SMOOTH_MAX - 1), CAPTURE_COL)
    ctx.font = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.90)'; ctx.textAlign = 'right'
    ctx.fillText(`${this._smoothWindow}f`, g.valueRight, g.midY)
    ctx.restore()
  }

  private _renderReplaceBtns(ctx: Ctx2D): void {
    const layout = trackRepBtnLayout(REP_DEFS as unknown as { w: number; label: string }[])
    this._repRectBounds = { x: layout[0]!.x, y: layout[0]!.y, width: layout[0]!.w, height: TRK_BTN_H }
    this._repPathBounds = { x: layout[1]!.x, y: layout[1]!.y, width: layout[1]!.w, height: TRK_BTN_H }
    this._repDrawBounds = { x: layout[2]!.x, y: layout[2]!.y, width: layout[2]!.w, height: TRK_BTN_H }
    for (const { x, y, w, label } of layout) renderTrackRepBtn(ctx, x, y, w, label)
  }

  // ── Interaction ────────────────────────────────────────────────────────

  protected override hitTestSelf(pt: Point): this | null {
    const cb = this._captureBtnBounds
    if (cb && pt.x >= cb.x && pt.x <= cb.x + cb.width &&
              pt.y >= cb.y && pt.y <= cb.y + cb.height) return this
    const pb = this._playBtnBounds
    if (pb && pt.x >= pb.x && pt.x <= pb.x + pb.width &&
              pt.y >= pb.y && pt.y <= pb.y + pb.height) return this
    const sb = this._smoothRowBounds()
    if (pt.x >= sb.x && pt.x <= sb.x + sb.width &&
        pt.y >= sb.y && pt.y <= sb.y + sb.height) return this
    for (const bb of [this._repRectBounds, this._repPathBounds, this._repDrawBounds]) {
      if (bb && pt.x >= bb.x && pt.x <= bb.x + bb.width &&
                pt.y >= bb.y && pt.y <= bb.y + bb.height) return this
    }
    return super.hitTestSelf(pt)
  }

  override handlePointerDown(pt: Point): boolean {
    const cb = this._captureBtnBounds
    if (cb && pt.x >= cb.x && pt.x <= cb.x + cb.width &&
              pt.y >= cb.y && pt.y <= cb.y + cb.height) {
      this.triggerCapture(); Node.scheduleFrame?.(); return true
    }
    const pb = this._playBtnBounds
    if (pb && pt.x >= pb.x && pt.x <= pb.x + pb.width &&
              pt.y >= pb.y && pt.y <= pb.y + pb.height) {
      const s = this.trackingSlot.state
      if (s === SlotState.Bound)               this.trackingSlot.suspend()
      else if (s === SlotState.SuspendedBound) this.trackingSlot.resume()
      else this._trackingEnabled = !this._trackingEnabled
      Node.scheduleFrame?.(); return true
    }
    const sb = this._smoothRowBounds()
    if (pt.x >= sb.x && pt.x <= sb.x + sb.width &&
        pt.y >= sb.y && pt.y <= sb.y + sb.height) {
      this._smoothDrag = true; this._applySmoothSlider(pt.x); return true
    }
    const repHit = (bb: BBox | null, fn: (() => void) | null) => {
      if (!bb || !fn) return false
      if (pt.x >= bb.x && pt.x <= bb.x + bb.width &&
          pt.y >= bb.y && pt.y <= bb.y + bb.height) { fn(); return true }
      return false
    }
    if (repHit(this._repRectBounds, this._onReplaceRect)) return true
    if (repHit(this._repPathBounds, this._onReplacePath)) return true
    if (repHit(this._repDrawBounds, this._onReplaceDraw)) return true
    return super.handlePointerDown(pt)
  }

  override handlePointerMove(pt: Point): void {
    if (this._smoothDrag) { this._applySmoothSlider(pt.x); return }
    super.handlePointerMove(pt)
  }

  override handlePointerUp(): void {
    this._smoothDrag = false; super.handlePointerUp()
  }

  private _applySmoothSlider(px: number): void {
    const g = this._smoothSliderGeom()
    this._smoothWindow = smoothValueFromPointer(px, g.sld0, g.sldR, SMOOTH_MAX)
    if (this._pointBuf.length > this._smoothWindow)
      this._pointBuf.splice(0, this._pointBuf.length - this._smoothWindow)
    Node.scheduleFrame?.()
  }

  // ── Auto-bind ──────────────────────────────────────────────────────────

  override autoBindRules() {
    return [{ slot: this.imageSlot, accepts: (l: Layer) => l.types.has(ValueType.Image) }]
  }

  // ── Persistence ────────────────────────────────────────────────────────

  override serializeState(): Record<string, unknown> {
    return {
      ...super.serializeState(),
      tracker:         this._tracker.serializeState(),
      smoothWindow:    this._smoothWindow,
      trackingEnabled: this._trackingEnabled,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    super.deserializeState(state)
    if (state.tracker && typeof state.tracker === 'object') {
      this._tracker.deserializeState(state.tracker as Record<string, unknown>)
      this._needsCapture  = !this._tracker.hasCapture
      this._smoothedPoint = this._tracker.getPoint()
    }
    if (typeof state.smoothWindow === 'number')
      this._smoothWindow = Math.max(1, Math.min(SMOOTH_MAX, state.smoothWindow))
    if (typeof state.trackingEnabled === 'boolean')
      this._trackingEnabled = state.trackingEnabled
  }
}
