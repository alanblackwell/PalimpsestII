import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  SlotState,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type Amount, type AmountSource,
  type Direction,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'
import { SliderSlot }   from '../ui/SliderSlot.js'
import { letterboxFillRect } from '../persistence/letterboxRescale.js'

// ------------------------------------------------------------
// TileLayer — repeat or stretch an image's content to fill the canvas
// ------------------------------------------------------------
//
// Input:
//   sourceSlot (Image)  — content to tile/fit
//   marginSlot (Amount) — gap between adjacent tiles in tile mode (bindable,
//                          like opacity); maps [0,1] -> [MARGIN_MIN, MARGIN_MAX] px.
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
// Mode is chosen with two big buttons at the top of the panel, each showing
// a live preview of what that mode currently produces from the bound
// source (same big-button-with-thumbnail convention as NoiseLayer's style
// picker) — no separate toggle/label strip.

const ACCENT      = '#7ecf7e'   // Image type colour
const AM_COL      = '#4a8fe8'   // Amount type colour

const MARGIN_MIN  = -2  // px (overlap — "bleed" — avoids hairline gaps at tile edges)
const MARGIN_MAX  = 200 // px

// Big Tile/Fit preview buttons.
const PV_MARGIN  = 10   // margin inside the pill around the two buttons
const PV_GAP     = 8    // gap between the two buttons
const PV_PAD     = 6    // padding between button edge and thumbnail preview
const PV_LABEL_H = 16   // label strip below the thumbnail
const PV_MIN_W   = 60
const PV_MAX_W   = 140

type Mode = 'tile' | 'fit'
type BBox = { x: number; y: number; width: number; height: number }
type ContentBBox = { x: number; y: number; w: number; h: number }

