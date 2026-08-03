import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type EventValue, type EventSource,
  type ImageValue, type ImageSource,
  type Amount, type AmountSource,
  type Rate, type RateSource,
  type Point, type Ctx2D,
} from '../core/types.js'
import { graph }         from '../dataflow/Graph.js'
import { BindingLayer }  from './BindingLayer.js'
import { EventLayer }    from './EventLayer.js'
import { drawIcon }      from '../ui/icons.js'
import { SliderSlot }    from '../ui/SliderSlot.js'

// ------------------------------------------------------------
// FlashLayer — brief image burst triggered by an event
// ------------------------------------------------------------
//
// Inputs:
//   triggerSlot (Event)  — each new event starts a flash. Declared as a
//                          feedback slot (see ParameterSlot.feedback) so
//                          that the tempo-from-length → repeating-event →
//                          retrigger-the-flash loop (bind an EventLayer
//                          driven by this layer's own Rate output back into
//                          triggerSlot) is a well-defined, one-frame-delayed
//                          cycle rather than infinite recursion: Flash reads
//                          the trigger source's cached value instead of
//                          eagerly pulling a fresh evaluation of it, and
//                          Graph.bind() exempts feedback slots from the
//                          reachability cycle check so the closing edge can
//                          actually be created.
//   imageSlot   (Image)  — content rendered during the flash
//   lengthSlot  (Amount) — flash duration, logarithmic [0, 1] → 16 ms … 4 s
//                          (SliderSlot row, standard suspend-on-touch)
//
// Output:
//   EventSource — slow mode only: two events per flash
//                 (one at start, one at end) suitable for toggle effects
//   RateSource  — the repetition rate (Hz) implied by the current
//                 length, i.e. the tempo of a flash repeated back-to-back
//                 at that interval
//
// Duration — logarithmic, 16 ms … 4 000 ms, split into two zones at
// ~200 ms:
//
//   Fast (< 200 ms): renders image locally for the flash duration,
//     then removes it.  No output events — propagation overhead
//     would exceed the flash window.
//
//   Slow (≥ 200 ms): emits a start event immediately, then an end
//     event after the duration.  These two events are ideal for
//     driving toggle parameters on other layers.
//
// Big-button row: a Trigger button (fires the flash directly, same
// as binding+firing the trigger slot's EventLayer) plus Frame/Pulse
// preset buttons. Frame sets length to a single frame (20 ms); Pulse
// sets it to the lowest value of the slow range (200 ms). Whichever
// zone the current length falls in is highlighted, mirroring the
// draw/erase mode-button highlight on MaskLayer. Pressing either
// while lengthSlot is bound suspends the binding first (standard
// suspend-on-touch).

const ACCENT       = '#e0e060'          // Event type colour
const AM_COL       = '#4a8fe8'          // Amount type colour (length slider)
const MIN_DUR_MS    = 16                // shortest flash: one frame at 60 fps
const MAX_DUR_MS    = 4000              // longest flash: 4 s

// Param value at which fast mode transitions to slow mode.
// Derived: log(200/16) / log(4000/16) ≈ 0.457
const FAST_THRESH  = Math.log(200 / MIN_DUR_MS) / Math.log(MAX_DUR_MS / MIN_DUR_MS)

// Preset param values for the Frame/Pulse buttons.
const FRAME_PARAM  = Math.log(20 / MIN_DUR_MS) / Math.log(MAX_DUR_MS / MIN_DUR_MS)   // single frame, 20 ms
const PULSE_PARAM  = FAST_THRESH                                                     // lowest "slow" value, 200 ms

// Big-button row geometry (Trigger / Frame / Pulse).
const BTN_H       = 52
const BTN_GAP     = 8
const BTN_MARGIN  = 10
const HDR_H       = BTN_MARGIN * 2 + BTN_H

// Length SliderSlot row (below the button row).
const ROW_H   = 30   // must match Layer.renderSlotGroup's row height
const ROW_PAD = 3

type BBox = { x: number; y: number; width: number; height: number }

