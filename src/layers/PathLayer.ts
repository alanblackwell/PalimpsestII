import { ShapeLayer } from './ShapeLayer.js'
import {
  ValueType,
  SlotState,
  type Colour,
  type Point,
  type PointSource,
  type DirectionSource,
  type Direction,
  type Ctx2D,
} from '../core/types.js'
import { BindingLayer } from './BindingLayer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'

// ------------------------------------------------------------
// PathLayer — a closed Catmull-Rom spline shape layer
// ------------------------------------------------------------
//
// Extends ShapeLayer so it shares the same slot set, rendering
// pipeline, and type identity as Rect and Ellipse.
//
// drawShape    — renders the spline fill (called by ShapeLayer.renderSelf)
// samplePerimeter — samples a point on the spline at t ∈ [0, 1)
// renderPanel  — overrides to show spline control-point handles
//                instead of the bbox handles used by Rect/Ellipse

// ------------------------------------------------------------------
// Catmull-Rom spline
// ------------------------------------------------------------------

function catmullRom(P0: Point, P1: Point, P2: Point, P3: Point, t: number): Point {
  const t2 = t * t, t3 = t2 * t
  return {
    x: 0.5 * ((-P0.x + 3*P1.x - 3*P2.x + P3.x)*t3 + (2*P0.x - 5*P1.x + 4*P2.x - P3.x)*t2 + (-P0.x + P2.x)*t + 2*P1.x),
    y: 0.5 * ((-P0.y + 3*P1.y - 3*P2.y + P3.y)*t3 + (2*P0.y - 5*P1.y + 4*P2.y - P3.y)*t2 + (-P0.y + P2.y)*t + 2*P1.y),
  }
}

function samplePath(points: Point[], t: number): Point {
  const n = points.length
  if (n === 0) return { x: 0, y: 0 }
  if (n === 1) return { ...points[0]! }
  const t0 = ((t % 1) + 1) % 1
  const fi = t0 * n
  const i  = Math.floor(fi)
  const u  = fi - i
  return catmullRom(
    points[(i - 1 + n) % n]!,
    points[i % n]!,
    points[(i + 1) % n]!,
    points[(i + 2) % n]!,
    u,
  )
}

function rotatePoint(p: Point, c: Point, angle: number): Point {
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const dx = p.x - c.x, dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

function defaultPoints(cx: number, cy: number): Point[] {
  const rx = 130, ry = 85, n = 6
  const avgR = (rx + ry) / 2
  const angleStep = (Math.PI * 2) / n
  // Angular jitter stays well under half a step so neighbouring points
  // can never swap order — guarantees a simple (non-self-crossing) polygon.
  const angleJitter  = angleStep * 0.35
  // Radius jitter stays within ~40% of the average radius — no spikes
  // or dents far beyond the nominal outline.
  const radiusJitter = avgR * 0.4
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2 + (Math.random() * 2 - 1) * angleJitter
    const rScale = 1 + (Math.random() * 2 - 1) * (radiusJitter / avgR)
    return { x: cx + rx * rScale * Math.cos(a), y: cy + ry * rScale * Math.sin(a) }
  })
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ACCENT     = '#e8a04a'
const DIR_ACCENT = '#7ecfcf'
const CP_R       = 6
const HIT_R      = 14
const ROT_OFF    = 24
const SAMPLES    = 200
const MIN_POINTS = 3   // smallest closed spline we allow (a triangle)

// ------------------------------------------------------------------
// PathLayer
// ------------------------------------------------------------------

export class PathLayer extends ShapeLayer {
  // types inherited from ShapeLayer: Set([ValueType.Point])

  protected _points:        Point[]
  private _dragIndex:       number = -1
  private _specialDrag:     'center' | 'size' | 'rotate' | null = null
  private _dragStartPtr:    Point = { x: 0, y: 0 }
  private _dragStartPts:    Point[] = []
  private _dragStartCenter: Point = { x: 0, y: 0 }
  private _dragStartAngle:  number = 0

  constructor(points?: Point[], cx = 500, cy = 300, colour?: Colour) {
    // Pass dummy w/h — PathLayer geometry is defined by control points, not bbox.
    super(cx, cy, 1, 1, colour)
    this._points = points ?? defaultPoints(cx, cy)
  }

  // ----------------------------------------------------------
  // Node — slot-driven rotation and position are applied to the
  // control points directly (PathLayer has no separate
  // width/height/centre render transform), then super.recompute()
  // resolves `_angle`/`_cx`/`_cy` to match.
  // ----------------------------------------------------------

