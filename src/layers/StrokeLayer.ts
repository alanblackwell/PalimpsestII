import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState, boundingBoxContains,
  type BoundingBox, type Colour, type Direction, type Point, type PointSource,
  type Ctx2D,
} from '../core/types.js'
import { BindingLayer }  from './BindingLayer.js'
import { PathLayer, samplePathOpen } from './PathLayer.js'
import { panelWidth } from '../interaction/layout.js'
import { drawIcon } from '../ui/icons.js'

// ------------------------------------------------------------
// StrokeLayer — open Catmull-Rom spline, drawn by freehand input
// ------------------------------------------------------------
//
// Extends PathLayer as an open (non-closed) spline. The user draws
// freehand; on pointer-up the raw polyline is simplified with
// Ramer-Douglas-Peucker (ε = 8 px) and the simplified vertices
// become the Catmull-Rom control points. After the first draw the
// control points are editable exactly like PathLayer's — drag to
// move, left-click the curve to insert, right-click to remove.
//
// Additional slots: start (Point, pins first control point),
// end (Point, pins last control point).
//
// samplePerimeter uses arc-length parameterisation so AnimPath
// travels at uniform speed along the open stroke.

const ACCENT          = '#e8a04a'
const AM_COL          = '#4a8fe8'
const RDP_EPS         = 8
const ARC_SAMPLES     = 200
const CLOSE_THRESHOLD = 20   // px — endpoint proximity that triggers path closure

export type StrokeStateSnapshot = {
  points:      Point[]
  colour:      Colour
  opacity:     number
  scale:       number
  radius:      number
  strokeWidth: number
  filled:      boolean
}

export class StrokeLayer extends PathLayer {

  // Override PathLayer default: open spline
  protected override _closedPath = false
  // Allow removing control points down to 2 (line)
  protected override get _minPoints(): number { return 2 }

  readonly startSlot: ParameterSlot
  readonly endSlot:   ParameterSlot

  private _drawMode  = true
  private _rawPoints: Point[] = []

  // Arc-length table for uniform-speed samplePerimeter
  private _arcSamples: Point[] = []
  private _totalLen   = 0

  // Closure callback — set by main.ts via setOnClose
  private _onClose: ((stroke: StrokeLayer) => void) | null = null

  // Draw button bounds (written in renderPanel, read in hitTestSelf)
  private _drawBtnBounds: BoundingBox | null = null

  constructor(colour?: Colour) {
    super([], Node.canvasWidth / 2, Node.canvasHeight / 2, colour)
    this._filled         = false   // stroke only — never fill
    this._showMaskButton = false   // no Mask convenience button

    this.startSlot = new ParameterSlot(ValueType.Point, this, 'start')
    this.endSlot   = new ParameterSlot(ValueType.Point, this, 'end')
    this.slots.push(this.startSlot, this.endSlot)
  }

  // ----------------------------------------------------------
  // Source interfaces
  // ----------------------------------------------------------

  override getPoint(): Point {
    return this._arcSamples.length >= 2 ? this.samplePerimeter(0.5)
                                        : { x: this._cx, y: this._cy }
  }

  // Arc-length-parameterised: t=0 → start, t=1 → end (clamped).
  override samplePerimeter(t: number): Point {
    if (this._arcSamples.length < 2) {
      return this._points.length > 0 ? { ...this._points[0]! } : { x: this._cx, y: this._cy }
    }
    const clamped = Math.max(0, Math.min(1, t))
    const target  = clamped * this._totalLen
    let acc = 0
    for (let i = 1; i < this._arcSamples.length; i++) {
      const a = this._arcSamples[i - 1]!, b = this._arcSamples[i]!
      const d = Math.hypot(b.x - a.x, b.y - a.y)
      if (acc + d >= target || i === this._arcSamples.length - 1) {
        const f = d > 0 ? (target - acc) / d : 0
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
      }
      acc += d
    }
    return { ...this._arcSamples[this._arcSamples.length - 1]! }
  }

