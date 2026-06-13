import { MaskLayer } from './MaskLayer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  type ImageValue, type ImageSource,
  type Ctx2D,
} from '../core/types.js'
import type { Layer } from '../core/Layer.js'

// ------------------------------------------------------------
// ClipDrawingLayer — a MaskLayer that renders a clipped image
// ------------------------------------------------------------
//
// Identical controls to MaskLayer (all inherited unchanged) — shape slots,
// freehand paint/erase tools, brush slider, mask overlay visualisation —
// but renders imageSlot's image clipped to its own painted/composited mask
// (this.getMask(), from MaskLayer) instead of just showing the mask.
//
// maskSlot is not read by recompute(): it exists only so the slot row can
// be bound to a hidden mask-tracker helper (see setMaskTracker), making
// that helper exposable via the standard "click a bound slot whose source
// is a hidden helper" gesture — same as ClipRectLayer etc. Here the helper
// is somewhat redundant (this layer already has its own paint tools), but
// it keeps the pattern consistent and gives an exposable copy of the
// composited mask.

export class ClipDrawingLayer extends MaskLayer implements ImageSource {
  override readonly types: ReadonlySet<ValueType> = new Set([ValueType.Mask, ValueType.Image])

  readonly imageSlot: ParameterSlot
  readonly maskSlot:  ParameterSlot

  private _clippedImage: OffscreenCanvas
  private _maskTracker: MaskLayer | null = null

  constructor() {
    super()
    this._clippedImage = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)

    this.imageSlot = new ParameterSlot(ValueType.Image, this, 'image')
    this.maskSlot  = new ParameterSlot(ValueType.Mask,  this, 'mask')
    this.slots.push(this.imageSlot, this.maskSlot)

    this.debugName = 'ClipDrawing'
  }

  // Link a hidden Mask helper whose content should track this layer's own
  // composited mask. The link persists for the helper's whole lifetime,
  // even after it is exposed (exposure only clears isHiddenHelper/helperHost).
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

  getImage(): ImageValue { return this._clippedImage }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected override recompute(): void {
    super.recompute()   // this._offscreen (the composited mask), via MaskLayer

    const w = Node.canvasWidth
    const h = Node.canvasHeight
    if (this._clippedImage.width !== w || this._clippedImage.height !== h) {
      this._clippedImage = new OffscreenCanvas(w, h)
    }

    const ctx = this._clippedImage.getContext('2d')!
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
      ...super.autoBindRules(),
      { slot: this.imageSlot, accepts: (l: Layer) => l.types.has(ValueType.Image) },
    ]
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  override renderSelf(ctx: Ctx2D): void {
    ctx.drawImage(this._clippedImage, 0, 0)
  }
}
