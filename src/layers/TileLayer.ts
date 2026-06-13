import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// TileLayer — repeat or stretch an image's content to fill the canvas
// ------------------------------------------------------------
//
// Input:
//   sourceSlot (Image) — content to tile/fit
//
// The bounding box of the source's non-transparent content is found
// (via a small downsampled scan), then:
//
//   tile mode — that bounding box is repeated horizontally and
//                vertically to cover the whole canvas.
//   fit mode  — that bounding box is scaled up uniformly (using
//                whichever dimension is the tighter fit) so it covers
//                the whole canvas, centred.
//
// [Tile/Fit] button in the panel toggles between modes.

const ACCENT      = '#7ecf7e'   // Image type colour

const BTN_W = 50
const BTN_H = 22
const PAD_X = 8

const STEP_BTN  = 18    // size of margin +/- buttons
const STEP_VAL_W = 22   // width of margin value label
const MARGIN_STEP = 1   // px per click
const MARGIN_MIN  = -2  // px (overlap — "bleed" — avoids hairline gaps at tile edges)
const MARGIN_MAX  = 200 // px

type Mode = 'tile' | 'fit'

export class TileLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private readonly _sourceSlot: ParameterSlot

  private _mode:       Mode = 'tile'
  // px gap between tiles (tile mode only). Defaults to a 2px overlap
  // ("bleed") so adjacent copies abut with no hairline gap.
  private _margin:     number = MARGIN_MIN
  private _offscreen:  OffscreenCanvas

  constructor() {
    super()
    this._offscreen  = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)
    this._sourceSlot = new ParameterSlot(ValueType.Image, this, 'image')
    this.slots.push(this._sourceSlot)
    this.debugName = 'TileLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._offscreen }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get sourceSlot(): ParameterSlot { return this._sourceSlot }

  // ----------------------------------------------------------
  // Mode toggle
  // ----------------------------------------------------------

  toggleMode(): void {
    this._mode = this._mode === 'tile' ? 'fit' : 'tile'
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Margin
  // ----------------------------------------------------------

  increaseMargin(): void {
    this._margin = Math.min(MARGIN_MAX, this._margin + MARGIN_STEP)
    this.markDirty()
  }

  decreaseMargin(): void {
    this._margin = Math.max(MARGIN_MIN, this._margin - MARGIN_STEP)
    this.markDirty()
  }

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

    const src = this._sourceSlot.isActive
      ? (this._sourceSlot.source as ImageSource).getImage()
      : null
    if (src === null) return

    const bbox = this._contentBbox(src)
    if (bbox === null) return

    if (this._mode === 'fit') {
      // Scale so the smaller dimension of the bbox exactly fills the
      // corresponding canvas dimension — guarantees full coverage.
      const scale = Math.max(w / bbox.w, h / bbox.h)
      const dw = bbox.w * scale
      const dh = bbox.h * scale
      ctx.drawImage(
        src as CanvasImageSource,
        bbox.x, bbox.y, bbox.w, bbox.h,
        (w - dw) / 2, (h - dh) / 2, dw, dh,
      )
    } else {
      // Tile the bbox content across the canvas, anchored so one tile
      // aligns with the original bbox position. _margin pixels of gap
      // (transparent) are left between adjacent tiles — negative values
      // (the default) overlap adjacent tiles by that many pixels instead,
      // avoiding hairline gaps from sub-pixel edge rounding.
      const tw = bbox.w + this._margin
      const th = bbox.h + this._margin
      const startX = ((bbox.x % tw) + tw) % tw - tw
      const startY = ((bbox.y % th) + th) % th - th
      for (let ty = startY; ty < h; ty += th) {
        for (let tx = startX; tx < w; tx += tw) {
          ctx.drawImage(
            src as CanvasImageSource,
            bbox.x, bbox.y, bbox.w, bbox.h,
            tx, ty, bbox.w, bbox.h,
          )
        }
      }
    }
  }

  override autoBindRules(): ReturnType<Layer['autoBindRules']> {
    return [
      // The image bound straight into a freshly-created TileLayer is
      // unlikely to be needed for anything else — move it to the
      // Background collection (still evaluated, recoverable via
      // DeletionLayer's toggle) rather than leaving it cluttering the stack.
      { slot: this._sourceSlot, accepts: (l: Layer) => l.types.has(ValueType.Image), sendToBackgroundAfterBind: true },
    ]
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._toggleBtnBounds(), point)) {
      this.toggleMode()
      return true
    }
    if (boundingBoxContains(this._marginMinusBtnBounds(), point)) {
      this.decreaseMargin()
      return true
    }
    if (boundingBoxContains(this._marginPlusBtnBounds(), point)) {
      this.increaseMargin()
      return true
    }
    return false
  }

  handlePointerMove(_point: Point): void {}
  handlePointerUp(): void {}

  protected override hitTestSelf(point: { x: number; y: number }) {
    return boundingBoxContains(this.canvasBounds, point) ? this : null
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
    const { x, y, width, height } = this.canvasBounds
    if (width <= 0 || height <= 0) return
    const midY = y + height / 2

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // Label
    ctx.fillStyle    = 'rgba(255,255,255,0.75)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Tile', x + 12, midY)

    // Mode toggle button
    const tb = this._toggleBtnBounds()
    ctx.fillStyle = 'rgba(255,255,255,0.10)'
    ctx.beginPath()
    ctx.roundRect(tb.x, tb.y, tb.width, tb.height, 4)
    ctx.fill()
    ctx.fillStyle    = 'rgba(255,255,255,0.85)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(this._mode === 'tile' ? 'Tile' : 'Fit', tb.x + tb.width / 2, midY)

    // Margin [-] value [+]
    const mmB = this._marginMinusBtnBounds()
    this._drawBtn(ctx, mmB, '−', this._margin > MARGIN_MIN ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.18)')

    const mvB = this._marginValueBounds()
    ctx.fillStyle    = 'rgba(255,255,255,0.70)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(this._margin), mvB.x + mvB.width / 2, midY)

    const mpB = this._marginPlusBtnBounds()
    this._drawBtn(ctx, mpB, '+', this._margin < MARGIN_MAX ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.18)')

    // Slot indicator — img
    ctx.font      = '9px monospace'
    ctx.textAlign = 'right'
    let dx = x + width - 8
    ctx.fillStyle = this._sourceSlot.isActive ? ACCENT : 'rgba(255,255,255,0.22)'
    ctx.fillText(this._sourceSlot.isActive ? '●' : '○', dx, midY)
    dx -= 12
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.fillText('img', dx, midY)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _toggleBtnBounds() {
    const { x, y, height } = this.canvasBounds
    return { x: x + 12 + 30 + PAD_X, y: y + (height - BTN_H) / 2, width: BTN_W, height: BTN_H }
  }

  private _marginMinusBtnBounds() {
    const tb = this._toggleBtnBounds()
    const { y, height } = this.canvasBounds
    return { x: tb.x + tb.width + PAD_X, y: y + (height - STEP_BTN) / 2, width: STEP_BTN, height: STEP_BTN }
  }

  private _marginValueBounds() {
    const mb = this._marginMinusBtnBounds()
    return { x: mb.x + mb.width + 4, y: mb.y, width: STEP_VAL_W, height: STEP_BTN }
  }

  private _marginPlusBtnBounds() {
    const vb = this._marginValueBounds()
    return { x: vb.x + vb.width + 4, y: vb.y, width: STEP_BTN, height: STEP_BTN }
  }

  private _drawBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    colour: string,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
    ctx.font         = '12px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }

  // Find the exact bounding box of the source's non-transparent content,
  // scanning at the source's native resolution (no downsampling, so tiled
  // copies abut exactly with no rounding-induced gap).
  private _contentBbox(src: ImageBitmap | OffscreenCanvas): { x: number; y: number; w: number; h: number } | null {
    const sw = src.width
    const sh = src.height

    let data: Uint8ClampedArray
    if (src instanceof OffscreenCanvas) {
      data = src.getContext('2d')!.getImageData(0, 0, sw, sh).data
    } else {
      const tmp  = new OffscreenCanvas(sw, sh)
      const tctx = tmp.getContext('2d')!
      tctx.drawImage(src, 0, 0)
      data = tctx.getImageData(0, 0, sw, sh).data
    }

    let x1 = sw, y1 = sh, x2 = -1, y2 = -1
    for (let py = 0; py < sh; py++) {
      for (let px = 0; px < sw; px++) {
        if (data[(py * sw + px) * 4 + 3]! > 10) {
          if (px < x1) x1 = px
          if (py < y1) y1 = py
          if (px > x2) x2 = px
          if (py > y2) y2 = py
        }
      }
    }
    if (x2 < x1) return null

    return { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 }
  }
}
