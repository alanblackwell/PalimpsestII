import { Layer } from '../core/Layer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type Direction, type DirectionSource,
  type Amount,   type AmountSource,
  type EventValue, type EventSource,
  type PointSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'

// ------------------------------------------------------------
// DirectionLayer — a 2-D direction picker (angle + magnitude)
//                  with optional continuous rotation animation
// ------------------------------------------------------------
//
// Dial handles:
//   positionSlot  (Point)  — overrides the dial centre.
//   handleSlot    (Point)  — overrides the angle from atan2(handle − position).
//   magnitudeSlot (Amount) — overrides the drag-derived magnitude.
//
// Rotation animation pill (below standard slots):
//   rotateToggleSlot (Event)  — each rising edge toggles running/stopped.
//                               Clicking the [⏺/⏸] button suspends binding
//                               (permanent-override convention, same as wander).
//   speedSlot        (Amount) — rotation speed [0,1] → [0, 1 rev/s].
//                               Slider drag suspends binding.
//   cwSlot           (Event)  — each rising edge flips CW/CCW.
//                               Clicking the [↻/↺] button suspends binding.
//
// When handleSlot is active it overrides the animated angle each frame,
// so rotation animation has no visible effect while handleSlot is bound.

const ACCENT       = '#7ecfcf'   // Direction type colour
const POINT_ACCENT = '#cf7ecf'   // Point type colour
const EV_ACCENT    = '#e0e060'   // Event type accent
const AM_ACCENT    = '#4a8fe8'   // Amount type accent

const DIAL_R         = 64
const HANDLE_R       = 8
const HANDLE_HIT     = 16
const ROT_HANDLE_R   = 7
const ROT_HANDLE_HIT = 14
const ROT_OFFSET     = 24

// Rotate-animation pill layout
type BBox = { x: number; y: number; width: number; height: number }
const ROT_PILL_PAD     = 4
const ROT_ROW_H        = 26
const ROT_ROW_GAP      = 4
const ROT_LABEL_W      = 78
const ROT_SLIDER_VAL_W = 40
const ROT_BTN_SZ       = ROT_ROW_H - 6
const N_ROT_ROWS       = 4
const ROT_PILL_H       = ROT_PILL_PAD * 2 + N_ROT_ROWS * ROT_ROW_H + (N_ROT_ROWS - 1) * ROT_ROW_GAP

// Animation constants
const MAX_ROT_SPEED = Math.PI * 2   // rad/s at speed=1 (1 revolution/second)
const MAX_DT        = 0.1           // cap dt to avoid jumps after a pause

type DragState =
  | { type: 'move'; startMouse: Point; startPos: Point }
  | { type: 'dial' }
  | { type: 'rotate' }

