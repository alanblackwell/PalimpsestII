import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  type Amount,    type AmountSource,
  type DirectionSource,
  type EventValue, type EventSource,
  type ImageValue, type ImageSource,
  type Point,     type PointSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'
import { contentLeft } from '../interaction/layout.js'

// ------------------------------------------------------------
// RotateLayer — animates rotation of image content about a centre point
// ------------------------------------------------------------
//
// Inputs:
//   sourceSlot  (Image)     — content to rotate
//   centreSlot  (Point)     — centre of rotation; unbound default: canvas centre
//   startSlot   (Direction) — angle at phase 0 (only .angle is used)
//   endSlot     (Direction) — angle at phase 1
//   phaseSlot   (Amount)    — driven by a Rate/Clock, cycles [0, 1)
//   runModeSlot (Event)     — each pulse toggles run/stop; click the
//                             radio checkbox to toggle directly (which
//                             suspends the binding, same as other
//                             slider-override controls)
//
// The raw [0,1) phase is folded into a ping-pong triangle wave so the
// rotation sweeps back and forth between the start and end angles
// rather than snapping back at the wrap.
//
// Output:
//   Image — sourceSlot's image rotated about centreSlot by the current
//           swept angle.

const ACCENT = '#7ecf7e'   // Image type colour
const DIAL_R = 48          // sweep-hand dial radius (px)

// Slot-row constants (must match Layer.ts renderSlots)
const SLOT_H   = 26
const SLOT_GAP = 4
const LABEL_W  = 78