export class TileLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private readonly _sourceSlot:  ParameterSlot
  private readonly _marginSlot:  ParameterSlot
  private readonly _opacitySlot: ParameterSlot
  private _manualOpacity = 1.0
  private readonly _opacityWidget: SliderSlot

  // marginSlot amount [0,1], resolved to a px value in recompute() — default
  // 0 maps to MARGIN_MIN, the same 2px-overlap "bleed" default as before.
  private _manualMarginAmt = 0
  private readonly _marginWidget: SliderSlot

  private _mode:       Mode = 'tile'
  // Opacity — computed each recompute from slot; 1.0 when unbound
  private _opacity = 1.0
  // px gap between tiles (tile mode only), resolved each recompute from
  // marginSlot/_manualMarginAmt.
  private _margin:     number = MARGIN_MIN
  private _offscreen:  OffscreenCanvas

  // Live previews shown on the big Tile/Fit buttons — regenerated every
  // recompute from the current source/margin, same as the real composite.
  private _tileThumb: OffscreenCanvas = new OffscreenCanvas(1, 1)
  private _fitThumb:  OffscreenCanvas = new OffscreenCanvas(1, 1)

  constructor() {
    super()
    this._offscreen  = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)
    this._sourceSlot = new ParameterSlot(ValueType.Image,  this, 'image')
    this._marginSlot = new ParameterSlot(ValueType.Amount, this, 'margin')
    this._opacitySlot = new ParameterSlot(ValueType.Amount, this, 'opacity')
    this.slots.push(this._sourceSlot, this._marginSlot, this._opacitySlot)
    this._marginWidget = new SliderSlot(
      this._marginSlot, 'margin', AM_COL,
      () => this._marginSlot.isActive
        ? (this._marginSlot.source as AmountSource).getAmount() as number
        : this._manualMarginAmt,
      (v) => {
        if (this._marginSlot.state === SlotState.Bound) BindingLayer.findForSlot(this._marginSlot)?.toggle()
        this._manualMarginAmt = Math.max(0, Math.min(1, v))
        this.markDirty()
      },
      () => this.markDirty(),
    )
    this._opacityWidget = new SliderSlot(
      this._opacitySlot, 'opacity', AM_COL,
      () => this._manualOpacity,
      (v) => {
        if (this._opacitySlot.state === SlotState.Bound) BindingLayer.findForSlot(this._opacitySlot)?.toggle()
        this._manualOpacity = v
        this.markDirty()
      },
      () => this.markDirty(),
    )
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

  get sourceSlot():    ParameterSlot { return this._sourceSlot    }
  get marginSlot():    ParameterSlot { return this._marginSlot   }
  get opacitySlot():   ParameterSlot { return this._opacitySlot  }
  get marginWidget():  SliderSlot    { return this._marginWidget  }
  get opacityWidget(): SliderSlot    { return this._opacityWidget }

  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | null {
    if (slot === this._marginSlot)  return this._manualMarginAmt
    if (slot === this._opacitySlot) return this._manualOpacity
    return null
  }

  // Canvas-space pill height comes from the big Tile/Fit preview buttons,
  // independent of `this.bounds.height`.
  override get canvasBounds(): { x: number; y: number; width: number; height: number } {
    const base = super.canvasBounds
    return { ...base, height: PV_MARGIN * 2 + this._previewBtnHeight(base.width) }
  }

  override get panelBottom(): number {
    return 50 + this.canvasBounds.height + 8
  }

  // ----------------------------------------------------------
  // Mode selection
  // ----------------------------------------------------------

  selectMode(mode: Mode): void {
    if (this._mode === mode) return
    this._mode = mode
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { mode: this._mode, manualMargin: this._manualMarginAmt, manualOpacity: this._manualOpacity }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (state.mode === 'tile' || state.mode === 'fit') this._mode = state.mode
    if (typeof state.manualMargin === 'number') this._manualMarginAmt = state.manualMargin
    if (typeof state.manualOpacity === 'number') this._manualOpacity = state.manualOpacity
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    this._opacity = this._opacitySlot.isActive
      ? (this._opacitySlot.source as AmountSource).getAmount() as Amount
      : this._manualOpacity

    const marginAmt = this._marginSlot.isActive
      ? (this._marginSlot.source as AmountSource).getAmount() as Amount
      : this._manualMarginAmt
    this._margin = MARGIN_MIN + marginAmt * (MARGIN_MAX - MARGIN_MIN)

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
    const bbox = src !== null ? this._contentBbox(src) : null

    if (src !== null && bbox !== null) {
      ctx.globalAlpha = Math.max(0, Math.min(1, this._opacity))
      // Node.letterboxMode === 'replay' confines the composited tile/fit
      // pattern to the letterbox rect instead of the full canvas — see
      // persistence/letterboxRescale.ts's letterboxFillRect(). A plain
      // translate+clip so _compositeMode's own (0,0)-(w,h) coordinate
      // logic is unchanged; a no-op in every other mode, where the rect
      // is the full canvas.
      const rect = letterboxFillRect()
      ctx.save()
      ctx.translate(rect.x, rect.y)
      ctx.beginPath()
      ctx.rect(0, 0, rect.width, rect.height)
      ctx.clip()
      this._compositeMode(ctx, rect.width, rect.height, this._mode, src as CanvasImageSource, bbox, this._margin)
      ctx.restore()
    }

    this._updatePreviews(src as CanvasImageSource | null, bbox)
  }

  // Shared tile/fit compositing, used both for the real full-size output and
  // (via tileScale) for the small preview thumbnails. "fit" always adapts to
  // whatever (w, h) is passed in; "tile" needs tileScale so the repeating
  // pattern stays visible when rendered much smaller than the real canvas.
  private _compositeMode(
    ctx: Ctx2D, w: number, h: number, mode: Mode,
    src: CanvasImageSource, bbox: ContentBBox, margin: number, tileScale = 1,
  ): void {
    if (mode === 'fit') {
      // Scale so the smaller dimension of the bbox exactly fills the
      // corresponding target dimension — guarantees full coverage.
      const scale = Math.max(w / bbox.w, h / bbox.h)
      const dw = bbox.w * scale
      const dh = bbox.h * scale
      ctx.drawImage(
        src, bbox.x, bbox.y, bbox.w, bbox.h,
        (w - dw) / 2, (h - dh) / 2, dw, dh,
      )
      return
    }

    // Tile the bbox content across the target, anchored so one tile aligns
    // with the original bbox position (scaled by tileScale). margin pixels
    // of gap (transparent) are left between adjacent tiles — negative
    // values (the default) overlap adjacent tiles by that many pixels
    // instead, avoiding hairline gaps from sub-pixel edge rounding.
    const dw = bbox.w * tileScale
    const dh = bbox.h * tileScale
    const tw = dw + margin * tileScale
    const th = dh + margin * tileScale
    const startX = (((bbox.x * tileScale) % tw) + tw) % tw - tw
    const startY = (((bbox.y * tileScale) % th) + th) % th - th
    for (let ty = startY; ty < h; ty += th) {
      for (let tx = startX; tx < w; tx += tw) {
        ctx.drawImage(src, bbox.x, bbox.y, bbox.w, bbox.h, tx, ty, dw, dh)
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
  // Slot rendering
  // ----------------------------------------------------------

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    // Standard slots except marginSlot/opacitySlot (both SliderSlot pills)
    const standard = this.slots.filter(s => s !== this._marginSlot && s !== this._opacitySlot)
    this.renderSlotGroup(ctx, standard, this.panelBottom)

    // Margin SliderSlot pill
    const mb = this._marginPillBounds()
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(mb.x, mb.y, mb.width, mb.height, 6)
    ctx.fill()
    ctx.restore()
    this._slotBounds.set(this._marginSlot, mb)
    this._marginWidget.render(ctx, mb)

    // Opacity SliderSlot pill
    const ob = this._opacityPillBounds()
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(ob.x, ob.y, ob.width, ob.height, 6)
    ctx.fill()
    ctx.restore()
    this._slotBounds.set(this._opacitySlot, ob)
    this._opacityWidget.render(ctx, ob)
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._tileBtnBounds(), point)) {
      this.selectMode('tile')
      return true
    }
    if (boundingBoxContains(this._fitBtnBounds(), point)) {
      this.selectMode('fit')
      return true
    }
    const mb = this._marginPillBounds()
    if (this._marginWidget.hitZone(point, mb) !== null) {
      return this._marginWidget.handlePointerDown(point, mb)
    }
    const ob = this._opacityPillBounds()
    if (this._opacityWidget.hitZone(point, ob) !== null) {
      return this._opacityWidget.handlePointerDown(point, ob)
    }
    return false
  }

  handlePointerMove(point: Point): void {
    this._marginWidget.handlePointerMove(point, this._marginPillBounds())
    if (this._opacityWidget.isDragging) {
      this._opacityWidget.handlePointerMove(point, this._opacityPillBounds())
    }
  }

  handlePointerUp(): void {
    this._marginWidget.handlePointerUp()
    this._opacityWidget.handlePointerUp()
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    if (boundingBoxContains(this.canvasBounds, point)) return this
    if (this._marginWidget.hitZone(point, this._marginPillBounds()) !== null) return this
    if (this._opacityWidget.hitZone(point, this._opacityPillBounds()) !== null) return this
    return null
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

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, 8)
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    this._drawPreviewBtn(ctx, this._tileBtnBounds(), this._tileThumb, 'Tile', this._mode === 'tile')
    this._drawPreviewBtn(ctx, this._fitBtnBounds(),  this._fitThumb,  'Fit',  this._mode === 'fit')

    ctx.restore()
  }

  // ── Big Tile/Fit preview buttons ────────────────────────────

  private _previewBtnWidth(pillWidth: number): number {
    const raw = (pillWidth - 2 * PV_MARGIN - PV_GAP) / 2
    return Math.max(PV_MIN_W, Math.min(PV_MAX_W, Math.floor(raw)))
  }

  private _previewThumbSize(pillWidth: number): number {
    return Math.max(1, this._previewBtnWidth(pillWidth) - 2 * PV_PAD)
  }

  private _previewBtnHeight(pillWidth: number): number {
    return PV_PAD + this._previewThumbSize(pillWidth) + PV_LABEL_H + PV_PAD
  }

  private _tileBtnBounds(): BBox {
    const cb = this.canvasBounds
    return {
      x: cb.x + PV_MARGIN, y: cb.y + PV_MARGIN,
      width: this._previewBtnWidth(cb.width), height: cb.height - 2 * PV_MARGIN,
    }
  }

  private _fitBtnBounds(): BBox {
    const tb = this._tileBtnBounds()
    return { x: tb.x + tb.width + PV_GAP, y: tb.y, width: tb.width, height: tb.height }
  }

  private _drawPreviewBtn(ctx: Ctx2D, b: BBox, thumb: OffscreenCanvas, label: string, active: boolean): void {
    ctx.save()
    ctx.fillStyle = active ? ACCENT + '33' : 'rgba(255,255,255,0.06)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 6)
    ctx.fill()
    if (active) {
      ctx.strokeStyle = ACCENT
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.roundRect(b.x + 0.75, b.y + 0.75, b.width - 1.5, b.height - 1.5, 6)
      ctx.stroke()
    }

    const ts = thumb.width
    const tx = b.x + (b.width - ts) / 2
    const ty = b.y + PV_PAD
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(tx, ty, ts, ts, 3)
    ctx.clip()
    ctx.fillStyle = 'rgba(0,0,0,0.30)'
    ctx.fillRect(tx, ty, ts, ts)
    ctx.drawImage(thumb as CanvasImageSource, tx, ty, ts, ts)
    ctx.restore()
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.lineWidth   = 1
    ctx.strokeRect(tx + 0.5, ty + 0.5, ts - 1, ts - 1)

    ctx.font         = '10px monospace'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = active ? '#ffffff' : 'rgba(255,255,255,0.65)'
    ctx.fillText(label, b.x + b.width / 2, ty + ts + PV_LABEL_H / 2)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _marginPillBounds() {
    const cb = this.canvasBounds
    const standard = this.slots.filter(s => s !== this._marginSlot && s !== this._opacitySlot)
    const stdH = standard.length * (30 + 4) - 4
    return { x: cb.x, y: this.panelBottom + stdH + 8, width: cb.width, height: 30 }
  }

  private _opacityPillBounds() {
    const mb = this._marginPillBounds()
    return { x: mb.x, y: mb.y + mb.height + 4, width: mb.width, height: 30 }
  }

  // Refreshes the two style-button preview swatches from the current
  // source/margin/mode-independent geometry — one per mode, so both buttons
  // always show what tapping them would produce, not just the active one.
  private _updatePreviews(src: CanvasImageSource | null, bbox: ContentBBox | null): void {
    const pillWidth = super.canvasBounds.width
    const size = this._previewThumbSize(pillWidth)
    this._ensureThumbSize(this._tileThumb, size)
    this._ensureThumbSize(this._fitThumb, size)

    const tctx = this._tileThumb.getContext('2d')!
    const fctx = this._fitThumb.getContext('2d')!
    tctx.clearRect(0, 0, size, size)
    fctx.clearRect(0, 0, size, size)

    if (src === null || bbox === null) {
      this._drawPlaceholderIcon(tctx, size, 'tile')
      this._drawPlaceholderIcon(fctx, size, 'fit')
      return
    }

    // "Fit" preview scales naturally to any target size.
    this._compositeMode(fctx, size, size, 'fit', src, bbox, this._margin)

    // "Tile" preview needs its own scale so a few repeats are visible
    // regardless of how large the source content actually is.
    const desiredTilesAcross = 3
    const tileScale = size / (desiredTilesAcross * Math.max(1, bbox.w))
    this._compositeMode(tctx, size, size, 'tile', src, bbox, this._margin, tileScale)
  }

  private _ensureThumbSize(canvas: OffscreenCanvas, size: number): void {
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width  = size
      canvas.height = size
    }
  }

  // Fallback shown before a source is bound — a plain geometric hint
  // rather than a blank button.
  private _drawPlaceholderIcon(ctx: Ctx2D, size: number, mode: Mode): void {
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth   = 1.5
    if (mode === 'fit') {
      const pad = size * 0.18
      ctx.strokeRect(pad, pad, size - pad * 2, size - pad * 2)
    } else {
      const cell = size / 3
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 2; c++) {
          ctx.strokeRect(cell * 0.5 + c * cell, cell * 0.5 + r * cell, cell * 0.7, cell * 0.7)
        }
      }
    }
    ctx.restore()
  }

  // Find the exact bounding box of the source's non-transparent content,
  // scanning at the source's native resolution (no downsampling, so tiled
  // copies abut exactly with no rounding-induced gap).
  private _contentBbox(src: ImageBitmap | OffscreenCanvas): ContentBBox | null {
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
