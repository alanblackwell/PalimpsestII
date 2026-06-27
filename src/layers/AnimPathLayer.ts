import { Layer }        from '../core/Layer.js'
import { Node }         from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  type Amount, type AmountSource,
  type Point,  type PointSource,
  type EventValue, type EventSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { contentLeft } from '../interaction/layout.js'

// ------------------------------------------------------------
// AnimPathLayer — samples a shape layer's perimeter at a given phase
// ------------------------------------------------------------
//
// Inputs:
//   shapeSlot    (Point)  — shape/path whose perimeter is sampled
//   phaseSlot    (Amount) — position along the perimeter [0, 1]
//   runModeSlot  (Event)  — each pulse toggles run/stop; click the
//                           radio checkbox to toggle directly
//
// Output:
//   Point — the canvas coordinate at the current phase on the shape

const ACCENT  = '#cf7ecf'   // purple, distinct from shape amber
const RING_R  = 10
const DOT_R   = 3

// Slot-row constants (must match Layer.ts renderSlots)
const SLOT_H   = 30
const SLOT_GAP = 4
const LABEL_W  = 78

export class AnimPathLayer extends Layer implements PointSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Point])

  readonly shapeSlot:   ParameterSlot
  readonly phaseSlot:   ParameterSlot
  readonly runModeSlot: ParameterSlot

  private _phase:         number = 0
  private _currentPoint:  Point
  private _running        = true
  private _lastEventTime: EventValue = null
  private _toggleBounds:  { x: number; y: number; width: number; height: number } | null = null

  constructor(cx: number, cy: number) {
    super()
    this._currentPoint = { x: cx, y: cy }

    this.shapeSlot   = new ParameterSlot(ValueType.Point,  this, 'shape')
    this.phaseSlot   = new ParameterSlot(ValueType.Amount, this, 'phase')
    this.runModeSlot = new ParameterSlot(ValueType.Event,  this, 'run mode')
    this.slots.push(this.shapeSlot, this.phaseSlot, this.runModeSlot)

    graph.register(this)
  }

  // PointSource
  getPoint(): Point { return { ...this._currentPoint } }

  // The shape slot is conventionally filled with a fresh closed shape
  // (Rect/Ellipse/Path) for the path to follow, not a plain PointLayer.
  override wantsShapeForSlot(slot: ParameterSlot): boolean {
    return slot === this.shapeSlot
  }

  // Current phase [0, 1) — exposed so EventLayer can detect cycle wraps.
  get phase(): number { return this._phase }

  // Sample the underlying shape at phase t — delegates to the bound shape's
  // samplePerimeter if available.  Used by EventLayer to calibrate the
  // closest-approach threshold without waiting for a full live traversal.
  samplePerimeter(t: number): Point {
    if (this.shapeSlot.isActive) {
      const src = this.shapeSlot.source as Record<string, unknown>
      if (typeof src['samplePerimeter'] === 'function') {
        return (src['samplePerimeter'] as (t: number) => Point)(t)
      }
      return (this.shapeSlot.source as PointSource).getPoint()
    }
    return { ...this._currentPoint }
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      phase:         this._phase,
      currentPoint:  this._currentPoint,
      running:       this._running,
      lastEventTime: this._lastEventTime,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.phase === 'number')   this._phase   = state.phase
    if (typeof state.running === 'boolean') this._running = state.running
    if (state.currentPoint && typeof state.currentPoint === 'object') {
      this._currentPoint = state.currentPoint as Point
    }
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

    // Only advance the phase when running.
    if (this._running && this.phaseSlot.isActive) {
      this._phase = (this.phaseSlot.source as AmountSource).getAmount() as Amount
    }

    if (this.shapeSlot.isActive) {
      const src = this.shapeSlot.source as Record<string, unknown>
      if (typeof src['samplePerimeter'] === 'function') {
        this._currentPoint = (src['samplePerimeter'] as (t: number) => Point)(this._phase)
      } else {
        this._currentPoint = (this.shapeSlot.source as PointSource).getPoint()
      }
    }
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(_ctx: Ctx2D): void { /* marker drawn in renderOverlay — selected layer only */ }

  override renderOverlay(ctx: Ctx2D): void {
    const { x, y } = this._currentPoint
    ctx.save()
    ctx.globalAlpha = this._running ? 1 : 0.45
    ctx.strokeStyle = ACCENT
    ctx.lineWidth   = 2
    ctx.beginPath()
    ctx.arc(x, y, RING_R, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(x, y, DOT_R, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  renderPanel(ctx: Ctx2D): void {
    this._drawPill(ctx, this.bounds)
    this._drawPill(ctx, this.canvasBounds)
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

  get isInteractive(): boolean { return this._toggleBounds !== null }

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
      this._running = !this._running
      this.markDirty()
      return true
    }
    return false
  }

  handlePointerUp(): void {}

  // ----------------------------------------------------------
  // Private
  // ----------------------------------------------------------

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return
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
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = this._running ? 'rgba(255,255,255,0.80)' : 'rgba(255,255,255,0.40)'
    ctx.textAlign    = 'left'
    ctx.fillText('AnimPath', x + 12, midY)

    const px = Math.round(this._currentPoint.x)
    const py = Math.round(this._currentPoint.y)
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.textAlign = 'right'
    ctx.fillText(`(${px}, ${py})`, x + width - 8, midY)

    ctx.restore()
  }
}
