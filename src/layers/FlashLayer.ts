import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type EventValue, type EventSource,
  type ImageValue, type ImageSource,
  type Point, type Ctx2D,
} from '../core/types.js'
import { graph }         from '../dataflow/Graph.js'
import { BindingLayer }  from './BindingLayer.js'
import { EventLayer }    from './EventLayer.js'
import { drawIcon }      from '../ui/icons.js'

// ------------------------------------------------------------
// FlashLayer — brief image burst triggered by an event
// ------------------------------------------------------------
//
// Inputs:
//   triggerSlot (Event) — each new event starts a flash
//   imageSlot   (Image) — content rendered during the flash
//
// Output:
//   EventSource — slow mode only: two events per flash
//                 (one at start, one at end) suitable for toggle effects
//
// Duration slider — logarithmic, 16 ms … 4 000 ms.
// The slider is divided into two zones at ~200 ms:
//
//   Fast (< 200 ms): renders image locally for the flash duration,
//     then removes it.  No output events — propagation overhead
//     would exceed the flash window.
//
//   Slow (≥ 200 ms): emits a start event immediately, then an end
//     event after the duration.  These two events are ideal for
//     driving toggle parameters on other layers.
//
// A mode badge (FAST / SLOW) and the duration value are shown in
// the pill.  The dividing line on the slider track shows the
// threshold visually.

const ACCENT       = '#e0e060'          // Event type colour
const MIN_DUR_MS   = 16                 // shortest flash: one frame at 60 fps
const MAX_DUR_MS   = 4000               // longest flash: 4 s
const TRIG_W       = 22                 // trigger button width in the pill

// Param value at which fast mode transitions to slow mode.
// Derived: log(200/16) / log(4000/16) ≈ 0.457
const FAST_THRESH  = Math.log(200 / MIN_DUR_MS) / Math.log(MAX_DUR_MS / MIN_DUR_MS)

type BBox = { x: number; y: number; width: number; height: number }

