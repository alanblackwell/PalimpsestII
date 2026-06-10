import { ShapeLayer } from './ShapeLayer.js'
import {
  ValueType,
  type Colour,
  type Point,
  type Ctx2D,
} from '../core/types.js'

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

function defaultPoints(cx: number, cy: number): Point[] {
  const rx = 130, ry = 85, n = 6
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }
  })
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ACCENT  = '#e8a04a'
const CP_R    = 6
const HIT_R   = 14
const SAMPLES = 200

// ------------------------------------------------------------------
// PathLayer
// ------------------------------------------------------------------

export class PathLayer extends ShapeLayer {
  // types inherited from ShapeLayer: Set([ValueType.Point])

  private _points:          Point[]
  private _dragIndex:       number = -1
  private _specialDrag:     'center' | 'size' | null = null
  private _dragStartPtr:    Point = { x: 0, y: 0 }
  private _dragStartPts:    Point[] = []
  private _dragStartCenter: Point = { x: 0, y: 0 }

  constructor(points?: Point[], cx = 500, cy = 300, colour?: Colour) {
    // Pass dummy w/h — PathLayer geometry is defined by control points, not bbox.
    super(cx, cy, 1, 1, colour)
    this._points = points ?? defaultPoints(cx, cy)
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
      ctx.lineWidth   = 2
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
    this._drawPill(ctx, { x: 300, y: 50, width: 260, height: this.bounds.height })
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
    const r2 = HIT_R * HIT_R
    const c  = this._centroid()
    if ((point.x - c.x) ** 2 + (point.y - c.y) ** 2 <= r2) return this
    const sh = this._sizeHandlePos()
    if ((point.x - sh.x) ** 2 + (point.y - sh.y) ** 2 <= r2) return this
    return this._nearest(point) >= 0 ? this : null
  }

  override handlePointerDown(point: Point): boolean {
    if (this._toggleBounds !== null) {
      const b = this._toggleBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) {
        this._filled = !this._filled
        this.markDirty()
        return true
      }
    }
    const r2 = HIT_R * HIT_R
    const c  = this._centroid()
    if ((point.x - c.x) ** 2 + (point.y - c.y) ** 2 <= r2) {
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
    const idx = this._nearest(point)
    if (idx < 0) return false
    this._dragIndex = idx
    this.markDirty()
    return true
  }

  override handlePointerMove(point: Point): void {
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
    if (this._dragIndex >= 0) {
      this._points[this._dragIndex] = { ...point }
      this.markDirty()
    }
  }

  override handlePointerUp(): void {
    this._specialDrag = null
    this._dragIndex   = -1
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

    const px = Math.round(this.getPoint().x)
    const py = Math.round(this.getPoint().y)
    ctx.fillStyle = 'rgba(255,255,255,0.50)'
    ctx.textAlign = 'right'
    ctx.fillText(`(${px}, ${py})`, x + width - 8, midY)

    ctx.restore()
  }

  private _drawControlHandles(ctx: Ctx2D): void {
    if (this._points.length < 2) return
    const c  = this._centroid()
    const sh = this._sizeHandlePos()

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

    ctx.restore()
  }
}
