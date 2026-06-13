import { EllipseLayer } from './EllipseLayer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  type ImageValue, type ImageSource,
  type Ctx2D,
} from '../core/types.js'
import type { Layer } from '../core/Layer.js'
import type { MaskLayer } from './MaskLayer.js'

// ------------------------------------------------------------
// ClipEllipseLayer — an EllipseLayer that renders a clipped image
// ------------------------------------------------------------
//
// Identical geometry, handles and panel to EllipseLayer (all inherited
// unchanged) — but renders imageSlot's image clipped to its own
// ellipse shape (this.getMask(), from ShapeLayer) instead of a
// filled ellipse.
//
// maskSlot is not read by recompute(): it exists only so the slot row
// can be bound to a hidden mask-tracker helper (see setMaskTracker),
// making that helper exposable via the standard "click a bound slot
// whose source is a hidden helper" gesture.

export class ClipEllipseLayer extends EllipseLayer implements ImageSource {
  readonly imageSlot: ParameterSlot
  readonly maskSlot:  ParameterSlot

  private _offscreen: OffscreenCanvas
  private _maskTracker: MaskLayer | null = null

  constructor() {
    super(Node.canvasWidth / 2, Node.canvasHeight / 2, Node.canvasWidth * 0.35, Node.canvasHeight * 0.3)
    this._offscreen = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)

    this.imageSlot = new ParameterSlot(ValueType.Image, this, 'image')
    this.maskSlot  = new ParameterSlot(ValueType.Mask,  this, 'mask')
    this.slots.push(this.imageSlot, this.maskSlot)

    this.debugName = 'ClipEllipse'
  }

  // Link a hidden Mask helper whose content should track this shape's
  // mask. The link persists for the helper's whole lifetime, even after
  // it is exposed (exposure only clears isHiddenHelper/helperHost).
  setMaskTracker(helper: MaskLayer): void {
    this._maskTracker = helper
    helper.trackedShape = this
  }

  override markDirty(): void {
    super.markDirty()
    this._maskTracker?.markDirty()
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  override getImage(): ImageValue { return this._offscreen }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected override recompute(): void {
    super.recompute()   // geometry, this._maskCanvas, rotationSlot, etc.

    const w = Node.canvasWidth
    const h = Node.canvasHeight
    if (this._offscreen.width !== w || this._offscreen.height !== h) {
      this._offscreen = new OffscreenCanvas(w, h)
    }

    const ctx = this._offscreen.getContext('2d')!
    ctx.clearRect(0, 0, w, h)

    if (this.imageSlot.isActive) {
      const image = (this.imageSlot.source as ImageSource).getImage()
      if (image !== null) {
        ctx.drawImage(image, 0, 0, w, h)

        const mask = this.getMask()
        if (mask !== null) {
          ctx.globalCompositeOperation = 'destination-in'
          ctx.drawImage(mask, 0, 0, w, h)
          ctx.globalCompositeOperation = 'source-over'
        }
      }
    }
  }

  override autoBindRules() {
    return [
      { slot: this.imageSlot, accepts: (l: Layer) => l.types.has(ValueType.Image) },
    ]
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  override renderSelf(ctx: Ctx2D): void {
    ctx.drawImage(this._offscreen, 0, 0)
  }
}
