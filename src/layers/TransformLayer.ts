import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type ImageValue,    type ImageSource,
  type Amount,        type AmountSource,
  type Point,         type PointSource,
  type Direction,     type DirectionSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// TransformLayer — 2-D affine transform applied to an image
// ------------------------------------------------------------
//
// Takes an ImageSource and applies translate + rotate + scale,
// outputting a transformed image on an OffscreenCanvas.
//
// Input slots:
//   sourceSlot    (Image)     — image to transform.
//                              Unbound: empty output.
//   positionSlot  (Point)     — translation (pivot on canvas).
//                              Unbound default: canvas centre.
//   directionSlot (Direction) — angle → rotation; magnitude → scale
//                              where scale = magnitude × 2.0, so
//                              neutral magnitude 0.5 → scale 1.0.
//                              Unbound defaults: angle=0, magnitude=0.5.
//   opacitySlot   (Amount)    — global alpha [0, 1].
//                              Unbound default: 1.0.
//
// Visual layout (height ≈ 36 px):
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌  ∠ 45°  × 1.00  (320, 240)    src ○  pos ○  dir ○  op ○ │
//   └──────────────────────────────────────────────────────────┘
//
// Call resize(w, h) when the canvas dimensions change.

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ACCENT = '#e09840'   // warm amber-orange

const DEFAULT_DIR: Direction = { angle: 0, magnitude: 0.5 }
const DEFAULT_OPACITY        = 1.0

// ------------------------------------------------------------------
// TransformLayer
// ------------------------------------------------------------------

export class TransformLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private readonly _sourceSlot:    ParameterSlot
  private readonly _positionSlot:  ParameterSlot
  private readonly _directionSlot: ParameterSlot
  private readonly _opacitySlot:   ParameterSlot

  private _offscreen: OffscreenCanvas

  constructor(canvasWidth = 1920, canvasHeight = 1080) {
    super()
    this._offscreen      = new OffscreenCanvas(canvasWidth, canvasHeight)
    this._sourceSlot     = new ParameterSlot(ValueType.Image,     this)
    this._positionSlot   = new ParameterSlot(ValueType.Point,     this)
    this._directionSlot  = new ParameterSlot(ValueType.Direction, this)
    this._opacitySlot    = new ParameterSlot(ValueType.Amount,    this)
    this.slots.push(this._sourceSlot, this._positionSlot,
                    this._directionSlot, this._opacitySlot)
    this.debugName = 'TransformLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._offscreen }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get sourceSlot():    ParameterSlot { return this._sourceSlot    }
  get positionSlot():  ParameterSlot { return this._positionSlot  }
  get directionSlot(): ParameterSlot { return this._directionSlot }
  get opacitySlot():   ParameterSlot { return this._opacitySlot   }

  // ----------------------------------------------------------
  // Resize
  // ----------------------------------------------------------

  resize(w: number, h: number): void {
    this._offscreen = new OffscreenCanvas(w, h)
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    const w = this._offscreen.width
    const h = this._offscreen.height

    const src: ImageValue = this._sourceSlot.isActive
      ? (this._sourceSlot.source as ImageSource).getImage()
      : null

    const pos: Point = this._positionSlot.isActive
      ? (this._positionSlot.source as PointSource).getPoint()
      : { x: w / 2, y: h / 2 }

    const dir: Direction = this._directionSlot.isActive
      ? (this._directionSlot.source as DirectionSource).getDirection()
      : DEFAULT_DIR

    const opacity: number = this._opacitySlot.isActive
      ? (this._opacitySlot.source as AmountSource).getAmount() as Amount
      : DEFAULT_OPACITY

    const scale = dir.magnitude * 2.0

    const ctx = this._offscreen.getContext('2d')! as unknown as CanvasRenderingContext2D
    ctx.clearRect(0, 0, w, h)

    if (src != null) {
      const sw = src instanceof OffscreenCanvas ? src.width  : (src as ImageBitmap).width
      const sh = src instanceof OffscreenCanvas ? src.height : (src as ImageBitmap).height

      ctx.save()
      ctx.globalAlpha = Math.max(0, Math.min(1, opacity))
      ctx.translate(pos.x, pos.y)
      ctx.rotate(dir.angle)
      ctx.scale(scale, scale)
      ctx.drawImage(src as CanvasImageSource, -sw / 2, -sh / 2, sw, sh)
      ctx.restore()
    }
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  protected override hitTestSelf(point: { x: number; y: number }) {
    return boundingBoxContains(this.bounds, point) ? this : null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    ctx.save()
    ctx.drawImage(this._offscreen as CanvasImageSource, 0, 0)
    ctx.restore()
  }

  // ── Stack panel ─────────────────────────────────────────────

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.bounds
    if (width <= 0 || height <= 0) return

    const midY = y + height / 2

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // Resolve current values for display
    const w = this._offscreen.width
    const h = this._offscreen.height

    const pos: Point = this._positionSlot.isActive
      ? (this._positionSlot.source as PointSource).getPoint()
      : { x: w / 2, y: h / 2 }

    const dir: Direction = this._directionSlot.isActive
      ? (this._directionSlot.source as DirectionSource).getDirection()
      : DEFAULT_DIR

    const scale = dir.magnitude * 2.0
    const angleDeg = Math.round(dir.angle * 180 / Math.PI)

    // Transform readout
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.85)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    const readout = `∠ ${angleDeg}°  × ${scale.toFixed(2)}  (${Math.round(pos.x)}, ${Math.round(pos.y)})`
    ctx.fillText(readout, x + 12, midY)

    // Slot indicators (right side)
    const slots = [
      { slot: this._sourceSlot,    label: 'src' },
      { slot: this._positionSlot,  label: 'pos' },
      { slot: this._directionSlot, label: 'dir' },
      { slot: this._opacitySlot,   label: 'op'  },
    ]
    let dx = x + width - 6
    ctx.font = '9px monospace'
    for (let i = slots.length - 1; i >= 0; i--) {
      const entry = slots[i]; if (!entry) continue
      const { slot, label } = entry
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

    ctx.restore()
  }
}
