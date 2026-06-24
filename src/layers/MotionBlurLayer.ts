import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  type ImageValue, type ImageSource,
  type Amount, type AmountSource,
  type EventSource,
  type Ctx2D, type Point, type Direction,
} from '../core/types.js'
import { graph }        from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'

// ------------------------------------------------------------
// MotionBlurLayer — temporal image accumulation / trails
// ------------------------------------------------------------
//
// Maintains a persistent cache canvas. On each update tick (gated
// by the delay control), it fades the cache and composites the
// current input image over it, producing motion-trail / long-
// exposure / ghost effects.
//
// Input slots:
//   imageSlot (Image)  — source image to accumulate
//   fadeSlot  (Amount) — decay per update: 0 = full accumulation
//                        (previous frames never cleared); 1 = instant
//                        clear (only the latest frame visible)
//   delaySlot (Amount) — update interval, log-scaled: 0 = every frame;
//                        1 = never (cache frozen)
//
// Touching either slider while its slot is Bound suspends the
// binding (standard suspend-on-touch pattern).
//
// Trails are visible where the source image has transparent pixels
// at the current position but was previously opaque — i.e. when the
// subject moves against a transparent background.

const ACCENT = '#7ecf7e'   // Image type colour
const AM_COL = '#4a8fe8'   // Amount type colour
const EV_COL = '#e0e060'   // Event type colour

const HDR_H    = 36   // header row height
const SLIDER_H = 26   // per-slider row height
const ROW_GAP  = 4    // gap between rows
const LABEL_W  = 48   // slider label column width
const VALUE_W  = 36   // numeric value column width

// Canvas-space pill height: header + 2 slider rows
const PILL_H = HDR_H + ROW_GAP + SLIDER_H + ROW_GAP + SLIDER_H   // 96

// Fade is remapped through a cubic curve so the slider midpoint (0.5)
// gives the same visual decay as the raw value 0.15 did previously,
// leaving more of the useful range in the lower half of the slider.
const FADE_EXPONENT = 3

// Log-scale base for delay: delay=0 → 1 frame, delay=0.5 → 10 frames,
// delay→1 → effectively never (guarded separately).
const DELAY_BASE = 100

