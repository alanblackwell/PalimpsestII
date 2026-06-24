import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  type Amount, type AmountSource,
  type Point,  type PointSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// AnimationPathLayer — a closed Catmull-Rom spline that produces
//                      a Point output at a given position [0, 1]
// ------------------------------------------------------------
//
// Inputs:
//   _posSlot  (Amount) — position along the path, [0, 1].
//             Cycles naturally: values outside [0,1) are wrapped.
//             Typically bound to a RateLayer or AmountLayer slider.
//             When unbound, the indicator sits at position 0.
//
// Output:
//   Point — the interpolated canvas coordinate at the given position.
//
// Path geometry:
//   An ordered array of control points.  The spline passes through
//   every control point in sequence and wraps smoothly back to the
//   first.  Control points are draggable at all times (editing the
//   path shape is independent of whether the position slot is bound).
//
// Rendering has two components (same pattern as PointLayer):
//   1. A compact label bar in the stack panel (this.bounds).
//   2. The spline, control-point handles, and position indicator
//      drawn directly at their canvas coordinates.
//
// Hit-testing finds the nearest control point within HIT_R px;
// handlePointerDown/Move/Up manage the drag of that point.

// ------------------------------------------------------------------
// Catmull-Rom spline math
// ------------------------------------------------------------------

// Evaluate a single Catmull-Rom segment at t ∈ [0, 1].
// P0..P3 are the four surrounding control points.
function catmullRom(P0: Point, P1: Point, P2: Point, P3: Point, t: number): Point {
  const t2 = t * t
  const t3 = t2 * t
  return {
    x: 0.5 * (
      (-P0.x + 3*P1.x - 3*P2.x + P3.x) * t3 +
      ( 2*P0.x - 5*P1.x + 4*P2.x - P3.x) * t2 +
      (-P0.x + P2.x) * t +
      2*P1.x
    ),
    y: 0.5 * (
      (-P0.y + 3*P1.y - 3*P2.y + P3.y) * t3 +
      ( 2*P0.y - 5*P1.y + 4*P2.y - P3.y) * t2 +
      (-P0.y + P2.y) * t +
      2*P1.y
    ),
  }
}

// Sample the closed spline at global parameter t ∈ ℝ (wrapped to [0,1)).
// Requires at least 2 points; returns first point for n < 2.
function samplePath(points: Point[], t: number): Point {
  const n = points.length
  if (n === 0) return { x: 0, y: 0 }
  if (n === 1) return { ...points[0] }

  // Wrap t into [0, 1)
  const t0 = ((t % 1) + 1) % 1
  const fi  = t0 * n
  const i   = Math.floor(fi)
  const u   = fi - i

  const P0 = points[(i - 1 + n) % n]
  const P1 = points[i]
  const P2 = points[(i + 1) % n]
  const P3 = points[(i + 2) % n]

  return catmullRom(P0, P1, P2, P3, u)
}

// Build a default elliptical path centred at (cx, cy).
function ellipsePath(cx: number, cy: number, rx: number, ry: number, n = 6): Point[] {
  const pts: Point[] = []
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2  // start at top
    pts.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) })
  }
  return pts
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ACCENT  = '#cf7ecf'   // Point type colour
const CP_R    = 6           // control-point visual radius
const HIT_R   = 14          // pointer-hit radius around each control point
const SAMPLES = 200         // spline rendering resolution

// ------------------------------------------------------------------
// AnimationPathLayer
// ------------------------------------------------------------------

