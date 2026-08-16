import { TextLayer } from './TextLayer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  type ImageValue, type ImageSource,
  type Ctx2D,
} from '../core/types.js'
import type { Layer } from '../core/Layer.js'
import { MaskLayer } from './MaskLayer.js'

// ------------------------------------------------------------
// ClipTextLayer — a TextLayer that renders a clipped image
// ------------------------------------------------------------
//
// Identical text content, typography controls and handles to TextLayer
// (all inherited unchanged) — but renders imageSlot's image clipped to a
// mask: the mask-tracker helper's fuller composited mask (own glyph
// silhouette ∪ any extra paint/shapes) when clipMaskSlot is bound to one,
// else this.getMask() (from TextLayer, just the bare glyph silhouette) —
// instead of filled, coloured text. See ClipRectLayer.ts for the read
// details (maskSlot.source, passive, not hiddenHelper — clipMaskSlot here).
//
// TextLayer already has a `maskSlot` (Mask) — its *input*, used to flow
// text inside a bound mask shape. That is a different, pre-existing
// feature and is kept unchanged (it still affects the glyph layout, and
// therefore the clip silhouette too). The mask-tracker-exposure slot
// added here is named `clipMaskSlot` to avoid colliding with it.
//
// clipMaskSlot also exists so the slot row can be bound to a hidden
// mask-tracker helper in the first place — main.ts's postInsertLayer binds
// this layer into the helper's own clipRegionSlot, a feedback slot, see
// MaskLayer.ts — making that helper exposable via the standard "click a
// bound slot whose source is a hidden helper" gesture.

export class ClipTextLayer extends TextLayer implements ImageSource {
  readonly imageSlot:    ParameterSlot
  readonly clipMaskSlot: ParameterSlot

  private _offscreen: OffscreenCanvas

  constructor() {
    super('Text')
    this._offscreen = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)

    this.imageSlot    = new ParameterSlot(ValueType.Image, this, 'image')
    // feedback — see ClipRectLayer's constructor comment.
    this.clipMaskSlot = new ParameterSlot(ValueType.Mask,  this, 'clip mask', true)
    this.slots.push(this.imageSlot, this.clipMaskSlot)

    this.debugName = 'ClipText'
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

        // Read via clipMaskSlot.source (persists past exposure), passive (no
        // forced evaluate()) — see ClipRectLayer.recompute() for why.
        const helper = this.clipMaskSlot.isActive && this.clipMaskSlot.source instanceof MaskLayer ? this.clipMaskSlot.source : null
        const mask = helper?.getMask() ?? this.getMask()
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

  override renderPanel(ctx: Ctx2D): void {
    if (this.imageSlot.isActive) {
      const src = (this.imageSlot.source as ImageSource).getImage()
      if (src !== null) {
        ctx.save()
        ctx.globalAlpha = 0.4
        // Native size — see ClipRectLayer.renderPanel for why this must not
        // use Node.canvasWidth/Height as the destination size.
        ctx.drawImage(src, 0, 0)
        ctx.restore()
        ctx.save()
        ctx.shadowColor   = 'rgba(0,0,0,0.75)'
        ctx.shadowBlur    = 18
        ctx.shadowOffsetX = 0
        ctx.shadowOffsetY = 3
        ctx.drawImage(this._offscreen, 0, 0)
        ctx.restore()
      }
    }
    super.renderPanel(ctx)
  }

  override renderSelf(ctx: Ctx2D): void {
    ctx.drawImage(this._offscreen, 0, 0)
  }
}