  protected override recompute(): void {
    if (this.rotationSlot.isActive) {
      const newAngle = (this.rotationSlot.source as DirectionSource).getDirection().angle
      const delta = newAngle - this._angle
      if (delta !== 0) {
        const c = this._centroid()
        this._points = this._points.map(p => rotatePoint(p, c, delta))
      }
    }
    if (this.positionSlot.isActive) {
      const p = (this.positionSlot.source as PointSource).getPoint()
      const c = this._centroid()
      const dx = p.x - c.x
      const dy = p.y - c.y
      if (dx !== 0 || dy !== 0) {
        this._points = this._points.map(pt => ({ x: pt.x + dx, y: pt.y + dy }))
      }
    }
    super.recompute()
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { ...super.serializeState(), points: this._points }
  }

  override deserializeState(state: Record<string, unknown>): void {
    super.deserializeState(state)
    if (Array.isArray(state.points)) this._points = state.points as Point[]
  }

  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | null {
    if (slot === this.positionSlot) return { ...this._centroid() }
    return super.getSlotDefault(slot)
  }

  // ----------------------------------------------------------
  // ShapeLayer contract
  // ----------------------------------------------------------

  /** Draw the spline. Called by ShapeLayer.renderSelf. */
  protected drawShape(
    ctx: Ctx2D,
    _cx: number, _cy: number,
    _w: number, _h: number,
    _angle: number,
    colour: Colour,
    opacity: number,
    filled: boolean,
    strokeWidth: number,
  ): void {
    if (this._points.length < 2) return
    const css = `rgba(${Math.round(colour.r*255)},${Math.round(colour.g*255)},${Math.round(colour.b*255)},${colour.a})`
    ctx.save()
    ctx.globalAlpha = opacity

    ctx.beginPath()
    for (let i = 0; i <= SAMPLES; i++) {
      const pt = samplePath(this._points, i / SAMPLES)
      if (i === 0) ctx.moveTo(pt.x, pt.y)
      else         ctx.lineTo(pt.x, pt.y)
    }
    ctx.closePath()
    if (filled) {
      ctx.fillStyle = css
      ctx.fill()
    } else {
      ctx.strokeStyle = css
      ctx.lineWidth   = strokeWidth
      ctx.stroke()
    }

    ctx.restore()
  }

  /** Sample a point on the spline perimeter. */
  samplePerimeter(t: number): Point {
    return samplePath(this._points, t)
  }

  // ----------------------------------------------------------
  // Rendering — override to show spline handles, not bbox handles
  // ----------------------------------------------------------

  override renderPanel(ctx: Ctx2D): void {
    this._drawPill(ctx, this.bounds)
    this._drawPill(ctx, this.canvasBounds)
    this._drawControlHandles(ctx)
    if (this.phaseSlot.isActive) this._drawPhaseIndicator(ctx)
  }

