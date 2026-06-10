import { Layer }        from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  type Amount, type AmountSource,
  type Point,  type PointSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// AnimPathLayer — samples a shape layer's perimeter at a given phase
// ------------------------------------------------------------
//
// Inputs:
//   shapeSlot  (Point) — a shape or path layer whose perimeter is sampled.
//                        If the source implements samplePerimeter(t) the
//                        layer samples the perimeter directly at the current
//                        phase; otherwise falls back to getPoint().
//   phaseSlot  (Amount) — position along the perimeter [0, 1]
//
// Output:
//   Point — the canvas coordinate at the current phase on the shape

const ACCENT  = '#cf7ecf'   // purple, distinct from shape amber
const RING_R  = 10
const DOT_R   = 3

export class AnimPathLayer extends Layer implements PointSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Point])

  readonly shapeSlot: ParameterSlot
  readonly phaseSlot: ParameterSlot

  private _phase:        number = 0
  private _currentPoint: Point

  constructor(cx: number, cy: number) {
    super()
    this._currentPoint = { x: cx, y: cy }

    this.shapeSlot = new ParameterSlot(ValueType.Point,  this, 'shape')
    this.phaseSlot = new ParameterSlot(ValueType.Amount, this, 'phase')
    this.slots.push(this.shapeSlot, this.phaseSlot)

    graph.register(this)
  }

  // PointSource
  getPoint(): Point { return { ...this._currentPoint } }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this.phaseSlot.isActive) {
      this._phase = (this.phaseSlot.source as AmountSource).getAmount() as Amount
    }
    if (this.shapeSlot.isActive) {
      const src = this.shapeSlot.source as Record<string, unknown>
      if (typeof src['samplePerimeter'] === 'function') {
        // Shape layer — sample the perimeter at the current phase.
        this._currentPoint = (src['samplePerimeter'] as (t: number) => Point)(this._phase)
      } else {
        // Generic point source — just use its current output.
        this._currentPoint = (this.shapeSlot.source as PointSource).getPoint()
      }
    }
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    const { x, y } = this._currentPoint
    ctx.save()
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
    this._drawPill(ctx, { x: 300, y: 50, width: 260, height: this.bounds.height })
  }

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
    ctx.fillStyle    = 'rgba(255,255,255,0.80)'
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
