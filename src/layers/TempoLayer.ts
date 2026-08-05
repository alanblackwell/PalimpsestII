import { Layer } from '../core/Layer.js'
import { Node }  from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type Amount, type AmountSource,
  type Rate,   type RateSource,
  type AudioSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'
import { SliderRegion } from '../regions/SliderRegion.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'
import { audioRhythm } from '../audio/AudioRhythm.js'
import { AudioScopeWidget } from '../audio/AudioScopeWidget.js'

// ------------------------------------------------------------
// TempoLayer — converts a time source into a cycling phase
// ------------------------------------------------------------
//
// Inputs:
//   _timeSlot  (Amount) — binds to a ClockLayer or any Amount source.
//                         Represents elapsed time in seconds.
//
//   _rateSlot  (Rate)   — optional. When bound, overrides the internal
//                         slider's Hz every recompute (suspend-on-touch:
//                         dragging the slider while bound suspends the
//                         binding first, same as AmountLayer's slider).
//                         Lets any RateSource (e.g. FlashLayer's implied
//                         repetition rate) drive this Tempo's speed.
//
//   _rateSlider (embedded SliderRegion) — controls the rate in Hz
//                         when no Rate slot is bound.  Maps slider
//                         value [0, 1] → [MIN_RATE, MAX_RATE] Hz.
//
//   _audioSlot (Audio)  — optional, e.g. a VideoLayer's file audio.
//                         Lowest priority: only used when _rateSlot is
//                         not bound. Filtering, onset detection, and the
//                         drift-tolerant beat-induction prior (crude PLL)
//                         all live in the shared audioRhythm singleton
//                         (src/audio/AudioRhythm.ts) — "one master audio
//                         rhythm" shared with EventLayer's audio-onset
//                         mode, not per-layer state. This layer duplicates
//                         EventLayer's audio pill (header + audioSlot row +
//                         AudioScopeWidget, identical layout) so the shared
//                         tuning can be dragged from either layer, plus the
//                         predicted-beat overlay for comparing prediction
//                         against detected onsets. Both layers also have
//                         their own TAP button, same shared
//                         audioRhythm.tap() — (re)seeding the prior helps
//                         onset-detection accuracy for rhythmic material
//                         too, not just tempo display, since EventLayer's
//                         tempo gate filters candidate onsets against it.
//
// Output:
//   Amount — a phase value (t × hz) mod 1, cycling [0, 1].
//   Rate   — the current rate value in Hz.
//             (types satisfies both Amount and Rate, so other layers
//              can bind to this as either.)
//
// Display is in BPM (beats per minute) with conventional metronome
// markings.  Internal computation remains in Hz.

export const MIN_RATE  = 0.001  // Hz — slider full-left  (~0.06 BPM)
export const MAX_RATE  = 8      // Hz — slider full-right (~480 BPM)
const ACCENT    = '#e87e7e'  // Rate type colour
const AUDIO_TC  = '#a87ee8'  // Audio type accent — matches EventLayer's audio pill

// Slot-row constants (must match Layer.ts renderSlotGroup)
const SLOT_H   = 30
const SLOT_GAP = 4

// Below this BPM, metronome terminology ("Larghissimo" etc.) stops making
// musical sense, so the readout switches to a seconds-per-cycle description.
const LOW_BPM_THRESHOLD = 10

// Logarithmic mapping between slider [0,1] and Hz [MIN_RATE, MAX_RATE].
const _logRange = Math.log(MAX_RATE / MIN_RATE)
export function sliderToHz(v: number): number {
  return MIN_RATE * Math.exp(v * _logRange)
}
export function hzToSlider(hz: number): number {
  return Math.log(Math.max(MIN_RATE, Math.min(MAX_RATE, hz)) / MIN_RATE) / _logRange
}

// Wrap into [0, 1) — handles negative input (JS `%` keeps the sign of its LHS).
function wrap01(v: number): number {
  return ((v % 1) + 1) % 1
}

// BPM ↔ Hz helpers used for display.
export function hzToBpm(hz: number): number { return hz * 60 }
export function bpmToHz(bpm: number): number { return bpm / 60 }

// Conventional Italian metronome markings, keyed by BPM threshold.
export function tempoMarking(hz: number): string {
  const bpm = hz * 60
  if (bpm <  24)  return 'Larghissimo'
  if (bpm <  40)  return 'Largo'
  if (bpm <  60)  return 'Lento'
  if (bpm <  66)  return 'Larghetto'
  if (bpm <  76)  return 'Adagio'
  if (bpm < 108)  return 'Andante'
  if (bpm < 120)  return 'Moderato'
  if (bpm < 156)  return 'Allegro'
  if (bpm < 176)  return 'Vivace'
  if (bpm < 200)  return 'Presto'
  return 'Prestissimo'
}

