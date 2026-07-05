import { Layer }        from '../core/Layer.js'
import { Node }         from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  type Amount, type AmountSource,
  type Point,  type PointSource,
  type EventValue, type EventSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'
import { RateLayer, sliderToHz, hzToSlider } from './RateLayer.js'
import { SliderRegion } from '../regions/SliderRegion.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'
import { drawIcon } from '../ui/icons.js'

// ------------------------------------------------------------
// AnimPathLayer — samples a shape layer's perimeter at a given phase
// ------------------------------------------------------------
//
// Inputs:
//   shapeSlot    (Point)  — shape/path whose perimeter is sampled
//   phaseSlot    (Amount) — position along the perimeter [0, 1]
//   runModeSlot  (Event)  — each pulse toggles run/stop; click the
//                           radio checkbox to toggle directly
//
// Output:
//   Point — the canvas coordinate at the current phase on the shape

const ACCENT       = '#cf7ecf'   // purple, distinct from shape amber
const RING_R       = 10
const DOT_R        = 3
const SLIDER_H     = 26    // rate slider section height inside the combined rate+phase pill
const AMOUNT_TC    = '#4a8fe8'   // Amount type accent colour (for phase slot binding box)

// Slot-row constants (must match Layer.ts renderSlots)
const SLOT_H   = 30
const SLOT_GAP = 4
const LABEL_W  = 78
const BTN_SZ   = SLOT_H - 6   // square toggle-button size

// Bottom convenience button — "Amount": creates an AmountLayer below and
// binds AnimPath's Point output to its y-position slot.
const ADD_BTN_H       = 30
const ADD_BTN_W       = 80
const ADD_BTN_GAP     = 14   // gap from bottom edge of viewport
const ADD_BTN_COLOUR  = '#4a8fe8'   // Amount accent

