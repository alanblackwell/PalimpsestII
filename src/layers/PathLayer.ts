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

  private _points:    Point[]
  private _dragIndex: number = -1

  constructor(points?: Point[], cx = 500, cy = 300, colour?: Colour) {
    // Pass dummy w/h — PathLayer geometry is defined by control points, not bbox.
    super(cx, cy, 1, 1, colour)
    this._points = points ?? defaultPoints(cx, cy)
  }

  // ----------------------------------------------------------
  // ShapeLayer contract
  // ----------------------------------------------------------

  /** Draw the filled spline. Called by ShapeLayer.renderSelf. */
  protected drawShape(
    ctx: Ctx2D,
    _cx: number, _cy: number,
    _w: number, _h: number,
    _angle: number,
    colour: Colour,
    opacity: number,
  ): void {
    if (this._points.length < 2) return
    const c = colour
    ctx.save()
    ctx.globalAlpha = opacity

    ctx.beginPath()
    for (let i = 0; i <= SAMPLES; i++) {
      const pt = samplePath(this._points, i / SAMPLES)
      if (i === 0) ctx.moveTo(pt.x, pt.y)
      else         ctx.lineTo(pt.x, pt.y)
    }
    ctx.closePath()
    ctx.fillStyle = `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},${c.a})`
    ctx.fill()

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
    return this._nearest(point) >= 0 ? this : null
  }

  override handlePointerDown(point: Point): boolean {
    const idx = this._nearest(point)
    if (idx < 0) return false
    this._dragIndex = idx
    this.markDirty()
    return true
  }

  override handlePointerMove(point: Point): void {
    if (this._dragIndex < 0) return
    this._points[this._dragIndex] = { ...point }
    this.markDirty()
  }

  override handlePointerUp(): void {
    this._dragIndex = -1
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

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
    ctx.save()

    // Spline outline (edit-mode overlay, brighter than fill)
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

    ctx.restore()
  }
}
