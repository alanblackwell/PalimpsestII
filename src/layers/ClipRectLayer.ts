import { RectLayer } from './RectLayer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  type ImageValue, type ImageSource,
  type Point, type Ctx2D,
} from '../core/types.js'
import type { Layer } from '../core/Layer.js'
import type { MaskLayer } from './MaskLayer.js'
import { contentLeft } from '../interaction/layout.js'

// ------------------------------------------------------------
// Clip-family bottom-of-screen button layout (Track + Move)
// ------------------------------------------------------------

const BTN_H   = 30
const BTN_GAP = 14   // gap from viewport bottom edge
const BTN_SEP = 8    // gap between the two buttons
const TRACK_W = 56
const MOVE_W  = 60
const TRACK_COL = '#cf7ecf'   // Point accent
const MOVE_COL  = '#7ecf7e'   // Image accent

type BtnPos = { x: number; y: number }

function clipBtnLayout(
  showTrack: boolean, showMove: boolean,
  viewportW: number, viewportH: number, canvasW: number,
): { track: BtnPos | null; move: BtnPos | null; y: number } {
  const left  = contentLeft(canvasW)
  const total = (showTrack ? TRACK_W : 0) + (showMove ? MOVE_W : 0) +
                (showTrack && showMove ? BTN_SEP : 0)
  const y     = viewportH - BTN_H - BTN_GAP
  let x = left + Math.max(0, (viewportW - left - total) / 2)
  let track: BtnPos | null = null
  let move:  BtnPos | null = null
  if (showTrack) { track = { x, y }; x += TRACK_W + BTN_SEP }
  if (showMove)  { move  = { x, y } }
  return { track, move, y }
}

function renderClipBtn(ctx: Ctx2D, x: number, y: number, w: number, label: string, col: string): void {
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.beginPath()
  ctx.roundRect(x, y, w, BTN_H, 5)
  ctx.fill()
  ctx.fillStyle = col + 'cc'
  ctx.beginPath()
  ctx.roundRect(x, y, 3, BTN_H, [5, 0, 0, 5])
  ctx.fill()
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, BTN_H)
  ctx.clip()
  ctx.fillStyle    = 'rgba(255,255,255,0.85)'
  ctx.font         = '11px monospace'
  ctx.textAlign    = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + 10, y + BTN_H / 2)
  ctx.restore()
  ctx.restore()
}

// ------------------------------------------------------------
// ClipRectLayer — a RectLayer that renders a clipped image
// ------------------------------------------------------------
//
// Identical geometry, handles and panel to RectLayer (all inherited
// unchanged) — but renders imageSlot's image clipped to its own
// rectangle shape (this.getMask(), from ShapeLayer) instead of a
// filled rectangle.
//
// maskSlot is not read by recompute(): it exists only so the slot row
// can be bound to a hidden mask-tracker helper (see setMaskTracker),
// making that helper exposable via the standard "click a bound slot
// whose source is a hidden helper" gesture.

export class ClipRectLayer extends RectLayer implements ImageSource {
  readonly imageSlot: ParameterSlot
  readonly maskSlot:  ParameterSlot

  private _offscreen: OffscreenCanvas
  private _maskTracker: MaskLayer | null = null
  private _addMoveDone  = false
  private _onAddMove: (() => void) | null = null

  private _addTrackDone = false
  private _onAddTrack: (() => void) | null = null

  constructor() {
    super(Node.canvasWidth / 2, Node.canvasHeight / 2, Node.canvasWidth * 0.35, Node.canvasHeight * 0.3)
    this._offscreen = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)

    this.imageSlot = new ParameterSlot(ValueType.Image, this, 'image')
    this.maskSlot  = new ParameterSlot(ValueType.Mask,  this, 'mask')
    this.slots.push(this.imageSlot, this.maskSlot)

    this.debugName = 'ClipRect'
    this._showAnimateButton = false
    this._showMaskButton    = false
    this._showPointButton   = false
  }

  // Link a hidden Mask helper whose content should track this shape's
  // mask. The link persists for the helper's whole lifetime, even after
  // it is exposed (exposure only clears isHiddenHelper/helperHost).
  setMaskTracker(helper: MaskLayer): void {
    this._maskTracker = helper
    helper.trackedShape = this
  }

  setOnAddMove(fn: () => void): void  { this._onAddMove  = fn }
  setOnAddTrack(fn: () => void): void { this._onAddTrack = fn }

  override markDirty(): void {
    super.markDirty()
    this._maskTracker?.markDirty()
  }

  override renderOverlay(ctx: Ctx2D): void {
    super.renderOverlay(ctx)
    const { track, move, y } = clipBtnLayout(
      !this._addTrackDone, !this._addMoveDone,
      Node.viewportWidth, Node.viewportHeight, Node.canvasWidth,
    )
    if (track) renderClipBtn(ctx, track.x, y, TRACK_W, 'Track', TRACK_COL)
    if (move)  renderClipBtn(ctx, move.x,  y, MOVE_W,  'Move',  MOVE_COL)
  }

  protected override hitTestSelf(point: Point): this | null {
    const { track, move, y } = clipBtnLayout(
      !this._addTrackDone, !this._addMoveDone,
      Node.viewportWidth, Node.viewportHeight, Node.canvasWidth,
    )
    if (track && this._hitBtn(point, track.x, TRACK_W, y)) return this
    if (move  && this._hitBtn(point, move.x,  MOVE_W,  y)) return this
    return super.hitTestSelf(point)
  }

  private _hitBtn(p: Point, bx: number, bw: number, by: number): boolean {
    return p.x >= bx && p.x <= bx + bw && p.y >= by && p.y <= by + BTN_H
  }

  handlePointerDown(point: Point): boolean {
    const { track, move, y } = clipBtnLayout(
      !this._addTrackDone, !this._addMoveDone,
      Node.viewportWidth, Node.viewportHeight, Node.canvasWidth,
    )
    if (track && this._hitBtn(point, track.x, TRACK_W, y)) {
      this._onAddTrack?.()
      this._addTrackDone = true
      return true
    }
    if (move && this._hitBtn(point, move.x, MOVE_W, y)) {
      this._onAddMove?.()
      this._addMoveDone = true
      return true
    }
    return super.handlePointerDown(point)
  }

  override serializeState(): Record<string, unknown> {
    return {
      ...super.serializeState(),
      addMoveDone:  this._addMoveDone,
      addTrackDone: this._addTrackDone,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    super.deserializeState(state)
    if (typeof state.addMoveDone  === 'boolean') this._addMoveDone  = state.addMoveDone
    if (typeof state.addTrackDone === 'boolean') this._addTrackDone = state.addTrackDone
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

  override renderPanel(ctx: Ctx2D): void {
    if (this.imageSlot.isActive) {
      const src = (this.imageSlot.source as ImageSource).getImage()
      if (src !== null) {
        ctx.save()
        ctx.globalAlpha = 0.4
        ctx.drawImage(src, 0, 0, Node.canvasWidth, Node.canvasHeight)
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