export class AnimPathLayer extends Layer implements PointSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Point])

  readonly shapeSlot:   ParameterSlot
  readonly phaseSlot:   ParameterSlot
  readonly runModeSlot: ParameterSlot
  readonly cwSlot:      ParameterSlot

  private _phase:         number = 0
  private _phaseOffset:   number = 0   // keeps effectiveT continuous across direction flips
  private _currentPoint:  Point
  private _running        = true
  private _clockwise      = true
  private _lastEventTime: EventValue = null
  private _lastCwTime:    EventValue = null
  private _toggleBounds:  { x: number; y: number; width: number; height: number } | null = null
  private _cwBounds:      { x: number; y: number; width: number; height: number } | null = null

  private _hiddenRate:  RateLayer | null = null
  private _rateSlider:  SliderRegion

  // Set by main.ts after insertion (and after load) — invoked when the
  // bottom "Amount" convenience button is pressed.
  private _onAddAmount: (() => void) | null = null
  // Once the button has been used once the button is hidden permanently.
  private _addAmountDone = false

  constructor(cx: number, cy: number) {
    super()
    this._currentPoint = { x: cx, y: cy }

    this.shapeSlot   = new ParameterSlot(ValueType.Point,  this, 'shape')
    this.phaseSlot   = new ParameterSlot(ValueType.Amount, this, 'phase')
    this.runModeSlot = new ParameterSlot(ValueType.Event,  this, 'run mode')
    this.cwSlot      = new ParameterSlot(ValueType.Event,  this, 'clockwise')
    this.slots.push(this.shapeSlot, this.phaseSlot, this.runModeSlot, this.cwSlot)

    this._rateSlider = new SliderRegion(this, hzToSlider(1.0))
    this._rateSlider.interactive = false

    graph.register(this)
  }

  // Called from main.ts to wire the bottom "Amount" button.
  setOnAddAmount(fn: () => void): void { this._onAddAmount = fn }

  // Called by SliderRegion when the user drags the rate slider.
  setValue(v: Amount): void {
    if (this._hiddenRate !== null) {
      this._hiddenRate.setRateHz(sliderToHz(v))
    }
    this.markDirty()
  }

  // PointSource
  getPoint(): Point { return { ...this._currentPoint } }

  // The shape slot is conventionally filled with a fresh closed shape
  // (Rect/Ellipse/Path) for the path to follow, not a plain PointLayer.
  override wantsShapeForSlot(slot: ParameterSlot): boolean {
    return slot === this.shapeSlot
  }

  // Current phase [0, 1) — exposed so EventLayer can detect cycle wraps.
  get phase(): number { return this._phase }

  // Sample the underlying shape at phase t — delegates to the bound shape's
  // samplePerimeter if available.  Used by EventLayer to calibrate the
  // closest-approach threshold without waiting for a full live traversal.
  samplePerimeter(t: number): Point {
    if (this.shapeSlot.isActive) {
      const src = this.shapeSlot.source as Record<string, unknown>
      if (typeof src['samplePerimeter'] === 'function') {
        return (src['samplePerimeter'] as (t: number) => Point)(t)
      }
      return (this.shapeSlot.source as PointSource).getPoint()
    }
    return { ...this._currentPoint }
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      phase:          this._phase,
      phaseOffset:    this._phaseOffset,
      currentPoint:   this._currentPoint,
      running:        this._running,
      clockwise:      this._clockwise,
      lastEventTime:  this._lastEventTime,
      addAmountDone:  this._addAmountDone,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.phase === 'number')        this._phase       = state.phase
    if (typeof state.phaseOffset === 'number')  this._phaseOffset = state.phaseOffset
    if (typeof state.running === 'boolean')     this._running     = state.running
    if (typeof state.clockwise === 'boolean')   this._clockwise   = state.clockwise
    if (state.currentPoint && typeof state.currentPoint === 'object') {
      this._currentPoint = state.currentPoint as Point
    }
    if (typeof state.lastEventTime === 'number' || state.lastEventTime === null) {
      this._lastEventTime = state.lastEventTime as EventValue
    }
    if (typeof state.addAmountDone === 'boolean') this._addAmountDone = state.addAmountDone
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    // Toggle run/stop on each new event pulse.
    if (this.runModeSlot.isActive) {
      const t = (this.runModeSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastEventTime) {
        this._lastEventTime = t
        this._running = !this._running
      }
    }

    // Flip CW/CCW on each new event pulse.
    if (this.cwSlot.isActive) {
      const t = (this.cwSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastCwTime) {
        this._lastCwTime = t
        this._flipDirection()
      }
    }

    // Only advance the phase when running.
    if (this._running && this.phaseSlot.isActive) {
      this._phase = (this.phaseSlot.source as AmountSource).getAmount() as Amount
    }

    if (this.shapeSlot.isActive) {
      const src = this.shapeSlot.source as Record<string, unknown>
      if (typeof src['samplePerimeter'] === 'function') {
        this._currentPoint = (src['samplePerimeter'] as (t: number) => Point)(this._effectiveT())
      } else {
        this._currentPoint = (this.shapeSlot.source as PointSource).getPoint()
      }
    }

    // Dynamically track which RateLayer is bound to phaseSlot.
    // This handles both the hidden-helper Rate and any manually bound Rate.
    const boundRate = (this.phaseSlot.isActive && this.phaseSlot.source instanceof RateLayer)
      ? (this.phaseSlot.source as RateLayer) : null
    if (boundRate !== this._hiddenRate) {
      this._hiddenRate = boundRate
      this._rateSlider.interactive = boundRate !== null
    }
    // Always sync slider from the rate source so the display stays current
    // even when the Rate layer's Hz is changed while this layer is not selected.
    if (boundRate !== null) this._rateSlider.setValue(hzToSlider(boundRate.getRate()))

    this._syncSliderBounds()
  }

  // Effective perimeter parameter [0,1] accounting for direction and offset.
  private _effectiveT(): number {
    const raw = this._clockwise
      ? this._phase + this._phaseOffset
      : this._phaseOffset - this._phase
    return ((raw % 1) + 1) % 1
  }

  // Flip direction while keeping the current perimeter position unchanged.
  private _flipDirection(): void {
    const prevT = this._effectiveT()
    this._clockwise = !this._clockwise
    // Solve for new offset: frac(±_phase + offset_new) = prevT
    this._phaseOffset = this._clockwise
      ? ((prevT - this._phase) % 1 + 1) % 1
      : ((prevT + this._phase) % 1 + 1) % 1
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(_ctx: Ctx2D): void { /* marker drawn in renderOverlay — selected layer only */ }

  override renderOverlay(ctx: Ctx2D): void {
    const { x, y } = this._currentPoint
    ctx.save()
    ctx.globalAlpha = this._running ? 1 : 0.45
    ctx.strokeStyle = ACCENT
    ctx.lineWidth   = 2
    ctx.beginPath()
    ctx.arc(x, y, RING_R, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(x, y, DOT_R, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    this._renderAddButton(ctx)
  }

  renderPanel(ctx: Ctx2D): void {
    this._drawPill(ctx, this.bounds)
    this._drawPill(ctx, this.canvasBounds)
  }

  // Three-pill slot layout:
  //   Pill 1 — shape slot (standard renderSlotGroup)
  //   Pill 2 — rate slider + phase slot binding row (combined)
  //   Pill 3 — run mode + clockwise slots (with toggle overlays)
  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()

    const PANEL_X = contentLeft(Node.canvasWidth)
    const PANEL_W = panelWidth(Node.canvasWidth)
    const drag    = Node.bindDrag

    let y = this.panelBottom

    // ── Pill 1: shape slot ───────────────────────────────────────
    y = this.renderSlotGroup(ctx, [this.shapeSlot], y) + SLOT_GAP

    // ── Pill 2: combined rate slider + phase slot row ────────────
    {
      const showSlider = this._hiddenRate !== null
      const combinedH  = (showSlider ? SLIDER_H : 0) + SLOT_H
      const phaseY     = y + (showSlider ? SLIDER_H : 0)

      ctx.save()
      ctx.font         = '10px monospace'
      ctx.textBaseline = 'middle'

      // Backdrop
      ctx.fillStyle = 'rgba(0,0,0,0.28)'
      ctx.beginPath()
      ctx.roundRect(PANEL_X, y, PANEL_W, combinedH, 6)
      ctx.fill()

      if (showSlider && this._hiddenRate !== null) {
        this._rateSlider.bounds = {
          x:      PANEL_X + 10,
          y:      y + 4,
          width:  Math.max(0, PANEL_W - 88),
          height: SLIDER_H - 8,
        }
        this._rateSlider.renderSelf(ctx)

        ctx.fillStyle = 'rgba(255,255,255,0.75)'
        ctx.textAlign = 'right'
        ctx.fillText(this._hiddenRate.getRate().toFixed(2) + ' Hz',
          PANEL_X + PANEL_W - 6, y + SLIDER_H / 2)
      }

      // Phase slot row
      const slot = this.phaseSlot
      const isCompat = (drag.active && drag.source !== null && slot.type !== null
                        && drag.source.types.has(slot.type))
                    || (Node.fileDragActive && slot.type === ValueType.Image
                        && slot.state === SlotState.Unbound)

      this._slotBounds.set(slot, { x: PANEL_X, y: phaseY, width: PANEL_W, height: SLOT_H })

      ctx.fillStyle = 'rgba(255,255,255,0.62)'
      ctx.textAlign = 'left'
      ctx.fillText(slot.label, PANEL_X + 6, phaseY + SLOT_H / 2)

      const vx = PANEL_X + LABEL_W
      const vw = PANEL_W - LABEL_W - 2
      const bby = phaseY + 3
      const bh  = SLOT_H - 6

      if (slot.isActive && !isCompat) {
        const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
        ctx.fillStyle = AMOUNT_TC + '22'
        ctx.beginPath(); ctx.roundRect(vx, bby, vw, bh, 4); ctx.fill()
        ctx.strokeStyle = AMOUNT_TC + 'cc'; ctx.lineWidth = 1; ctx.setLineDash([])
        ctx.beginPath(); ctx.roundRect(vx + 0.5, bby + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.textAlign = 'left'
        ctx.fillText(srcName, vx + 6, phaseY + SLOT_H / 2)
      } else if (isCompat) {
        ctx.fillStyle = 'rgba(50,200,70,0.18)'
        ctx.beginPath(); ctx.roundRect(vx, bby, vw, bh, 4); ctx.fill()
        ctx.strokeStyle = 'rgba(50,200,70,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([])
        ctx.beginPath(); ctx.roundRect(vx + 0.5, bby + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
        ctx.fillStyle = 'rgba(100,255,120,0.75)'; ctx.textAlign = 'left'
        ctx.fillText(slot.isActive ? 'replace binding' : 'drop to bind', vx + 6, phaseY + SLOT_H / 2)
      } else if (slot.state === SlotState.SuspendedBound) {
        const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
        ctx.fillStyle = AMOUNT_TC + '11'
        ctx.beginPath(); ctx.roundRect(vx, bby, vw, bh, 4); ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.40)'; ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.beginPath(); ctx.roundRect(vx + 0.5, bby + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = 'rgba(255,255,255,0.60)'; ctx.textAlign = 'left'
        ctx.fillText('⏸ ' + srcName, vx + 6, phaseY + SLOT_H / 2)
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.beginPath(); ctx.roundRect(vx + 0.5, bby + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.textAlign = 'left'
        ctx.fillText('unbound', vx + 6, phaseY + SLOT_H / 2)
      }

      ctx.restore()
      y += combinedH + SLOT_GAP
    }

    // ── Pill 3: run mode + clockwise ─────────────────────────────
    this.renderSlotGroup(ctx, [this.runModeSlot, this.cwSlot], y)

    // Run-mode radio checkbox overlay
    const runMidY = y + SLOT_H / 2
    const cbx = PANEL_X + LABEL_W - 14
    this._toggleBounds = { x: PANEL_X, y, width: LABEL_W, height: SLOT_H }

    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.70)'
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    ctx.arc(cbx, runMidY, 5, 0, Math.PI * 2)
    ctx.stroke()
    if (this._running) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.beginPath()
      ctx.arc(cbx, runMidY, 3, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()

    // CW/CCW toggle button overlay
    const cwY   = y + SLOT_H + SLOT_GAP
    const cwMidY = cwY + SLOT_H / 2
    const btnX  = PANEL_X + PANEL_W - BTN_SZ - 3
    const btnY  = cwY + 3
    const cwState = this.cwSlot.state
    const cwBound = cwState === SlotState.Bound
    const cwSusp  = cwState === SlotState.SuspendedBound
    this._cwBounds = { x: btnX, y: btnY, width: BTN_SZ, height: BTN_SZ }

    ctx.save()
    ctx.fillStyle = cwBound ? ACCENT + '33' : cwSusp ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(btnX, btnY, BTN_SZ, BTN_SZ, 3)
    ctx.fill()
    ctx.strokeStyle = cwBound ? ACCENT + '99' : 'rgba(255,255,255,0.30)'
    ctx.lineWidth = 1
    if (cwSusp) ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.roundRect(btnX + 0.5, btnY + 0.5, BTN_SZ - 1, BTN_SZ - 1, 3)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = ACCENT
    drawIcon(ctx, this._clockwise ? 'arrow-clockwise' : 'arrow-counter-clockwise',
      btnX + BTN_SZ / 2, cwMidY, BTN_SZ - 8)
    ctx.restore()
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  get isInteractive(): boolean { return this._toggleBounds !== null }

  protected override hitTestSelf(point: Point): Node | null {
    if (this._addBtnHitTest(point)) return this
    if (this._toggleBounds !== null) {
      const b = this._toggleBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) return this
    }
    if (this._cwBounds !== null) {
      const b = this._cwBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) return this
    }
    if (this._hiddenRate !== null) {
      const hit = this._rateSlider.hitTest(point)
      if (hit !== null) return hit
    }
    return null
  }

  handlePointerDown(point: Point): boolean {
    if (this._addBtnHitTest(point)) {
      this._onAddAmount?.()
      this._addAmountDone = true
      return true
    }
    if (this._toggleBounds !== null) {
      const b = this._toggleBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) {
        this._running = !this._running
        this.markDirty()
        return true
      }
    }
    if (this._cwBounds !== null) {
      const b = this._cwBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) {
        if (this.cwSlot.state === SlotState.Bound) this.cwSlot.suspend()
        this._flipDirection()
        this.markDirty()
        return true
      }
    }
    return false
  }

  handlePointerUp(): void {}

  // ----------------------------------------------------------
  // Private
  // ----------------------------------------------------------

  private _syncSliderBounds(): void {
    if (this._hiddenRate === null) return
    const PANEL_X = contentLeft(Node.canvasWidth)
    const PANEL_W = panelWidth(Node.canvasWidth)
    // Combined pill starts at: panelBottom + shape pill (SLOT_H) + gap
    const combinedPillY = this.panelBottom + SLOT_H + SLOT_GAP
    this._rateSlider.bounds = {
      x:      PANEL_X + 10,
      y:      combinedPillY + 4,
      width:  Math.max(0, PANEL_W - 88),
      height: SLIDER_H - 8,
    }
  }

  // ----------------------------------------------------------
  // Bottom convenience button
  // ----------------------------------------------------------

  private _addBtnRect(): { x: number; y: number } {
    const left = contentLeft(Node.canvasWidth)
    const right = Node.viewportWidth
    const x = left + Math.max(0, (right - left - ADD_BTN_W) / 2)
    const y = Node.viewportHeight - ADD_BTN_H - ADD_BTN_GAP
    return { x, y }
  }

  private _addBtnHitTest(point: Point): boolean {
    if (this._addAmountDone) return false
    const { x, y } = this._addBtnRect()
    return point.x >= x && point.x <= x + ADD_BTN_W &&
           point.y >= y && point.y <= y + ADD_BTN_H
  }

  private _renderAddButton(ctx: Ctx2D): void {
    if (this._addAmountDone) return
    const { x, y } = this._addBtnRect()
    const midY = y + ADD_BTN_H / 2

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(x, y, ADD_BTN_W, ADD_BTN_H, 5)
    ctx.fill()

    ctx.fillStyle = ADD_BTN_COLOUR + 'cc'
    ctx.beginPath()
    ctx.roundRect(x, y, 3, ADD_BTN_H, [5, 0, 0, 5])
    ctx.fill()

    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, ADD_BTN_W, ADD_BTN_H)
    ctx.clip()
    ctx.fillStyle    = 'rgba(255,255,255,0.85)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Amount', x + 10, midY)
    ctx.restore()

    ctx.restore()
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return
    const midY = y + height / 2

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    ctx.font         = '11px monospace'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = this._running ? 'rgba(255,255,255,0.80)' : 'rgba(255,255,255,0.40)'
    ctx.textAlign    = 'left'
    ctx.fillText('AnimPath', x + 12, midY)

    // CW/CCW indicator icon
    ctx.fillStyle = ACCENT
    drawIcon(ctx, this._clockwise ? 'arrow-clockwise' : 'arrow-counter-clockwise',
      x + width - 30, midY, 13)

    const px = Math.round(this._currentPoint.x)
    const py = Math.round(this._currentPoint.y)
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.textAlign = 'right'
    ctx.fillText(`(${px}, ${py})`, x + width - 44, midY)

    ctx.restore()
  }
}
