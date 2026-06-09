import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  type Direction, type DirectionSource,
  type Amount,   type AmountSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// DirectionLayer — a 2-D direction picker (angle + magnitude)
// ------------------------------------------------------------
//
// The embedded circular dial lets the user set both values by
// dragging anywhere inside the circle:
//
//   Angle     — atan2 of pointer position relative to dial centre.
//               Displayed in degrees (−180 … 180).
//
//   Magnitude — distance from centre normalised to dial radius,
//               clamped to [0, 1].  Ignored when magnitudeSlot
//               is active (driven externally).
//
// Optional input:
//   magnitudeSlot (Amount) — overrides the drag-derived magnitude;
//                            the dial arm length reflects the bound
//                            value.  Angle is still set by drag.
//
// Visual layout (height ≈ 70 px):
//
//   ┌─────────────────────────────────────────────────────┐
//   │ ▌  [circular dial]      ∠ 45.2°                    │
//   │                         m  0.73                     │
//   └─────────────────────────────────────────────────────┘
//
// The dial ring dims when magnitude slot is bound (magnitude
// portion of drag is ignored).

const ACCENT  = '#7ecfcf'   // Direction type colour
const DIAL_R  = 26          // radius of the interactive circle (px)
const DIAL_OX = 12          // left padding before dial centre

export class DirectionLayer extends Layer implements DirectionSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Direction])

  private readonly _magnitudeSlot: ParameterSlot

  private _angle:     number = 0    // radians; 0 = right (+x), CCW positive
  private _magnitude: number = 0.7  // [0, 1]
  private _dragging   = false
  private _cpBounds: { x: number; y: number; width: number; height: number } | null = null

  constructor(angle = 0, magnitude = 0.7) {
    super()
    this._angle          = angle
    this._magnitude      = Math.max(0, Math.min(1, magnitude))
    this._magnitudeSlot  = new ParameterSlot(ValueType.Amount, this)
    this.slots.push(this._magnitudeSlot)
    this.debugName = 'DirectionLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // DirectionSource
  // ----------------------------------------------------------

  getDirection(): Direction {
    return { angle: this._angle, magnitude: this._magnitude }
  }

  // ----------------------------------------------------------
  // Slot accessor
  // ----------------------------------------------------------

  get magnitudeSlot(): ParameterSlot { return this._magnitudeSlot }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this._magnitudeSlot.isActive) {
      this._magnitude = (this._magnitudeSlot.source as AmountSource).getAmount() as Amount
    }
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    const c = this._dialCentre(this._cpBounds ?? this.bounds)
    const dx = point.x - c.x
    const dy = point.y - c.y
    if (dx * dx + dy * dy <= DIAL_R * DIAL_R) {
      this._dragging = true
      this._applyPointer(point)
      return true
    }
    return false
  }

  handlePointerMove(point: Point): void {
    if (this._dragging) this._applyPointer(point)
  }

  handlePointerUp(): void {
    this._dragging = false
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    const c  = this._dialCentre(this._cpBounds ?? this.bounds)
    const dx = point.x - c.x
    const dy = point.y - c.y
    return dx * dx + dy * dy <= DIAL_R * DIAL_R ? this : null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width <= 0 || this.bounds.height <= 0) return
    this._drawPill(ctx, this.bounds)
    const cp = { x: 300, y: 50, width: 260, height: this.bounds.height }
    this._cpBounds = cp
    this._drawPill(ctx, cp)
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
    const midY = y + height / 2
    const c    = this._dialCentre(b)

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

    // ── Dial ────────────────────────────────────────────────
    const magBound = this._magnitudeSlot.isActive

    // Outer ring
    ctx.strokeStyle = magBound ? 'rgba(126,207,207,0.30)' : 'rgba(126,207,207,0.55)'
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    ctx.arc(c.x, c.y, DIAL_R, 0, Math.PI * 2)
    ctx.stroke()

    // Magnitude arc (progress ring, clockwise from right)
    if (this._magnitude > 0.01) {
      ctx.strokeStyle = magBound ? 'rgba(126,207,207,0.50)' : ACCENT
      ctx.lineWidth   = 2.5
      ctx.beginPath()
      ctx.arc(c.x, c.y, DIAL_R - 4, -Math.PI / 2, -Math.PI / 2 + this._magnitude * Math.PI * 2)
      ctx.stroke()
    }

    // Cross-hairs (subtle guides)
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(c.x - DIAL_R, c.y); ctx.lineTo(c.x + DIAL_R, c.y)
    ctx.moveTo(c.x, c.y - DIAL_R); ctx.lineTo(c.x, c.y + DIAL_R)
    ctx.stroke()

    // Direction arm
    const armLen = this._magnitude * (DIAL_R - 4)
    const tx = c.x + Math.cos(this._angle) * armLen
    const ty = c.y + Math.sin(this._angle) * armLen

    if (armLen > 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.80)'
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.moveTo(c.x, c.y)
      ctx.lineTo(tx, ty)
      ctx.stroke()

      // Arrowhead
      const hw = 4
      const ha = this._angle
      ctx.fillStyle = 'rgba(255,255,255,0.80)'
      ctx.beginPath()
      ctx.moveTo(tx, ty)
      ctx.lineTo(tx - Math.cos(ha - 0.45) * hw, ty - Math.sin(ha - 0.45) * hw)
      ctx.lineTo(tx - Math.cos(ha + 0.45) * hw, ty - Math.sin(ha + 0.45) * hw)
      ctx.closePath()
      ctx.fill()
    }

    // Centre dot
    ctx.fillStyle = 'rgba(255,255,255,0.50)'
    ctx.beginPath()
    ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2)
    ctx.fill()

    // ── Labels ──────────────────────────────────────────────
    const labelX = c.x + DIAL_R + 14
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'

    // Angle in degrees
    const deg = (this._angle * 180 / Math.PI).toFixed(1)
    ctx.fillStyle    = 'rgba(255,255,255,0.85)'
    ctx.textBaseline = 'middle'
    ctx.fillText(`∠ ${deg}°`, labelX, midY - 7)

    // Magnitude
    ctx.fillStyle = magBound
      ? 'rgba(126,207,207,0.85)'
      : 'rgba(255,255,255,0.65)'
    ctx.fillText(`m  ${this._magnitude.toFixed(2)}`, labelX, midY + 7)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _dialCentre(b?: { x: number; y: number; width: number; height: number }): Point {
    const { x, y, height } = b ?? this.bounds
    return { x: x + DIAL_OX + DIAL_R, y: y + height / 2 }
  }

  private _applyPointer(point: Point): void {
    const c  = this._dialCentre(this._cpBounds ?? this.bounds)
    const dx = point.x - c.x
    const dy = point.y - c.y
    this._angle = Math.atan2(dy, dx)
    if (!this._magnitudeSlot.isActive) {
      const dist    = Math.sqrt(dx * dx + dy * dy)
      this._magnitude = Math.min(1, dist / DIAL_R)
    }
    this.markDirty()
  }
}