export class TempoLayer extends Layer implements AmountSource, RateSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Amount, ValueType.Rate])

  private readonly _timeSlot:   ParameterSlot   // Amount input (time source)
  private readonly _rateSlot:   ParameterSlot   // Rate input — overrides the slider when bound
  private readonly _audioSlot:  ParameterSlot   // Audio input — beat induction, lowest priority
  private readonly _rateSlider: SliderRegion     // Rate control widget

  private _phase:     Amount = 0   // output: cycling [0, 1]
  private _rateHz:    Rate   = 1   // current rate in Hz
  private _timeValue: number = 0   // last time input (for display)
  private _cpBounds: { x: number; y: number; width: number; height: number } | null = null

  // ── Audio-driven beat induction ─────────────────────────
  // Filter/detector/PLL state lives in the shared audioRhythm singleton;
  // this widget instance only holds this layer's own drag/UI state (see
  // EventLayer's identical setup and src/audio/AudioScopeWidget.ts).
  private readonly _scope = new AudioScopeWidget()
  private _tapBtnBounds: { x: number; y: number; width: number; height: number } | null = null
  private _tempoGateBtnBounds: { x: number; y: number; width: number; height: number } | null = null

  // True once the user drags the rate slider directly while tap/audio
  // tempo is driving it — hands control back to the manual slider, same
  // suspend-on-touch convention as a suspended ParameterSlot binding.
  // Cleared (re-engaged) by the next tap().
  private _tapSuspended = false

  // Layers whose sliders directly control this Tempo's Hz (tracked externally
  // by those layers; not a ParameterSlot binding).
  private readonly _controllers: Set<Layer> = new Set()

  private static readonly PAD_X   = 10
  private static readonly PAD_Y   = 8
  private static readonly LABEL_W = 80   // reserved on right for text labels

  constructor(initialRateHz: Rate = 1.0) {
    super()
    this._rateHz     = Math.max(MIN_RATE, Math.min(MAX_RATE, initialRateHz))
    const sliderInit = hzToSlider(this._rateHz)
    this._timeSlot   = new ParameterSlot(ValueType.Amount, this, 'time')
    this._rateSlot   = new ParameterSlot(ValueType.Rate,   this, 'rate')
    this._audioSlot  = new ParameterSlot(ValueType.Audio,  this, 'audio')
    this._rateSlider = new SliderRegion(this, sliderInit)
    this._rateSlider.setOnDragStart(() => {
      if (this._rateSlot.state === SlotState.Bound) BindingLayer.findForSlot(this._rateSlot)?.toggle()
      if (this._audioSlot.state === SlotState.Bound) BindingLayer.findForSlot(this._audioSlot)?.toggle()
      this._tapSuspended = true
    })
    this.slots.push(this._timeSlot, this._rateSlot, this._audioSlot)
    this.debugName = 'TempoLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // AmountSource + RateSource
  // ----------------------------------------------------------

  getAmount(): Amount { return this._phase  }
  getRate():   Rate   { return this._rateHz }

  // ----------------------------------------------------------
  // Slot accessor (for BindingLayer.create)
  // ----------------------------------------------------------

  get timeSlot():  ParameterSlot { return this._timeSlot }
  get rateSlot():  ParameterSlot { return this._rateSlot }
  get audioSlot(): ParameterSlot { return this._audioSlot }

  // ----------------------------------------------------------
  // Called by the embedded SliderRegion when the user drags.
  // ----------------------------------------------------------

  setValue(v: Amount): void {
    this._rateHz = v * MAX_RATE
    this.markDirty()
  }

  // Set the rate directly (e.g. from a proxy slider on the host layer).
  setRateHz(hz: number): void {
    const clamped = Math.max(MIN_RATE, Math.min(MAX_RATE, hz))
    this._rateSlider.setValue(hzToSlider(clamped))
    this._rateHz = clamped
    this.markDirty()
  }

  // Register/unregister a layer whose slider proxies this Tempo's Hz.
  // Called from the controller layer's recompute() when _hiddenRate changes.
  addController(layer: Layer):    void { this._controllers.add(layer)    }
  removeController(layer: Layer): void { this._controllers.delete(layer) }

  // Tap-tempo — (re)seeds the shared audioRhythm prior directly from the
  // median of recent tap intervals, same convention as music software.
  // Does NOT suspend _audioSlot: the point is to reseed the prior, not to
  // disable the ongoing audio tracking that keeps refining it afterward.
  // Re-engages tap-driven rate control if a manual drag had suspended it.
  tap(): void {
    if (this._rateSlot.state === SlotState.Bound) BindingLayer.findForSlot(this._rateSlot)?.toggle()
    this._tapSuspended = false
    audioRhythm.tap(performance.now())
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { sliderValue: this._rateSlider.value }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.sliderValue === 'number') this._rateSlider.setValue(state.sliderValue)
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    // Rate — from the bound Rate source when active (overrides the slider,
    // suspend-on-touch lets the user take over by dragging), else the slider.
    if (this._rateSlot.isActive) {
      const hz = (this._rateSlot.source as RateSource).getRate()
      this._rateHz = Math.max(MIN_RATE, Math.min(MAX_RATE, hz))
      this._rateSlider.setValue(hzToSlider(this._rateHz))
    } else if (this._audioSlot.isActive) {
      const analyser = (this._audioSlot.source as AudioSource).getAudio()
      if (analyser !== null) audioRhythm.update(analyser, performance.now())
      this._rateHz = audioRhythm.periodMs !== null
        ? Math.max(MIN_RATE, Math.min(MAX_RATE, audioRhythm.currentRateHz()))
        : sliderToHz(this._rateSlider.value)
      this._rateSlider.setValue(hzToSlider(this._rateHz))
      queueMicrotask(() => this.forceDirty())   // keep tracking even without a time-slot dependent
    } else if (!this._tapSuspended && audioRhythm.tapMarkerTimesMs.length > 0) {
      // Tap-only tempo — no live audio bound anywhere, but the user has
      // tapped at least once. Keeps the shared history/tick clock advancing
      // off wall time alone (no real signal) so the scope's tap markers and
      // predicted-beat grid still render from the very first tap; once a
      // period estimate exists (second tap onward), drives the rate exactly
      // like the live-audio branch above.
      audioRhythm.tickSilent(performance.now())
      this._rateHz = audioRhythm.periodMs !== null
        ? Math.max(MIN_RATE, Math.min(MAX_RATE, audioRhythm.currentRateHz()))
        : sliderToHz(this._rateSlider.value)
      this._rateSlider.setValue(hzToSlider(this._rateHz))
      queueMicrotask(() => this.forceDirty())
    } else {
      this._rateHz = sliderToHz(this._rateSlider.value)
    }
    const tapDriving = !this._rateSlot.isActive && !this._audioSlot.isActive
      && !this._tapSuspended && audioRhythm.tapMarkerTimesMs.length > 0
    this._rateSlider.interactive  = !this._rateSlot.isActive && !this._audioSlot.isActive && !tapDriving
    this._rateSlider.displayValue = this._rateSlider.value

    // Time — from bound source, or zero if unbound.
    if (this._timeSlot.isActive) {
      this._timeValue = (this._timeSlot.source as AmountSource).getAmount()
    } else {
      this._timeValue = 0
    }

    // Phase — audio-locked case reads the shared prediction directly
    // (wall-clock based, decoupled from this layer's own _timeValue —
    // see AudioRhythm.currentPhase); every other case keeps the original
    // continuous real-time-from-_timeValue formula unchanged.
    if (this._audioSlot.isActive && audioRhythm.periodMs !== null) {
      this._phase = audioRhythm.currentPhase(performance.now())
    } else {
      this._phase = this._rateHz > 0 ? wrap01(this._timeValue * this._rateHz) : 0
    }

    this._syncSliderBounds()
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  // Two-line tempo readout for the strip pill next to the slider. Below
  // LOW_BPM_THRESHOLD, BPM and metronome markings are replaced with a
  // seconds-per-cycle description.
  private get _tempoLines(): [string, string] {
    const bpm = this._rateHz * 60
    if (bpm < LOW_BPM_THRESHOLD) {
      const sec = this._rateHz > 0 ? Math.round(1 / this._rateHz) : 0
      return [`${sec} seconds`, 'per cycle']
    }
    return [`${Math.round(bpm)} BPM`, tempoMarking(this._rateHz)]
  }

  // Single-line label for the phase-arc dial — the metronome marking name
  // for ordinary tempos, or seconds-per-cycle below LOW_BPM_THRESHOLD (where
  // BPM and marking names stop making musical sense).
  private get _dialLabel(): string {
    const bpm = this._rateHz * 60
    if (bpm < LOW_BPM_THRESHOLD) {
      const sec = this._rateHz > 0 ? Math.round(1 / this._rateHz) : 0
      return `${sec} seconds per cycle`
    }
    return tempoMarking(this._rateHz)
  }

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width <= 0 || this.bounds.height <= 0) return
    this._drawPill(ctx, this.bounds)
    const cp = this.canvasBounds
    this._cpBounds = cp
    this._drawPill(ctx, cp)
    this._renderPhaseArc(ctx)
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
    const midY   = y + height / 2
    const labelX = x + width - TempoLayer.LABEL_W + 4

    const px = TempoLayer.PAD_X
    const py = TempoLayer.PAD_Y
    const lw = TempoLayer.LABEL_W
    this._rateSlider.bounds = {
      x:      x + px,
      y:      y + py,
      width:  Math.max(0, width  - px * 2 - lw),
      height: Math.max(0, height - py * 2),
    }

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe (Rate colour)
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // Rate slider widget
    this._rateSlider.renderSelf(ctx)

    ctx.font      = '11px monospace'
    ctx.textAlign = 'left'

    const [line1, line2] = this._tempoLines

    // Upper label line — BPM, or seconds-per-cycle below LOW_BPM_THRESHOLD
    ctx.fillStyle    = 'rgba(255,255,255,0.80)'
    ctx.textBaseline = 'middle'
    ctx.fillText(line1, labelX, midY - 7)

    // Lower label line — metronome marking or "per cycle" — lit when time source is active
    ctx.fillStyle = this._timeSlot.isActive
      ? 'rgba(232,196,74,0.90)'
      : 'rgba(255,255,255,0.30)'
    ctx.fillText(line2, labelX, midY + 7)

    ctx.restore()
  }

  private _renderPhaseArc(ctx: Ctx2D): void {
    const cw   = ctx.canvas.width
    const ch   = ctx.canvas.height
    const cx   = (cw + 280) / 2
    const cy   = ch / 2
    const R    = 36
    const r    = 22

    const sweep = this._phase * Math.PI * 2
    const start = -Math.PI / 2

    ctx.save()

    // Track ring background
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(232,126,126,0.18)'
    ctx.lineWidth   = R - r
    ctx.stroke()

    // Filled arc representing current phase
    if (this._phase > 0) {
      ctx.beginPath()
      ctx.arc(cx, cy, R, start, start + sweep)
      ctx.strokeStyle = `rgba(232,126,126,${this._timeSlot.isActive ? '0.80' : '0.35'})`
      ctx.lineWidth   = R - r
      ctx.stroke()
    }

    // Single-line readout below the dial — metronome marking name, or
    // seconds-per-cycle below LOW_BPM_THRESHOLD.
    const textY = cy + R + 20
    ctx.font         = '11px monospace'
    ctx.fillStyle    = this._timeSlot.isActive
      ? 'rgba(232,196,74,0.90)'
      : 'rgba(255,255,255,0.55)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(this._dialLabel, cx, textY)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Slot rendering — time slot + optional "responds to" pill
  // ----------------------------------------------------------

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const PANEL_X = contentLeft(Node.canvasWidth)
    const PANEL_W = panelWidth(Node.canvasWidth)
    const GAP     = 4

    // time + rate — audioSlot is pulled out into its own pill below,
    // matching EventLayer's audio-onset pill layout.
    const mainSlots = this.slots.filter(s => s !== this._audioSlot)
    const y1 = this.renderSlotGroup(ctx, mainSlots, this.panelBottom)

    const y1b = this._renderAudioPill(ctx, y1 + GAP, PANEL_X, PANEL_W)

    if (this._controllers.size === 0) return

    const HEAD_H  = 18
    const ENTRY_H = 18
    const y0      = y1b + GAP

    const names: string[] = []
    for (const c of this._controllers) names.push(c.debugName ?? '?')

    const totalH = HEAD_H + names.length * ENTRY_H

    ctx.save()
    ctx.textBaseline = 'middle'

    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(PANEL_X, y0, PANEL_W, totalH, 6)
    ctx.fill()

    ctx.font      = '9px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.38)'
    ctx.textAlign = 'left'
    ctx.fillText('responds to', PANEL_X + 8, y0 + HEAD_H / 2)

    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.70)'
    let ey = y0 + HEAD_H
    for (const name of names) {
      ctx.fillText(name, PANEL_X + 14, ey + ENTRY_H / 2)
      ey += ENTRY_H
    }

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (this._tapBtnBounds && boundingBoxContains(this._tapBtnBounds, point)) {
      this.tap()
      return true
    }
    if (this._tempoGateBtnBounds && boundingBoxContains(this._tempoGateBtnBounds, point)) {
      audioRhythm.tempoGate = !audioRhythm.tempoGate
      this.markDirty()
      return true
    }
    if (this._scope.handlePointerDown(point)) return true
    return false
  }

  handlePointerMove(point: Point): void {
    this._scope.handlePointerMove(point)
    if (this._scope.dragging) this.markDirty()
  }

  handlePointerUp(): void {
    this._scope.handlePointerUp()
  }

  protected override hitTestSelf(point: Point) {
    if (this._tapBtnBounds && boundingBoxContains(this._tapBtnBounds, point)) return this
    if (this._tempoGateBtnBounds && boundingBoxContains(this._tempoGateBtnBounds, point)) return this
    if (this._scope.hitTest(point) !== null) return this
    return this._rateSlider.hitTest(point)
  }

  // ----------------------------------------------------------
  // Private
  // ----------------------------------------------------------

  // Audio pill — header + audioSlot binding row + shared live scope, same
  // layout/style as EventLayer's audio-onset pill (deliberately identical:
  // one shared control surface for tuning audioRhythm, duplicated so it's
  // reachable from whichever layer is selected). Returns the bottom y.
  private _renderAudioPill(ctx: Ctx2D, y: number, PANEL_X: number, PANEL_W: number): number {
    const HEAD_H = 18
    const totalH = HEAD_H + SLOT_H + SLOT_GAP + AudioScopeWidget.HEIGHT + 8

    ctx.save()
    ctx.textBaseline = 'middle'

    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(PANEL_X, y, PANEL_W, totalH, 6)
    ctx.fill()

    ctx.font      = '9px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.38)'
    ctx.textAlign = 'left'
    ctx.fillText('audio tempo', PANEL_X + 8, y + HEAD_H / 2)

    // TAP button — (re)seeds the shared audioRhythm prior directly, same
    // logic (same shared state) as EventLayer's TAP button.
    const TAP_W = 36, TAP_H = HEAD_H - 4
    const tapX  = PANEL_X + PANEL_W - TAP_W - 3
    const tapY  = y + 2
    this._tapBtnBounds = { x: tapX, y: tapY, width: TAP_W, height: TAP_H }
    ctx.fillStyle = 'rgba(255,255,255,0.10)'
    ctx.beginPath(); ctx.roundRect(tapX, tapY, TAP_W, TAP_H, 4); ctx.fill()
    ctx.fillStyle = AUDIO_TC
    ctx.font = 'bold 10px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('TAP', tapX + TAP_W / 2, tapY + TAP_H / 2 + 0.5)

    // Tempo-gate toggle — small button left of TAP, identical to
    // EventLayer's. Drives the shared audioRhythm.tempoGate directly (see
    // AudioRhythm._registerBeatOnset) — it protects the estimate itself,
    // not just a per-layer firing decision, so it belongs here too.
    const GATE_SZ = HEAD_H - 4
    const gateX   = tapX - GATE_SZ - 4
    const gateY   = y + 2
    this._tempoGateBtnBounds = { x: gateX, y: gateY, width: GATE_SZ, height: GATE_SZ }
    ctx.fillStyle = audioRhythm.tempoGate ? AUDIO_TC + '55' : 'rgba(255,255,255,0.08)'
    ctx.beginPath(); ctx.roundRect(gateX, gateY, GATE_SZ, GATE_SZ, 3); ctx.fill()
    ctx.strokeStyle = audioRhythm.tempoGate ? AUDIO_TC : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    ctx.beginPath(); ctx.arc(gateX + GATE_SZ / 2, gateY + GATE_SZ / 2, GATE_SZ / 2 - 4, 0, Math.PI * 2); ctx.stroke()

    // audioSlot row — shared generic slot-row renderer, backdrop already
    // painted above.
    const rowY = y + HEAD_H
    ctx.font = '10px monospace'
    this.renderSlotGroup(ctx, [this._audioSlot], rowY, false)

    // Frequency slider + scope + handles.
    this._scope.render(ctx, PANEL_X, rowY + SLOT_H + SLOT_GAP, PANEL_W)

    ctx.restore()
    return y + totalH
  }

  private _syncSliderBounds(): void {
    const { x, y, width, height } = this.bounds
    const px = TempoLayer.PAD_X
    const py = TempoLayer.PAD_Y
    const lw = TempoLayer.LABEL_W
    this._rateSlider.bounds = {
      x:      x + px,
      y:      y + py,
      width:  Math.max(0, width  - px * 2 - lw),
      height: Math.max(0, height - py * 2),
    }
  }
}