export class FlashLayer extends Layer implements EventSource, RateSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Event, ValueType.Rate])

  readonly triggerSlot: ParameterSlot
  readonly imageSlot:   ParameterSlot
  readonly lengthSlot:  ParameterSlot

  private _length:            number     = 0.30       // [0, 1] manual fallback for lengthSlot
  private _currentEventTime:  EventValue = null        // slow-mode output
  private _lastSeenTrigger:   EventValue = null
  private _flashStart:        number | null = null     // wall time (ms)
  private _flashEndTime:      number     = 0
  private _timeoutId:         ReturnType<typeof setTimeout> | null = null

  private readonly _lengthWidget: SliderSlot

  constructor() {
    super()
    this.triggerSlot = new ParameterSlot(ValueType.Event,  this, 'trigger', true)
    this.imageSlot   = new ParameterSlot(ValueType.Image,  this, 'image')
    this.lengthSlot  = new ParameterSlot(ValueType.Amount, this, 'length')
    this.slots.push(this.triggerSlot, this.imageSlot, this.lengthSlot)
    this.debugName = 'Flash'
    this._lengthWidget = new SliderSlot(
      this.lengthSlot, 'length', AM_COL,
      () => this._lengthValue,
      v => {
        if (this.lengthSlot.state === SlotState.Bound) BindingLayer.findForSlot(this.lengthSlot)?.toggle()
        this._length = v
        this.markDirty()
      },
      () => this.markDirty(),
    )
    graph.register(this)
  }

  // ----------------------------------------------------------
  // EventSource + RateSource
  // ----------------------------------------------------------

  getEventTime(): EventValue { return this._currentEventTime }
  getRate():      Rate       { return 1000 / this._durationMs }

  // ----------------------------------------------------------
  // Derived state
  // ----------------------------------------------------------

  private get _lengthValue(): number {
    return this.lengthSlot.isActive
      ? Math.max(0, Math.min(1, (this.lengthSlot.source as AmountSource).getAmount() as Amount))
      : this._length
  }

  private get _durationMs(): number {
    return MIN_DUR_MS * Math.pow(MAX_DUR_MS / MIN_DUR_MS, this._lengthValue)
  }

  private get _isFast(): boolean {
    return this._lengthValue < FAST_THRESH
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { durationParam: this._length }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.durationParam === 'number') this._length = state.durationParam
  }

  override getSlotDefault(slot: ParameterSlot): number | null {
    if (slot === this.lengthSlot) return this._length
    return null
  }

  // ----------------------------------------------------------
  // Default bindings
  // ----------------------------------------------------------

  // Move the image source to Background so it stops rendering to the canvas
  // while this layer manages its visibility via the flash gate.
  override autoBindRules(): ReturnType<Layer['autoBindRules']> {
    return [
      { slot: this.imageSlot, accepts: (l: Layer) => l.types.has(ValueType.Image), sendToBackgroundAfterBind: true },
    ]
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    // Detect a new trigger event.
    if (this.triggerSlot.isActive) {
      const t = (this.triggerSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastSeenTrigger) {
        this._lastSeenTrigger = t
        this._startFlash()
      }
    }

    // Keep frames running during any flash so fast-mode expiry is detected.
    // markDirty() inside recompute() is a no-op because _dirty is still true
    // at that point; queueMicrotask fires after evaluate() clears _dirty, so
    // the next rAF finds the node dirty again.
    if (this._flashStart !== null) {
      if (this._isFast && performance.now() >= this._flashEndTime) {
        this._flashStart = null
      } else {
        queueMicrotask(() => { if (this._flashStart !== null) this.forceDirty() })
      }
    }
  }

  // ----------------------------------------------------------
  // Flash lifecycle
  // ----------------------------------------------------------

  private _startFlash(): void {
    if (this._timeoutId !== null) {
      clearTimeout(this._timeoutId)
      this._timeoutId = null
    }

    const isFast = this._isFast
    const dur    = this._durationMs
    const now    = performance.now()

    this._flashStart   = now
    this._flashEndTime = now + dur

    if (isFast) {
      // Render locally; keep evaluating until the window closes.
      this.markDirty()
    } else {
      // Emit start event immediately.
      this._currentEventTime = now
      this.markDirty()

      // Emit end event after the flash duration.
      this._timeoutId = setTimeout(() => {
        this._timeoutId  = null
        this._flashStart = null
        this._currentEventTime = performance.now()
        this.markDirty()
      }, dur)
    }
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    if (this._flashStart === null) return
    if (!this.imageSlot.isActive) return
    const img = (this.imageSlot.source as ImageSource).getImage()
    if (img === null) return
    ctx.drawImage(img as CanvasImageSource, 0, 0, Node.canvasWidth, Node.canvasHeight)
  }

  override get canvasBounds() {
    return { ...super.canvasBounds, height: HDR_H }
  }

  override get panelBottom(): number {
    return 50 + HDR_H + 8
  }

  renderPanel(ctx: Ctx2D): void {
    const cb = this.canvasBounds
    if (cb.width <= 0 || cb.height <= 0) return

    ctx.save()

    // Pill background
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(cb.x, cb.y, cb.width, cb.height, 8)
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(cb.x, cb.y, 4, cb.height, [4, 0, 0, 4])
    ctx.fill()

    const isFast = this._isFast
    this._drawTriggerBtn(ctx, this._triggerBtnBounds())
    this._drawModeBtn(ctx, this._frameBtnBounds(), 'Frame', isFast)
    this._drawModeBtn(ctx, this._pulseBtnBounds(), 'Pulse', !isFast)

    ctx.restore()
  }

  private _drawTriggerBtn(ctx: Ctx2D, b: BBox): void {
    const flashing = this._flashStart !== null
    ctx.fillStyle = flashing ? ACCENT + '33' : 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 6)
    ctx.fill()
    ctx.strokeStyle = flashing ? ACCENT : 'rgba(255,255,255,0.25)'
    ctx.lineWidth   = flashing ? 1.5 : 1
    ctx.beginPath()
    ctx.roundRect(b.x + 0.5, b.y + 0.5, b.width - 1, b.height - 1, 6)
    ctx.stroke()
    ctx.fillStyle = ACCENT
    drawIcon(ctx, 'lightning', b.x + b.width / 2, b.y + b.height / 2, Math.min(b.width, b.height) - 16)
  }

  private _drawModeBtn(ctx: Ctx2D, b: BBox, label: string, active: boolean): void {
    ctx.fillStyle = active ? AM_COL + '22' : 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 6)
    ctx.fill()
    if (active) {
      ctx.strokeStyle = AM_COL
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.roundRect(b.x + 0.5, b.y + 0.5, b.width - 1, b.height - 1, 6)
      ctx.stroke()
    }
    ctx.fillStyle    = active ? AM_COL : 'rgba(255,255,255,0.55)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }

  // ----------------------------------------------------------
  // Slot rendering — length SliderSlot row, then standard trigger/image rows
  // ----------------------------------------------------------

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const cb    = this.canvasBounds
    const px    = cb.x, py = this.panelBottom, pw = cb.width
    const pillH = ROW_H + 2 * ROW_PAD

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath(); ctx.roundRect(px, py, pw, pillH, 6); ctx.fill()
    ctx.fillStyle = AM_COL
    ctx.beginPath(); ctx.roundRect(px, py, 4, pillH, [4, 0, 0, 4]); ctx.fill()
    ctx.restore()

    const lengthRow = this._lengthRow()
    this._slotBounds.set(this.lengthSlot, lengthRow)
    this._lengthWidget.render(ctx, lengthRow)

    this.renderSlotGroup(ctx, [this.triggerSlot, this.imageSlot], py + pillH + 8)
  }

  // ----------------------------------------------------------
  // Trigger button — fire the bound EventLayer, or create one on first press
  // ----------------------------------------------------------

  private _fireTrigger(): void {
    const slot = this.triggerSlot

    if (slot.isActive) {
      if (slot.source instanceof EventLayer) {
        // Already bound to an EventLayer (including Background) — fire it.
        (slot.source as EventLayer).fire()
      } else {
        // Bound to a non-EventLayer EventSource — fire the flash directly.
        this._startFlash()
      }
      return
    }

    // Slot is unbound: create a named EventLayer, bind it to the slot, and
    // send it to BackgroundLayer so it stays live without cluttering the stack.
    // The user can retrieve it by clicking the (now-bound) trigger slot.
    const el = new EventLayer()
    Layer.assignSlotCreatedName(el, this, slot)
    el.bounds = { ...this.bounds }
    BindingLayer.create(el, slot)
    Node.sendToBackground?.(el)
    el.fire()
  }

  // ----------------------------------------------------------
  // Frame / Pulse presets
  // ----------------------------------------------------------

  private _applyPreset(param: number): void {
    if (this.lengthSlot.state === SlotState.Bound) BindingLayer.findForSlot(this.lengthSlot)?.toggle()
    this._length = param
    this.markDirty()
  }

  private _setFrame(): void { this._applyPreset(FRAME_PARAM) }
  private _setPulse(): void { this._applyPreset(PULSE_PARAM) }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    const cb = this.canvasBounds
    if (boundingBoxContains(cb, point)) return this
    const lr = this._lengthRow()
    if (boundingBoxContains(lr, point)) return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._triggerBtnBounds(), point)) { this._fireTrigger(); return true }
    if (boundingBoxContains(this._frameBtnBounds(),   point)) { this._setFrame();     return true }
    if (boundingBoxContains(this._pulseBtnBounds(),   point)) { this._setPulse();     return true }
    if (this._lengthWidget.handlePointerDown(point, this._lengthRow())) return true
    return false
  }

  handlePointerMove(point: Point): void {
    this._lengthWidget.handlePointerMove(point, this._lengthRow())
  }

  handlePointerUp(): void {
    this._lengthWidget.handlePointerUp()
  }

  // ----------------------------------------------------------
  // Private geometry helpers
  // ----------------------------------------------------------

  private _btnBounds(i: number): BBox {
    const cb   = this.canvasBounds
    const btnW = (cb.width - 2 * BTN_MARGIN - 2 * BTN_GAP) / 3
    return {
      x: cb.x + BTN_MARGIN + i * (btnW + BTN_GAP),
      y: cb.y + BTN_MARGIN,
      width: btnW, height: BTN_H,
    }
  }

  private _triggerBtnBounds(): BBox { return this._btnBounds(0) }
  private _frameBtnBounds():   BBox { return this._btnBounds(1) }
  private _pulseBtnBounds():   BBox { return this._btnBounds(2) }

  private _lengthRow(): BBox {
    const cb = this.canvasBounds
    return { x: cb.x, y: this.panelBottom + ROW_PAD, width: cb.width, height: ROW_H }
  }
}
