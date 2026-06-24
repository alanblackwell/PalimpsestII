import { Layer } from '../core/Layer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type MaskValue,  type MaskSource,
  type Amount,     type AmountSource,
  type Direction,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { SliderRegion } from '../regions/SliderRegion.js'
import { BindingLayer } from './BindingLayer.js'

// ------------------------------------------------------------
// CompositeLayer — blends two images with an optional mask
// ------------------------------------------------------------
//
// Reads leftSlot and rightSlot (both Image), composites them using
// the selected blend mode at the given amount, and optionally
// constrains the blend to where maskSlot is white.
//
// The result is written to an internal OffscreenCanvas and returned
// from getImage() so downstream layers can consume it.  It is also
// drawn onto the main canvas (full-canvas blit) as the layer's
// visual output.
//
// Compositing pipeline:
//   1. Clear result canvas.
//   2. Draw left (if bound).
//   3. If mask is bound:
//        a. Draw right onto a temp canvas.
//        b. Apply mask to temp via `destination-in`.
//        c. Draw temp onto result with blend mode + amount.
//      Else:
//        c. Draw right directly onto result with blend mode + amount.
//
// Blend modes (13):
//   normal  multiply  screen  overlay
//   darken  lighten   add     difference
//   exclusion  hard-light  soft-light  color-burn  color-dodge
//
// Input slots:
//   leftSlot    (Image)  — background image
//   rightSlot   (Image)  — foreground image being composited
//   maskSlot    (Mask)   — white=right, black=left (optional)
//   opacitySlot (Amount) — blend amount [0, 1]; default 0.5
//
// A centre-of-canvas widget (panel-only, selected layer) shows small
// thumbnails of the left/right images at either end of a slider whose
// handle is "the amount" (opacitySlot when bound, otherwise a
// user-draggable value defaulting to 0.5 — same suspend-on-touch
// pattern as AmountLayer's slider). A button below the slider swaps
// the leftSlot/rightSlot bindings.
//
// Visual layout of the stack panel (height ≈ 36 px):
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌  [◀] multiply [▶]    left ●  right ●  mask ○  α ○    │
//   └──────────────────────────────────────────────────────────┘
//
// Call resize(w, h) when the canvas dimensions change.

// ------------------------------------------------------------------
// Blend mode table
// ------------------------------------------------------------------

interface BlendMode {
  readonly label: string
  readonly op:    GlobalCompositeOperation
}

const MODES: readonly BlendMode[] = [
  { label: 'normal',     op: 'source-over'  },
  { label: 'multiply',   op: 'multiply'     },
  { label: 'screen',     op: 'screen'       },
  { label: 'overlay',    op: 'overlay'      },
  { label: 'darken',     op: 'darken'       },
  { label: 'lighten',    op: 'lighten'      },
  { label: 'add',        op: 'lighter'      },
  { label: 'difference', op: 'difference'   },
  { label: 'exclusion',  op: 'exclusion'    },
  { label: 'hard-light', op: 'hard-light'   },
  { label: 'soft-light', op: 'soft-light'   },
  { label: 'burn',       op: 'color-burn'   },
  { label: 'dodge',      op: 'color-dodge'  },
]

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ACCENT  = '#7ecf7e'   // Image type colour
const BTN_W   = 18
const BTN_H   = 22
const LABEL_W = 72          // blend mode name zone

// Centre-of-canvas amount widget geometry
const WIDGET_PAD   = 12
const THUMB        = 48
const SLIDER_W     = 160
const SLIDER_H     = 24
const ROW_GAP      = 10
const SWAP_BTN_W   = 90
const SWAP_BTN_H   = 24

