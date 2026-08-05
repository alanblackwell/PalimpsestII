import { Layer } from '../core/Layer.js'
import { Node }  from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type Amount, type AmountSource,
  type EventValue, type EventSource,
  type ImageSource,
  type PointSource,
  type AudioSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { drawIcon, type IconName } from '../ui/icons.js'
import { TempoLayer, sliderToHz, hzToSlider } from './TempoLayer.js'
import { SliderRegion } from '../regions/SliderRegion.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'
import { audioRhythm } from '../audio/AudioRhythm.js'
import { AudioScopeWidget } from '../audio/AudioScopeWidget.js'

// ------------------------------------------------------------
// EventLayer — discrete event source (pulse generator)
// ------------------------------------------------------------
//
// Four independent triggering modes (all active simultaneously
// when their slots are bound):
//
//   Manual       — [▶ FIRE] button triggers a pulse on click.
//
//   Rate-driven  — an AmountSource (typically a TempoLayer phase)
//                  is bound to rateSlot.  Fires each time the
//                  phase wraps around (robust zero-crossing).
//
//   Proximity    — animPathSlot (Point / AnimPath) and targetSlot
//                  (Point) are both bound.  Fires once per cycle
//                  when the AnimPath makes its closest approach to
//                  the target point.
//
//                  Calibration: on first bind (and whenever a full
//                  cycle passes without a trigger, indicating the
//                  path or target has moved), the layer samples the
//                  full path at CALIBRATION_SAMPLES evenly-spaced
//                  phases to find the global minimum distance.  A
//                  5 % tolerance band on that minimum prevents
//                  frame-rate quantisation from causing misses.
//
//                  Cycle detection: the AnimPath exposes its current
//                  phase; a drop of > 0.5 from one frame to the next
//                  signals a wrap.
//
//   Collision    — imageASlot and imageBSlot (both Image) are bound.
//                  Fires on the first frame that the two images share
//                  any non-transparent pixels (rising-edge only).
//                  Detection uses a 64×64 downsampled probe canvas:
//                  image A is drawn, then image B is composited with
//                  destination-in (alpha multiplication), and any
//                  surviving pixel signals contact.  The alpha-weighted
//                  centroid of surviving pixels is mapped back to
//                  canvas coordinates and shown as a crosshair/flash.
//
//   Audio onset  — audioSlot (Audio, e.g. a VideoLayer's file audio) is
//                  bound. The signal is passed through the shared
//                  audioRhythm singleton's band-pass BiquadFilterNode
//                  (tunable centre frequency + Q, e.g. isolating a kick
//                  drum from vocals — full-band amplitude alone is
//                  dominated by whatever's loudest) built downstream of
//                  the raw AnalyserNode VideoLayer exposes. Fires on the
//                  below→above rising edge of a level threshold on the
//                  filtered envelope, gated by a short refractory period.
//                  See src/audio/AudioRhythm.ts — filter/detector/beat-
//                  tracking are all shared with TempoLayer's audio mode
//                  ("one master audio rhythm"), not per-layer state, so
//                  tuning either layer's scope tunes both. Level
//                  threshold, filter frequency, and Q are dragged
//                  directly on a live amplitude-trace scope
//                  (AudioScopeWidget, src/audio/AudioScopeWidget.ts),
//                  which also marks each detected onset with a travelling
//                  yellow line and the shared beat prediction with a cyan
//                  grid. An optional tempo gate (toggle button in the
//                  pill header) rejects onsets that don't land near a
//                  predicted beat — bounces/reverb trailing a real hit.
//                  A TAP button (same header, same shared audioRhythm.tap()
//                  as TempoLayer's) lets the prior be (re)seeded directly
//                  from here — useful for rhythmic material, where a
//                  manually-set inter-onset-interval estimate improves the
//                  tempo gate's accuracy without needing a TempoLayer.
//
// Output: EventValue — performance.now() timestamp of the most
// recent pulse, or null if never triggered.

const ACCENT               = '#e0e060'
const AUDIO_TC              = '#a87ee8'   // Audio type accent
const CALIBRATION_SAMPLES  = 500
const PROXIMITY_TOLERANCE  = 1.05   // fire within 5 % of calibrated minimum
const PROBE_SIZE           = 64     // collision probe canvas dimensions
// Consecutive non-collision frames required before separation is confirmed.
// Guards against the probe briefly missing a thin-sliver overlap as shapes
// pass through each other, which would otherwise spuriously reset _wasColliding
// and trigger a second fire mid-passage.
const SEPARATION_THRESHOLD = 3

// Button geometry
const BTN_M = 6
const BTN   = 24

// Slot-row constants (must match Layer.ts renderSlots)
const SLIDER_H = 26
const SLOT_H   = 30
const SLOT_GAP = 4
const LABEL_W  = 78
const RATE_TC   = '#e87e7e'