export class FlashLayer extends Layer implements EventSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Event])

  readonly triggerSlot: ParameterSlot
  readonly imageSlot:   ParameterSlot

  private _durationParam:    number     = 0.30       // [0, 1] slider position
  private _currentEventTime: EventValue = null        // slow-mode output
  private _lastSeenTrigger:  EventValue = null
  private _flashStart:       number | null = null     // wall time (ms)
  private _flashEndTime:     number     = 0
  private _timeoutId:        ReturnType<typeof setTimeout> | null = null

  private _dragSlider  = false
  private _trackBounds:  BBox | null = null
  private _trigBtnBounds: BBox | null = null

  constructor() {
    super()
    this.triggerSlot = new ParameterSlot(ValueType.Event, this, 'trigger')
    this.imageSlot   = new ParameterSlot(ValueType.Image, this, 'image')
    this.slots.push(this.triggerSlot, this.imageSlot)
    this.debugName = 'Flash'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // EventSource
  // ----------------------------------------------------------

  getEventTime(): EventValue { return this._currentEventTime }

  // ----------------------------------------------------------
  // Derived state
  // ----------------------------------------------------------

  private get _durationMs(): number {
    return MIN_DUR_MS * Math.pow(MAX_DUR_MS / MIN_DUR_MS, this._durationParam)
  }

  private get _isFast(): boolean {
    return this._durationParam < FAST_THRESH
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { durationParam: this._durationParam }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.durationParam === 'number') this._durationParam = state.durationParam
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

    // Keep frames running during any flash so the progress bar animates and
    // fast-mode expiry is detected. markDirty() inside recompute() is a no-op
    // because _dirty is still true at that point; queueMicrotask fires after
    // evaluate() clears _dirty, so the next rAF finds the node dirty again.
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

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width: w, height: h } = this.canvasBounds
    if (w <= 0 || h <= 0) return
    this._drawPill(ctx, x, y, w, h)
  }

  private _drawPill(ctx: Ctx2D, x: number, y: number, w: number, h: number): void {
    const midY   = y + h / 2
    const isFast = this._isFast
    const dur    = this._durationMs
    const durStr = dur < 1000 ? `${Math.round(dur)} ms` : `${(dur / 1000).toFixed(1)} s`

    // Layout constants
    const LABEL_W  = 52   // "Flash" label area
    const TRIG_GAP = 4    // gap between label and trigger button
    const MODE_W   = 40   // "FAST"/"SLOW" badge
    const VAL_W    = 46   // duration text
    const TRACK_PL = 8    // left padding before track
    const TRACK_PR = 8    // right padding after track

    const trigBtnH = h - 10
    const trigBtnX = x + 4 + LABEL_W + TRIG_GAP
    const trigBtnY = y + 5
    this._trigBtnBounds = { x: trigBtnX, y: trigBtnY, width: TRIG_W, height: trigBtnH }

    const trackX = x + 4 + LABEL_W + TRIG_GAP + TRIG_W + TRACK_PL
    const trackW = w - 4 - LABEL_W - TRIG_GAP - TRIG_W - TRACK_PL - TRACK_PR - MODE_W - VAL_W - 6
    const trackH = 5
    const trackY = midY - Math.floor(trackH / 2)

    this._trackBounds = { x: trackX, y, width: trackW, height: h }

    const threshX = trackX + FAST_THRESH * trackW
    const thumbX  = trackX + this._durationParam * trackW

    ctx.save()

    // Pill background
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, Math.min(h / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, h, [4, 0, 0, 4])
    ctx.fill()

    // "Flash" label
    ctx.fillStyle    = 'rgba(255,255,255,0.75)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Flash', x + 12, midY)

    // Trigger button — fires a hidden EventLayer on click
    ctx.fillStyle = 'rgba(224,224,96,0.15)'
    ctx.beginPath()
    ctx.roundRect(trigBtnX, trigBtnY, TRIG_W, trigBtnH, 4)
    ctx.fill()
    ctx.fillStyle = ACCENT
    drawIcon(ctx, 'lightning', trigBtnX + TRIG_W / 2, trigBtnY + trigBtnH / 2, trigBtnH - 4)

    // Slider track — fast zone (blue-tinted, left) and slow zone (amber, right)
    ctx.fillStyle = 'rgba(100,180,255,0.22)'
    ctx.beginPath()
    ctx.roundRect(trackX, trackY, threshX - trackX, trackH, [3, 0, 0, 3])
    ctx.fill()

    ctx.fillStyle = 'rgba(232,160,74,0.22)'
    ctx.beginPath()
    ctx.roundRect(threshX, trackY, trackX + trackW - threshX, trackH, [0, 3, 3, 0])
    ctx.fill()

    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.roundRect(trackX + 0.5, trackY + 0.5, trackW - 1, trackH - 1, 3)
    ctx.stroke()

    // Threshold divider
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth   = 1
    ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.moveTo(threshX, y + 7)
    ctx.lineTo(threshX, y + h - 7)
    ctx.stroke()
    ctx.setLineDash([])

    // Thumb
    const thumbColour = isFast ? '#64b4ff' : ACCENT
    ctx.shadowColor = thumbColour
    ctx.shadowBlur  = 7
    ctx.fillStyle   = thumbColour
    ctx.beginPath()
    ctx.arc(thumbX, midY, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur  = 0

    // Progress bar above the track — grows from left toward the thumb,
    // using the same logarithmic mapping as the slider scale.
    if (this._flashStart !== null) {
      const elapsed      = Math.max(1, performance.now() - this._flashStart)
      const logScale     = Math.log(MAX_DUR_MS / MIN_DUR_MS)
      const progressParam = Math.min(
        this._durationParam,
        Math.max(0, Math.log(elapsed / MIN_DUR_MS) / logScale),
      )
      const barW = progressParam * trackW
      if (barW > 0) {
        const barY = trackY - 4
        ctx.fillStyle = isFast ? 'rgba(100,180,255,0.80)' : ACCENT + 'cc'
        ctx.beginPath()
        ctx.roundRect(trackX, barY, barW, 3, 2)
        ctx.fill()
      }
    }

    // Mode badge
    const badgeX = trackX + trackW + TRACK_PR
    const badgeH = h - 12
    const badgeY = y + 6
    ctx.fillStyle = isFast ? 'rgba(100,180,255,0.20)' : 'rgba(232,160,74,0.20)'
    ctx.beginPath()
    ctx.roundRect(badgeX, badgeY, MODE_W, badgeH, 3)
    ctx.fill()
    ctx.fillStyle    = isFast ? '#64b4ff' : ACCENT
    ctx.font         = 'bold 9px monospace'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(isFast ? 'FAST' : 'SLOW', badgeX + MODE_W / 2, midY)

    // Duration value
    ctx.fillStyle    = 'rgba(255,255,255,0.55)'
    ctx.font         = '9px monospace'
    ctx.textAlign    = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(durStr, x + w - 4, midY)

    // Active flash indicator — bright dot on accent stripe
    if (this._flashStart !== null) {
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(x + 2, midY, 2.5, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.restore()
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
  // Interaction
  // ----------------------------------------------------------

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    return boundingBoxContains(this.canvasBounds, point) ? this : null
  }

  handlePointerDown(point: Point): boolean {
    if (this._trigBtnBounds !== null && boundingBoxContains(this._trigBtnBounds, point)) {
      this._fireTrigger()
      return true
    }
    const tb = this._trackBounds
    if (tb === null) return false
    if (point.x >= tb.x && point.x <= tb.x + tb.width &&
        point.y >= tb.y && point.y <= tb.y + tb.height) {
      this._dragSlider = true
      this._setParamFromX(point.x)
      return true
    }
    return false
  }

  handlePointerMove(point: Point): void {
    if (this._dragSlider) this._setParamFromX(point.x)
  }

  handlePointerUp(): void {
    this._dragSlider = false
  }

  private _setParamFromX(px: number): void {
    const tb = this._trackBounds
    if (tb === null) return
    this._durationParam = Math.max(0, Math.min(1, (px - tb.x) / tb.width))
    this.markDirty()
  }
}
