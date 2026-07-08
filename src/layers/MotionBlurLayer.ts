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
import { SliderSlot }   from '../ui/SliderSlot.js'

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

const HDR_H   = 36   // header row height (panel pill)
const ROW_H   = 30   // SliderSlot row height (matches Layer.renderSlotGroup)
const ROW_GAP = 4    // gap between slot rows
const ROW_PAD = 3    // slot pill top/bottom padding

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

  private readonly _fadeWidget:  SliderSlot
  private readonly _delayWidget: SliderSlot

  constructor() {
    super()
    this._imageSlot   = new ParameterSlot(ValueType.Image,  this, 'image')
    this._fadeSlot    = new ParameterSlot(ValueType.Amount, this, 'fade')
    this._delaySlot   = new ParameterSlot(ValueType.Amount, this, 'delay')
    this._captureSlot = new ParameterSlot(ValueType.Event,  this, 'capture')
    this.slots.push(this._imageSlot, this._fadeSlot, this._delaySlot, this._captureSlot)
    this.displayBaseName = 'Trail'
    this.debugName = 'Trail'
    this._fadeWidget = new SliderSlot(
      this._fadeSlot, 'fade', AM_COL,
      () => this._fadeSlot.isActive
        ? Math.max(0, Math.min(1, (this._fadeSlot.source as AmountSource).getAmount() as number))
        : this._fade,
      v => {
        if (this._fadeSlot.state === SlotState.Bound) BindingLayer.findForSlot(this._fadeSlot)?.toggle()
        this._fade = v; this.markDirty()
      },
      () => this.markDirty(),
    )
    this._delayWidget = new SliderSlot(
      this._delaySlot, 'delay', AM_COL,
      () => this._delaySlot.isActive
        ? Math.max(0, Math.min(1, (this._delaySlot.source as AmountSource).getAmount() as number))
        : this._delay,
      v => {
        if (this._delaySlot.state === SlotState.Bound) BindingLayer.findForSlot(this._delaySlot)?.toggle()
        this._delay = v; this.markDirty()
      },
      () => this.markDirty(),
    )
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
  get fadeWidget():  SliderSlot    { return this._fadeWidget  }
  get delayWidget(): SliderSlot    { return this._delayWidget }

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
    return { ...super.canvasBounds, height: HDR_H }
  }

  override get panelBottom(): number {
    return 50 + HDR_H + 8
  }

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width } = this.canvasBounds
    if (width <= 0) return

    ctx.save()

    // Background pill (header row only)
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, HDR_H, 8)
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, HDR_H, [4, 0, 0, 4])
    ctx.fill()

    // Header row
    const hdrMidY = y + HDR_H / 2
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.80)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Motion Blur', x + 12, hdrMidY)

    // Indicators for image and capture only (fade/delay shown via SliderSlot rows)
    this._drawIndicators(ctx, [
      { slot: this._imageSlot,   label: 'img', colour: ACCENT },
      { slot: this._captureSlot, label: 'cap', colour: EV_COL },
    ], x + width - 8, hdrMidY)

    ctx.restore()
  }

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const cb   = this.canvasBounds
    const px   = cb.x, py = this.panelBottom, pw = cb.width
    const pillH = 2 * (ROW_H + ROW_GAP) - ROW_GAP + 2 * ROW_PAD

    // Pill background for fade + delay SliderSlot rows
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath(); ctx.roundRect(px, py, pw, pillH, 6); ctx.fill()
    ctx.fillStyle = AM_COL
    ctx.beginPath(); ctx.roundRect(px, py, 4, pillH, [4, 0, 0, 4]); ctx.fill()
    ctx.restore()

    const fadeRow  = { x: px, y: py + ROW_PAD,                    width: pw, height: ROW_H }
    const delayRow = { x: px, y: py + ROW_PAD + ROW_H + ROW_GAP, width: pw, height: ROW_H }
    this._slotBounds.set(this._fadeSlot,  fadeRow)
    this._slotBounds.set(this._delaySlot, delayRow)
    this._fadeWidget.render(ctx, fadeRow)
    this._delayWidget.render(ctx, delayRow)

    // Standard rows for image and capture
    this.renderSlotGroup(ctx, [this._imageSlot, this._captureSlot], py + pillH + 8)
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    const b = this.canvasBounds
    if (point.x >= b.x && point.x <= b.x + b.width &&
        point.y >= b.y && point.y <= b.y + b.height) return this
    // SliderSlot pill
    const pillH = 2 * (ROW_H + ROW_GAP) - ROW_GAP + 2 * ROW_PAD
    if (point.x >= b.x && point.x <= b.x + b.width &&
        point.y >= this.panelBottom && point.y <= this.panelBottom + pillH) return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    const { fadeRow, delayRow } = this._slotRows()
    if (this._fadeWidget.handlePointerDown(point, fadeRow))   return true
    if (this._delayWidget.handlePointerDown(point, delayRow)) return true
    return false
  }

  handlePointerMove(point: Point): void {
    const { fadeRow, delayRow } = this._slotRows()
    this._fadeWidget.handlePointerMove(point, fadeRow)
    this._delayWidget.handlePointerMove(point, delayRow)
  }

  handlePointerUp(): void {
    this._fadeWidget.handlePointerUp()
    this._delayWidget.handlePointerUp()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _slotRows() {
    const cb = this.canvasBounds
    const px = cb.x, py = this.panelBottom, pw = cb.width
    const fadeRow  = { x: px, y: py + ROW_PAD,                    width: pw, height: ROW_H }
    const delayRow = { x: px, y: py + ROW_PAD + ROW_H + ROW_GAP, width: pw, height: ROW_H }
    return { fadeRow, delayRow }
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
