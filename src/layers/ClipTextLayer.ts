import { TextLayer } from './TextLayer.js'
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
// ClipTextLayer — a TextLayer that renders a clipped image
// ------------------------------------------------------------
//
// Identical text content, typography controls and handles to TextLayer
// (all inherited unchanged) — but renders imageSlot's image clipped to
// the text's own glyph silhouette (this.getMask(), from TextLayer)
// instead of filled, coloured text.
//
// TextLayer already has a `maskSlot` (Mask) — its *input*, used to flow
// text inside a bound mask shape. That is a different, pre-existing
// feature and is kept unchanged (it still affects the glyph layout, and
// therefore the clip silhouette too). The mask-tracker-exposure slot
// added here is named `clipMaskSlot` to avoid colliding with it.
//
// clipMaskSlot is not read by recompute(): it exists only so the slot row
// can be bound to a hidden mask-tracker helper (see setMaskTracker),
// making that helper exposable via the standard "click a bound slot
// whose source is a hidden helper" gesture.

export class ClipTextLayer extends TextLayer implements ImageSource {
  readonly imageSlot:    ParameterSlot
  readonly clipMaskSlot: ParameterSlot

  private _offscreen: OffscreenCanvas
  private _maskTracker: MaskLayer | null = null

  constructor() {
    super('Text')
    this._offscreen = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)

    this.imageSlot    = new ParameterSlot(ValueType.Image, this, 'image')
    this.clipMaskSlot = new ParameterSlot(ValueType.Mask,  this, 'clip mask')
    this.slots.push(this.imageSlot, this.clipMaskSlot)

    this.debugName = 'ClipText'
  }

  // Link a hidden Mask helper whose content should track this layer's
  // glyph-silhouette mask. The link persists for the helper's whole
  // lifetime, even after it is exposed (exposure only clears
  // isHiddenHelper/helperHost).
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

  getImage(): ImageValue { return this._offscreen }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected override recompute(): void {
    super.recompute()   // text layout, this._maskCanvas (glyph silhouette), etc.

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