export class CompositeLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private readonly _leftSlot:    ParameterSlot
  private readonly _rightSlot:   ParameterSlot
  private readonly _maskSlot:    ParameterSlot
  private readonly _opacitySlot: ParameterSlot

  private _modeIndex: number = 0  // default: normal

  // "Amount" handle — used when opacitySlot is unbound. Default 0.5.
  private _amount: Amount = 0.5
  private readonly _slider: SliderRegion

  // Off-screen surfaces — recreated on resize()
  private _result: OffscreenCanvas
  private _temp:   OffscreenCanvas

  constructor(canvasWidth = 1920, canvasHeight = 1080) {
    super()
    this._result      = new OffscreenCanvas(canvasWidth, canvasHeight)
    this._temp        = new OffscreenCanvas(canvasWidth, canvasHeight)
    this._leftSlot    = new ParameterSlot(ValueType.Image,  this)
    this._rightSlot   = new ParameterSlot(ValueType.Image,  this)
    this._maskSlot    = new ParameterSlot(ValueType.Mask,   this)
    this._opacitySlot = new ParameterSlot(ValueType.Amount, this)
    this._slider      = new SliderRegion(this, this._amount)
    this.slots.push(this._leftSlot, this._rightSlot, this._maskSlot, this._opacitySlot)
    this._slider.setOnDragStart(() => this._suspendAmountSlot())
    this.displayBaseName = 'Blend'
    this.debugName = 'Blend'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._result }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get leftSlot():    ParameterSlot { return this._leftSlot    }
  get rightSlot():   ParameterSlot { return this._rightSlot   }
  get maskSlot():    ParameterSlot { return this._maskSlot    }
  get opacitySlot(): ParameterSlot { return this._opacitySlot }

  // Seed a newly-created layer (via slot-click-to-create) with the value
  // currently shown by the manual slider, so the binding starts as a no-op.
  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | null {
    if (slot === this._opacitySlot) return this._amount
    return null
  }

  // ----------------------------------------------------------
  // Amount handle
  // ----------------------------------------------------------

  // Called by SliderRegion when the user drags the handle.
  setValue(v: Amount): void {
    this._amount = v
    this.markDirty()
  }

  // Suspend an active opacitySlot binding so the user can take manual
  // control of the handle (same pattern as AmountLayer's slider).
  private _suspendAmountSlot(): void {
    if (this._opacitySlot.isActive) {
      BindingLayer.findForSlot(this._opacitySlot)?.toggle()
    }
  }

  // ----------------------------------------------------------
  // Default bindings
  // ----------------------------------------------------------

  // Bind the nearest two Image-producing layers below to left/right
  // at creation time, if both can be found, and move them to the
  // Background collection — both inputs are fully consumed by the
  // composite, so they no longer need their own stack position.
  override autoBindRules(): ReturnType<Layer['autoBindRules']> {
    const isImage = (l: Layer) => l.types.has(ValueType.Image)
    return [
      { slot: this._leftSlot,  accepts: isImage, sendToBackgroundAfterBind: true },
      { slot: this._rightSlot, accepts: (l: Layer) => isImage(l) && l !== this._leftSlot.source, sendToBackgroundAfterBind: true },
    ]
  }

  // ----------------------------------------------------------
  // Mode cycling
  // ----------------------------------------------------------

  cycleNext(): void { this._modeIndex = (this._modeIndex + 1) % MODES.length; this.markDirty() }
  cyclePrev(): void { this._modeIndex = (this._modeIndex - 1 + MODES.length) % MODES.length; this.markDirty() }

  // ----------------------------------------------------------
  // Resize
  // ----------------------------------------------------------

  resize(w: number, h: number): void {
    this._result = new OffscreenCanvas(w, h)
    this._temp   = new OffscreenCanvas(w, h)
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { modeIndex: this._modeIndex, amount: this._amount }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.modeIndex === 'number') this._modeIndex = state.modeIndex
    if (typeof state.amount === 'number') {
      this._amount = state.amount as Amount
      this._slider.setValue(this._amount)
    }
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    // Always match the grow-only content canvas — sources (VideoLayer,
    // ImageLayer, etc.) all produce canvasWidth×canvasHeight images, so
    // the result must be the same size to blit them at 1:1 without scaling.
    const cw = Node.canvasWidth
    const ch = Node.canvasHeight
    if (this._result.width !== cw || this._result.height !== ch) {
      this._result = new OffscreenCanvas(cw, ch)
      this._temp   = new OffscreenCanvas(cw, ch)
    }

    const left    = this._leftSlot.isActive
      ? (this._leftSlot.source as ImageSource).getImage()    : null
    const right   = this._rightSlot.isActive
      ? (this._rightSlot.source as ImageSource).getImage()   : null
    const mask    = this._maskSlot.isActive
      ? (this._maskSlot.source as MaskSource).getMask()      : null

    if (this._opacitySlot.isActive) {
      this._amount = (this._opacitySlot.source as AmountSource).getAmount() as Amount
      this._slider.displayValue = this._amount
      this._slider.interactive  = false
    } else {
      this._slider.interactive  = true
      this._slider.displayValue = this._amount
    }
    const opacity = this._amount

    const rctx = this._result.getContext('2d')!
    rctx.clearRect(0, 0, cw, ch)

    // Draw left
    if (left !== null) {
      rctx.globalCompositeOperation = 'source-over'
      rctx.globalAlpha = 1
      rctx.drawImage(left as CanvasImageSource, 0, 0)
    }

    if (right === null) return

    const mode = MODES[this._modeIndex]

    if (mask !== null) {
      // 1. Draw right onto temp canvas
      const tctx = this._temp.getContext('2d')!
      tctx.clearRect(0, 0, cw, ch)
      tctx.globalCompositeOperation = 'source-over'
      tctx.globalAlpha = 1
      tctx.drawImage(right as CanvasImageSource, 0, 0)

      // 2. Apply mask — keep only where mask is opaque (white)
      tctx.globalCompositeOperation = 'destination-in'
      tctx.globalAlpha = 1
      tctx.drawImage(mask as CanvasImageSource, 0, 0)

      // 3. Composite masked right onto result
      rctx.globalCompositeOperation = mode.op
      rctx.globalAlpha = opacity
      rctx.drawImage(this._temp as CanvasImageSource, 0, 0)
    } else {
      // No mask — composite right directly
      rctx.globalCompositeOperation = mode.op
      rctx.globalAlpha = opacity
      rctx.drawImage(right as CanvasImageSource, 0, 0)
    }

    rctx.globalCompositeOperation = 'source-over'
    rctx.globalAlpha = 1
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._prevBtnBounds(), point)) { this.cyclePrev(); return true }
    if (boundingBoxContains(this._nextBtnBounds(), point)) { this.cycleNext(); return true }
    if (boundingBoxContains(this._modeLabelBounds(), point)) { this.cycleNext(); return true }
    if (boundingBoxContains(this._swapBtnBounds(), point)) { this._swapLeftRight(); return true }
    return false
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    if (boundingBoxContains(this.canvasBounds, point)) return this
    if (this._slider.hitTest(point) !== null) return this._slider
    if (boundingBoxContains(this._swapBtnBounds(), point)) return this
    return null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    // Blit composited result to the main canvas (full size)
    ctx.save()
    ctx.drawImage(this._result as CanvasImageSource, 0, 0)
    ctx.restore()
  }

  // ── Stack panel ─────────────────────────────────────────────

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.canvasBounds
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

    // [◀] prev
    this._drawNavBtn(ctx, this._prevBtnBounds(), '◀', midY)

    // Mode label
    const mb = this._modeLabelBounds()
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(mb.x, mb.y, mb.width, mb.height, 3)
    ctx.fill()
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(MODES[this._modeIndex].label, mb.x + mb.width / 2, midY)

    // [▶] next
    this._drawNavBtn(ctx, this._nextBtnBounds(), '▶', midY)

    // Slot indicators — right side
    const slots = [
      { slot: this._leftSlot,    label: 'left'  },
      { slot: this._rightSlot,   label: 'right' },
      { slot: this._maskSlot,    label: 'mask'  },
      { slot: this._opacitySlot, label: 'α'     },
    ]
    let dx = x + width - 8
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

    ctx.restore()

    // Centre-of-canvas amount widget
    this._renderAmountWidget(ctx)
  }

  // ── Centre-of-canvas amount widget ──────────────────────────

  private _renderAmountWidget(ctx: Ctx2D): void {
    const wb = this._widgetBounds()

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(wb.x, wb.y, wb.width, wb.height, 10)
    ctx.fill()

    // Thumbnails
    this._drawThumb(ctx, this._leftThumbBounds(),  this._leftSlot)
    this._drawThumb(ctx, this._rightThumbBounds(), this._rightSlot)

    // Slider
    this._slider.bounds = this._sliderBounds()
    this._slider.renderSelf(ctx)

    // Swap button
    const sb = this._swapBtnBounds()
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(sb.x, sb.y, sb.width, sb.height, 4)
    ctx.fill()
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.75)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('⇄ swap', sb.x + sb.width / 2, sb.y + sb.height / 2)

    ctx.restore()
  }

  private _drawThumb(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    slot: ParameterSlot,
  ): void {
    ctx.save()
    ctx.fillStyle = 'rgba(255,255,255,0.06)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()

    if (slot.isActive) {
      const img = (slot.source as ImageSource).getImage()
      if (img !== null) {
        ctx.save()
        ctx.beginPath()
        ctx.roundRect(b.x, b.y, b.width, b.height, 4)
        ctx.clip()
        ctx.drawImage(img as CanvasImageSource, b.x, b.y, b.width, b.height)
        ctx.restore()
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.roundRect(b.x + 0.5, b.y + 0.5, b.width - 1, b.height - 1, 4)
    ctx.stroke()
    ctx.restore()
  }

  // Swap the source layers bound to leftSlot and rightSlot (any
  // combination of bound/unbound is handled).
  private _swapLeftRight(): void {
    const leftBL  = BindingLayer.findForSlot(this._leftSlot)
    const rightBL = BindingLayer.findForSlot(this._rightSlot)
    const leftSource  = leftBL?.source  ?? null
    const rightSource = rightBL?.source ?? null

    leftBL?.remove()
    rightBL?.remove()

    if (rightSource !== null) BindingLayer.create(rightSource, this._leftSlot)
    if (leftSource  !== null) BindingLayer.create(leftSource,  this._rightSlot)
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

  private _prevBtnBounds() {
    const { x, y, height } = this.canvasBounds
    return { x: x + 8, y: y + (height - BTN_H) / 2, width: BTN_W, height: BTN_H }
  }

  private _modeLabelBounds() {
    const pb = this._prevBtnBounds()
    return { x: pb.x + BTN_W + 4, y: pb.y, width: LABEL_W, height: BTN_H }
  }

  private _nextBtnBounds() {
    const lb = this._modeLabelBounds()
    return { x: lb.x + LABEL_W + 4, y: lb.y, width: BTN_W, height: BTN_H }
  }

  // ── Centre-of-canvas amount widget geometry ─────────────────

  private _widgetBounds() {
    const width  = WIDGET_PAD * 2 + THUMB * 2 + 16 + SLIDER_W
    const height = WIDGET_PAD * 2 + THUMB + ROW_GAP + SWAP_BTN_H
    // Centre within the visible viewport, not the full content canvas —
    // the canvas may be wider than the viewport on mobile.
    const cx = Math.min(Node.canvasWidth,  Node.viewportWidth)  / 2
    const cy = Math.min(Node.canvasHeight, Node.viewportHeight) / 2
    return { x: cx - width / 2, y: cy - height / 2, width, height }
  }

  private _leftThumbBounds() {
    const wb = this._widgetBounds()
    return { x: wb.x + WIDGET_PAD, y: wb.y + WIDGET_PAD, width: THUMB, height: THUMB }
  }

  private _rightThumbBounds() {
    const wb = this._widgetBounds()
    return { x: wb.x + wb.width - WIDGET_PAD - THUMB, y: wb.y + WIDGET_PAD, width: THUMB, height: THUMB }
  }

  private _sliderBounds() {
    const lt = this._leftThumbBounds()
    const rt = this._rightThumbBounds()
    return {
      x:      lt.x + lt.width + 8,
      y:      lt.y + (THUMB - SLIDER_H) / 2,
      width:  rt.x - 8 - (lt.x + lt.width + 8),
      height: SLIDER_H,
    }
  }

  private _swapBtnBounds() {
    const wb = this._widgetBounds()
    return {
      x: wb.x + (wb.width - SWAP_BTN_W) / 2,
      y: wb.y + WIDGET_PAD + THUMB + ROW_GAP,
      width:  SWAP_BTN_W,
      height: SWAP_BTN_H,
    }
  }
}
