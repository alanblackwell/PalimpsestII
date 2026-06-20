import { Layer } from '../core/Layer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  type Direction, type DirectionSource,
  type Amount,   type AmountSource,
  type PointSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'

// ------------------------------------------------------------
// DirectionLayer — a 2-D direction picker (angle + magnitude)
// ------------------------------------------------------------
//
// A large circular dial, centred on the canvas by default, lets the
// user set both values by dragging:
//
//   Angle     — atan2 of pointer position relative to the dial centre.
//               Displayed in degrees (−180 … 180).
//
//   Magnitude — distance from centre normalised to dial radius,
//               clamped to [0, 1].  Ignored when magnitudeSlot
//               is active (driven externally).
//
// A move handle (glowing crosshair) sits at the dial centre — dragging
// it repositions the whole dial anywhere on the canvas.
//
// Optional inputs:
//   positionSlot  (Point)  — overrides the dial centre (_position).
//   handleSlot    (Point)  — overrides the angle: _angle is derived from
//                            atan2(handle − position).  Magnitude is
//                            unaffected.
//   magnitudeSlot (Amount) — overrides the drag-derived magnitude;
//                            the dial arm length reflects the bound
//                            value.  Angle is still set by drag.
//
// Dragging a handle while its corresponding slot is bound suspends that
// binding first (same slider-override pattern as AmountLayer), handing
// manual control back to the user at the current value.

const ACCENT       = '#7ecfcf'   // Direction type colour
const POINT_ACCENT = '#cf7ecf'   // Point type colour
const DIAL_R     = 64          // radius of the interactive dial (px)
const HANDLE_R   = 8           // visual radius of the move handle (px)
const HANDLE_HIT = 16           // pointer hit-test radius of the move handle (px)

const ROT_HANDLE_R   = 7        // visual radius of the rotate handle (px)
const ROT_HANDLE_HIT = 14       // pointer hit-test radius of the rotate handle (px)
const ROT_OFFSET     = 24       // rotate handle sits this far beyond the dial ring (px)

type DragState =
  | { type: 'move'; startMouse: Point; startPos: Point }
  | { type: 'dial' }
  | { type: 'rotate' }