  // ----------------------------------------------------------
  // Hit testing — control points instead of bbox handles
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point): this | null {
    if (this._toggleBounds !== null) {
      const b = this._toggleBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) return this
    }
    if (this._strokeSliderHit(point)) return this
    const r2 = HIT_R * HIT_R
    const c  = this._centroid()
    if ((point.x - c.x) ** 2 + (point.y - c.y) ** 2 <= r2) return this
    const sh = this._sizeHandlePos()
    if ((point.x - sh.x) ** 2 + (point.y - sh.y) ** 2 <= r2) return this
    const rh = this._rotateHandlePos()
    if ((point.x - rh.x) ** 2 + (point.y - rh.y) ** 2 <= r2) return this
    if (this._nearest(point) >= 0) return this
    return this._curveHit(point) !== null ? this : null
  }

  override handlePointerDown(point: Point): boolean {
    if (this._toggleBounds !== null) {
      const b = this._toggleBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) {
        if (this.fillModeSlot.state === SlotState.Bound) {
          this.fillModeSlot.suspend()
        } else if (this.fillModeSlot.state === SlotState.SuspendedBound) {
          this.fillModeSlot.resume()
        } else {
          this._filled = !this._filled
        }
        this.markDirty()
        return true
      }
    }
    if (this._strokeSliderHit(point)) {
      this._strokeSliderDrag = true
      this._setStrokeWidthFromPointer(point.x)
      this.markDirty()
      return true
    }
    const r2 = HIT_R * HIT_R
    const c  = this._centroid()
    if ((point.x - c.x) ** 2 + (point.y - c.y) ** 2 <= r2) {
      if (this.positionSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this.positionSlot)?.toggle()
      }
      this._specialDrag     = 'center'
      this._dragStartPtr    = { ...point }
      this._dragStartPts    = this._points.map(p => ({ ...p }))
      this.markDirty()
      return true
    }
    const sh = this._sizeHandlePos()
    if ((point.x - sh.x) ** 2 + (point.y - sh.y) ** 2 <= r2) {
      this._specialDrag     = 'size'
      this._dragStartPtr    = { ...point }
      this._dragStartPts    = this._points.map(p => ({ ...p }))
      this._dragStartCenter = c
      this.markDirty()
      return true
    }
    const rh = this._rotateHandlePos()
    if ((point.x - rh.x) ** 2 + (point.y - rh.y) ** 2 <= r2) {
      if (this.rotationSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this.rotationSlot)?.toggle()
      }
      this._specialDrag     = 'rotate'
      this._dragStartPtr    = { ...point }
      this._dragStartPts    = this._points.map(p => ({ ...p }))
      this._dragStartCenter = c
      this._dragStartAngle  = this._angle
      this.markDirty()
      return true
    }
    const idx = this._nearest(point)
    if (idx >= 0) {
      this._dragIndex = idx
      this.markDirty()
      return true
    }
    // Click on the spline outline itself: insert a new control point
    // exactly on the current curve, so the shape is unchanged until the
    // new point is dragged.
    const hit = this._curveHit(point)
    if (hit !== null) {
      this._points.splice(hit.insertAt, 0, { ...hit.pos })
      this._dragIndex = hit.insertAt
      this.markDirty()
      return true
    }
    return false
  }

  /** Right-click on a control point removes it. */
  handleContextMenu(point: Point): boolean {
    if (this._points.length <= MIN_POINTS) return false
    const idx = this._nearest(point)
    if (idx < 0) return false
    this._points.splice(idx, 1)
    if (this._dragIndex === idx) this._dragIndex = -1
    this.markDirty()
    return true
  }

  override handlePointerMove(point: Point): void {
    if (this._strokeSliderDrag) {
      this._setStrokeWidthFromPointer(point.x)
      return
    }
    if (this._specialDrag === 'center') {
      const dx = point.x - this._dragStartPtr.x
      const dy = point.y - this._dragStartPtr.y
      this._points = this._dragStartPts.map(p => ({ x: p.x + dx, y: p.y + dy }))
      this.markDirty()
      return
    }
    if (this._specialDrag === 'size') {
      const c0   = this._dragStartCenter
      const d0   = Math.hypot(this._dragStartPtr.x - c0.x, this._dragStartPtr.y - c0.y)
      const d1   = Math.hypot(point.x - c0.x, point.y - c0.y)
      const scale = d0 > 0 ? d1 / d0 : 1
      this._points = this._dragStartPts.map(p => ({
        x: c0.x + (p.x - c0.x) * scale,
        y: c0.y + (p.y - c0.y) * scale,
      }))
      this.markDirty()
      return
    }
    if (this._specialDrag === 'rotate') {
      const c0 = this._dragStartCenter
      const a0 = Math.atan2(this._dragStartPtr.y - c0.y, this._dragStartPtr.x - c0.x)
      const a1 = Math.atan2(point.y - c0.y, point.x - c0.x)
      const delta = a1 - a0
      this._points = this._dragStartPts.map(p => rotatePoint(p, c0, delta))
      this._angle  = this._dragStartAngle + delta
      this.markDirty()
      return
    }
    if (this._dragIndex >= 0) {
      this._points[this._dragIndex] = { ...point }
      this.markDirty()
    }
  }

  override handlePointerUp(): void {
    this._specialDrag = null
    this._dragIndex   = -1
    this._strokeSliderDrag = false
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _centroid(): Point {
    if (this._points.length === 0) return { x: 0, y: 0 }
    const x = this._points.reduce((s, p) => s + p.x, 0) / this._points.length
    const y = this._points.reduce((s, p) => s + p.y, 0) / this._points.length
    return { x, y }
  }

  private _sizeHandlePos(): Point {
    const c    = this._centroid()
    const maxR = this._points.reduce((r, p) => Math.max(r, Math.hypot(p.x - c.x, p.y - c.y)), 0)
    return { x: c.x + maxR + 24, y: c.y }
  }

  /** Rotate handle — orbits the centroid, tracking `_angle`. */
  private _rotateHandlePos(): Point {
    const c    = this._centroid()
    const maxR = this._points.reduce((r, p) => Math.max(r, Math.hypot(p.x - c.x, p.y - c.y)), 0)
    const a    = this._angle - Math.PI / 2
    return { x: c.x + (maxR + ROT_OFF) * Math.cos(a), y: c.y + (maxR + ROT_OFF) * Math.sin(a) }
  }

  private _nearest(p: Point): number {
    const r2 = HIT_R * HIT_R
    let best = -1, bestD = Infinity
    for (let i = 0; i < this._points.length; i++) {
      const cp = this._points[i]!
      const d2 = (p.x - cp.x) ** 2 + (p.y - cp.y) ** 2
      if (d2 <= r2 && d2 < bestD) { bestD = d2; best = i }
    }
    return best
  }

  /**
   * Test whether `p` lies on the spline outline (within HIT_R) and, if so,
   * return where a new control point should be inserted: the index to
   * splice at, and the on-curve position to give it (so the shape is
   * visually unchanged until that point is dragged).
   */
  private _curveHit(p: Point): { insertAt: number; pos: Point } | null {
    const n = this._points.length
    if (n < 2) return null
    const r2 = HIT_R * HIT_R
    let bestT = 0, bestD2 = Infinity, bestPos: Point = { x: 0, y: 0 }
    for (let i = 0; i <= SAMPLES; i++) {
      const t  = (i / SAMPLES) % 1
      const pt = samplePath(this._points, t)
      const d2 = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2
      if (d2 < bestD2) { bestD2 = d2; bestT = t; bestPos = pt }
    }
    if (bestD2 > r2) return null
    const segIndex = Math.min(n - 1, Math.floor(bestT * n))
    return { insertAt: segIndex + 1, pos: bestPos }
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
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
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = 'rgba(255,255,255,0.80)'
    ctx.textAlign    = 'left'
    ctx.fillText(`${this._points.length} pts`, x + 28, midY)

    // Angle (right side), with rotation-slot indicator dot
    const deg = ((this._angle * 180 / Math.PI) % 360 + 360) % 360
    const rotActive = this.rotationSlot.isActive
    ctx.fillStyle = rotActive ? DIR_ACCENT : 'rgba(255,255,255,0.50)'
    ctx.textAlign = 'right'
    ctx.fillText(`∠ ${deg.toFixed(0)}°`, x + width - 8, midY)
    const angleW = ctx.measureText(`∠ ${deg.toFixed(0)}°`).width
    ctx.fillStyle = rotActive ? DIR_ACCENT : 'rgba(255,255,255,0.22)'
    ctx.font = '9px monospace'
    ctx.fillText(rotActive ? '●' : '○', x + width - 12 - angleW, midY)

    ctx.restore()
  }

  private _drawControlHandles(ctx: Ctx2D): void {
    if (this._points.length < 2) return
    const c  = this._centroid()
    const sh = this._sizeHandlePos()
    const rh = this._rotateHandlePos()

    ctx.save()

    // Spline outline (edit-mode overlay)
    ctx.beginPath()
    for (let i = 0; i <= SAMPLES; i++) {
      const pt = samplePath(this._points, i / SAMPLES)
      if (i === 0) ctx.moveTo(pt.x, pt.y)
      else         ctx.lineTo(pt.x, pt.y)
    }
    ctx.closePath()
    ctx.strokeStyle = 'rgba(232,160,74,0.70)'
    ctx.lineWidth   = 1.5
    ctx.setLineDash([])
    ctx.stroke()

    // Dashed line from centre to size handle
    ctx.strokeStyle = 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(c.x, c.y)
    ctx.lineTo(sh.x, sh.y)
    ctx.stroke()

    // Dashed line from centre to rotate handle
    ctx.beginPath()
    ctx.moveTo(c.x, c.y)
    ctx.lineTo(rh.x, rh.y)
    ctx.stroke()
    ctx.setLineDash([])

    // Control point handles
    for (let i = 0; i < this._points.length; i++) {
      const pt  = this._points[i]!
      const lit = i === this._dragIndex
      ctx.fillStyle   = lit ? ACCENT : 'rgba(232,160,74,0.30)'
      ctx.strokeStyle = lit ? '#ffffff' : ACCENT
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, CP_R, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }

    // Centre handle (amber filled circle)
    const litC = this._specialDrag === 'center'
    ctx.fillStyle   = litC ? '#ffffff' : ACCENT
    ctx.strokeStyle = litC ? ACCENT : 'rgba(0,0,0,0.50)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.arc(c.x, c.y, CP_R + 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    // Size handle (white square)
    const litS = this._specialDrag === 'size'
    const hs   = CP_R
    ctx.fillStyle   = litS ? ACCENT : 'rgba(255,255,255,0.85)'
    ctx.strokeStyle = 'rgba(0,0,0,0.50)'
    ctx.lineWidth   = 1
    ctx.fillRect(sh.x - hs, sh.y - hs, hs * 2, hs * 2)
    ctx.strokeRect(sh.x - hs, sh.y - hs, hs * 2, hs * 2)

    // Rotate handle (circle, dimmed when rotationSlot is active)
    const litR = this._specialDrag === 'rotate'
    ctx.fillStyle = litR ? '#ffffff'
      : this.rotationSlot.isActive ? 'rgba(102,102,136,0.85)' : 'rgba(232,160,74,0.85)'
    ctx.strokeStyle = 'rgba(0,0,0,0.50)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.arc(rh.x, rh.y, CP_R, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    ctx.restore()
  }
}
