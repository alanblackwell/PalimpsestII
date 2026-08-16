import { PathLayer } from './PathLayer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  type ImageValue, type ImageSource,
  type Point, type Colour, type Ctx2D,
} from '../core/types.js'
import type { Layer } from '../core/Layer.js'
import { MaskLayer } from './MaskLayer.js'
import { moveButtonHitTest, renderMoveButton } from './ClipMoveButton.js'
import { detectContour } from './contourTrace.js'

const INIT_PTS = 10

// ------------------------------------------------------------
// ClipPathLayer — a PathLayer that renders a clipped image
// ------------------------------------------------------------
//
// Identical geometry, handles and panel to PathLayer (all inherited
// unchanged) — but renders imageSlot's image clipped to a mask: the
// mask-tracker helper's fuller composited mask (own shape ∪ any extra
// paint/shapes) when maskSlot is bound to one, else this.getMask() (from
// ShapeLayer, just the bare spline outline) — instead of a filled spline.
// See ClipRectLayer.ts for the read details (maskSlot.source, passive, not
// hiddenHelper).
//
// maskSlot also exists so the slot row can be bound to a hidden
// mask-tracker helper in the first place — main.ts's postInsertLayer binds
// this shape into the helper's own clipRegionSlot, a feedback slot, see
// MaskLayer.ts — making that helper exposable via the standard "click a
// bound slot whose source is a hidden helper" gesture.

export class ClipPathLayer extends PathLayer implements ImageSource {
  readonly imageSlot: ParameterSlot
  readonly maskSlot:  ParameterSlot

  private _offscreen:       OffscreenCanvas
  private _pathInitialized: boolean = false
  private _addMoveDone = false
  private _onAddMove: (() => void) | null = null

  constructor(points?: Point[], colour?: Colour) {
    // Centred on the *viewport*, not the grow-only canvas — see
    // ClipRectLayer's constructor comment.
    super(points, Node.viewportWidth / 2, Node.viewportHeight / 2, colour)
    if (points !== undefined && points.length >= 3) this._pathInitialized = true
    this._offscreen = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)

    this.imageSlot = new ParameterSlot(ValueType.Image, this, 'image')
    // feedback — see ClipRectLayer's constructor comment.
    this.maskSlot  = new ParameterSlot(ValueType.Mask,  this, 'mask', true)
    this.slots.push(this.imageSlot, this.maskSlot)

    this.debugName = 'ClipPath'
    this._showAnimateButton = false
    this._showMaskButton    = false
    this._showPointButton   = false
  }

  setOnAddMove(fn: () => void): void { this._onAddMove = fn }

  override renderOverlay(ctx: Ctx2D): void {
    super.renderOverlay(ctx)
    renderMoveButton(ctx, this._addMoveDone)
  }

  protected override hitTestSelf(point: Point): this | null {
    if (moveButtonHitTest(point, this._addMoveDone)) return this
    return super.hitTestSelf(point)
  }

  handlePointerDown(point: Point): boolean {
    if (moveButtonHitTest(point, this._addMoveDone)) {
      this._onAddMove?.()
      this._addMoveDone = true
      return true
    }
    return super.handlePointerDown(point)
  }

  override serializeState(): Record<string, unknown> {
    return { ...super.serializeState(), addMoveDone: this._addMoveDone, pathInitialized: this._pathInitialized }
  }

  override deserializeState(state: Record<string, unknown>): void {
    super.deserializeState(state)
    if (typeof state.addMoveDone === 'boolean') this._addMoveDone = state.addMoveDone
    // A loaded save already carries its (possibly hand-edited) points —
    // without this, the one-shot contour trace in recompute() would fire
    // again on the first frame after load and silently discard them.
    if (typeof state.pathInitialized === 'boolean') this._pathInitialized = state.pathInitialized
    else if (Array.isArray(state.points) && state.points.length >= 3) this._pathInitialized = true
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  override getImage(): ImageValue { return this._offscreen }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected override recompute(): void {
    // One-shot: trace the image contour to replace the default random points.
    if (!this._pathInitialized && this.imageSlot.isActive) {
      const img = (this.imageSlot.source as ImageSource).getImage()
      if (img !== null) {
        const pts = detectContour(img as OffscreenCanvas, null, INIT_PTS)
        if (pts !== null) this._points = pts
        this._pathInitialized = true
      }
    }

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

        // Read via maskSlot.source (persists past exposure), passive (no
        // forced evaluate()) — see ClipRectLayer.recompute() for why.
        const helper = this.maskSlot.isActive && this.maskSlot.source instanceof MaskLayer ? this.maskSlot.source : null
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
