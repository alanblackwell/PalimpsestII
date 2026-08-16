import { RectLayer } from './RectLayer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  type ImageValue, type ImageSource,
  type Point, type Ctx2D,
} from '../core/types.js'
import type { Layer } from '../core/Layer.js'
import { MaskLayer } from './MaskLayer.js'
import { contentLeft } from '../interaction/layout.js'

// ------------------------------------------------------------
// Move-button constants (Track moved to VideoLayer)
// ------------------------------------------------------------

const BTN_H   = 30
const BTN_GAP = 14
const MOVE_W  = 60
const MOVE_COL = '#7ecf7e'   // Image accent

type BtnPos = { x: number; y: number }

function moveBtnLayout(
  viewportW: number, viewportH: number, canvasW: number,
): BtnPos {
  const left = contentLeft(canvasW)
  const x    = left + Math.max(0, (viewportW - left - MOVE_W) / 2)
  const y    = viewportH - BTN_H - BTN_GAP
  return { x, y }
}

function renderClipBtn(ctx: Ctx2D, x: number, y: number, w: number, label: string, col: string): void {
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.beginPath(); ctx.roundRect(x, y, w, BTN_H, 5); ctx.fill()
  ctx.fillStyle = col + 'cc'
  ctx.beginPath(); ctx.roundRect(x, y, 3, BTN_H, [5, 0, 0, 5]); ctx.fill()
  ctx.save()
  ctx.beginPath(); ctx.rect(x, y, w, BTN_H); ctx.clip()
  ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = '11px monospace'
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  ctx.fillText(label, x + 10, y + BTN_H / 2)
  ctx.restore(); ctx.restore()
}

// ------------------------------------------------------------
// ClipRectLayer — a RectLayer that renders a clipped image
// ------------------------------------------------------------
//
// Identical geometry, handles and panel to RectLayer (all inherited
// unchanged) — but renders imageSlot's image clipped to a mask: the
// mask-tracker helper's fuller composited mask (own shape ∪ any extra
// paint/shapes) when maskSlot is bound to one, else this.getMask() (from
// ShapeLayer, just the bare rectangle outline) — instead of a filled
// rectangle. See recompute() for the read (via maskSlot.source directly,
// not hiddenHelper, which is cleared once the helper is exposed — and
// deliberately passive, no forced evaluate()).
//
// maskSlot also exists so the slot row can be bound to a hidden
// mask-tracker helper in the first place — main.ts's postInsertLayer binds
// this shape into the helper's own clipRegionSlot, a feedback slot, see
// MaskLayer.ts — making that helper exposable via the standard "click a
// bound slot whose source is a hidden helper" gesture.

export class ClipRectLayer extends RectLayer implements ImageSource {
  readonly imageSlot: ParameterSlot
  readonly maskSlot:  ParameterSlot

  private _offscreen: OffscreenCanvas
  private _addMoveDone = false
  private _onAddMove: (() => void) | null = null

  constructor() {
    // Centred on the *viewport*, not the grow-only canvas — matches
    // ImageLayer's own default position and the plain RectLayer factory in
    // MenuLayer, so a freshly created clip shape lines up with a freshly
    // created image even when canvasWidth/Height has grown past the
    // current window size (see spec notes on the grow-only canvas).
    super(Node.viewportWidth / 2, Node.viewportHeight / 2, Node.viewportWidth * 0.35, Node.viewportHeight * 0.3)
    this._offscreen = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)

    this.imageSlot = new ParameterSlot(ValueType.Image, this, 'image')
    // feedback: never read by recompute() (see class comment) — marking it
    // feedback stops Node.evaluate()'s eager pull from evaluating maskHelper
    // every time this layer evaluates, which would otherwise re-enter
    // maskHelper's own recompute() (it pulls this layer back via
    // clipRegionSlot) while that recompute() is still running.
    this.maskSlot  = new ParameterSlot(ValueType.Mask,  this, 'mask', true)
    this.slots.push(this.imageSlot, this.maskSlot)

