import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  type ImageValue, type ImageSource,
  type MaskSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// ClipLayer — clip an image to a mask region
// ------------------------------------------------------------
//
// Takes one image input and one mask input and outputs the image
// with all pixels outside the mask made transparent.
//
//   imageSlot (Image) — the content to clip (ImageLayer, ShapeLayer,
//                       CompositeLayer, or any ImageSource)
//   maskSlot  (Mask)  — defines which area is kept (MaskLayer or
//                       any MaskSource)
//
// The mask uses alpha to encode inclusion: opaque = keep,
// transparent = discard.  Clipping is applied with destination-in.
//
// If maskSlot is unbound the image is passed through unmodified.
// If imageSlot is unbound the output is transparent.

const ACCENT = '#7ecf7e'   // Image type colour

export class ClipLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private readonly _imageSlot: ParameterSlot
  private readonly _maskSlot:  ParameterSlot

  private _offscreen: OffscreenCanvas

  constructor() {
    super()
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    this._offscreen = new OffscreenCanvas(w, h)
    this._imageSlot = new ParameterSlot(ValueType.Image, this, 'image')
    this._maskSlot  = new ParameterSlot(ValueType.Mask,  this, 'mask')
    this.slots.push(this._imageSlot, this._maskSlot)
    this.debugName = 'ClipLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._offscreen }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    if (this._offscreen.width !== w || this._offscreen.height !== h) {
      this._offscreen = new OffscreenCanvas(w, h)
    }

    const ctx = this._offscreen.getContext('2d')!
    ctx.clearRect(0, 0, w, h)

    if (!this._imageSlot.isActive) return

    const image = (this._imageSlot.source as ImageSource).getImage()
    if (image === null) return

    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(image as CanvasImageSource, 0, 0, w, h)

    if (this._maskSlot.isActive) {
      const mask = (this._maskSlot.source as MaskSource).getMask()
      if (mask !== null) {
        // Keep only pixels where the mask is opaque (included).
        ctx.globalCompositeOperation = 'destination-in'
        ctx.drawImage(mask as CanvasImageSource, 0, 0, w, h)
        ctx.globalCompositeOperation = 'source-over'
      }
    }
  }

  override autoBindRules() {
    return [
      { slot: this._imageSlot, accepts: (l: Layer) => l.types.has(ValueType.Image), removeAfterBind: true },
      { slot: this._maskSlot,  accepts: (l: Layer) => l.types.has(ValueType.Mask),  removeAfterBind: true },
    ]
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
    const { x, y, width, height } = this.bounds
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

    ctx.fillStyle    = 'rgba(255,255,255,0.75)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Clip', x + 12, midY)

    // Slot indicators right-to-left
    const slots = [
      { slot: this._imageSlot, label: 'image' },
      { slot: this._maskSlot,  label: 'mask'  },
    ]
    let dx = x + width - 8
    ctx.font = '9px monospace'
    for (let i = slots.length - 1; i >= 0; i--) {
      const { slot, label } = slots[i]!
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