function ptDist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export class DirectionLayer extends Layer implements DirectionSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Direction])

  // ── Dial slots ──────────────────────────────────────────────
  private readonly _positionSlot:  ParameterSlot
  private readonly _handleSlot:    ParameterSlot
  private readonly _magnitudeSlot: ParameterSlot

  // ── Rotation animation slots ─────────────────────────────────
  private readonly _rotateToggleSlot: ParameterSlot
  private readonly _speedSlot:        ParameterSlot
  private readonly _cwSlot:           ParameterSlot

  private _angle:     number = 0
  private _magnitude: number = 1
  private _position:  Point  = { x: Node.canvasWidth / 2, y: Node.canvasHeight / 2 }
  private _drag:      DragState | null = null

  // Rotation animation state
  private _rotating           = false
  private _clockwise          = true
  private _rotateSpeed        = 0.3          // manual [0,1]
  private _lastTickTime:    number | null = null
  private _lastRotToggleTime: EventValue  = null
  private _lastCwToggleTime:  EventValue  = null

  // Hit-test bounds for the two toggle buttons (set during renderSlots)
  private _rotateToggleBounds: BBox | null = null
  private _cwBounds:           BBox | null = null
  private _speedSliderDrag = false

  constructor(angle = 0, magnitude = 1) {
    super()
    this._angle          = angle
    this._magnitude      = Math.max(0, Math.min(1, magnitude))
    this._positionSlot     = new ParameterSlot(ValueType.Point,  this, 'position')
    this._handleSlot       = new ParameterSlot(ValueType.Point,  this, 'handle')
    this._magnitudeSlot    = new ParameterSlot(ValueType.Amount, this)
    this._rotateToggleSlot = new ParameterSlot(ValueType.Event,  this, 'rotate')
    this._speedSlot        = new ParameterSlot(ValueType.Amount, this, 'speed')
    this._cwSlot           = new ParameterSlot(ValueType.Event,  this, 'clockwise')
    this.slots.push(
      this._positionSlot, this._handleSlot, this._magnitudeSlot,
      this._rotateToggleSlot, this._speedSlot, this._cwSlot,
    )
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

  get positionSlot():      ParameterSlot { return this._positionSlot      }
  get handleSlot():        ParameterSlot { return this._handleSlot        }
  get magnitudeSlot():     ParameterSlot { return this._magnitudeSlot     }
  get rotateToggleSlot():  ParameterSlot { return this._rotateToggleSlot  }
  get speedSlot():         ParameterSlot { return this._speedSlot         }
  get cwSlot():            ParameterSlot { return this._cwSlot            }

  getDialPosition():   Point { return { ...this._position }       }
  getHandlePosition(): Point { return this._rotateHandlePos()     }

  protected override receiveValue(type: ValueType | null, val: Point | number | Direction): void {
    if (type !== ValueType.Direction || typeof val !== 'object' || !('angle' in val)) return
    const d = val as Direction
    this.setAngleMagnitude(d.angle, d.magnitude)
  }

  setAngleMagnitude(angle: number, magnitude: number): void {
    if (this._handleSlot.state    === SlotState.Bound) BindingLayer.findForSlot(this._handleSlot)?.toggle()
    if (this._magnitudeSlot.state === SlotState.Bound) BindingLayer.findForSlot(this._magnitudeSlot)?.toggle()
    this._angle     = angle
    this._magnitude = Math.max(0, Math.min(1, magnitude))
    this.markDirty()
  }

  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | null {
    if (slot === this._magnitudeSlot) return this._magnitude
    if (slot === this._speedSlot)     return this._rotateSpeed
    return null
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this._positionSlot.isActive) {
      this._position = (this._positionSlot.source as PointSource).getPoint()
    }

    // Rotate-toggle events (permanent-suspend-on-touch when clicked manually).
    if (this._rotateToggleSlot.isActive) {
      const t = (this._rotateToggleSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastRotToggleTime) {
        this._lastRotToggleTime = t
        this._rotating = !this._rotating
        if (this._rotating) this._lastTickTime = null
      }
    }

    // CW/CCW events.
    if (this._cwSlot.isActive) {
      const t = (this._cwSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastCwToggleTime) {
        this._lastCwToggleTime = t
        this._clockwise = !this._clockwise
      }
    }

    // Advance angle when rotating (and handleSlot is not overriding).
    if (this._rotating && !this._handleSlot.isActive) {
      this._rotateTick()
    } else if (!this._rotating) {
      this._lastTickTime = null
    }

    // handleSlot overrides the animated angle.
    if (this._handleSlot.isActive) {
      const hp = (this._handleSlot.source as PointSource).getPoint()
      this._angle = Math.atan2(hp.y - this._position.y, hp.x - this._position.x)
    }
    if (this._magnitudeSlot.isActive) {
      this._magnitude = (this._magnitudeSlot.source as AmountSource).getAmount() as Amount
    }

    // Self-perpetuate while rotating so animation advances every frame.
    if (this._rotating && !this._handleSlot.isActive && (!this.outsideStack || this.inBackground)) {
      queueMicrotask(() => {
        if (this._rotating && !this._handleSlot.isActive && (!this.outsideStack || this.inBackground)) {
          this.forceDirty()
        }
      })
    }
  }

  private _rotateTick(): void {
    if (Node.clock?.paused) return
    const now = performance.now()
    if (this._lastTickTime === null) {
      this._lastTickTime = now
      return
    }
    const dt = Math.min(MAX_DT, (now - this._lastTickTime) / 1000)
    this._lastTickTime = now
    if (dt === 0) return
    const speed = this._speedSlot.isActive
      ? (this._speedSlot.source as AmountSource).getAmount() * MAX_ROT_SPEED
      : this._rotateSpeed * MAX_ROT_SPEED
    this._angle += speed * dt * (this._clockwise ? 1 : -1)
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      angle:       this._angle,
      magnitude:   this._magnitude,
      position:    this._position,
      rotating:    this._rotating,
      clockwise:   this._clockwise,
      rotateSpeed: this._rotateSpeed,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.angle === 'number')       this._angle       = state.angle
    if (typeof state.magnitude === 'number')   this._magnitude   = state.magnitude as Amount
    if (state.position && typeof state.position === 'object') this._position = state.position as Point
    if (typeof state.rotating === 'boolean')   this._rotating    = state.rotating
    if (typeof state.clockwise === 'boolean')  this._clockwise   = state.clockwise
    if (typeof state.rotateSpeed === 'number') this._rotateSpeed = state.rotateSpeed
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    // ── Rotation pill buttons ────────────────────────────────
    if (this._rotateToggleBounds !== null && boundingBoxContains(this._rotateToggleBounds, point)) {
      this._handleRotateToggle()
      return true
    }
    if (this._cwBounds !== null && boundingBoxContains(this._cwBounds, point)) {
      this._handleCwToggle()
      return true
    }

    // ── Speed slider ─────────────────────────────────────────
    if (this._speedSliderHit(point)) {
      this._speedSliderDrag = true
      this._setSpeedFromPointer(point.x)
      return true
    }

    // ── Dial handles ─────────────────────────────────────────
    if (ptDist(point, this._rotateHandlePos()) <= ROT_HANDLE_HIT) {
      if (this._handleSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._handleSlot)?.toggle()
      }
      this._drag = { type: 'rotate' }
      this._applyRotate(point)
      return true
    }

    const dx   = point.x - this._position.x
    const dy   = point.y - this._position.y
    const dist = Math.hypot(dx, dy)

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
    if (this._speedSliderDrag) {
      this._setSpeedFromPointer(point.x)
      return
    }
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
    this._speedSliderDrag = false
  }

  protected override hitTestSelf(point: Point) {
    if (this._drag !== null) return this
    if (this._rotateToggleBounds !== null && boundingBoxContains(this._rotateToggleBounds, point)) return this
    if (this._cwBounds           !== null && boundingBoxContains(this._cwBounds, point))           return this
    if (this._speedSliderHit(point)) return this
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
  }

  override renderOverlay(ctx: Ctx2D): void {
    this._renderDial(ctx)
  }

  // Standard slot rows (positionSlot, handleSlot, magnitudeSlot), then the
  // rotation-animation pill below them.
  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const stdSlots = [this._positionSlot, this._handleSlot, this._magnitudeSlot]
    this.renderSlotGroup(ctx, stdSlots, this.panelBottom)
    this._drawRotatePill(ctx)
  }

  // ----------------------------------------------------------
  // Rotate-pill rendering
  // ----------------------------------------------------------

  private _rotatePillBounds(): BBox {
    const cb   = this.canvasBounds
    const stdH = 3 * (ROT_ROW_H + ROT_ROW_GAP) - ROT_ROW_GAP
    return { x: cb.x, y: this.panelBottom + stdH + 8, width: cb.width, height: ROT_PILL_H }
  }

  private _rotateRow(i: number): BBox {
    const b = this._rotatePillBounds()
    return { x: b.x, y: b.y + ROT_PILL_PAD + i * (ROT_ROW_H + ROT_ROW_GAP), width: b.width, height: ROT_ROW_H }
  }

  private _speedSliderRow(): BBox { return this._rotateRow(1) }

  private _speedSliderHit(point: Point): boolean {
    const b = this._speedSliderRow()
    return boundingBoxContains(b, point)
  }

  private _speedSliderGeom() {
    const b          = this._speedSliderRow()
    const valueRight = b.x + b.width - 8
    const sld0       = b.x + ROT_LABEL_W
    const sldR       = valueRight - ROT_SLIDER_VAL_W - 6
    return { b, midY: b.y + b.height / 2, sld0, sldR, valueRight }
  }

  private _setSpeedFromPointer(px: number): void {
    if (this._speedSlot.state === SlotState.Bound) {
      BindingLayer.findForSlot(this._speedSlot)?.toggle()
    }
    const g = this._speedSliderGeom()
    const lo    = g.sld0 + 5
    const hi    = g.sldR - 5
    const range = Math.max(1e-6, hi - lo)
    this._rotateSpeed = Math.max(0, Math.min(1, (px - lo) / range))
    this.markDirty()
  }

  private _handleRotateToggle(): void {
    if (this._rotateToggleSlot.state === SlotState.Bound) {
      this._rotateToggleSlot.suspend()
    }
    this._rotating = !this._rotating
    if (this._rotating) this._lastTickTime = null
    this.markDirty()
  }

  private _handleCwToggle(): void {
    if (this._cwSlot.state === SlotState.Bound) {
      this._cwSlot.suspend()
    }
    this._clockwise = !this._clockwise
    this.markDirty()
  }

  private _drawRotatePill(ctx: Ctx2D): void {
    const b = this._rotatePillBounds()

    // Pill background
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 8)
    ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, 4, b.height, [4, 0, 0, 4])
    ctx.fill()
    ctx.restore()

    // Row 0 — rotate toggle binding + play/pause button
    const row0 = this._rotateRow(0)
    this._renderBindRow(ctx, this._rotateToggleSlot, row0)
    this._renderToggleBtn(ctx, row0, this._rotating ? '⏺' : '⏸',
      this._rotating ? EV_ACCENT : 'rgba(255,255,255,0.55)',
      this._rotateToggleSlot.state, (b) => { this._rotateToggleBounds = b })

    // Row 1 — speed slider
    this._renderSpeedSlider(ctx)

    // Row 2 — speedSlot binding
    this._renderBindRow(ctx, this._speedSlot, this._rotateRow(2))

    // Row 3 — CW/CCW toggle binding + direction button
    const row3 = this._rotateRow(3)
    this._renderBindRow(ctx, this._cwSlot, row3)
    this._renderToggleBtn(ctx, row3, this._clockwise ? '↻' : '↺',
      ACCENT,
      this._cwSlot.state, (b) => { this._cwBounds = b })
  }

  private _renderSpeedSlider(ctx: Ctx2D): void {
    const g      = this._speedSliderGeom()
    const active = this._speedSlot.isActive
    const colour = active ? AM_ACCENT : ACCENT
    const val    = active
      ? (this._speedSlot.source as AmountSource).getAmount() as Amount
      : this._rotateSpeed

    ctx.save()
    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.50)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('speed', g.b.x + 8, g.midY)

    this._drawSlider(ctx, g.midY, g.sld0, g.sldR, val, colour)

    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    ctx.textAlign = 'right'
    ctx.fillText(val.toFixed(2), g.valueRight, g.midY)
    ctx.restore()
  }

  // Generic toggle button — a small square at the right of `row`.
  // Calls `setBounds(b)` so the caller can store the hit-test rect.
  private _renderToggleBtn(
    ctx:      Ctx2D,
    row:      BBox,
    label:    string,
    colour:   string,
    state:    SlotState,
    setBounds: (b: BBox) => void,
  ): void {
    const btnX  = row.x + row.width - ROT_BTN_SZ - 3
    const btnY  = row.y + 3
    const midY  = row.y + row.height / 2
    const bound = state === SlotState.Bound
    const susp  = state === SlotState.SuspendedBound

    setBounds({ x: btnX, y: btnY, width: ROT_BTN_SZ, height: ROT_BTN_SZ })

    ctx.save()
    ctx.fillStyle = bound ? EV_ACCENT + '33' : susp ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(btnX, btnY, ROT_BTN_SZ, ROT_BTN_SZ, 3)
    ctx.fill()

    ctx.strokeStyle = bound ? EV_ACCENT + '99' : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    if (susp) ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.roundRect(btnX + 0.5, btnY + 0.5, ROT_BTN_SZ - 1, ROT_BTN_SZ - 1, 3)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.font         = '13px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, btnX + ROT_BTN_SZ / 2, midY)
    ctx.restore()
  }

  // Slot binding row — label + drop-target box. Registers in _slotBounds.
  private _renderBindRow(ctx: Ctx2D, slot: ParameterSlot, b: BBox): void {
    const drag     = Node.bindDrag
    const isCompat = drag.active && drag.source !== null && slot.type !== null
                  && drag.source.types.has(slot.type)

    this._slotBounds.set(slot, b)

    const midY = b.y + b.height / 2
    const tc   = slot.type === ValueType.Event  ? EV_ACCENT
               : slot.type === ValueType.Amount ? AM_ACCENT
               : ACCENT

    ctx.save()
    ctx.font         = '10px monospace'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = 'rgba(255,255,255,0.62)'
    ctx.textAlign    = 'left'
    ctx.fillText(slot.label, b.x + 6, midY)

    const vx = b.x + ROT_LABEL_W
    const vw = b.width - ROT_LABEL_W - 2
    const by = b.y + 3
    const bh = b.height - 6

    if (slot.isActive && !isCompat) {
      const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
      ctx.fillStyle   = tc + '22'
      ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
      ctx.strokeStyle = tc + 'cc'; ctx.lineWidth = 1; ctx.setLineDash([])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.fillStyle   = 'rgba(255,255,255,0.92)'; ctx.textAlign = 'left'
      ctx.fillText(srcName, vx + 6, midY)
    } else if (isCompat) {
      ctx.fillStyle   = 'rgba(50,200,70,0.18)'
      ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
      ctx.strokeStyle = 'rgba(50,200,70,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.fillStyle   = 'rgba(100,255,120,0.75)'; ctx.textAlign = 'left'
      ctx.fillText(slot.isActive ? 'replace binding' : 'drop to bind', vx + 6, midY)
    } else if (slot.state === SlotState.SuspendedBound) {
      const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
      ctx.fillStyle   = tc + '11'
      ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.40)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.60)'; ctx.textAlign = 'left'
      ctx.fillText('⏸ ' + srcName, vx + 6, midY)
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.textAlign = 'left'
      ctx.fillText('unbound', vx + 6, midY)
    }

    ctx.restore()
  }

  private _drawSlider(ctx: Ctx2D, midY: number, x0: number, x1: number, v: number, colour: string): void {
    const thumbR = 5
    const lo     = x0 + thumbR
    const hi     = x1 - thumbR
    const range  = Math.max(0, hi - lo)
    const thumbX = lo + Math.max(0, Math.min(1, v)) * range
    ctx.lineCap  = 'round'
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 3
    ctx.beginPath(); ctx.moveTo(lo, midY); ctx.lineTo(hi, midY); ctx.stroke()
    ctx.strokeStyle = colour
    ctx.beginPath(); ctx.moveTo(lo, midY); ctx.lineTo(thumbX, midY); ctx.stroke()
    ctx.fillStyle = colour
    ctx.beginPath(); ctx.arc(thumbX, midY, thumbR, 0, Math.PI * 2); ctx.fill()
  }

  // ----------------------------------------------------------
  // Panel pill
  // ----------------------------------------------------------

  private _drawPill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    const midY      = y + height / 2
    const magBound  = this._magnitudeSlot.isActive

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

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

    // Rotation state indicator
    if (this._rotating) {
      ctx.font      = '13px monospace'
      ctx.fillStyle = EV_ACCENT
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(this._clockwise ? '↻' : '↺', x + width - 48, midY)
    }

    // Slot indicators (●/○), right-to-left
    const slotRows: Array<{ slot: ParameterSlot; label: string; accent: string }> = [
      { slot: this._cwSlot,           label: 'cw',  accent: EV_ACCENT    },
      { slot: this._speedSlot,        label: 'spd', accent: AM_ACCENT    },
      { slot: this._rotateToggleSlot, label: 'rot', accent: EV_ACCENT    },
      { slot: this._magnitudeSlot,    label: 'mag', accent: ACCENT       },
      { slot: this._handleSlot,       label: 'hdl', accent: POINT_ACCENT },
      { slot: this._positionSlot,     label: 'pos', accent: POINT_ACCENT },
    ]
    let dx = x + width - 10
    ctx.font = '9px monospace'
    for (const { slot, label, accent } of slotRows) {
      const active = slot.isActive
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillStyle    = active ? accent : 'rgba(255,255,255,0.22)'
      ctx.fillText(active ? '●' : '○', dx, midY)
      dx -= 12
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText(label, dx, midY)
      dx -= ctx.measureText(label).width + 8
    }

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Dial overlay
  // ----------------------------------------------------------

  private _renderDial(ctx: Ctx2D): void {
    const c        = this._position
    const magBound = this._magnitudeSlot.isActive

    ctx.save()

    // Outer ring
    ctx.strokeStyle = 'rgba(70,70,95,0.55)'
    ctx.lineWidth   = 2
    ctx.beginPath()
    ctx.arc(c.x, c.y, DIAL_R, 0, Math.PI * 2)
    ctx.stroke()

    // Cross-hairs
    ctx.strokeStyle = 'rgba(70,70,95,0.18)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(c.x - DIAL_R, c.y); ctx.lineTo(c.x + DIAL_R, c.y)
    ctx.moveTo(c.x, c.y - DIAL_R); ctx.lineTo(c.x, c.y + DIAL_R)
    ctx.stroke()

    // Direction arm + arrowhead
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

      const shaftLen = Math.max(0, armLen - hw)
      const sx = c.x + Math.cos(ha) * shaftLen
      const sy = c.y + Math.sin(ha) * shaftLen

      ctx.strokeStyle = 'rgba(0,0,0,0.30)'; ctx.lineWidth = 6
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(sx, sy); ctx.stroke()
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 3
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(sx, sy); ctx.stroke()

      const haloHw = hw + 3
      const htx = tx + Math.cos(ha) * 3
      const hty = ty + Math.sin(ha) * 3
      const hax1 = htx - Math.cos(ha - 0.4) * haloHw
      const hay1 = hty - Math.sin(ha - 0.4) * haloHw
      const hax2 = htx - Math.cos(ha + 0.4) * haloHw
      const hay2 = hty - Math.sin(ha + 0.4) * haloHw
      ctx.fillStyle = 'rgba(0,0,0,0.30)'
      ctx.beginPath(); ctx.moveTo(htx, hty); ctx.lineTo(hax1, hay1); ctx.lineTo(hax2, hay2); ctx.closePath(); ctx.fill()
      ctx.fillStyle = ACCENT
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ax1, ay1); ctx.lineTo(ax2, ay2); ctx.closePath(); ctx.fill()
    }

    // Rotate handle — outline ring beyond the dial edge at current angle
    const rh = this._rotateHandlePos()
    this._drawGlowRing(ctx, rh, ROT_HANDLE_R, this._handleSlot.isActive ? '#666688' : '#ffb74d')

    // Move handle — glowing crosshair at the dial centre
    this._drawGlowCircle(ctx, c, HANDLE_R, this._positionSlot.isActive ? '#666688' : '#ffffff')
    const cr = HANDLE_R - 2
    ctx.strokeStyle = 'rgba(0,0,0,0.80)'; ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(c.x - cr, c.y); ctx.lineTo(c.x + cr, c.y)
    ctx.moveTo(c.x, c.y - cr); ctx.lineTo(c.x, c.y + cr)
    ctx.stroke()

    // Readout below the dial
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

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _rotateHandlePos(): Point {
    const r = DIAL_R + ROT_OFFSET
    return {
      x: this._position.x + Math.cos(this._angle) * r,
      y: this._position.y + Math.sin(this._angle) * r,
    }
  }

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

  private _applyRotate(point: Point): void {
    this._angle = Math.atan2(point.y - this._position.y, point.x - this._position.x)
    this.markDirty()
  }

  private _drawGlowCircle(ctx: Ctx2D, pt: Point, r: number, glowColour: string): void {
    ctx.save()
    ctx.shadowColor = glowColour; ctx.shadowBlur = 14
    ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fill()
    ctx.restore()
    ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.lineWidth = 1.5; ctx.stroke()
  }

  private _drawGlowRing(ctx: Ctx2D, pt: Point, r: number, glowColour: string): void {
    ctx.save()
    ctx.shadowColor = glowColour; ctx.shadowBlur = 8
    ctx.strokeStyle = glowColour; ctx.lineWidth = 2.5
    ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
    ctx.beginPath(); ctx.arc(pt.x, pt.y, r + 1.5, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke()
  }
}