    this.debugName = 'ClipRect'
    this._showAnimateButton = false
    this._showMaskButton    = false
    this._showPointButton   = false
  }

  setOnAddMove(fn: () => void): void { this._onAddMove = fn }

  override renderOverlay(ctx: Ctx2D): void {
    super.renderOverlay(ctx)
    if (!this._addMoveDone) {
      const { x, y } = moveBtnLayout(Node.viewportWidth, Node.viewportHeight, Node.canvasWidth)
      renderClipBtn(ctx, x, y, MOVE_W, 'Move', MOVE_COL)
    }
  }

  protected override hitTestSelf(point: Point): this | null {
    if (!this._addMoveDone) {
      const { x, y } = moveBtnLayout(Node.viewportWidth, Node.viewportHeight, Node.canvasWidth)
      if (point.x >= x && point.x <= x + MOVE_W && point.y >= y && point.y <= y + BTN_H) return this
    }
    return super.hitTestSelf(point)
  }

  handlePointerDown(point: Point): boolean {
    if (!this._addMoveDone) {
      const { x, y } = moveBtnLayout(Node.viewportWidth, Node.viewportHeight, Node.canvasWidth)
      if (point.x >= x && point.x <= x + MOVE_W && point.y >= y && point.y <= y + BTN_H) {
        this._onAddMove?.()
        this._addMoveDone = true
        return true
      }
    }
    return super.handlePointerDown(point)
  }

  override serializeState(): Record<string, unknown> {
    return { ...super.serializeState(), addMoveDone: this._addMoveDone }
  }

  override deserializeState(state: Record<string, unknown>): void {
    super.deserializeState(state)
    if (typeof state.addMoveDone === 'boolean') this._addMoveDone = state.addMoveDone
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  override getImage(): ImageValue { return this._offscreen }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected override recompute(): void {
    super.recompute()

    const w = Node.canvasWidth, h = Node.canvasHeight
    if (this._offscreen.width !== w || this._offscreen.height !== h)
      this._offscreen = new OffscreenCanvas(w, h)

    const ctx = this._offscreen.getContext('2d')!
    ctx.clearRect(0, 0, w, h)

    if (this.imageSlot.isActive) {
      const image = (this.imageSlot.source as ImageSource).getImage()
      if (image !== null) {
        ctx.drawImage(image, 0, 0, w, h)
        // Prefer the mask-tracker helper's full composited mask (own shape
        // ∪ any extra paint/shapes the user added) over the bare shape
        // outline, so painting on the helper actually affects the clip.
        // Read via maskSlot.source, not hiddenHelper — hiddenHelper/
        // helperHost are cleared the moment the helper is exposed (the
        // whole point of exposing it is to paint on it), but maskSlot's
        // binding persists for the helper's whole lifetime regardless.
        // Deliberately a passive read (no forced evaluate()) — the helper's
        // own recompute() also reads this layer's mask passively (see
        // MaskLayer.recompute()'s clipRegionSlot handling), so forcing
        // either side would race the other's still-in-progress recompute()
        // within the same frame. Passive on both sides settles to correct
        // output within about one frame via ordinary dirty propagation,
        // imperceptible during a live drag; the one gap this leaves — a
        // brand-new pair where neither side has ever evaluated — is handled
        // once, at creation/load time, by settleMaskTrackerPair
        // (MaskLayer.ts).
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
    return [{ slot: this.imageSlot, accepts: (l: Layer) => l.types.has(ValueType.Image) }]
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
        // Native size, not Node.canvasWidth/Height as the destination — src
        // is already canvas-sized, and on the desktop-pills render path
        // (Evaluator.render()) Node.canvasWidth is temporarily overridden to
        // the viewport width while renderPanel runs, which would otherwise
        // stretch this guide image out of alignment with this._offscreen
        // (drawn below at native size) and the actual clip output.
        ctx.drawImage(src, 0, 0)
        ctx.restore()
        ctx.save()
        ctx.shadowColor = 'rgba(0,0,0,0.75)'; ctx.shadowBlur = 18
        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 3
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