export class RotateLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  readonly sourceSlot:  ParameterSlot
  readonly centreSlot:  ParameterSlot
  readonly startSlot:   ParameterSlot
  readonly endSlot:     ParameterSlot
  readonly phaseSlot:   ParameterSlot
  readonly runModeSlot: ParameterSlot

  private _offscreen: OffscreenCanvas

  private _phase:        number = 0          // raw [0,1) from phaseSlot
  private _startAngle:   number = 0
  private _endAngle:     number = Math.PI / 2
  private _currentAngle: number = 0           // current swept angle (radians)
  private _centre:       Point  = { x: Node.canvasWidth / 2, y: Node.canvasHeight / 2 }
  private _running               = true
  private _lastEventTime: EventValue = null
  private _toggleBounds: { x: number; y: number; width: number; height: number } | null = null

  constructor() {
    super()
    this._offscreen = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)

    this.sourceSlot  = new ParameterSlot(ValueType.Image,     this, 'image')
    this.centreSlot  = new ParameterSlot(ValueType.Point,     this, 'centre')
    this.startSlot   = new ParameterSlot(ValueType.Direction, this, 'start')
    this.endSlot     = new ParameterSlot(ValueType.Direction, this, 'end')
    this.phaseSlot   = new ParameterSlot(ValueType.Amount,    this, 'phase')
    this.runModeSlot = new ParameterSlot(ValueType.Event,     this, 'run mode')
    this.slots.push(this.sourceSlot, this.centreSlot, this.startSlot, this.endSlot, this.phaseSlot, this.runModeSlot)

    this.debugName = 'RotateLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._offscreen }

  // ----------------------------------------------------------
  // autoBindRules
  // ----------------------------------------------------------

  override autoBindRules(): ReturnType<Layer['autoBindRules']> {
    return [
      { slot: this.sourceSlot, accepts: (l: Layer) => l.types.has(ValueType.Image), sendToBackgroundAfterBind: true },
    ]
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      phase:         this._phase,
      running:       this._running,
      lastEventTime: this._lastEventTime,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.phase === 'number')    this._phase   = state.phase
    if (typeof state.running === 'boolean') this._running = state.running
    if (typeof state.lastEventTime === 'number' || state.lastEventTime === null) {
      this._lastEventTime = state.lastEventTime as EventValue
    }
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    // Toggle run/stop on each new event pulse.
    if (this.runModeSlot.isActive) {
      const t = (this.runModeSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastEventTime) {
        this._lastEventTime = t
        this._running = !this._running
      }
    }

    if (this._running && this.phaseSlot.isActive) {
      this._phase = (this.phaseSlot.source as AmountSource).getAmount() as Amount
    }

    this._startAngle = this.startSlot.isActive
      ? (this.startSlot.source as DirectionSource).getDirection().angle
      : 0
    this._endAngle = this.endSlot.isActive
      ? (this.endSlot.source as DirectionSource).getDirection().angle
      : Math.PI / 2

    // Ping-pong: phase 0→0.5 sweeps start→end, 0.5→1 sweeps back end→start.
    const t = this._phase < 0.5 ? this._phase * 2 : 2 - this._phase * 2
    this._currentAngle = this._startAngle + (this._endAngle - this._startAngle) * t

    this._centre = this.centreSlot.isActive
      ? (this.centreSlot.source as PointSource).getPoint()
      : { x: Node.canvasWidth / 2, y: Node.canvasHeight / 2 }

    const w = Node.canvasWidth
    const h = Node.canvasHeight
    if (this._offscreen.width !== w || this._offscreen.height !== h) {
      this._offscreen = new OffscreenCanvas(w, h)
    }
    const ctx = this._offscreen.getContext('2d')!
    ctx.clearRect(0, 0, w, h)

    if (this.sourceSlot.isActive) {
      const src = (this.sourceSlot.source as ImageSource).getImage()
      if (src !== null) {
        ctx.save()
        ctx.translate(this._centre.x, this._centre.y)
        ctx.rotate(this._currentAngle)
        ctx.translate(-this._centre.x, -this._centre.y)
        ctx.drawImage(src as CanvasImageSource, 0, 0, w, h)
        ctx.restore()
      }
    }
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    ctx.save()
    ctx.drawImage(this._offscreen as CanvasImageSource, 0, 0)
    ctx.restore()
  }

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.canvasBounds
    if (width > 0 && height > 0) this._drawPill(ctx, { x, y, width, height })
    this._renderSweepHand(ctx)
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
    const midY = y + height / 2

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = this._running ? 'rgba(255,255,255,0.80)' : 'rgba(255,255,255,0.40)'
    ctx.fillText('Rotate', x + 12, midY)

    const deg = (this._currentAngle * 180 / Math.PI).toFixed(1)
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.textAlign = 'right'
    ctx.fillText(`∠ ${deg}°`, x + width - 8, midY)

    ctx.restore()
  }

  // Sweep-hand visualisation — dial ring at the rotation centre, dashed
  // ghost arms at the start/end angles, and a solid accent hand at the
  // current swept angle.
  private _renderSweepHand(ctx: Ctx2D): void {
    const c = this._centre

    ctx.save()
    ctx.globalAlpha = this._running ? 1 : 0.45

    ctx.strokeStyle = 'rgba(70,70,95,0.55)'
    ctx.lineWidth   = 2
    ctx.beginPath()
    ctx.arc(c.x, c.y, DIAL_R, 0, Math.PI * 2)
    ctx.stroke()

    this._drawGhostArm(ctx, c, this._startAngle)
    this._drawGhostArm(ctx, c, this._endAngle)
    this._drawSweepArm(ctx, c, this._currentAngle)

    ctx.fillStyle = 'rgba(30,30,40,0.85)'
    ctx.beginPath()
    ctx.arc(c.x, c.y, 3, 0, Math.PI * 2)
    ctx.fill()

    ctx.font         = '12px monospace'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'top'
    const deg = (this._currentAngle * 180 / Math.PI).toFixed(1)
    ctx.fillStyle = 'rgba(30,30,40,0.85)'
    ctx.fillText(`∠ ${deg}°`, c.x, c.y + DIAL_R + 10)

    ctx.restore()
  }

  private _drawGhostArm(ctx: Ctx2D, c: Point, angle: number): void {
    ctx.save()
    ctx.strokeStyle = 'rgba(70,70,95,0.35)'
    ctx.lineWidth   = 1.5
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(c.x, c.y)
    ctx.lineTo(c.x + Math.cos(angle) * DIAL_R, c.y + Math.sin(angle) * DIAL_R)
    ctx.stroke()
    ctx.restore()
  }

  // Solid sweep-hand arm with a sharp-pointed arrowhead — same
  // filled-triangle technique as DirectionLayer's dial arm.
  private _drawSweepArm(ctx: Ctx2D, c: Point, angle: number): void {
    const armLen = DIAL_R
    const hw = 8
    const tx = c.x + Math.cos(angle) * armLen
    const ty = c.y + Math.sin(angle) * armLen
    const shaftLen = Math.max(0, armLen - hw)
    const sx = c.x + Math.cos(angle) * shaftLen
    const sy = c.y + Math.sin(angle) * shaftLen

    ctx.strokeStyle = 'rgba(0,0,0,0.30)'
    ctx.lineWidth   = 5
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(sx, sy); ctx.stroke()

    ctx.strokeStyle = ACCENT
    ctx.lineWidth   = 2.5
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(sx, sy); ctx.stroke()

    const ax1 = tx - Math.cos(angle - 0.4) * hw
    const ay1 = ty - Math.sin(angle - 0.4) * hw
    const ax2 = tx - Math.cos(angle + 0.4) * hw
    const ay2 = ty - Math.sin(angle + 0.4) * hw

    const haloHw = hw + 2
    const htx = tx + Math.cos(angle) * 2
    const hty = ty + Math.sin(angle) * 2
    const hax1 = htx - Math.cos(angle - 0.4) * haloHw
    const hay1 = hty - Math.sin(angle - 0.4) * haloHw
    const hax2 = htx - Math.cos(angle + 0.4) * haloHw
    const hay2 = hty - Math.sin(angle + 0.4) * haloHw

    ctx.fillStyle = 'rgba(0,0,0,0.30)'
    ctx.beginPath(); ctx.moveTo(htx, hty); ctx.lineTo(hax1, hay1); ctx.lineTo(hax2, hay2); ctx.closePath(); ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ax1, ay1); ctx.lineTo(ax2, ay2); ctx.closePath(); ctx.fill()
  }

  // Draw radio checkbox overlay on the runModeSlot row.
  override renderSlots(ctx: Ctx2D): void {
    super.renderSlots(ctx)

    const idx = this.slots.indexOf(this.runModeSlot)
    if (idx < 0) return

    const PANEL_X = contentLeft(Node.canvasWidth)
    const y    = this.panelBottom + idx * (SLOT_H + SLOT_GAP)
    const midY = y + SLOT_H / 2
    const cbx  = PANEL_X + LABEL_W - 14
    const cbr  = 5

    this._toggleBounds = { x: PANEL_X, y, width: LABEL_W, height: SLOT_H }

    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.70)'
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    ctx.arc(cbx, midY, cbr, 0, Math.PI * 2)
    ctx.stroke()
    if (this._running) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.beginPath()
      ctx.arc(cbx, midY, cbr - 2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point): this | null {
    if (this._toggleBounds === null) return null
    const b = this._toggleBounds
    if (point.x >= b.x && point.x <= b.x + b.width &&
        point.y >= b.y && point.y <= b.y + b.height) return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    if (this._toggleBounds === null) return false
    const b = this._toggleBounds
    if (point.x >= b.x && point.x <= b.x + b.width &&
        point.y >= b.y && point.y <= b.y + b.height) {
      if (this.runModeSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this.runModeSlot)?.toggle()
      }
      this._running = !this._running
      this.markDirty()
      return true
    }
    return false
  }

  handlePointerUp(): void {}
}
