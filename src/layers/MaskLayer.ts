import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type MaskValue, type MaskSource,
  type Point,    type PointSource,
  type Amount,   type AmountSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// MaskLayer — procedural mask generator
// ------------------------------------------------------------
//
// Produces a greyscale OffscreenCanvas (white = included,
// black = excluded) in one of three shapes:
//
//   rect    — axis-aligned rectangle with optional feathered edge
//   ellipse — filled ellipse with optional feathered edge
//   radial  — radial gradient, white at centre fading to black
//
// Shape is cycled with [◀] / [▶] or by clicking the label.
// A [↺] button resets all manual overrides to defaults.
//
// Input slots:
//   positionSlot  (Point)  — centre of the mask shape on-canvas.
//                            Unbound default: canvas centre.
//   sizeSlot      (Amount) — maps [0, 1] → [MIN_PX, MAX_PX] px radius.
//                            Unbound default: DEFAULT_SIZE px.
//   softnessSlot  (Amount) — feather width in px [0, MAX_SOFT].
//                            Unbound default: 20 px.
//
// Canvas resize:
//   Call resize(w, h) when the backing canvas changes dimensions.
//   The OffscreenCanvas is recreated and the mask is redrawn.
//
// Visual layout of the stack panel (height ≈ 36 px):
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌  [◀] ellipse [▶]    pos ●  sz ●  soft ○       [↺]   │
//   └──────────────────────────────────────────────────────────┘
//
// On-canvas preview: the mask boundary is drawn as a dashed stroke
// in the Mask accent colour, so the shape is visible without
// occluding image content.

const ACCENT      = '#cfcf7e'   // Mask type colour
const MIN_PX      = 20
const MAX_PX      = 600
const DEFAULT_SIZE = 200
const MAX_SOFT    = 120
const DEFAULT_SOFT = 20

// Button / zone geometry
const BTN_W   = 18
const BTN_H   = 22
const SHAPE_W = 68
const BTN_M   = 6
const BTN_S   = 20

type ShapeId = 'rect' | 'ellipse' | 'radial'
const SHAPES: ShapeId[] = ['rect', 'ellipse', 'radial']