export class EventLayer extends Layer implements EventSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Event])

  private readonly _rateSlot:     ParameterSlot
  private readonly _animPathSlot: ParameterSlot
  private readonly _targetSlot:   ParameterSlot
  private readonly _imageASlot:   ParameterSlot
  private readonly _imageBSlot:   ParameterSlot
  private readonly _audioSlot:    ParameterSlot

  // Collision probe canvas — allocated once, reused every frame
  private readonly _probe:    OffscreenCanvas
  private readonly _probeCtx: OffscreenCanvasRenderingContext2D

  private _eventTime: EventValue = null
  private _prevPhase: number     = 0
  private _cpBounds: { x: number; y: number; width: number; height: number } | null = null

  // ── Rate-slider / play-pause state ─────────────────────
  private _hiddenRate:    TempoLayer | null = null
  private readonly _rateSlider: SliderRegion
  private _running:       boolean = false
  private _lastAutoFire:  number | null = null
  private _playBtnBounds: { x: number; y: number; width: number; height: number } | null = null

  // ── Proximity detection state ───────────────────────────
  private _threshold:      number | null = null   // calibrated minimum distance
  private _prevDist:       number | null = null   // distance last frame
  private _prevAnimPhase:  number | null = null   // AnimPath phase last frame
  private _firedThisCycle: boolean = false
  // Track sources to detect binding changes
  private _prevAnimSrc: unknown = null
  private _prevTgtSrc:  unknown = null

  // ── Collision detection state ───────────────────────────
  private _wasColliding:      boolean      = false
  private _separationFrames:  number       = 0     // consecutive non-collision frames
  private _contactPoint:      Point | null = null  // current-frame collision centroid
  private _lastContactPoint:  Point | null = null  // snapshot at last event fire

  // ── Audio-onset detection state ─────────────────────────────
  // Filter/detector state itself lives in the shared audioRhythm
  // singleton ("one master audio rhythm") — this widget instance only
  // holds this layer's own drag/UI state, so EventLayer's and
  // TempoLayer's scopes can be dragged independently while staying in
  // sync (see src/audio/AudioRhythm.ts, src/audio/AudioScopeWidget.ts).
  private readonly _scope = new AudioScopeWidget()

  // Tempo gate — toggle button drives the shared audioRhythm.tempoGate
  // directly (see AudioRhythm._registerBeatOnset / passesTempoGate); no
  // local copy, since it now protects the shared estimate for both this
  // layer and TempoLayer, not just this layer's firing decision.
  private _tempoGateBtnBounds: { x: number; y: number; width: number; height: number } | null = null
  private _tapBtnBounds: { x: number; y: number; width: number; height: number } | null = null

  // Whole audio-onset pill bounds (header + audioSlot row + scope), cached
  // from the last render — used by main.ts's dragover handler to decide
  // whether the drag point falls inside the pill (see setAudioDropHover).
  private _audioPillBounds: { x: number; y: number; width: number; height: number } | null = null
  private _audioDropHover = false

  // True once the user drags the rate slider directly while tap/audio
  // tempo is driving it — hands control back to the manual slider, same
  // suspend-on-touch convention TempoLayer's TAP uses. Cleared (re-engaged)
  // by the next TAP press.
  private _tapSuspended = false

  constructor() {
    super()
    this._rateSlot     = new ParameterSlot(ValueType.Rate, this, 'tempo')
    this._animPathSlot = new ParameterSlot(ValueType.Point,  this, 'anim path')
    this._targetSlot   = new ParameterSlot(ValueType.Point,  this, 'target')
    this._imageASlot   = new ParameterSlot(ValueType.Image,  this, 'image A', true)
    this._imageBSlot   = new ParameterSlot(ValueType.Image,  this, 'image B', true)
    this._audioSlot    = new ParameterSlot(ValueType.Audio,  this, 'audio')
    this.slots.push(
      this._rateSlot, this._animPathSlot, this._targetSlot,
      this._imageASlot, this._imageBSlot, this._audioSlot,
    )

    this._probe    = new OffscreenCanvas(PROBE_SIZE, PROBE_SIZE)
    this._probeCtx = this._probe.getContext('2d')!
    this._rateSlider = new SliderRegion(this, hzToSlider(1.0))
    this._rateSlider.setOnDragStart(() => { this._tapSuspended = true })

    this.debugName = 'EventLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // EventSource
  // ----------------------------------------------------------

  getEventTime(): EventValue { return this._eventTime }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get rateSlot():     ParameterSlot { return this._rateSlot }
  get animPathSlot(): ParameterSlot { return this._animPathSlot }
  get targetSlot():   ParameterSlot { return this._targetSlot }
  get imageASlot():   ParameterSlot { return this._imageASlot }
  get imageBSlot():   ParameterSlot { return this._imageBSlot }
  get audioSlot():    ParameterSlot { return this._audioSlot }

  // ----------------------------------------------------------
  // OS file drag — audio-onset pill drop target
  // ----------------------------------------------------------

  // Whole audio-onset pill bounds, for main.ts's dragover handler to hit-test
  // the drag point against. Null until this layer has rendered at least once
  // (i.e. been selected) — same "stale but fine" caching every other cached
  // bounds field in this codebase uses for hit-testing.
  audioPillBounds(): { x: number; y: number; width: number; height: number } | null {
    return this._audioPillBounds
  }

  // Called from main.ts's dragover/dragleave/drop handlers while this layer
  // is selected and an OS file is being dragged — true whenever the drag
  // point is anywhere inside the audio-onset pill, regardless of the
  // dragged file's actual type (unknown/unreliable this early — see
  // Layer.fileDropTarget). Purely a display hint; the real type check
  // happens at drop, in main.ts.
  setAudioDropHover(v: boolean): void { this._audioDropHover = v }

  override fileDropTarget(): ParameterSlot | null {
    return (this._audioDropHover && this._audioSlot.state === SlotState.Unbound) ? this._audioSlot : null
  }

  // ----------------------------------------------------------
  // SliderRegion callback — called when user drags the rate slider
  // ----------------------------------------------------------

  setValue(v: Amount): void {
    if (this._hiddenRate !== null) this._hiddenRate.setRateHz(sliderToHz(v))
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      running:         this._running,
      rateSliderValue: this._rateSlider.value,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.running === 'boolean')         this._running = state.running
    if (typeof state.rateSliderValue === 'number')  this._rateSlider.setValue(state.rateSliderValue)
  }

  // ----------------------------------------------------------
  // Controls
  // ----------------------------------------------------------

  fire(): void {
    this._eventTime = performance.now()
    this.markDirty()
  }

  clearEvent(): void {
    this._eventTime        = null
    this._prevPhase        = 0
    this._threshold        = null
    this._prevDist         = null
    this._prevAnimPhase    = null
    this._firedThisCycle   = false
    this._wasColliding     = false
    this._separationFrames = 0
    this._contactPoint     = null
    this._lastContactPoint = null
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    // ── Track bound TempoLayer for the slider ───────────────
    const boundRate = (this._rateSlot.isActive && this._rateSlot.source instanceof TempoLayer)
      ? (this._rateSlot.source as TempoLayer) : null
    if (boundRate !== this._hiddenRate) {
      this._hiddenRate?.removeController(this)
      boundRate?.addController(this)
      this._hiddenRate = boundRate
    }
    if (boundRate !== null) this._rateSlider.setValue(hzToSlider(boundRate.getRate()))

    // ── Mode 1: rate slot wrap detection (gated by play) ───
    if (this._rateSlot.isActive) {
      const phase = (this._rateSlot.source as AmountSource).getAmount() as Amount
      if (this._running && phase < this._prevPhase - 0.5) this._eventTime = performance.now()
      this._prevPhase = phase
    }

    // ── Tap/audio tempo → rate slider, mirroring a manual drag ──
    // Feeds mode 1b's timer below. Only relevant when no external rate
    // source is bound (mode 1 already owns firing in that case) and the
    // user hasn't manually taken the slider back. tickSilent() is skipped
    // whenever mode 4 below already has a live analyser feeding history —
    // no need to also drive the wall-clock fallback in that case.
    const tapDriving = !this._rateSlot.isActive && !this._tapSuspended
      && audioRhythm.tapMarkerTimesMs.length > 0
    if (tapDriving) {
      if (!this._audioSlot.isActive) audioRhythm.tickSilent(performance.now())
      if (audioRhythm.periodMs !== null) {
        const t = hzToSlider(audioRhythm.currentRateHz())
        this._rateSlider.setValue(t)
        this.setValue(t)
      }
      queueMicrotask(() => this.forceDirty())
    }

    // ── Mode 1b: internal timer when no rate slot bound ────
    // Gated on the global pause (Node.clock?.paused, same convention as
    // PointLayer/DirectionLayer's wander/rotate sims) so this wall-clock
    // timer actually stops firing under the 'p' key — without the check it
    // would keep advancing off performance.now() regardless of anything
    // else in the graph being paused. Keep re-dirtying (and _lastAutoFire
    // frozen, not reset) while paused so it resumes cleanly from where it
    // left off rather than bursting missed fires on resume.
    if (this._running && !this._rateSlot.isActive) {
      if (!Node.clock?.paused) {
        const now = performance.now()
        const intervalMs = 1000 / sliderToHz(this._rateSlider.value)
        if (this._lastAutoFire === null) this._lastAutoFire = now - intervalMs
        if (now - this._lastAutoFire >= intervalMs) {
          this._eventTime    = now
          this._lastAutoFire = now
        }
      }
      queueMicrotask(() => this.forceDirty())
    } else if (!this._running) {
      this._lastAutoFire = null
    }

    // ── Mode 2: proximity detection ────────────────────────
    if (this._animPathSlot.isActive && this._targetSlot.isActive) {
      const animSrc = this._animPathSlot.source!
      const tgtSrc  = this._targetSlot.source!

      // Reset on binding change
      if (animSrc !== this._prevAnimSrc || tgtSrc !== this._prevTgtSrc) {
        this._threshold      = null
        this._prevDist       = null
        this._prevAnimPhase  = null
        this._firedThisCycle = false
      }
      this._prevAnimSrc = animSrc
      this._prevTgtSrc  = tgtSrc

      const animRec  = animSrc as Record<string, unknown>
      const tgtPtSrc = tgtSrc  as PointSource

      // Calibrate immediately via samplePerimeter if threshold is unknown.
      if (this._threshold === null) this._calibrate(animRec, tgtPtSrc)

      // Current distance.
      const pos  = (animRec as unknown as PointSource).getPoint()
      const tgt  = tgtPtSrc.getPoint()
      const dist = Math.hypot(pos.x - tgt.x, pos.y - tgt.y)

      // Detect local minimum (distance was decreasing, now increasing).
      // Fire if this minimum is within the tolerance band of the threshold.
      if (this._prevDist !== null
          && !this._firedThisCycle
          && dist > this._prevDist
          && this._threshold !== null
          && this._prevDist <= this._threshold * PROXIMITY_TOLERANCE) {
        this._eventTime      = performance.now()
        this._firedThisCycle = true
      }

      // Cycle detection via AnimPath.phase.
      const animPhase = animRec['phase'] as number | undefined
      if (typeof animPhase === 'number') {
        if (this._prevAnimPhase !== null && animPhase < this._prevAnimPhase - 0.5) {
          // Phase wrapped — new cycle started.
          if (!this._firedThisCycle) {
            // Missed a trigger: path or target has changed.  Recalibrate.
            this._threshold = null
            this._calibrate(animRec, tgtPtSrc)
          }
          this._firedThisCycle = false
        }
        this._prevAnimPhase = animPhase
      }

      this._prevDist = dist
    }

    // ── Mode 3: collision detection ────────────────────────
    if (this._imageASlot.isActive && this._imageBSlot.isActive) {
      const imgA = (this._imageASlot.source as ImageSource).getImage()
      const imgB = (this._imageBSlot.source as ImageSource).getImage()
      const colliding = (imgA !== null && imgB !== null)
        ? this._checkCollision(imgA, imgB)
        : false
      if (colliding) {
        this._separationFrames = 0
        if (!this._wasColliding) {
          this._eventTime        = performance.now()
          this._lastContactPoint = this._contactPoint
            ? { x: this._contactPoint.x, y: this._contactPoint.y }
            : null
          this._wasColliding = true
        }
      } else {
        // Only declare separation after SEPARATION_THRESHOLD consecutive
        // non-collision frames, absorbing brief probe misses on thin overlaps.
        if (this._wasColliding) {
          this._separationFrames++
          if (this._separationFrames >= SEPARATION_THRESHOLD) {
            this._wasColliding     = false
            this._separationFrames = 0
          }
        }
      }
    } else {
      this._wasColliding     = false
      this._separationFrames = 0
      this._contactPoint     = null
    }

    // ── Mode 4: audio onset detection ──────────────────────
    if (this._audioSlot.isActive) {
      const analyser = (this._audioSlot.source as AudioSource).getAudio()
      if (analyser !== null) {
        const nowMs  = performance.now()
        const onset  = audioRhythm.update(analyser, nowMs)
        if (onset && audioRhythm.passesTempoGate(nowMs)) this._eventTime = performance.now()
      }
      queueMicrotask(() => this.forceDirty())   // keep the live scope animating
    }
  }

  // Tap-tempo — same shared audioRhythm.tap() TempoLayer's TAP button
  // uses. Re-engages tap-driven rate control (see tapDriving in
  // recompute()) if a manual slider drag had suspended it.
  private _tap(): void {
    this._tapSuspended = false
    audioRhythm.tap(performance.now())
    this.markDirty()
  }

  // Downscale both images to a 64×64 probe canvas, multiply their alphas
  // via destination-in, then find the alpha-weighted centroid of any surviving
  // pixels.  O(PROBE_SIZE²) pixel scan with no early exit so the centroid
  // covers the full contact area rather than just the first hit.
  private _checkCollision(
    imgA: ImageBitmap | OffscreenCanvas,
    imgB: ImageBitmap | OffscreenCanvas,
  ): boolean {
    const P   = PROBE_SIZE
    const ctx = this._probeCtx

    ctx.clearRect(0, 0, P, P)
    ctx.drawImage(imgA as CanvasImageSource, 0, 0, P, P)
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(imgB as CanvasImageSource, 0, 0, P, P)
    ctx.globalCompositeOperation = 'source-over'

    const data = ctx.getImageData(0, 0, P, P).data

    let totalAlpha = 0, sumX = 0, sumY = 0
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3]!
      if (a > 0) {
        const pIdx  = i >> 2
        const px    = pIdx % P
        const py    = (pIdx / P) | 0
        totalAlpha += a
        sumX       += px * a
        sumY       += py * a
      }
    }

    if (totalAlpha === 0) {
      this._contactPoint = null
      return false
    }

    // Map probe centroid to canvas coordinates (add 0.5 for pixel centre)
    const cw = Node.canvasWidth
    const ch = Node.canvasHeight
    this._contactPoint = {
      x: ((sumX / totalAlpha) + 0.5) / P * cw,
      y: ((sumY / totalAlpha) + 0.5) / P * ch,
    }
    return true
  }

  // Sample the full path to find the global minimum distance to the target.
  private _calibrate(
    animSrc: Record<string, unknown>,
    tgtSrc:  PointSource,
  ): void {
    if (typeof animSrc['samplePerimeter'] !== 'function') return
    const tgt = tgtSrc.getPoint()
    let minDist = Infinity
    for (let i = 0; i < CALIBRATION_SAMPLES; i++) {
      const pt = (animSrc['samplePerimeter'] as (t: number) => Point)(i / CALIBRATION_SAMPLES)
      const d  = Math.hypot(pt.x - tgt.x, pt.y - tgt.y)
      if (d < minDist) minDist = d
    }
    this._threshold = minDist
  }

  // ----------------------------------------------------------
  // Rendering — canvas content (always visible)
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    // ── Proximity mode ──────────────────────────────────────
    if (this._animPathSlot.isActive && this._targetSlot.isActive) {
      const tgt = (this._targetSlot.source as PointSource).getPoint()
      const pos = (this._animPathSlot.source as unknown as PointSource).getPoint()
      const now = performance.now()
      const age    = this._eventTime !== null ? (now - this._eventTime) / 1000 : Infinity
      const bright = Math.max(0, 1 - age)

      ctx.save()

      // Dashed line from AnimPath position to target.
      ctx.strokeStyle = 'rgba(224,224,96,0.20)'
      ctx.lineWidth   = 1
      ctx.setLineDash([3, 4])
      ctx.beginPath(); ctx.moveTo(pos.x, pos.y); ctx.lineTo(tgt.x, tgt.y); ctx.stroke()
      ctx.setLineDash([])

      // Threshold ring — the closest-approach boundary.
      if (this._threshold !== null && this._threshold > 0) {
        ctx.beginPath()
        ctx.arc(tgt.x, tgt.y, this._threshold, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(224,224,96,0.28)'
        ctx.lineWidth   = 1
        ctx.setLineDash([4, 4])
        ctx.stroke()
        ctx.setLineDash([])
      }

      // Target crosshair.
      const r = 7
      ctx.strokeStyle = bright > 0
        ? `rgba(224,224,96,${(0.45 + bright * 0.45).toFixed(2)})`
        : 'rgba(224,224,96,0.45)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(tgt.x - r, tgt.y); ctx.lineTo(tgt.x + r, tgt.y); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(tgt.x, tgt.y - r); ctx.lineTo(tgt.x, tgt.y + r); ctx.stroke()

      ctx.restore()
    }

    // ── Collision mode: crosshair at contact ────────────────
    if (this._imageASlot.isActive && this._imageBSlot.isActive) {
      // Show current contact while colliding, else fade from last known point
      const pt = this._contactPoint ?? this._lastContactPoint
      if (pt) {
        const now    = performance.now()
        const age    = this._eventTime !== null ? (now - this._eventTime) / 1000 : Infinity
        const bright = Math.max(0, 1 - age)
        const alpha  = this._wasColliding ? 0.70 : (0.25 + bright * 0.45)

        ctx.save()
        ctx.strokeStyle = `rgba(224,224,96,${alpha.toFixed(2)})`
        ctx.lineWidth   = 1.5
        const r = 7
        ctx.beginPath(); ctx.moveTo(pt.x - r, pt.y); ctx.lineTo(pt.x + r, pt.y); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(pt.x, pt.y - r); ctx.lineTo(pt.x, pt.y + r); ctx.stroke()
        ctx.restore()
      }
    }
  }

  // ----------------------------------------------------------
  // Rendering — panel UI (selected layer only)
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width <= 0 || this.bounds.height <= 0) return
    this._drawPill(ctx, this.bounds)
    const cp = this.canvasBounds
    this._cpBounds = cp
    this._drawPill(ctx, cp)

    const proximityActive = this._animPathSlot.isActive && this._targetSlot.isActive
    const collisionActive = this._imageASlot.isActive && this._imageBSlot.isActive

    if (proximityActive) {
      this._renderFireFlash(ctx)
    } else if (collisionActive && this._lastContactPoint !== null) {
      this._renderContactFlash(ctx, this._lastContactPoint)
    } else {
      this._renderBlob(ctx)
    }
  }

  // Fire flash — blooms from the proximity target point.
  private _renderFireFlash(ctx: Ctx2D): void {
    const now    = performance.now()
    const age    = this._eventTime !== null ? (now - this._eventTime) / 1000 : Infinity
    const bright = Math.max(0, 1 - age)
    if (bright <= 0) return

    const tgt    = (this._targetSlot.source as PointSource).getPoint()
    const base   = this._threshold ?? 16
    const flashR = base * (0.6 + bright * 0.6)

    ctx.save()
    ctx.beginPath()
    ctx.arc(tgt.x, tgt.y, flashR, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(224,224,96,${(bright * 0.40).toFixed(2)})`
    ctx.fill()
    ctx.restore()
  }

  // Contact flash — blooms from the collision centroid.
  private _renderContactFlash(ctx: Ctx2D, pt: Point): void {
    const now    = performance.now()
    const age    = this._eventTime !== null ? (now - this._eventTime) / 1000 : Infinity
    const bright = Math.max(0, 1 - age)
    if (bright <= 0) return

    const flashR = 16 * (0.6 + bright * 0.6)

    ctx.save()
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, flashR, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(224,224,96,${(bright * 0.40).toFixed(2)})`
    ctx.fill()
    ctx.restore()
  }

  private _renderBlob(ctx: Ctx2D): void {
    const cw  = ctx.canvas.width
    const ch  = ctx.canvas.height
    const bx  = (cw + 280) / 2
    const by  = ch / 2
    const now = performance.now()

    const age    = this._eventTime !== null ? (now - this._eventTime) / 1000 : Infinity
    const bright = Math.max(0, 1 - age)

    const restR = 10
    ctx.save()
    ctx.beginPath()
    ctx.arc(bx, by, restR, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(224,224,96,0.15)'
    ctx.fill()

    if (bright > 0) {
      const flashR = restR + bright * 22
      ctx.beginPath()
      ctx.arc(bx, by, flashR, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(224,224,96,${(bright * 0.7).toFixed(2)})`
      ctx.fill()
    }

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Rendering — slot rows (three pills: rate+slider, proximity, collision)
  // ----------------------------------------------------------

  override renderSlots(ctx: Ctx2D): void {
    if (this.slots.length === 0) return
    this._slotBounds.clear()

    const PANEL_X = contentLeft(Node.canvasWidth)
    const PANEL_W = panelWidth(Node.canvasWidth)
    const drag    = Node.bindDrag

    let y = this.panelBottom

    // ── Pill 1: rate slider + play/pause + rate slot row ────
    {
      const combinedH = SLIDER_H + SLOT_H
      const rateSlotY = y + SLIDER_H

      ctx.save()
      ctx.font         = '10px monospace'
      ctx.textBaseline = 'middle'

      // Backdrop
      ctx.fillStyle = 'rgba(0,0,0,0.28)'
      ctx.beginPath()
      ctx.roundRect(PANEL_X, y, PANEL_W, combinedH, 6)
      ctx.fill()

      // Rate slider
      const btnAreaW = BTN_M + BTN + BTN_M
      const hzTextW  = 56
      this._rateSlider.bounds = {
        x:      PANEL_X + 10,
        y:      y + 4,
        width:  Math.max(0, PANEL_W - 10 - hzTextW - btnAreaW - 4),
        height: SLIDER_H - 8,
      }
      this._rateSlider.renderSelf(ctx)

      // Hz readout
      const hz = this._hiddenRate !== null
        ? this._hiddenRate.getRate()
        : sliderToHz(this._rateSlider.value)
      ctx.fillStyle = 'rgba(255,255,255,0.75)'
      ctx.textAlign = 'right'
      ctx.fillText(Math.round(hz * 60) + ' BPM', PANEL_X + PANEL_W - btnAreaW - 4, y + SLIDER_H / 2)

      // Play/pause button
      const pbtnX = PANEL_X + PANEL_W - BTN_M - BTN
      const pbtnY = y + (SLIDER_H - BTN) / 2
      this._playBtnBounds = { x: pbtnX, y: pbtnY, width: BTN, height: BTN }
      ctx.fillStyle = this._running ? ACCENT + '33' : 'rgba(255,255,255,0.08)'
      ctx.beginPath()
      ctx.roundRect(pbtnX, pbtnY, BTN, BTN, 4)
      ctx.fill()
      ctx.fillStyle = this._running ? ACCENT : 'rgba(255,255,255,0.50)'
      drawIcon(ctx, this._running ? 'pause' : 'play',
        pbtnX + BTN / 2, y + SLIDER_H / 2, BTN - 8)

      // Rate slot row (manual render — inside shared backdrop)
      const slot     = this._rateSlot
      const isCompat = drag.active && drag.source !== null && slot.type !== null
                    && drag.source.types.has(slot.type)

      this._slotBounds.set(slot, { x: PANEL_X, y: rateSlotY, width: PANEL_W, height: SLOT_H })

      ctx.fillStyle = 'rgba(255,255,255,0.62)'
      ctx.textAlign = 'left'
      ctx.fillText(slot.label, PANEL_X + 6, rateSlotY + SLOT_H / 2)

      const vx  = PANEL_X + LABEL_W
      const vw  = PANEL_W - LABEL_W - 2
      const bby = rateSlotY + 3
      const bh  = SLOT_H - 6

      if (slot.isActive && !isCompat) {
        const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
        ctx.fillStyle = RATE_TC + '22'
        ctx.beginPath(); ctx.roundRect(vx, bby, vw, bh, 4); ctx.fill()
        ctx.strokeStyle = RATE_TC + 'cc'; ctx.lineWidth = 1; ctx.setLineDash([])
        ctx.beginPath(); ctx.roundRect(vx + 0.5, bby + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.textAlign = 'left'
        ctx.fillText(srcName, vx + 6, rateSlotY + SLOT_H / 2)
      } else if (isCompat) {
        ctx.fillStyle = 'rgba(50,200,70,0.18)'
        ctx.beginPath(); ctx.roundRect(vx, bby, vw, bh, 4); ctx.fill()
        ctx.strokeStyle = 'rgba(50,200,70,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([])
        ctx.beginPath(); ctx.roundRect(vx + 0.5, bby + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
        ctx.fillStyle = 'rgba(100,255,120,0.75)'; ctx.textAlign = 'left'
        ctx.fillText(slot.isActive ? 'replace binding' : 'drop to bind', vx + 6, rateSlotY + SLOT_H / 2)
      } else if (slot.state === SlotState.SuspendedBound) {
        const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
        ctx.fillStyle = RATE_TC + '11'
        ctx.beginPath(); ctx.roundRect(vx, bby, vw, bh, 4); ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.40)'; ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.beginPath(); ctx.roundRect(vx + 0.5, bby + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = 'rgba(255,255,255,0.60)'; ctx.textAlign = 'left'
        ctx.fillText('⏸ ' + srcName, vx + 6, rateSlotY + SLOT_H / 2)
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.beginPath(); ctx.roundRect(vx + 0.5, bby + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.textAlign = 'left'
        ctx.fillText('unbound', vx + 6, rateSlotY + SLOT_H / 2)
      }

      ctx.restore()
      y += combinedH + SLOT_GAP
    }

    // ── Pill 2: anim path + target ───────────────────────────
    const y2 = this.renderSlotGroup(ctx, [this._animPathSlot, this._targetSlot], y) + SLOT_GAP

    // ── Pill 3: collision (image A + B) with heading ─────────
    const HEAD_H = 18
    const cSlots = [this._imageASlot, this._imageBSlot]
    const totalH = HEAD_H + cSlots.length * (SLOT_H + SLOT_GAP) - SLOT_GAP
    {
      const IMAGE_TC = '#7ecf7e'

      ctx.save()
      ctx.textBaseline = 'middle'

      ctx.fillStyle = 'rgba(0,0,0,0.28)'
      ctx.beginPath()
      ctx.roundRect(PANEL_X, y2, PANEL_W, totalH, 6)
      ctx.fill()

      ctx.font      = '9px monospace'
      ctx.fillStyle = 'rgba(255,255,255,0.38)'
      ctx.textAlign = 'left'
      ctx.fillText('collision', PANEL_X + 8, y2 + HEAD_H / 2)

      let rowY = y2 + HEAD_H
      for (const slot of cSlots) {
        const isCompat = (drag.active && drag.source !== null && slot.type !== null
                       && drag.source.types.has(slot.type))
                      || (Node.fileDragActive && slot.type === ValueType.Image
                       && slot.state === SlotState.Unbound)

        this._slotBounds.set(slot, { x: PANEL_X, y: rowY, width: PANEL_W, height: SLOT_H })

        ctx.font      = '10px monospace'
        ctx.fillStyle = 'rgba(255,255,255,0.62)'
        ctx.textAlign = 'left'
        ctx.fillText(slot.label, PANEL_X + 6, rowY + SLOT_H / 2)

        const vx  = PANEL_X + LABEL_W
        const vw  = PANEL_W - LABEL_W - 2
        const bby = rowY + 3
        const bh  = SLOT_H - 6

        if (slot.isActive && !isCompat) {
          const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
          ctx.fillStyle = IMAGE_TC + '22'
          ctx.beginPath(); ctx.roundRect(vx, bby, vw, bh, 4); ctx.fill()
          ctx.strokeStyle = IMAGE_TC + 'cc'; ctx.lineWidth = 1; ctx.setLineDash([])
          ctx.beginPath(); ctx.roundRect(vx + 0.5, bby + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
          ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.textAlign = 'left'
          ctx.fillText(srcName, vx + 6, rowY + SLOT_H / 2)
        } else if (isCompat) {
          ctx.fillStyle = 'rgba(50,200,70,0.18)'
          ctx.beginPath(); ctx.roundRect(vx, bby, vw, bh, 4); ctx.fill()
          ctx.strokeStyle = 'rgba(50,200,70,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([])
          ctx.beginPath(); ctx.roundRect(vx + 0.5, bby + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
          ctx.fillStyle = 'rgba(100,255,120,0.75)'; ctx.textAlign = 'left'
          ctx.fillText(slot.isActive ? 'replace binding' : 'drop to bind', vx + 6, rowY + SLOT_H / 2)
        } else if (slot.state === SlotState.SuspendedBound) {
          const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
          ctx.fillStyle = IMAGE_TC + '11'
          ctx.beginPath(); ctx.roundRect(vx, bby, vw, bh, 4); ctx.fill()
          ctx.strokeStyle = 'rgba(255,255,255,0.40)'; ctx.lineWidth = 1
          ctx.setLineDash([3, 3])
          ctx.beginPath(); ctx.roundRect(vx + 0.5, bby + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
          ctx.setLineDash([])
          ctx.fillStyle = 'rgba(255,255,255,0.60)'; ctx.textAlign = 'left'
          ctx.fillText('⏸ ' + srcName, vx + 6, rowY + SLOT_H / 2)
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 1
          ctx.setLineDash([3, 3])
          ctx.beginPath(); ctx.roundRect(vx + 0.5, bby + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
          ctx.setLineDash([])
          ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.textAlign = 'left'
          ctx.fillText('unbound', vx + 6, rowY + SLOT_H / 2)
        }

        rowY += SLOT_H + SLOT_GAP
      }

      ctx.restore()
    }

    // ── Pill 4: audio onset ──────────────────────────────────
    const y3 = y2 + totalH + SLOT_GAP
    this._renderAudioPill(ctx, y3, PANEL_X, PANEL_W)
  }

  // Live amplitude-trace scope (of the band-pass-filtered signal) with a
  // draggable level-threshold handle, a draggable Q handle, a band-centre-
  // frequency mini-slider, and a travelling yellow marker at the most
  // recent detected onset, plus the audioSlot binding row.
  private _renderAudioPill(ctx: Ctx2D, y: number, PANEL_X: number, PANEL_W: number): void {
    const HEAD_H  = 18
    const totalH  = HEAD_H + SLOT_H + SLOT_GAP + AudioScopeWidget.HEIGHT + 8
    this._audioPillBounds = { x: PANEL_X, y, width: PANEL_W, height: totalH }

    ctx.save()
    ctx.textBaseline = 'middle'

    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(PANEL_X, y, PANEL_W, totalH, 6)
    ctx.fill()

    ctx.font      = '9px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.38)'
    ctx.textAlign = 'left'
    ctx.fillText('audio onset', PANEL_X + 8, y + HEAD_H / 2)

    // TAP button — (re)seeds the shared audioRhythm prior directly, same
    // logic (same shared state) as TempoLayer's TAP button. Useful here
    // too: rhythmic material's onset detection gets more accurate once
    // the tempo gate (below) has a manually-set inter-onset-interval
    // estimate to filter candidate onsets against.
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

    // Tempo-gate toggle — small button left of TAP. Drives the shared
    // audioRhythm.tempoGate directly (see AudioRhythm._registerBeatOnset) —
    // TempoLayer draws the identical button in its own audio pill, both
    // reading/writing the same singleton field.
    const GATE_SZ = HEAD_H - 4
    const gateX   = tapX - GATE_SZ - 4
    const gateY   = y + 2
    this._tempoGateBtnBounds = { x: gateX, y: gateY, width: GATE_SZ, height: GATE_SZ }
    ctx.fillStyle = audioRhythm.tempoGate ? AUDIO_TC + '55' : 'rgba(255,255,255,0.08)'
    ctx.beginPath(); ctx.roundRect(gateX, gateY, GATE_SZ, GATE_SZ, 3); ctx.fill()
    ctx.strokeStyle = audioRhythm.tempoGate ? AUDIO_TC : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    ctx.beginPath(); ctx.arc(gateX + GATE_SZ / 2, gateY + GATE_SZ / 2, GATE_SZ / 2 - 4, 0, Math.PI * 2); ctx.stroke()

    // audioSlot row — via the shared generic slot-row renderer (same
    // accent/compat/suspended states every other slot gets); backdrop
    // already painted above, so drawBackdrop = false.
    const rowY = y + HEAD_H
    ctx.font = '10px monospace'
    this.renderSlotGroup(ctx, [this._audioSlot], rowY, false)

    // Frequency slider + scope + handles — shared with TempoLayer's audio
    // mode via the same audioRhythm singleton (see AudioScopeWidget).
    this._scope.render(ctx, PANEL_X, rowY + SLOT_H + SLOT_GAP, PANEL_W)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    const b = this._cpBounds ?? this.bounds
    if (boundingBoxContains(this._fireBtnBounds(b), point)) {
      this.fire()
      return true
    }
    if (boundingBoxContains(this._clearBtnBounds(b), point)) {
      this.clearEvent()
      return true
    }
    if (this._playBtnBounds && boundingBoxContains(this._playBtnBounds, point)) {
      this._running = !this._running
      if (!this._running) this._lastAutoFire = null
      this.markDirty()
      return true
    }
    if (this._tempoGateBtnBounds && boundingBoxContains(this._tempoGateBtnBounds, point)) {
      audioRhythm.tempoGate = !audioRhythm.tempoGate
      this.markDirty()
      return true
    }
    if (this._tapBtnBounds && boundingBoxContains(this._tapBtnBounds, point)) {
      this._tap()
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

  protected override hitTestSelf(point: { x: number; y: number }) {
    if (this._cpBounds && boundingBoxContains(this._cpBounds, point)) return this
    if (this._playBtnBounds && boundingBoxContains(this._playBtnBounds, point)) return this
    if (this._tempoGateBtnBounds && boundingBoxContains(this._tempoGateBtnBounds, point)) return this
    if (this._tapBtnBounds && boundingBoxContains(this._tapBtnBounds, point)) return this
    if (this._scope.hitTest(point) !== null) return this
    const sliderHit = this._rateSlider.hitTest(point)
    if (sliderHit !== null) return sliderHit
    return null
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
    const midY = y + height / 2
    const now  = performance.now()

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    const fb = this._fireBtnBounds(b)
    ctx.fillStyle = 'rgba(224,224,96,0.15)'
    ctx.beginPath()
    ctx.roundRect(fb.x, fb.y, fb.width, fb.height, 4)
    ctx.fill()
    ctx.fillStyle    = ACCENT
    drawIcon(ctx, 'lightning', fb.x + fb.width / 2, fb.y + fb.height / 2, fb.height - 6)

    const clearB = this._clearBtnBounds(b)
    const labelX = fb.x + fb.width + 10
    const labelR = clearB.x - 8
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'

    if (this._eventTime === null) {
      ctx.fillStyle = 'rgba(255,255,255,0.22)'
      ctx.fillText('last: —', labelX, midY)
    } else {
      const age    = (now - this._eventTime) / 1000
      const bright = Math.max(0, 1 - age)
      const alpha  = 0.45 + bright * 0.50
      const bv     = Math.round(bright * 96)
      ctx.fillStyle = `rgba(255,255,${bv},${alpha.toFixed(2)})`
      const ageSec  = age < 100 ? age.toFixed(1) + ' s ago' : '—'
      ctx.textAlign = 'right'
      ctx.fillText('last: ' + ageSec, labelR, midY)
    }

    // Mode status label (left of timestamp)
    if (this._animPathSlot.isActive && this._targetSlot.isActive) {
      const status = this._threshold !== null
        ? `⊙ ${Math.round(this._threshold)} px`
        : '⊙ calibrating…'
      ctx.fillStyle = 'rgba(224,224,96,0.55)'
      ctx.font      = '10px monospace'
      ctx.textAlign = 'left'
      ctx.fillText(status, labelX, midY)
    } else if (this._imageASlot.isActive && this._imageBSlot.isActive) {
      ctx.fillStyle = this._wasColliding
        ? 'rgba(224,224,96,0.90)'
        : 'rgba(224,224,96,0.40)'
      ctx.font      = '10px monospace'
      ctx.textAlign = 'left'
      ctx.fillText(this._wasColliding ? '⊕ contact' : '⊕', labelX, midY)
    }

    this._drawBtn(ctx, clearB, 'arrow-counter-clockwise', 'rgba(255,255,255,0.40)')

    ctx.restore()
  }

  private _drawBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    icon: IconName,
    colour: string,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
    ctx.fillStyle = colour
    drawIcon(ctx, icon, b.x + b.width / 2, b.y + b.height / 2, Math.min(b.width, b.height) - 8)
  }

  private _clearBtnBounds(b?: { x: number; y: number; width: number; height: number }) {
    const { x, y, width, height } = b ?? this.bounds
    return { x: x + width - BTN_M - BTN, y: y + (height - BTN) / 2, width: BTN, height: BTN }
  }

  private _fireBtnBounds(b?: { x: number; y: number; width: number; height: number }) {
    const { x, y, height } = b ?? this.bounds
    const fw = 58, fh = 22
    return { x: x + 10, y: y + (height - fh) / 2, width: fw, height: fh }
  }
}
