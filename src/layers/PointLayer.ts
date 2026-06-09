import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import { ValueType, type Point, type PointSource, type Ctx2D } from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { DraggablePointRegion, registerPromotionFactory } from '../regions/DraggablePointRegion.js'

// ------------------------------------------------------------
// PointLayer — a layer that holds and exposes a Point value
// ------------------------------------------------------------
//
// Two operating modes:
//
//   Unbound — the handle is freely draggable anywhere on the canvas.
//
//   Bound   — the handle is driven by a source layer (the slot);
//             the handle position is read-only.
//
// Rendering has two components:
//
//   1. A compact label bar drawn at this.bounds, positioned in the
//      stack panel, showing the current (x, y) coordinates.
//
//   2. The draggable handle (crosshair circle) drawn at the point
//      value itself — which can be anywhere on the canvas.
//
// Hit-testing delegates entirely to the handle's 32×32 hit zone,
// not to the label bar.  Users grab the handle, not the label.

registerPromotionFactory((initial: Point) => new PointLayer(initial))

// Accent colour for the Point type.
const ACCENT = '#cf7ecf'

export class PointLayer extends Layer implements PointSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Point])

  private readonly _slot:   ParameterSlot
  private readonly _region: DraggablePointRegion
  private _point: Point

  constructor(initial: Point = { x: 200, y: 200 }) {
    super()
    this._point  = { ...initial }
    this._slot   = new ParameterSlot(ValueType.Point, this)
    this._region = new DraggablePointRegion(this, initial)
    this.slots.push(this._slot)
    this.debugName = 'PointLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // PointSource
  // ----------------------------------------------------------

  getPoint(): Point { return { ...this._point } }

  // ----------------------------------------------------------
  // Value
  // ----------------------------------------------------------

  // Called by the embedded DraggablePointRegion when the user drags.
  setPoint(p: Point): void {
    this._point = { ...p }
    this.markDirty()
  }

  get slot(): ParameterSlot { return this._slot }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this._slot.isActive) {
      const src = this._slot.source as PointSource
      this._point = src.getPoint()
      this._region.setPoint(this._point)
      this._region.interactive = false
    } else {
      this._region.interactive = true
      // Reflect the region's current dragged position.
      this._point = this._region.point
      this._region.setPoint(this._point)
    }
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.bounds

    // ── Label bar (stack panel) ────────────────────────────
    if (width > 0 && height > 0) {
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

      // Coordinate label
      const px = Math.round(this._point.x)
      const py = Math.round(this._point.y)
      ctx.font         = '11px monospace'
      ctx.fillStyle    = this._slot.isActive
        ? 'rgba(255,255,255,0.55)'
        : 'rgba(255,255,255,0.80)'
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(`(${px}, ${py})`, x + 12, y + height / 2)

      ctx.restore()
    }

    // ── Draggable handle (anywhere on canvas) ─────────────
    this._region.renderSelf(ctx)
  }

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  // Delegates to the handle's hit-test zone, not the label bar.
  protected override hitTestSelf(point: Point) {
    return this._region.hitTest(point)
  }
}
