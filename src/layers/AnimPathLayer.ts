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
import { TempoLayer, sliderToHz, hzToSlider } from './TempoLayer.js'
import { SliderRegion } from '../regions/SliderRegion.js'
import { SliderSlot } from '../ui/SliderSlot.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'
import { drawIcon } from '../ui/icons.js'

// ------------------------------------------------------------
// AnimPathLayer — samples a shape layer's perimeter at a given phase
// ------------------------------------------------------------
//
// Inputs:
//   shapeSlot       (Point)  — shape/path whose perimeter is sampled
//   phaseSlot       (Amount) — cycling [0,1) time base, normally fed by an
//                              auto-created hidden TempoLayer (the "rate")
//   phaseOffsetSlot (Amount) — a slider+binding phase offset, 0 = path
//                              start, 1 = path end. While `runModeSlot` is
//                              off, this is the point's entire position.
//                              While running, it's added to the rate-driven
//                              cycle, so it acts as a live-adjustable shift.
//                              Binding a fresh source here (not resuming a
//                              suspended one) automatically stops run mode,
//                              so the binding alone controls position until
//                              the user switches running back on.
//   runModeSlot     (Event)  — each pulse toggles run/stop; click the
//                              radio checkbox to toggle directly
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

  readonly shapeSlot:       ParameterSlot
  readonly phaseSlot:       ParameterSlot
  readonly phaseOffsetSlot: ParameterSlot
  readonly runModeSlot:     ParameterSlot
  readonly cwSlot:          ParameterSlot

  private _phase:         number = 0
  private _phaseOffset:   number = 0   // keeps effectiveT continuous across direction flips
  private _currentPoint:  Point
  private _running        = true
  private _clockwise      = true
  private _lastEventTime: EventValue = null
  private _lastCwTime:    EventValue = null
  private _toggleBounds:  { x: number; y: number; width: number; height: number } | null = null
  private _cwBounds:      { x: number; y: number; width: number; height: number } | null = null

  // Manual/synced value for phaseOffsetSlot, and the slot's previous state —
  // used to detect a *fresh* bind (Unbound -> Bound) as opposed to a resume
  // from SuspendedBound, which should not re-trigger the auto-stop below.
  private _offsetValue:         number    = 0
  private _offsetSlotPrevState: SlotState = SlotState.Unbound
  private readonly _offsetWidget: SliderSlot

  private _hiddenRate:  TempoLayer | null = null  // bound TempoLayer, if any
  private _rateSlider:  SliderRegion

  // Set by main.ts after insertion (and after load) — invoked when the
  // bottom "Amount" convenience button is pressed.
  private _onAddAmount: (() => void) | null = null
  // Once the button has been used once the button is hidden permanently.
  private _addAmountDone = false

  constructor(cx: number, cy: number) {
    super()
    this._currentPoint = { x: cx, y: cy }

    this.shapeSlot       = new ParameterSlot(ValueType.Point,  this, 'shape')
    this.phaseSlot       = new ParameterSlot(ValueType.Amount, this, 'tempo')
    this.runModeSlot     = new ParameterSlot(ValueType.Event,  this, 'run mode')
    this.cwSlot          = new ParameterSlot(ValueType.Event,  this, 'clockwise')
    this.phaseOffsetSlot = new ParameterSlot(ValueType.Amount, this, 'phase')
    // phaseOffsetSlot appended last so old saves (positional slot restore)
    // keep binding their first four slots correctly — see CLAUDE.md's
    // Persistence section.
    this.slots.push(this.shapeSlot, this.phaseSlot, this.runModeSlot, this.cwSlot, this.phaseOffsetSlot)

    this._rateSlider = new SliderRegion(this, hzToSlider(1.0))
    this._rateSlider.interactive = false

    this._offsetWidget = new SliderSlot(
      this.phaseOffsetSlot, 'phase', AMOUNT_TC,
      () => this._currentPhaseOffset(),
      v => this.setPhaseOffset(v),
      () => this.markDirty(),
    )

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

  get phaseOffsetWidget(): SliderSlot { return this._offsetWidget }

  // Called by the phase-offset SliderSlot when the user drags its handle —
  // suspend-on-touch, same convention as every other manual/slot pair.
  setPhaseOffset(v: number): void {
    if (this.phaseOffsetSlot.state === SlotState.Bound) {
      BindingLayer.findForSlot(this.phaseOffsetSlot)?.toggle()
    }
    this._offsetValue = Math.max(0, Math.min(1, v))
    this.markDirty()
  }

  // Current phase-offset value — the bound source's amount, or the manual
  // slider value when unbound/suspended.
  private _currentPhaseOffset(): number {
    return this.phaseOffsetSlot.isActive
      ? Math.max(0, Math.min(1, (this.phaseOffsetSlot.source as AmountSource).getAmount() as number))
      : this._offsetValue
  }

  // PointSource
  getPoint(): Point { return { ...this._currentPoint } }

  // The shape slot is conventionally filled with a fresh closed shape
  // (Rect/Ellipse/Path) for the path to follow, not a plain PointLayer.
  override wantsShapeForSlot(slot: ParameterSlot): boolean {
    return slot === this.shapeSlot
  }

  // phaseSlot doesn't accept a bare Rate directly (it needs an accumulating
  // phase, not an instantaneous Hz value) but main.ts's tryBindRateIntoPhase
  // auto-creates a hidden TempoLayer adapter for exactly this case.
  override adapterCompatible(slot: ParameterSlot, sourceTypes: ReadonlySet<ValueType>): boolean {
    return slot === this.phaseSlot && sourceTypes.has(ValueType.Rate)
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
      phase:               this._phase,
      phaseOffset:         this._phaseOffset,
      currentPoint:        this._currentPoint,
      running:             this._running,
      clockwise:           this._clockwise,
      lastEventTime:       this._lastEventTime,
      addAmountDone:       this._addAmountDone,
      offsetValue:         this._offsetValue,
      offsetSlotPrevState: this._offsetSlotPrevState,
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
    if (typeof state.offsetValue === 'number')    this._offsetValue = state.offsetValue
    if (state.offsetSlotPrevState === SlotState.Unbound ||
        state.offsetSlotPrevState === SlotState.Bound ||
        state.offsetSlotPrevState === SlotState.SuspendedBound) {
      this._offsetSlotPrevState = state.offsetSlotPrevState
    }
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

    // Phase-offset slot: the moment a source is *freshly* bound (Unbound ->
    // Bound, not a resume from SuspendedBound), stop automatic running so
    // the bound amount alone determines the point's position (start..end)
    // until the user switches run mode back on.
    const offsetState = this.phaseOffsetSlot.state
    if (this._offsetSlotPrevState === SlotState.Unbound && offsetState === SlotState.Bound) {
      this._running = false
    }
    this._offsetSlotPrevState = offsetState

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

    // Dynamically track which TempoLayer is bound to phaseSlot.
    // This handles both the hidden-helper Rate and any manually bound Rate.
    const boundRate = (this.phaseSlot.isActive && this.phaseSlot.source instanceof TempoLayer)
      ? (this.phaseSlot.source as TempoLayer) : null
    if (boundRate !== this._hiddenRate) {
      this._hiddenRate?.removeController(this)
      boundRate?.addController(this)
      this._hiddenRate = boundRate
      this._rateSlider.interactive = boundRate !== null
    }
    // Always sync slider from the rate source so the display stays current
    // even when the Rate layer's Hz is changed while this layer is not selected.
    if (boundRate !== null) this._rateSlider.setValue(hzToSlider(boundRate.getRate()))

    this._syncSliderBounds()
  }

  // Effective perimeter parameter [0,1] accounting for direction and offset.
  // While stopped *and* phaseOffsetSlot is bound, the bound amount *is* the
  // position (0 = path start, 1 = path end) — the rate-driven cycle plays no
  // part, so binding a source there is enough to scrub the point by hand.
  // Otherwise (running, or offset unbound/manual/paused-for-unrelated-
  // reasons) the offset is just added on top of the ordinary rate-driven
  // cycle — 0 by default, so an untouched layer behaves exactly as before,
  // and a manual drag on the slider always nudges the point live regardless
  // of run state.
  private _effectiveT(): number {
    const offset = this._currentPhaseOffset()
    if (!this._running && this.phaseOffsetSlot.isActive) return offset
    const raw = this._clockwise
      ? this._phase + this._phaseOffset + offset
      : this._phaseOffset - this._phase + offset
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

  // Four-pill slot layout:
  //   Pill 1 — shape slot (standard renderSlotGroup)
  //   Pill 2 — rate slider + phase slot binding row (combined)
  //   Pill 3 — phase-offset slider + slot (SliderSlot)
  //   Pill 4 — run mode + clockwise slots (with toggle overlays)
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
        ctx.fillText(Math.round(this._hiddenRate.getRate() * 60) + ' BPM',
          PANEL_X + PANEL_W - 6, y + SLIDER_H / 2)
      }

      // Phase slot row
      const slot = this.phaseSlot
      const dragSourceOk = drag.active && drag.source !== null && slot.type !== null
      const isCompat = (dragSourceOk && drag.source!.types.has(slot.type!))
                    || (Node.fileDragActive && slot.type === ValueType.Image
                        && slot.state === SlotState.Unbound)
      const isAdapterCompat = !isCompat && dragSourceOk
        && this.adapterCompatible(slot, drag.source!.types)

      this._slotBounds.set(slot, { x: PANEL_X, y: phaseY, width: PANEL_W, height: SLOT_H })

      ctx.fillStyle = 'rgba(255,255,255,0.62)'
      ctx.textAlign = 'left'
      ctx.fillText(slot.label, PANEL_X + 6, phaseY + SLOT_H / 2)

      const vx = PANEL_X + LABEL_W
      const vw = PANEL_W - LABEL_W - 2
      const bby = phaseY + 3
      const bh  = SLOT_H - 6

      if (slot.isActive && !isCompat && !isAdapterCompat) {
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
      } else if (isAdapterCompat) {
        ctx.fillStyle = 'rgba(230,160,50,0.18)'
        ctx.beginPath(); ctx.roundRect(vx, bby, vw, bh, 4); ctx.fill()
        ctx.strokeStyle = 'rgba(230,160,50,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([])
        ctx.beginPath(); ctx.roundRect(vx + 0.5, bby + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
        ctx.fillStyle = 'rgba(255,200,100,0.80)'; ctx.textAlign = 'left'
        ctx.fillText(slot.isActive ? 'convert & replace' : 'drop to convert', vx + 6, phaseY + SLOT_H / 2)
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

    // ── Pill 3: phase-offset slider + slot ───────────────────────
    {
      const row = this._phaseOffsetRow()
      ctx.save()
      ctx.fillStyle = 'rgba(0,0,0,0.28)'
      ctx.beginPath()
      ctx.roundRect(row.x, row.y, row.width, row.height, 6)
      ctx.fill()
      ctx.restore()
      this._slotBounds.set(this.phaseOffsetSlot, row)
      this._offsetWidget.render(ctx, row)
      y = row.y + row.height + SLOT_GAP
    }

    // ── Pill 4: run mode + clockwise ─────────────────────────────
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
    if (this._offsetWidget.hitZone(point, this._phaseOffsetRow()) !== null) return this
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
    if (this._offsetWidget.handlePointerDown(point, this._phaseOffsetRow())) return true
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

  handlePointerMove(point: Point): void {
    this._offsetWidget.handlePointerMove(point, this._phaseOffsetRow())
  }

  handlePointerUp(): void {
    this._offsetWidget.handlePointerUp()
  }

  // ----------------------------------------------------------
  // Private
  // ----------------------------------------------------------

  // Bounds of the phase-offset pill (Pill 3) — computed on demand from
  // panelBottom, matching the layout math in renderSlots, so interaction
  // handlers don't need a render pass to have run first.
  private _phaseOffsetRow(): { x: number; y: number; width: number; height: number } {
    const PANEL_X    = contentLeft(Node.canvasWidth)
    const PANEL_W    = panelWidth(Node.canvasWidth)
    const showSlider = this._hiddenRate !== null
    const combinedH  = (showSlider ? SLIDER_H : 0) + SLOT_H
    const y = this.panelBottom + SLOT_H + SLOT_GAP + combinedH + SLOT_GAP
    return { x: PANEL_X, y, width: PANEL_W, height: SLOT_H }
  }

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

}