export class MaskLayer extends Layer implements MaskSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Mask])

  private readonly _positionSlot: ParameterSlot
  private readonly _sizeSlot:     ParameterSlot
  private readonly _softnessSlot: ParameterSlot

  private _shapeIndex: number = 1   // default: ellipse
  private _offscreen:  OffscreenCanvas

  // Resolved values
  private _position: Point  = { x: 400, y: 300 }
  private _size:     number = DEFAULT_SIZE
  private _soft:     number = DEFAULT_SOFT

  constructor(canvasWidth = 1920, canvasHeight = 1080) {
    super()
    this._offscreen    = new OffscreenCanvas(canvasWidth, canvasHeight)
    this._positionSlot = new ParameterSlot(ValueType.Point,  this)
    this._sizeSlot     = new ParameterSlot(ValueType.Amount, this)
    this._softnessSlot = new ParameterSlot(ValueType.Amount, this)
    this.slots.push(this._positionSlot, this._sizeSlot, this._softnessSlot)
    this.debugName = 'MaskLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // MaskSource
  // ----------------------------------------------------------

  getMask(): MaskValue { return this._offscreen }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get positionSlot(): ParameterSlot { return this._positionSlot }
  get sizeSlot():     ParameterSlot { return this._sizeSlot     }
  get softnessSlot(): ParameterSlot { return this._softnessSlot }

  // ----------------------------------------------------------
  // Shape cycling
  // ----------------------------------------------------------

  cycleNext(): void {
    this._shapeIndex = (this._shapeIndex + 1) % SHAPES.length
    this.markDirty()
  }

  cyclePrev(): void {
    this._shapeIndex = (this._shapeIndex - 1 + SHAPES.length) % SHAPES.length
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Resize — call when the backing canvas dimensions change
  // ----------------------------------------------------------

  resize(w: number, h: number): void {
    this._offscreen = new OffscreenCanvas(w, h)
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    this._position = this._positionSlot.isActive
      ? (this._positionSlot.source as PointSource).getPoint()
      : { x: this._offscreen.width / 2, y: this._offscreen.height / 2 }

    this._size = this._sizeSlot.isActive
      ? MIN_PX + (this._sizeSlot.source as AmountSource).getAmount() as Amount * (MAX_PX - MIN_PX)
      : DEFAULT_SIZE

    this._soft = this._softnessSlot.isActive
      ? (this._softnessSlot.source as AmountSource).getAmount() as Amount * MAX_SOFT
      : DEFAULT_SOFT

    this._drawMask()
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._prevBtnBounds(), point)) { this.cyclePrev(); return true }
    if (boundingBoxContains(this._nextBtnBounds(), point)) { this.cycleNext(); return true }
    if (boundingBoxContains(this._shapeLabelBounds(), point)) { this.cycleNext(); return true }
    if (boundingBoxContains(this._resetBtnBounds(), point)) {
      // Reset to defaults — clear slots' manual state by just dirtying
      this._size = DEFAULT_SIZE
      this._soft = DEFAULT_SOFT
      this.markDirty()
      return true
    }
    return false
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    return boundingBoxContains(this.bounds, point) ? this : null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    this._renderPreview(ctx)
  }

  renderPanel(ctx: Ctx2D): void {
    this._renderPanelImpl(ctx)
  }

  // ── Stack panel ─────────────────────────────────────────────

  private _renderPanelImpl(ctx: Ctx2D): void {
    const { x, y, width, height } = this.bounds
    if (width <= 0 || height <= 0) return

    const midY = y + height / 2

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

    // [◀] prev
    this._drawNavBtn(ctx, this._prevBtnBounds(), '◀', midY)

    // Shape label (click to cycle)
    const sb = this._shapeLabelBounds()
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(sb.x, sb.y, sb.width, sb.height, 3)
    ctx.fill()
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(SHAPES[this._shapeIndex], sb.x + sb.width / 2, midY)

    // [▶] next
    this._drawNavBtn(ctx, this._nextBtnBounds(), '▶', midY)

    // Slot indicators
    const resetB = this._resetBtnBounds()
    const slots  = [
      { slot: this._positionSlot, label: 'pos'  },
      { slot: this._sizeSlot,     label: 'sz'   },
      { slot: this._softnessSlot, label: 'soft' },
    ]
    let dx = resetB.x - 6
    ctx.font = '9px monospace'
    for (let i = slots.length - 1; i >= 0; i--) {
      const { slot, label } = slots[i]
      const active = slot.isActive
      ctx.fillStyle    = active ? ACCENT : 'rgba(255,255,255,0.22)'
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(active ? '●' : '○', dx, midY)
      dx -= 12
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText(label, dx, midY)
      dx -= ctx.measureText(label).width + 6
    }

    // [↺] reset button
    this._drawBtn(ctx, resetB, '↺', 'rgba(255,255,255,0.45)')

    ctx.restore()
  }

  // ── On-canvas preview — dashed boundary stroke ───────────────

  private _renderPreview(ctx: Ctx2D): void {
    const { x: cx, y: cy } = this._position
    const s    = this._shapeIndex
    const size = this._size

    ctx.save()
    ctx.strokeStyle = ACCENT
    ctx.lineWidth   = 1.5
    ctx.setLineDash([5, 4])
    ctx.globalAlpha = 0.70

    ctx.beginPath()
    if (SHAPES[s] === 'rect') {
      ctx.rect(cx - size, cy - size, size * 2, size * 2)
    } else {
      // ellipse and radial both preview as an ellipse outline
      ctx.ellipse(cx, cy, size, size * 0.65, 0, 0, Math.PI * 2)
    }
    ctx.stroke()

    // Centre cross-hair
    ctx.setLineDash([2, 3])
    ctx.lineWidth = 1
    ctx.globalAlpha = 0.40
    ctx.beginPath()
    ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy)
    ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10)
    ctx.stroke()

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Mask generation (draws into the OffscreenCanvas)
  // ----------------------------------------------------------

  private _drawMask(): void {
    const oc  = this._offscreen
    const ctx = oc.getContext('2d')!
    const w   = oc.width
    const h   = oc.height
    const { x: cx, y: cy } = this._position
    const size = this._size
    const soft = this._soft
    const shape = SHAPES[this._shapeIndex]

    ctx.clearRect(0, 0, w, h)

    if (shape === 'radial') {
      // Radial gradient: white at centre → black at edge
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size)
      grad.addColorStop(0,   'white')
      grad.addColorStop(soft > 0 ? Math.max(0, 1 - soft / size) : 1, 'white')
      grad.addColorStop(1,   'black')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)
    } else if (shape === 'rect') {
      if (soft <= 0) {
        ctx.fillStyle = 'white'
        ctx.fillRect(cx - size, cy - size, size * 2, size * 2)
      } else {
        // Feathered rect via radial gradient on each "strip" is complex;
        // use a simpler 2-pass approach: fill then blur-mask via shadow.
        ctx.fillStyle = 'white'
        ctx.shadowColor  = 'white'
        ctx.shadowBlur   = soft
        ctx.fillRect(cx - size + soft, cy - size + soft,
                     (size - soft) * 2, (size - soft) * 2)
        ctx.shadowBlur = 0
      }
    } else {
      // ellipse
      if (soft <= 0) {
        ctx.fillStyle = 'white'
        ctx.beginPath()
        ctx.ellipse(cx, cy, size, size * 0.65, 0, 0, Math.PI * 2)
        ctx.fill()
      } else {
        ctx.fillStyle   = 'white'
        ctx.shadowColor = 'white'
        ctx.shadowBlur  = soft
        ctx.beginPath()
        ctx.ellipse(cx, cy, Math.max(1, size - soft), Math.max(1, (size - soft) * 0.65), 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0
      }
    }
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _drawNavBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    midY: number,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 3)
    ctx.fill()
    ctx.font         = '9px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.55)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, midY)
  }

  private _drawBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    colour: string,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
    ctx.font         = '13px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }

  // Button / zone geometry

  private _prevBtnBounds() {
    const { x, y, height } = this.bounds
    return { x: x + 8, y: y + (height - BTN_H) / 2, width: BTN_W, height: BTN_H }
  }

  private _shapeLabelBounds() {
    const pb = this._prevBtnBounds()
    return { x: pb.x + BTN_W + 4, y: pb.y, width: SHAPE_W, height: BTN_H }
  }

  private _nextBtnBounds() {
    const sb = this._shapeLabelBounds()
    return { x: sb.x + SHAPE_W + 4, y: sb.y, width: BTN_W, height: BTN_H }
  }

  private _resetBtnBounds() {
    const { x, y, width, height } = this.bounds
    return { x: x + width - BTN_M - BTN_S, y: y + (height - BTN_S) / 2, width: BTN_S, height: BTN_S }
  }
}