export class AnimationPathLayer extends Layer implements PointSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Point])

  private readonly _posSlot: ParameterSlot

  private _points:       Point[]            // mutable control-point array
  private _position:     number  = 0        // current t value (from slot or 0)
  private _currentPoint: Point   = { x: 0, y: 0 }  // evaluated output
  private _dragIndex:    number  = -1       // index of dragged control point

  constructor(points?: Point[]) {
    super()
    this._posSlot = new ParameterSlot(ValueType.Amount, this)
    this._points  = points ?? ellipsePath(500, 300, 130, 85)
    this._currentPoint = samplePath(this._points, 0)
    this.slots.push(this._posSlot)
    this.displayBaseName = 'Animate'
    this.debugName = 'Animate'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // PointSource
  // ----------------------------------------------------------

  getPoint(): Point { return { ...this._currentPoint } }

  // ----------------------------------------------------------
  // Slot accessor (for BindingLayer.create)
  // ----------------------------------------------------------

  get positionSlot(): ParameterSlot { return this._posSlot }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  // Control points are always editable, even when the position
  // slot is bound.  The path shape and the animated position
  // are independent concerns.
  get isInteractive(): boolean { return this._points.length > 0 }

  handlePointerDown(point: Point): boolean {
    const idx = this._nearestControlPoint(point)
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

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  protected override hitTestSelf(point: { x: number; y: number }): this | null {
    return this._nearestControlPoint(point) >= 0 ? this : null
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this._posSlot.isActive) {
      this._position = (this._posSlot.source as AmountSource).getAmount()
    } else {
      this._position = 0
    }
    this._currentPoint = samplePath(this._points, this._position)
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(_ctx: Ctx2D): void {}

  renderPanel(ctx: Ctx2D): void {
    this._renderLabel(ctx)
  }

  override renderOverlay(ctx: Ctx2D): void {
    this._renderPath(ctx)
  }

  private _renderLabel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.bounds
    if (width <= 0 || height <= 0) return

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    const midY = y + height / 2
    ctx.font         = '11px monospace'
    ctx.textBaseline = 'middle'

    // Current output coordinates
    const px = Math.round(this._currentPoint.x)
    const py = Math.round(this._currentPoint.y)
    ctx.fillStyle = this._posSlot.isActive
      ? 'rgba(255,255,255,0.55)'
      : 'rgba(255,255,255,0.80)'
    ctx.textAlign = 'left'
    ctx.fillText(`(${px}, ${py})`, x + 12, midY)

    // Position t on the right
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.textAlign = 'right'
    ctx.fillText(`t=${this._position.toFixed(2)}`, x + width - 8, midY)

    ctx.restore()
  }

  private _renderPath(ctx: Ctx2D): void {
    if (this._points.length === 0) return

    ctx.save()

    // ── Spline curve ──────────────────────────────────────
    if (this._points.length >= 2) {
      ctx.beginPath()
      for (let i = 0; i <= SAMPLES; i++) {
        const pt = samplePath(this._points, i / SAMPLES)
        if (i === 0) ctx.moveTo(pt.x, pt.y)
        else         ctx.lineTo(pt.x, pt.y)
      }
      ctx.closePath()
      ctx.strokeStyle = this._posSlot.isActive
        ? 'rgba(207,126,207,0.70)'
        : 'rgba(207,126,207,0.40)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // ── Control-point handles ─────────────────────────────
    for (let i = 0; i < this._points.length; i++) {
      const pt     = this._points[i]
      const active = i === this._dragIndex

      ctx.fillStyle   = active ? ACCENT : 'rgba(207,126,207,0.25)'
      ctx.strokeStyle = active ? '#ffffff' : ACCENT
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, CP_R, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }

    // ── Position indicator ────────────────────────────────
    {
      const cp = this._currentPoint
      // Outer ring
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.arc(cp.x, cp.y, CP_R + 5, 0, Math.PI * 2)
      ctx.stroke()
      // Filled dot
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(cp.x, cp.y, 3, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  // Returns the index of the nearest control point within HIT_R,
  // or -1 if none is close enough.
  private _nearestControlPoint(p: Point): number {
    const r2 = HIT_R * HIT_R
    let bestIdx  = -1
    let bestDist = Infinity
    for (let i = 0; i < this._points.length; i++) {
      const cp = this._points[i]
      const d2 = (p.x - cp.x) ** 2 + (p.y - cp.y) ** 2
      if (d2 <= r2 && d2 < bestDist) {
        bestDist = d2
        bestIdx  = i
      }
    }
    return bestIdx
  }
}