function ptDist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export class DirectionLayer extends Layer implements DirectionSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Direction])

  private readonly _positionSlot:  ParameterSlot
  private readonly _handleSlot:    ParameterSlot
  private readonly _magnitudeSlot: ParameterSlot

  private _angle:     number = 0    // radians; 0 = right (+x), CCW positive
  private _magnitude: number = 1    // [0, 1]
  private _position:  Point  = { x: Node.canvasWidth / 2, y: Node.canvasHeight / 2 }
  private _drag:      DragState | null = null

  constructor(angle = 0, magnitude = 1) {
    super()
    this._angle          = angle
    this._magnitude      = Math.max(0, Math.min(1, magnitude))
    this._positionSlot   = new ParameterSlot(ValueType.Point,  this, 'position')
    this._handleSlot     = new ParameterSlot(ValueType.Point,  this, 'handle')
    this._magnitudeSlot  = new ParameterSlot(ValueType.Amount, this)
    this.slots.push(this._positionSlot, this._handleSlot, this._magnitudeSlot)
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
  // Slot accessors
  // ----------------------------------------------------------

  get positionSlot():  ParameterSlot { return this._positionSlot }
  get handleSlot():    ParameterSlot { return this._handleSlot }
  get magnitudeSlot(): ParameterSlot { return this._magnitudeSlot }

  // Current dial centre / control-handle position — used to seed a new
  // PointLayer when the user clicks an empty positionSlot/handleSlot row,
  // so the binding is a no-op by default.
  getDialPosition(): Point { return { ...this._position } }
  getHandlePosition(): Point { return this._rotateHandlePos() }

  // Called by a consumer (e.g. LineLayer) when its direction binding is
  // re-enabled: snaps the manual angle/magnitude to the given values and
  // suspends any active slots that were overriding those values, so the snap
  // takes effect rather than being immediately overridden by a live source.
  setAngleMagnitude(angle: number, magnitude: number): void {
    if (this._handleSlot.state    === SlotState.Bound) BindingLayer.findForSlot(this._handleSlot)?.toggle()
    if (this._magnitudeSlot.state === SlotState.Bound) BindingLayer.findForSlot(this._magnitudeSlot)?.toggle()
    this._angle     = angle
    this._magnitude = Math.max(0, Math.min(1, magnitude))
    this.markDirty()
  }

  // Seed a newly-created layer (via slot-click-to-create) with the value
  // currently shown by the manual control, so the binding starts as a no-op.
  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | null {
    if (slot === this._magnitudeSlot) return this._magnitude
    return null
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this._positionSlot.isActive) {
      this._position = (this._positionSlot.source as PointSource).getPoint()
    }
    if (this._handleSlot.isActive) {
      const hp = (this._handleSlot.source as PointSource).getPoint()
      this._angle = Math.atan2(hp.y - this._position.y, hp.x - this._position.x)
    }
    if (this._magnitudeSlot.isActive) {
      this._magnitude = (this._magnitudeSlot.source as AmountSource).getAmount() as Amount
    }
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { angle: this._angle, magnitude: this._magnitude, position: this._position }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.angle === 'number')     this._angle     = state.angle
    if (typeof state.magnitude === 'number') this._magnitude = state.magnitude as Amount
    if (state.position && typeof state.position === 'object') this._position = state.position as Point
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    const dx   = point.x - this._position.x
    const dy   = point.y - this._position.y
    const dist = Math.hypot(dx, dy)

    if (ptDist(point, this._rotateHandlePos()) <= ROT_HANDLE_HIT) {
      if (this._handleSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._handleSlot)?.toggle()
      }
      this._drag = { type: 'rotate' }
      this._applyRotate(point)
      return true
    }

    if (dist <= HANDLE_HIT) {
      if (this._positionSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._positionSlot)?.toggle()
      }
      this._drag = { type: 'move', startMouse: { ...point }, startPos: { ...this._position } }
      return true
    }
    if (dist <= DIAL_R) {
      if (this._handleSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._handleSlot)?.toggle()
      }
      this._drag = { type: 'dial' }
      this._applyPointer(point)
      return true
    }
    return false
  }

  handlePointerMove(point: Point): void {
    if (this._drag === null) return

    if (this._drag.type === 'move') {
      this._position = {
        x: this._drag.startPos.x + point.x - this._drag.startMouse.x,
        y: this._drag.startPos.y + point.y - this._drag.startMouse.y,
      }
      this.markDirty()
    } else if (this._drag.type === 'rotate') {
      this._applyRotate(point)
    } else {
      this._applyPointer(point)
    }
  }

  handlePointerUp(): void {
    this._drag = null
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    if (this._drag !== null) return this
    const dist = Math.hypot(point.x - this._position.x, point.y - this._position.y)
    if (dist <= DIAL_R) return this
    if (ptDist(point, this._rotateHandlePos()) <= ROT_HANDLE_HIT) return this
    return null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.canvasBounds
    if (width > 0 && height > 0) this._drawPill(ctx, { x, y, width, height })
    this._renderDial(ctx)
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
    const midY = y + height / 2
    const magBound = this._magnitudeSlot.isActive

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

    // Angle / magnitude readout
    const deg = (this._angle * 180 / Math.PI).toFixed(1)
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = 'rgba(255,255,255,0.85)'
    ctx.fillText(`∠ ${deg}°`, x + 12, midY - 7)
    ctx.fillStyle = magBound ? ACCENT : 'rgba(255,255,255,0.65)'
    ctx.fillText(`m  ${this._magnitude.toFixed(2)}`, x + 12, midY + 7)

    // Slot indicators (●/○), right-to-left
    const slotRows: Array<{ slot: ParameterSlot; label: string; accent: string }> = [
      { slot: this._magnitudeSlot, label: 'mag', accent: ACCENT },
      { slot: this._handleSlot,    label: 'hdl', accent: POINT_ACCENT },
      { slot: this._positionSlot,  label: 'pos', accent: POINT_ACCENT },
    ]
    let dx = x + width - 10
    ctx.font = '9px monospace'
    for (const { slot, label, accent } of slotRows) {
      const active = slot.isActive
      ctx.textAlign = 'right'
      ctx.fillStyle = active ? accent : 'rgba(255,255,255,0.22)'
      ctx.fillText(active ? '●' : '○', dx, midY)
      dx -= 12
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText(label, dx, midY)
      dx -= ctx.measureText(label).width + 8
    }

    ctx.restore()
  }

  // Large dial, centred at this._position — drawn on the canvas, panel-only.
  private _renderDial(ctx: Ctx2D): void {
    const c = this._position
    const magBound = this._magnitudeSlot.isActive

    ctx.save()

    // Outer ring — dark/neutral so it reads against a white canvas
    ctx.strokeStyle = 'rgba(70,70,95,0.55)'
    ctx.lineWidth   = 2
    ctx.beginPath()
    ctx.arc(c.x, c.y, DIAL_R, 0, Math.PI * 2)
    ctx.stroke()

    // Cross-hairs (subtle guides)
    ctx.strokeStyle = 'rgba(70,70,95,0.18)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(c.x - DIAL_R, c.y); ctx.lineTo(c.x + DIAL_R, c.y)
    ctx.moveTo(c.x, c.y - DIAL_R); ctx.lineTo(c.x, c.y + DIAL_R)
    ctx.stroke()

    // Direction arm + arrowhead — drawn with a dark halo so the accent
    // colour reads against light and dark backgrounds alike.
    const armLen = this._magnitude * DIAL_R
    const tx = c.x + Math.cos(this._angle) * armLen
    const ty = c.y + Math.sin(this._angle) * armLen

    if (armLen > 2) {
      const ha  = this._angle
      const hw  = 10
      const ax1 = tx - Math.cos(ha - 0.4) * hw
      const ay1 = ty - Math.sin(ha - 0.4) * hw
      const ax2 = tx - Math.cos(ha + 0.4) * hw
      const ay2 = ty - Math.sin(ha + 0.4) * hw

      // Shaft halo + accent — stop short of the arrowhead so the strokes'
      // flat ends are covered by the (wider) arrowhead shapes below,
      // leaving a clean point at the tip rather than a truncated stub.
      const shaftLen = Math.max(0, armLen - hw)
      const sx = c.x + Math.cos(ha) * shaftLen
      const sy = c.y + Math.sin(ha) * shaftLen

      ctx.strokeStyle = 'rgba(0,0,0,0.30)'
      ctx.lineWidth   = 6
      ctx.beginPath()
      ctx.moveTo(c.x, c.y)
      ctx.lineTo(sx, sy)
      ctx.stroke()

      ctx.strokeStyle = ACCENT
      ctx.lineWidth   = 3
      ctx.beginPath()
      ctx.moveTo(c.x, c.y)
      ctx.lineTo(sx, sy)
      ctx.stroke()

      // Arrowhead halo — a slightly enlarged triangle, filled (no stroke
      // caps), so the tip comes to a clean point under the accent fill.
      const haloHw = hw + 3
      const htx = tx + Math.cos(ha) * 3
      const hty = ty + Math.sin(ha) * 3
      const hax1 = htx - Math.cos(ha - 0.4) * haloHw
      const hay1 = hty - Math.sin(ha - 0.4) * haloHw
      const hax2 = htx - Math.cos(ha + 0.4) * haloHw
      const hay2 = hty - Math.sin(ha + 0.4) * haloHw
      ctx.fillStyle = 'rgba(0,0,0,0.30)'
      ctx.beginPath()
      ctx.moveTo(htx, hty)
      ctx.lineTo(hax1, hay1)
      ctx.lineTo(hax2, hay2)
      ctx.closePath()
      ctx.fill()

      // Arrowhead accent — sharp point at the tip
      ctx.fillStyle = ACCENT
      ctx.beginPath()
      ctx.moveTo(tx, ty)
      ctx.lineTo(ax1, ay1)
      ctx.lineTo(ax2, ay2)
      ctx.closePath()
      ctx.fill()
    }

    // Rotate handle — sits just beyond the ring at the current angle, so
    // it's visible (and grabbable) even when the arrow itself is short.
    // Drawn as an outline-only ring (no solid fill) so it doesn't leave a
    // pale halo over the arrowhead when the arm reaches full length.
    const rh = this._rotateHandlePos()
    this._drawGlowRing(ctx, rh, ROT_HANDLE_R, this._handleSlot.isActive ? '#666688' : '#ffb74d')

    // Move handle — glowing crosshair at the dial centre
    this._drawGlowCircle(ctx, c, HANDLE_R, this._positionSlot.isActive ? '#666688' : '#ffffff')
    const cr = HANDLE_R - 2
    ctx.strokeStyle = 'rgba(0,0,0,0.80)'
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    ctx.moveTo(c.x - cr, c.y); ctx.lineTo(c.x + cr, c.y)
    ctx.moveTo(c.x, c.y - cr); ctx.lineTo(c.x, c.y + cr)
    ctx.stroke()

    // Angle / magnitude readout below the dial
    ctx.font         = '12px monospace'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'top'
    const deg = (this._angle * 180 / Math.PI).toFixed(1)
    ctx.fillStyle = 'rgba(30,30,40,0.85)'
    ctx.fillText(`∠ ${deg}°`, c.x, c.y + DIAL_R + ROT_OFFSET + 14)
    ctx.fillStyle = magBound ? '#2f7a7a' : 'rgba(30,30,40,0.65)'
    ctx.fillText(`m ${this._magnitude.toFixed(2)}`, c.x, c.y + DIAL_R + ROT_OFFSET + 30)

    ctx.restore()
  }

  // Position of the rotate handle: just beyond the ring, at the current angle.
  private _rotateHandlePos(): Point {
    const r = DIAL_R + ROT_OFFSET
    return {
      x: this._position.x + Math.cos(this._angle) * r,
      y: this._position.y + Math.sin(this._angle) * r,
    }
  }

  private _drawGlowCircle(ctx: Ctx2D, pt: Point, r: number, glowColour: string): void {
    ctx.save()
    ctx.shadowColor = glowColour
    ctx.shadowBlur  = 14
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,255,255,0.95)'
    ctx.fill()
    ctx.restore()
    // Dark outline drawn without shadow
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(0,0,0,0.65)'
    ctx.lineWidth   = 1.5
    ctx.stroke()
  }

  // Outline-only handle: a coloured ring with a glow, but no solid fill —
  // used where a filled circle would otherwise leave a pale halo over
  // nearby content (e.g. the arrowhead when the arm reaches the ring).
  private _drawGlowRing(ctx: Ctx2D, pt: Point, r: number, glowColour: string): void {
    ctx.save()
    ctx.shadowColor = glowColour
    ctx.shadowBlur  = 8
    ctx.strokeStyle = glowColour
    ctx.lineWidth   = 2.5
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
    // Dark outline drawn without shadow, for contrast against light backgrounds
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, r + 1.5, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'
    ctx.lineWidth   = 1
    ctx.stroke()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _applyPointer(point: Point): void {
    const dx = point.x - this._position.x
    const dy = point.y - this._position.y
    this._angle = Math.atan2(dy, dx)
    if (!this._magnitudeSlot.isActive) {
      const dist = Math.hypot(dx, dy)
      this._magnitude = Math.min(1, dist / DIAL_R)
    }
    this.markDirty()
  }

  // Rotate handle: changes angle only, leaving magnitude untouched.
  private _applyRotate(point: Point): void {
    this._angle = Math.atan2(point.y - this._position.y, point.x - this._position.x)
    this.markDirty()
  }
}