  // Canvas-space endpoints — used by main.ts when creating a PointLayer
  // via slot-click so the initial binding is a no-op.
  getStrokeStart(): Point {
    if (this._points.length === 0) return { x: this._cx, y: this._cy }
    const p = this._points[0]!
    if (this._scale === 1) return { ...p }
    const c = this._centroid()
    return { x: c.x + (p.x - c.x) * this._scale, y: c.y + (p.y - c.y) * this._scale }
  }
  getStrokeEnd(): Point {
    const n = this._points.length
    if (n === 0) return { x: this._cx, y: this._cy }
    const p = this._points[n - 1]!
    if (this._scale === 1) return { ...p }
    const c = this._centroid()
    return { x: c.x + (p.x - c.x) * this._scale, y: c.y + (p.y - c.y) * this._scale }
  }

  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | Colour | null {
    if (slot === this.startSlot) return this.getStrokeStart()
    if (slot === this.endSlot)   return this.getStrokeEnd()
    return super.getSlotDefault(slot)
  }

  // Block pixel-pick scan while the user is actively sketching.
  get blockPixelPick(): boolean { return this._drawMode }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { ...super.serializeState(), drawMode: this._drawMode }
  }

  override deserializeState(state: Record<string, unknown>): void {
    super.deserializeState(state)
    if (typeof state.drawMode === 'boolean') this._drawMode = state.drawMode
  }

  // ----------------------------------------------------------
  // Recompute
  // ----------------------------------------------------------

  protected override recompute(): void {
    // Apply startSlot / endSlot before super (which handles rotation/position)
    const hasPoints = this._points.length >= 2
    if (hasPoints) {
      if (this.startSlot.isActive && this.endSlot.isActive) {
        const A = this._points[0]!
        const B = this._points[this._points.length - 1]!
        const S = (this.startSlot.source as PointSource).getPoint()
        const E = (this.endSlot.source as PointSource).getPoint()
        const fromLen = Math.hypot(B.x - A.x, B.y - A.y)
        const toLen   = Math.hypot(E.x - S.x, E.y - S.y)
        if (fromLen > 0.001) {
          const scale = toLen / fromLen
          const rot   = Math.atan2(E.y - S.y, E.x - S.x) - Math.atan2(B.y - A.y, B.x - A.x)
          const cos = Math.cos(rot), sin = Math.sin(rot)
          this._points = this._points.map(p => {
            const dx = p.x - A.x, dy = p.y - A.y
            return { x: S.x + (dx * cos - dy * sin) * scale,
                     y: S.y + (dx * sin + dy * cos) * scale }
          })
        } else {
          const dx = S.x - A.x, dy = S.y - A.y
          if (dx !== 0 || dy !== 0)
            this._points = this._points.map(p => ({ x: p.x + dx, y: p.y + dy }))
        }
      } else if (this.startSlot.isActive) {
        const A  = this._points[0]!
        const S  = (this.startSlot.source as PointSource).getPoint()
        const dx = S.x - A.x, dy = S.y - A.y
        if (dx !== 0 || dy !== 0)
          this._points = this._points.map(p => ({ x: p.x + dx, y: p.y + dy }))
      } else if (this.endSlot.isActive) {
        const B  = this._points[this._points.length - 1]!
        const E  = (this.endSlot.source as PointSource).getPoint()
        const dx = E.x - B.x, dy = E.y - B.y
        if (dx !== 0 || dy !== 0)
          this._points = this._points.map(p => ({ x: p.x + dx, y: p.y + dy }))
      }
    }

    super.recompute()  // handles radius, rotation, position, colour, opacity, scale, strokeWidth
    this._rebuildArcSamples()
  }

  private _rebuildArcSamples(): void {
    if (this._points.length < 2) { this._arcSamples = []; this._totalLen = 0; return }
    const pts: Point[] = []
    const c = this._scale !== 1 ? this._centroid() : null
    for (let i = 0; i <= ARC_SAMPLES; i++) {
      let p = samplePathOpen(this._points, i / ARC_SAMPLES, this._radius)
      if (c !== null) p = { x: c.x + (p.x - c.x) * this._scale, y: c.y + (p.y - c.y) * this._scale }
      pts.push(p)
    }
    let len = 0
    for (let i = 1; i < pts.length; i++)
      len += Math.hypot(pts[i]!.x - pts[i-1]!.x, pts[i]!.y - pts[i-1]!.y)
    this._arcSamples = pts
    this._totalLen   = len
  }

  // ----------------------------------------------------------
  // drawShape override: round linecap/join for stroke rendering
  // ----------------------------------------------------------

  protected override drawShape(
    ctx: Ctx2D, cx: number, cy: number, w: number, h: number, angle: number,
    colour: Colour, opacity: number, filled: boolean, strokeWidth: number,
  ): void {
    if (!filled) {
      ctx.save()
      ctx.lineCap  = 'round'
      ctx.lineJoin = 'round'
      super.drawShape(ctx, cx, cy, w, h, angle, colour, opacity, filled, strokeWidth)
      ctx.restore()
    } else {
      super.drawShape(ctx, cx, cy, w, h, angle, colour, opacity, filled, strokeWidth)
    }
  }

  // ----------------------------------------------------------
  // renderSelf: show freehand preview while drawing
  // ----------------------------------------------------------

  override renderSelf(ctx: Ctx2D): void {
    if (this._drawMode && this._rawPoints.length >= 2) {
      const c = this._colour
      ctx.save()
      ctx.globalAlpha = Math.max(0, Math.min(1, this._opacity))
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.lineWidth   = this._strokeWidth
      ctx.strokeStyle = `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},0.55)`
      ctx.beginPath()
      this._rawPoints.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))
      ctx.stroke()
      ctx.restore()
    } else if (!this._drawMode) {
      super.renderSelf(ctx)
    }
  }

  // ----------------------------------------------------------
  // renderPanel: custom pill with draw button
  // ----------------------------------------------------------

  override renderPanel(ctx: Ctx2D): void {
    this._drawStrokeLayerPill(ctx, this.bounds)
    this._drawStrokeLayerPill(ctx, this.canvasBounds)
  }

  private _drawStrokeLayerPill(ctx: Ctx2D, b: BoundingBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return
    const midY = y + height / 2
    const c    = this._colour

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    ctx.fillStyle = `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},${c.a})`
    ctx.beginPath()
    ctx.arc(x + 16, midY, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth   = 1
    ctx.stroke()

    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.80)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    const nPts = this._points.length
    ctx.fillText(
      this._drawMode ? 'Stroke  ✎ drawing…'
                     : `Stroke  ${nPts} pt${nPts !== 1 ? 's' : ''}`,
      x + 28, midY,
    )

    // Opacity slot indicator (canvas-space pill only)
    if (width >= panelWidth(Node.canvasWidth)) {
      const active = this.opacitySlot.isActive
      ctx.font      = '9px monospace'
      ctx.fillStyle = active ? AM_COL : 'rgba(255,255,255,0.22)'
      ctx.textAlign = 'right'
      ctx.fillText(active ? '●' : '○', x + width - 56, midY)
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText('α', x + width - 68, midY)
    }

    // Draw / Done button (canvas-space pill only)
    if (width >= panelWidth(Node.canvasWidth)) {
      const BTN_W = 44, BTN_H = height - 8
      const btnX  = x + width - BTN_W - 4, btnY = y + 4
      this._drawBtnBounds = { x: btnX, y: btnY, width: BTN_W, height: BTN_H }

      ctx.fillStyle = this._drawMode ? ACCENT + '44' : 'rgba(255,255,255,0.10)'
      ctx.beginPath()
      ctx.roundRect(btnX, btnY, BTN_W, BTN_H, 3)
      ctx.fill()
      ctx.strokeStyle = this._drawMode ? ACCENT + 'cc' : 'rgba(255,255,255,0.30)'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.roundRect(btnX + 0.5, btnY + 0.5, BTN_W - 1, BTN_H - 1, 3)
      ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.88)'
      drawIcon(ctx, this._drawMode ? 'check' : 'pencil', btnX + BTN_W / 2, midY, BTN_H - 6)
    } else {
      this._drawBtnBounds = null
    }

    ctx.restore()
  }

  // ----------------------------------------------------------
  // renderOverlay: suppress handles while drawing
  // ----------------------------------------------------------

  override renderOverlay(ctx: Ctx2D): void {
    if (!this._drawMode) {
      super.renderOverlay(ctx)   // PathLayer: handles + snap guides + animate btn
    } else {
      this._renderConvBtn(ctx, 'animate')
    }
  }

  // ----------------------------------------------------------
  // renderSlots: exclude positionSlot from standard pill
  // ----------------------------------------------------------

  protected override _strokePillBounds() {
    const cb           = this.canvasBounds
    const standardSlots = this.slots.filter(
      s => s !== this.fillModeSlot && s !== this.strokeWidthSlot &&
           s !== this.scaleSlot && s !== this.radiusSlot && s !== this.positionSlot
    )
    const standardH = standardSlots.length * (30 + 4) - 4
    return { x: cb.x, y: this.panelBottom + standardH + 8, width: cb.width, height: 5 * 30 + 4 * 4 }
  }

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const standardSlots = this.slots.filter(
      s => s !== this.fillModeSlot && s !== this.strokeWidthSlot &&
           s !== this.scaleSlot && s !== this.radiusSlot && s !== this.positionSlot
    )
    this.renderSlotGroup(ctx, standardSlots, this.panelBottom)
    this._drawStrokePill(ctx)
    this._drawRadiusPill(ctx)
  }

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point): this | null {
    if (this._drawMode) return this
    if (this._drawBtnBounds !== null && boundingBoxContains(this._drawBtnBounds, point)) return this
    return super.hitTestSelf(point)
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  override handlePointerDown(point: Point): boolean {
    // Draw button takes priority in all modes
    if (this._drawBtnBounds !== null && boundingBoxContains(this._drawBtnBounds, point)) {
      if (this._drawMode) {
        if (this._rawPoints.length >= 2) {
          this._fitToPoints()
          this._drawMode = false
        } else if (this._points.length >= 2) {
          this._drawMode = false   // cancel back to edit mode
        }
        this._rawPoints = []
      } else {
        this._enterDrawMode()
      }
      this.markDirty()
      return true
    }

    if (this._drawMode) {
      this._rawPoints = [{ ...point }]
      this.markDirty()
      return true
    }

    return super.handlePointerDown(point)
  }

  override handlePointerMove(point: Point): void {
    if (this._drawMode) {
      this._rawPoints.push({ ...point })
      this.markDirty()
      return
    }
    super.handlePointerMove(point)
  }

  override handlePointerUp(): void {
    if (this._drawMode) {
      if (this._rawPoints.length >= 2) {
        this._fitToPoints()
        this._drawMode = false
      }
      this._rawPoints = []
      this.markDirty()
    }
    super.handlePointerUp()
    this._checkClosure()
  }

  // Suspend endpoint slots when any canvas-space handle drag starts.
  protected override _onHandleDragStart(): void {
    this._suspendEndpointSlots()
  }

  private _suspendEndpointSlots(): void {
    if (this.startSlot.state === SlotState.Bound)
      BindingLayer.findForSlot(this.startSlot)?.toggle()
    if (this.endSlot.state === SlotState.Bound)
      BindingLayer.findForSlot(this.endSlot)?.toggle()
  }

  // ----------------------------------------------------------
  // Path closure
  // ----------------------------------------------------------

  setOnClose(cb: (stroke: StrokeLayer) => void): void {
    this._onClose = cb
  }

  /** Returns a snapshot of the current visual state for use when
   *  converting this stroke into a closed PathLayer. */
  getStateSnapshot(): StrokeStateSnapshot {
    return {
      points:      [...this._points],
      colour:      { ...this._colour },
      opacity:     this._opacity,
      scale:       this._scale,
      radius:      this._radius,
      strokeWidth: this._strokeWidth,
      filled:      this._filled,
    }
  }

  private _checkClosure(): void {
    const n = this._points.length
    if (n < 3 || this._onClose === null) return
    const A = this._points[0]!, B = this._points[n - 1]!
    if (Math.hypot(B.x - A.x, B.y - A.y) < CLOSE_THRESHOLD) {
      this._points[n - 1] = { ...A }   // snap to exact coincidence
      this._onClose(this)
    }
  }

  // ----------------------------------------------------------
  // Freehand fitting
  // ----------------------------------------------------------

  private _enterDrawMode(): void {
    this._drawMode  = true
    this._rawPoints = []
    this.markDirty()
  }

  private _fitToPoints(): void {
    const simplified = this._rdp(this._rawPoints, RDP_EPS)
    this._points = simplified.length >= 2
      ? simplified
      : this._rawPoints.length >= 2
        ? [this._rawPoints[0]!, this._rawPoints[this._rawPoints.length - 1]!]
        : []
    this._scale  = 1
    this._angle  = 0
    this.markDirty()
  }

  private _rdp(points: Point[], epsilon: number): Point[] {
    if (points.length <= 2) return [...points]
    const first = points[0]!, last = points[points.length - 1]!
    let maxDist = 0, maxIdx = 0
    for (let i = 1; i < points.length - 1; i++) {
      const d = this._ptLineDist(points[i]!, first, last)
      if (d > maxDist) { maxDist = d; maxIdx = i }
    }
    if (maxDist > epsilon) {
      const L = this._rdp(points.slice(0, maxIdx + 1), epsilon)
      const R = this._rdp(points.slice(maxIdx),         epsilon)
      return [...L.slice(0, -1), ...R]
    }
    return [first, last]
  }

  private _ptLineDist(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x, dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
  }
}