export class MotionBlurLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private readonly _imageSlot:   ParameterSlot
  private readonly _fadeSlot:    ParameterSlot
  private readonly _delaySlot:   ParameterSlot
  private readonly _captureSlot: ParameterSlot

  private _fade:  number = 0.5
  private _delay: number = 0.0

  private _lastCaptureTime: number | null = null

  // Persistent trail buffer, working canvas, and output
  private _cache:  OffscreenCanvas | null = null
  private _work:   OffscreenCanvas | null = null
  private _result: OffscreenCanvas | null = null

  private _frameCount = 0

  // 0 = fade slider, 1 = delay slider, null = none dragging
  private _sliderDrag: 0 | 1 | null = null

  constructor() {
    super()
    this._imageSlot   = new ParameterSlot(ValueType.Image,  this, 'image')
    this._fadeSlot    = new ParameterSlot(ValueType.Amount, this, 'fade')
    this._delaySlot   = new ParameterSlot(ValueType.Amount, this, 'delay')
    this._captureSlot = new ParameterSlot(ValueType.Event,  this, 'capture')
    this.slots.push(this._imageSlot, this._fadeSlot, this._delaySlot, this._captureSlot)
    this.displayBaseName = 'Trail'
    this.debugName = 'Trail'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._result }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get imageSlot():   ParameterSlot { return this._imageSlot   }
  get fadeSlot():    ParameterSlot { return this._fadeSlot    }
  get delaySlot():   ParameterSlot { return this._delaySlot   }
  get captureSlot(): ParameterSlot { return this._captureSlot }

  override getSlotDefault(slot: ParameterSlot): number | Point | Direction | null {
    if (slot === this._fadeSlot)  return this._fade
    if (slot === this._delaySlot) return this._delay
    return null
  }

  override autoBindRules() {
    return [{
      slot:    this._imageSlot,
      accepts: (l: Layer) => l.types.has(ValueType.Image),
      sendToBackgroundAfterBind: true,
    }]
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    const w = Node.canvasWidth
    const h = Node.canvasHeight

    const fadeRaw = Math.max(0, Math.min(1, this._fadeSlot.isActive
      ? (this._fadeSlot.source as AmountSource).getAmount() as Amount
      : this._fade))
    const fade = Math.pow(fadeRaw, FADE_EXPONENT)
    const delay = Math.max(0, Math.min(1, this._delaySlot.isActive
      ? (this._delaySlot.source as AmountSource).getAmount() as Amount
      : this._delay))

    if (!this._cache || this._cache.width !== w || this._cache.height !== h) {
      this._cache  = new OffscreenCanvas(w, h)
      this._work   = new OffscreenCanvas(w, h)
      this._result = new OffscreenCanvas(w, h)
    }

    const src = this._imageSlot.isActive
      ? (this._imageSlot.source as ImageSource).getImage()
      : null

    if (src === null) {
      this._cache.getContext('2d')!.clearRect(0, 0, w, h)
      this._result!.getContext('2d')!.clearRect(0, 0, w, h)
      return
    }

    // Capture event: rising edge triggers an immediate cache update,
    // overriding the delay counter. Useful with delay=1 for manual control.
    let captureTriggered = false
    if (this._captureSlot.isActive) {
      const t = (this._captureSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastCaptureTime) {
        this._lastCaptureTime = t
        captureTriggered = true
      }
    }

    // Determine whether to update the cache this frame
    this._frameCount++
    const interval = delay >= 1.0
      ? Infinity
      : Math.max(1, Math.round(Math.pow(DELAY_BASE, delay)))
    const shouldUpdate = captureTriggered ||
      (Number.isFinite(interval) && this._frameCount % interval === 0)

    if (shouldUpdate) {
      const wctx = this._work!.getContext('2d')!
      wctx.clearRect(0, 0, w, h)

      // Faded previous cache (alpha = 1−fade preserves old frames)
      wctx.globalAlpha = 1.0 - fade
      wctx.drawImage(this._cache as CanvasImageSource, 0, 0)
      wctx.globalAlpha = 1.0

      // Current input composited on top (source-over)
      wctx.drawImage(src as CanvasImageSource, 0, 0)

      // Commit work → cache
      const cctx = this._cache.getContext('2d')!
      cctx.clearRect(0, 0, w, h)
      cctx.drawImage(this._work as CanvasImageSource, 0, 0)
    }

    // Copy to result for getImage() / renderSelf()
    const rctx = this._result!.getContext('2d')!
    rctx.clearRect(0, 0, w, h)
    rctx.drawImage(this._cache as CanvasImageSource, 0, 0)
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { fade: this._fade, delay: this._delay }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.fade  === 'number') this._fade  = state.fade
    if (typeof state.delay === 'number') this._delay = state.delay
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    if (this._result === null) return
    ctx.drawImage(this._result as CanvasImageSource, 0, 0, Node.canvasWidth, Node.canvasHeight)
  }

  override get canvasBounds() {
    return { ...super.canvasBounds, height: PILL_H }
  }

  override get panelBottom(): number {
    return 50 + PILL_H + 8
  }

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width } = this.canvasBounds
    if (width <= 0) return

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, PILL_H, 8)
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, PILL_H, [4, 0, 0, 4])
    ctx.fill()

    // Header row
    const hdrMidY = y + HDR_H / 2
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.80)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Motion Blur', x + 12, hdrMidY)

    // Slot indicators right-to-left: image, fade, delay, capture
    this._drawIndicators(ctx, [
      { slot: this._imageSlot,   label: 'img', colour: ACCENT },
      { slot: this._fadeSlot,    label: 'fde', colour: AM_COL },
      { slot: this._delaySlot,   label: 'dly', colour: AM_COL },
      { slot: this._captureSlot, label: 'cap', colour: EV_COL },
    ], x + width - 8, hdrMidY)

    // Slider rows
    const fadeVal  = this._fadeSlot.isActive
      ? Math.max(0, Math.min(1, (this._fadeSlot.source as AmountSource).getAmount() as Amount))
      : this._fade
    const delayVal = this._delaySlot.isActive
      ? Math.max(0, Math.min(1, (this._delaySlot.source as AmountSource).getAmount() as Amount))
      : this._delay

    this._renderSliderRow(ctx, 0, 'fade',  this._fadeSlot,  fadeVal,  AM_COL, x, y, width)
    this._renderSliderRow(ctx, 1, 'delay', this._delaySlot, delayVal, AM_COL, x, y, width)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    const b = this.canvasBounds
    return (point.x >= b.x && point.x <= b.x + b.width &&
            point.y >= b.y && point.y <= b.y + b.height) ? this : null
  }

  handlePointerDown(point: Point): boolean {
    const { x, y, width } = this.canvasBounds
    for (let i = 0; i < 2; i++) {
      const ry = this._sliderRowY(i, y)
      if (point.y < ry || point.y > ry + SLIDER_H) continue
      const { sld0, sldR } = this._sliderLayout(x, width)
      if (point.x < sld0 - 6 || point.x > sldR + 6) continue
      const slot = i === 0 ? this._fadeSlot : this._delaySlot
      if (slot.state === SlotState.Bound) BindingLayer.findForSlot(slot)?.toggle()
      this._sliderDrag = i as 0 | 1
      this._applySliderDrag(i, point.x, x, width)
      return true
    }
    return false
  }

  handlePointerMove(point: Point): void {
    if (this._sliderDrag === null) return
    const { x, width } = this.canvasBounds
    this._applySliderDrag(this._sliderDrag, point.x, x, width)
  }

  handlePointerUp(): void {
    this._sliderDrag = null
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _sliderRowY(i: number, pillY: number): number {
    return pillY + HDR_H + ROW_GAP + i * (SLIDER_H + ROW_GAP)
  }

  private _sliderLayout(pillX: number, pillW: number) {
    const sld0 = pillX + 8 + 4 + LABEL_W
    const sldR = pillX + pillW - 8 - VALUE_W - 14
    return { sld0, sldR }
  }

  private _applySliderDrag(i: number, px: number, pillX: number, pillW: number): void {
    const { sld0, sldR } = this._sliderLayout(pillX, pillW)
    const thumbR = 5
    const lo = sld0 + thumbR
    const hi = sldR - thumbR
    const v = Math.max(0, Math.min(1, (px - lo) / Math.max(1e-6, hi - lo)))
    if (i === 0) this._fade  = v
    else         this._delay = v
    this.markDirty()
  }

  private _renderSliderRow(
    ctx: Ctx2D, i: number, label: string, slot: ParameterSlot,
    value01: number, activeColour: string,
    pillX: number, pillY: number, pillW: number,
  ): void {
    const ry     = this._sliderRowY(i, pillY)
    const midY   = ry + SLIDER_H / 2
    const active = slot.isActive
    const colour = active ? activeColour : ACCENT
    const { sld0, sldR } = this._sliderLayout(pillX, pillW)
    const indX   = pillX + pillW - 8

    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.50)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, pillX + 12, midY)

    this._drawSlider(ctx, midY, sld0, sldR, value01, colour)

    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    ctx.textAlign = 'right'
    ctx.fillText(value01.toFixed(2), indX - 12, midY)

    ctx.font      = '9px monospace'
    ctx.fillStyle = active ? activeColour : 'rgba(255,255,255,0.22)'
    ctx.textAlign = 'right'
    ctx.fillText(active ? '●' : '○', indX, midY)
  }

  private _drawSlider(ctx: Ctx2D, midY: number, x0: number, x1: number, v: number, colour: string): void {
    const thumbR = 5
    const lo = x0 + thumbR
    const hi = x1 - thumbR
    const thumbX = lo + Math.max(0, Math.min(1, v)) * Math.max(0, hi - lo)

    ctx.lineCap = 'round'

    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth   = 3
    ctx.beginPath(); ctx.moveTo(lo, midY); ctx.lineTo(hi, midY); ctx.stroke()

    ctx.strokeStyle = colour
    ctx.beginPath(); ctx.moveTo(lo, midY); ctx.lineTo(thumbX, midY); ctx.stroke()

    ctx.fillStyle = colour
    ctx.beginPath(); ctx.arc(thumbX, midY, thumbR, 0, Math.PI * 2); ctx.fill()
  }

  private _drawIndicators(
    ctx: Ctx2D,
    items: Array<{ slot: ParameterSlot; label: string; colour: string }>,
    rightX: number,
    midY: number,
  ): void {
    let dx = rightX
    ctx.font         = '9px monospace'
    ctx.textBaseline = 'middle'
    for (let i = items.length - 1; i >= 0; i--) {
      const { slot, label, colour } = items[i]!
      const active = slot.isActive
      ctx.fillStyle = active ? colour : 'rgba(255,255,255,0.22)'
      ctx.textAlign = 'right'
      ctx.fillText(active ? '●' : '○', dx, midY)
      dx -= 11
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText(label, dx, midY)
      dx -= ctx.measureText(label).width + 8
    }
  }
}
