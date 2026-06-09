import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  type Colour, type ColourSource,
  type Amount, type AmountSource,
  type Point,  type PointSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// PathLayer — a closed Catmull-Rom spline shape layer that
//             also produces a Point output at a given phase [0,1]
// ------------------------------------------------------------
//
// Inputs:
//   phaseSlot   (Amount) — position along path [0, 1]
//   colourSlot  (Colour) — fill colour
//   opacitySlot (Amount) — fill opacity
//
// Output:
//   Point — interpolated canvas coordinate at the given phase
//
// Rendering:
//   renderSelf  — filled+stroked spline (always visible)
//   renderPanel — label pill + control-point handles + phase indicator

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

const ACCENT  = '#e8a04a'   // same amber as ShapeLayer
const CP_R    = 6
const HIT_R   = 14
const SAMPLES = 200

// ------------------------------------------------------------------
// PathLayer
// ------------------------------------------------------------------

export class PathLayer extends Layer implements PointSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Point])

  readonly phaseSlot:   ParameterSlot
  readonly colourSlot:  ParameterSlot
  readonly opacitySlot: ParameterSlot

  private _points:       Point[]
  private _phase:        number = 0
  private _currentPoint: Point  = { x: 0, y: 0 }
  private _colour:       Colour = { r: 0.91, g: 0.63, b: 0.29, a: 1 }
  private _opacity:      number = 0.25
  private _dragIndex:    number = -1

  constructor(points?: Point[], cx = 500, cy = 300) {
    super()
    this._points       = points ?? defaultPoints(cx, cy)
    this._currentPoint = samplePath(this._points, 0)

    this.phaseSlot   = new ParameterSlot(ValueType.Amount,  this)
    this.colourSlot  = new ParameterSlot(ValueType.Colour,  this)
    this.opacitySlot = new ParameterSlot(ValueType.Amount,  this)
    this.slots.push(this.phaseSlot, this.colourSlot, this.opacitySlot)

    graph.register(this)
  }

  // PointSource
  getPoint(): Point { return { ...this._currentPoint } }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  get isInteractive(): boolean { return this._points.length > 0 }

  handlePointerDown(point: Point): boolean {
    const idx = this._nearest(point)
    if (idx < 0) return false
    this._dragIndex = idx
    this.markDirty()
    return true
  }

  handlePointerMove(point: Point): void {
    if (this._dragIndex < 0) return
    this._points[this._dragIndex] = { ...point }
    this.markDirty()
  }

  handlePointerUp(): void {
    this._dragIndex = -1
    this.markDirty()
  }

  protected override hitTestSelf(point: Point): this | null {
    return this._nearest(point) >= 0 ? this : null
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this.phaseSlot.isActive) {
      this._phase = (this.phaseSlot.source as AmountSource).getAmount() as Amount
    }
    if (this.colourSlot.isActive) {
      this._colour = (this.colourSlot.source as ColourSource).getColour()
    }
    if (this.opacitySlot.isActive) {
      this._opacity = (this.opacitySlot.source as AmountSource).getAmount() as Amount
    }
    this._currentPoint = samplePath(this._points, this._phase)
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    if (this._points.length < 2) return
    const c = this._colour
    ctx.save()
    ctx.globalAlpha = this._opacity

    // Filled spline
    ctx.beginPath()
    for (let i = 0; i <= SAMPLES; i++) {
      const pt = samplePath(this._points, i / SAMPLES)
      if (i === 0) ctx.moveTo(pt.x, pt.y)
      else         ctx.lineTo(pt.x, pt.y)
    }
    ctx.closePath()
    ctx.fillStyle = `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},${c.a})`
    ctx.fill()

    // Outline at full opacity
    ctx.globalAlpha = Math.min(1, this._opacity * 2.5)
    ctx.strokeStyle = `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},0.85)`
    ctx.lineWidth   = 1.5
    ctx.stroke()

    ctx.restore()
  }

  renderPanel(ctx: Ctx2D): void {
    this._drawPill(ctx, this.bounds)
    this._drawPill(ctx, { x: 300, y: 50, width: 260, height: this.bounds.height })
    this._drawControlHandles(ctx)
    if (this.phaseSlot.isActive) this._drawPhaseIndicator(ctx)
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

    const px = Math.round(this._currentPoint.x)
    const py = Math.round(this._currentPoint.y)
    ctx.fillStyle = 'rgba(255,255,255,0.50)'
    ctx.textAlign = 'right'
    ctx.fillText(`(${px}, ${py})`, x + width - 8, midY)

    ctx.restore()
  }

  private _drawControlHandles(ctx: Ctx2D): void {
    if (this._points.length < 2) return
    ctx.save()

    // Spline outline (brighter when selected)
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

  private _drawPhaseIndicator(ctx: Ctx2D): void {
    const cp = this._currentPoint
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    ctx.arc(cp.x, cp.y, 8, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(cp.x, cp.y, 3, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}
